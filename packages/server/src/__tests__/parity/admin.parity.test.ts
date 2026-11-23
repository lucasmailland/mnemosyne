/**
 * Tier A parity — GET /admin/stats (design.md D3).
 *
 * HTTP characterization contract for the ONE `deps.core` call site in
 * `packages/server/src/routes/admin-stats.ts` (`getStats`'s `deps.core.vitals`).
 * `admin.ts`'s other routes (LLM/retention config, embedding migrations)
 * never used `deps.core` and are already covered by
 * `unit/admin-llm-config-route.test.ts` / `unit/admin-config-retention.test.ts`
 * / `unit/admin-audit-emit.test.ts` — not duplicated here.
 *
 * Written and merged green against the legacy `deps.core.vitals` (`CoreLike`)
 * implementation FIRST (flatten-legacy-dual-core PR12); the port commit in
 * this same PR then swapped the route to `deps.storage.getWorkspaceVitals`
 * (v3 `StorageAdapter`, already added to the port surface in PR6) with ZERO
 * changes to any `expect(...)` line below EXCEPT the one explicitly marked
 * "DISCLOSED exception" (same call-shape difference `health.parity.test.ts`
 * already documented for this exact method: `vitals({workspaceId})` bag vs.
 * `getWorkspaceVitals(workspaceId)` positional).
 *
 * flatten-legacy-dual-core Phase 9 (task 9.1): `getHealthSnapshot` no longer
 * needs a `vi.mock("@mnemo-ai/core")` module mock to avoid opening a real DB
 * tx — the route now sources it from `deps.storage.getHealthSnapshot` (v3
 * StorageAdapter port), a plain deps fake like every other method here.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { buildMountHarness } from "../_mountHarness.js";
import { mountAdminStats } from "../../routes/admin-stats.js";

const PLAINTEXT_KEY = "mns_live_adminparitytest000001";
const WS_ID = "00000000-0000-0000-0000-000000000d01";

async function makeKeyLookup(scopes: string[] = []): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [{ id: "admin-key-001", keyHash, workspaceId: WS_ID, scopes }],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${PLAINTEXT_KEY}` };
}

function vitalsRecord() {
  return {
    workspaceId: WS_ID,
    factsLive: 100,
    factsClosed: 20,
    pinnedCount: 5,
    lastRecallAt: "2026-06-01T10:00:00.000Z",
    lastWriteAt: "2026-06-01T11:00:00.000Z",
    embeddings: { indexed: 95, pending: 5 },
    factsByScopeRef: [{ scopeRef: "project:abc", count: 3 }],
  };
}

// make-primitives-recallable Requirement 5: a fresh snapshot genuinely
// recording zero for every snapshot-derived count — must be distinguishable
// from "no snapshot exists" (all-null) below.
function zeroSnapshotRecord() {
  return {
    workspaceId: WS_ID,
    snapshotAt: new Date("2026-06-01T09:59:00.000Z"),
    factCountActive: 100,
    factCountArchived: 0,
    factCountEmbedded: 95,
    factCountUnembedded: 5,
    decisionCountActive: 0,
    relationCountConflicts: 0,
    factsWithZeroHits: 0,
    recallHitRate30d: null,
    extractionJobsFailed7d: 0,
    extractionJobsDeferred: 0,
    computedInMs: 12,
  };
}

async function buildApp(
  vitals = vi.fn().mockResolvedValue(vitalsRecord()),
  getHealthSnapshot = vi.fn().mockResolvedValue(null),
  scopes: string[] = [],
  extra: Record<string, unknown> = {}
) {
  const deps = {
    storage: {
      getWorkspaceVitals: vitals,
      getHealthSnapshot,
      countOpenConflicts: vi.fn().mockResolvedValue(0),
      getRecallLatency: vi.fn().mockResolvedValue({ p50Ms: 12, p95Ms: 80, samples: 9 }),
      getWritesPerDay: vi.fn().mockResolvedValue([
        { day: "2026-06-01", count: 2 },
        { day: "2026-06-02", count: 0 },
      ]),
      ...extra,
    },
    apiKeys: await makeKeyLookup(scopes),
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountAdminStats]);
  return { app, vitals, getHealthSnapshot };
}

describe("Tier A parity: GET /admin/stats", () => {
  it("returns 401 with no bearer token", async () => {
    const { app } = await buildApp();
    const res = await app.request("/admin/stats");
    expect(res.status).toBe(401);
  });

  it("returns 200 with composed vitals shape", async () => {
    const { app } = await buildApp();
    const res = await app.request("/admin/stats", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.workspaceId).toBe(WS_ID);
    expect(body.facts.live).toBe(100);
    expect(body.facts.closed).toBe(20);
    expect(body.facts.pinned).toBe(5);
    expect(body.facts.byScopeRef).toEqual([{ scopeRef: "project:abc", count: 3 }]);
    expect(body.embeddings.indexed).toBe(95);
    expect(body.embeddings.pending).toBe(5);
    expect(body.recall.lastRecallAt).toBe("2026-06-01T10:00:00.000Z");
    expect(body.lastWriteAt).toBe("2026-06-01T11:00:00.000Z");
  });

  it("handles null lastRecallAt/lastWriteAt gracefully", async () => {
    const { app } = await buildApp(
      vi.fn().mockResolvedValue({ ...vitalsRecord(), lastRecallAt: null, lastWriteAt: null })
    );
    const res = await app.request("/admin/stats", { headers: authed() });
    const body = (await res.json()) as Record<string, any>;
    expect(body.recall.lastRecallAt).toBeNull();
    expect(body.lastWriteAt).toBeNull();
  });

  it("forwards the caller's workspaceId to the vitals call", async () => {
    // DISCLOSED exception (see file header): pre-port `vitals({workspaceId})`
    // takes an options bag; post-port `getWorkspaceVitals(workspaceId)` takes
    // a positional string — same class as health.parity.test.ts's precedent
    // for this exact method. Every other expect() in this file is unchanged.
    const { app, vitals } = await buildApp();
    await app.request("/admin/stats", { headers: authed() });
    expect(vitals).toHaveBeenCalledWith(WS_ID);
  });

  // make-primitives-recallable Requirement 5 — the exact bug being fixed: a
  // workspace with a stale/absent snapshot must never silently report `0`.
  it("reports null (not 0) for the four snapshot-derived counts when no snapshot exists", async () => {
    const { app } = await buildApp(undefined, vi.fn().mockResolvedValue(null));
    const res = await app.request("/admin/stats", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.facts.archived).toBeNull();
    expect(body.facts.withZeroHits).toBeNull();
    expect(body.decisions.active).toBeNull();
    // relations.conflicts is a live count (countOpenConflicts), not snapshot-derived.
    expect(body.relations.conflicts).toBe(0);
    expect(body.snapshot).toEqual({ at: null, ageSeconds: null, available: false });
  });

  it("reports 0, distinguishably, when a fresh snapshot genuinely records zero", async () => {
    const { app } = await buildApp(undefined, vi.fn().mockResolvedValue(zeroSnapshotRecord()));
    const res = await app.request("/admin/stats", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.facts.archived).toBe(0);
    expect(body.facts.withZeroHits).toBe(0);
    expect(body.decisions.active).toBe(0);
    expect(body.relations.conflicts).toBe(0);
    expect(body.snapshot.available).toBe(true);
    expect(body.snapshot.at).toBe("2026-06-01T09:59:00.000Z");
    expect(typeof body.snapshot.ageSeconds).toBe("number");
    expect(body.snapshot.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it("adds recall latency and writes per day for an admin, alongside every admin field", async () => {
    const { app } = await buildApp(undefined, undefined, ["memory:read", "memory:admin"]);
    const res = await app.request("/admin/stats", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.recall.latencyP50Ms7d).toBe(12);
    expect(body.recall.latencyP95Ms7d).toBe(80);
    expect(body.writesPerDay14d).toEqual([
      { day: "2026-06-01", count: 2 },
      { day: "2026-06-02", count: 0 },
    ]);
    expect(body.embeddings).toEqual({ indexed: 95, pending: 5 });
    expect(body.snapshot).toBeDefined();
    expect(body.facts.byScopeRef).toBeDefined();
    expect(body.facts).toHaveProperty("withZeroHits");
    expect(body.recall.precisionAtK).toBeDefined();
    expect(body.recall.precisionUnavailable).toBeDefined();
  });

  it("serves a memory:read caller a trimmed body: admin-only fields are absent, the rest stays", async () => {
    const { app } = await buildApp(undefined, undefined, ["memory:read"]);
    const res = await app.request("/admin/stats", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).not.toHaveProperty("embeddings");
    expect(body).not.toHaveProperty("snapshot");
    expect(body.facts).not.toHaveProperty("withZeroHits");
    expect(body.facts).not.toHaveProperty("byScopeRef");
    for (const k of Object.keys(body.recall)) expect(k).not.toMatch(/^precision/);
    expect(body.facts.live).toBe(100);
    expect(body.facts.archived).toBeNull();
    expect(body.decisions).toEqual({ active: null });
    expect(body.recall.hitRate30d).toBeNull();
    expect(body.recall.lastRecallAt).toBe("2026-06-01T10:00:00.000Z");
    expect(body.recall.latencyP50Ms7d).toBe(12);
    expect(body.writesPerDay14d).toHaveLength(2);
    expect(body.lastWriteAt).toBe("2026-06-01T11:00:00.000Z");
  });

  it("does not run the precision read for a member", async () => {
    const getRecallPrecision = vi.fn();
    const { app } = await buildApp(undefined, undefined, ["memory:read"], { getRecallPrecision });
    await app.request("/admin/stats", { headers: authed() });
    expect(getRecallPrecision).not.toHaveBeenCalled();
  });

  it("degrades to null latency and empty series when the new reads fail", async () => {
    const { app } = await buildApp(undefined, undefined, ["memory:read"], {
      getRecallLatency: vi.fn().mockRejectedValue(new Error("boom")),
      getWritesPerDay: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const res = await app.request("/admin/stats", { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.recall.latencyP50Ms7d).toBeNull();
    expect(body.recall.latencyP95Ms7d).toBeNull();
    expect(body.writesPerDay14d).toEqual([]);
  });
});
