/**
 * Unit tests for GET /admin/stats route (API-4).
 *
 * Mirrors the pattern from metacognition-route.test.ts:
 *   - OpenAPIHono with fake auth middleware
 *   - Fake storage.getWorkspaceVitals() (flatten-legacy-dual-core PR12 —
 *     was the legacy core's vitals()) + fake storage.getHealthSnapshot()
 *     (flatten-legacy-dual-core Phase 9, task 9.1 — was `vi.mock(@mnemo-ai/
 *     core)`'s `getHealthSnapshot`, ported to the v3 StorageAdapter port so
 *     the route no longer imports `@mnemo-ai/core` at all; every
 *     `expect(...)` below is unchanged from the pre-port version, only the
 *     mocking mechanism moved from a module mock to a deps fake)
 *   - Drive via app.request() — no real HTTP socket, no DB
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { HealthSnapshot } from "@mnemo-ai/types";
import { mountAdminStats } from "../../routes/admin-stats.js";
import { toErrorBody } from "../../errors.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";

const FAKE_VITALS = {
  workspaceId: WORKSPACE_ID,
  factsLive: 100,
  factsClosed: 20,
  pinnedCount: 5,
  lastRecallAt: "2025-06-01T10:00:00.000Z",
  lastWriteAt: "2025-06-01T11:00:00.000Z",
  embeddings: { indexed: 95, pending: 5 },
};

function makeApp(
  vitalOverrides: Partial<typeof FAKE_VITALS> = {},
  healthSnapshot: HealthSnapshot | null = null,
  auth: { scopes?: string[]; maxSensitivity?: string } = {}
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", (auth.scopes ?? []) as ReadonlyArray<string>);
    if (auth.maxSensitivity) c.set("maxSensitivity" as never, auth.maxSensitivity as never);
    await next();
  });

  // flatten-legacy-dual-core PR12: GET /admin/stats ported off the legacy
  // core's vitals() onto deps.storage.getWorkspaceVitals (v3 StorageAdapter,
  // added in PR6) — same aggregate query, positional workspaceId arg.
  // Phase 9 (task 9.1): the drift snapshot fields are now sourced from
  // deps.storage.getHealthSnapshot (v3 StorageAdapter, added this phase).
  const getHealthSnapshotMock = vi.fn().mockResolvedValue(healthSnapshot);
  const fakeDeps = {
    storage: {
      getWorkspaceVitals: vi.fn().mockResolvedValue({ ...FAKE_VITALS, ...vitalOverrides }),
      getHealthSnapshot: getHealthSnapshotMock,
      countOpenConflicts: vi.fn().mockResolvedValue(2),
    } as unknown as ServerDeps["storage"],
  } as unknown as ServerDeps;

  mountAdminStats(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return { app, fakeDeps, getHealthSnapshotMock };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /admin/stats", () => {
  it("returns 200 with composed vitals shape", async () => {
    const { app } = makeApp();
    const res = await app.request("/admin/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBe(WORKSPACE_ID);
    expect(typeof body.generatedAt).toBe("string");
    expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
    // Vitals fields
    expect(body.facts.live).toBe(100);
    expect(body.facts.closed).toBe(20);
    expect(body.facts.pinned).toBe(5);
    expect(body.embeddings.indexed).toBe(95);
    expect(body.embeddings.pending).toBe(5);
    expect(body.recall.lastRecallAt).toBe("2025-06-01T10:00:00.000Z");
    expect(body.lastWriteAt).toBe("2025-06-01T11:00:00.000Z");
  });

  it("reports null (not 0) for snapshot-derived fields when no health snapshot exists (make-primitives-recallable Requirement 5)", async () => {
    const { app } = makeApp();
    const res = await app.request("/admin/stats");
    const body = await res.json();
    // No snapshot → null, distinguishable from a genuine zero
    expect(body.facts.archived).toBeNull();
    expect(body.facts.withZeroHits).toBeNull();
    expect(body.decisions.active).toBeNull();
    // Not snapshot-derived: the live count under the caller's ceiling.
    expect(body.relations.conflicts).toBe(2);
    expect(body.recall.hitRate30d).toBeNull();
    expect(body.snapshot).toEqual({ at: null, ageSeconds: null, available: false });
  });

  it("composites vitals + drift snapshot when snapshot available", async () => {
    const snapshotAt = new Date("2025-06-01T12:00:00.000Z");
    const mockSnapshot: HealthSnapshot = {
      workspaceId: WORKSPACE_ID,
      snapshotAt,
      factCountActive: 100,
      factCountArchived: 30,
      factCountEmbedded: 95,
      factCountUnembedded: 5,
      decisionCountActive: 8,
      relationCountConflicts: 3,
      factsWithZeroHits: 7,
      recallHitRate30d: 0.85,
      extractionJobsFailed7d: 0,
      extractionJobsDeferred: 2,
      computedInMs: 15,
    };

    const { app } = makeApp({}, mockSnapshot);
    const res = await app.request("/admin/stats");
    expect(res.status).toBe(200);
    const body = await res.json();

    // Vitals fields (primary source)
    expect(body.facts.live).toBe(100);
    expect(body.facts.pinned).toBe(5);
    // Snapshot-enriched fields
    expect(body.facts.archived).toBe(30);
    expect(body.facts.withZeroHits).toBe(7);
    expect(body.decisions.active).toBe(8);
    // The live, ceiling-aware count wins over the snapshot's (3, every tier).
    expect(body.relations.conflicts).toBe(2);
    expect(body.recall.hitRate30d).toBeCloseTo(0.85);
    expect(body.snapshot.available).toBe(true);
    expect(body.snapshot.at).toBe(snapshotAt.toISOString());
    expect(typeof body.snapshot.ageSeconds).toBe("number");
  });

  it("handles null lastRecallAt and lastWriteAt from vitals gracefully", async () => {
    const { app } = makeApp({ lastRecallAt: undefined, lastWriteAt: undefined });
    const res = await app.request("/admin/stats");
    const body = await res.json();
    expect(body.recall.lastRecallAt).toBeNull();
    expect(body.lastWriteAt).toBeNull();
  });

  it("forwards fresh:false to getHealthSnapshot", async () => {
    const { app, getHealthSnapshotMock } = makeApp();
    await app.request("/admin/stats");
    expect(getHealthSnapshotMock).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, fresh: false });
  });
});

// APP-015 (audit 2026-11-22): nothing measured the context Mnemosyne serves,
// and the only "tokens saved" figures were constants. /admin/stats now reports
// what recall actually served (from the recall observations) next to what
// injecting every live fact would cost: the comparison a reader can check.
describe("GET /admin/stats — context economy", () => {
  it("reports served context and the live-memory size when the storage can read them", async () => {
    const { app, fakeDeps } = makeApp();
    (fakeDeps.storage as unknown as Record<string, unknown>).getContextEconomy = vi
      .fn()
      .mockResolvedValue({
        recalls: 40,
        servedCharsAvg: 820,
        servedCharsP95: 1900,
        liveFacts: 500,
        liveFactChars: 61_000,
      });
    const body = (await (await app.request("/admin/stats")).json()) as {
      context: Record<string, unknown>;
    };
    expect(body.context).toMatchObject({
      recalls7d: 40,
      servedCharsAvg7d: 820,
      servedCharsP95_7d: 1900,
      liveFacts: 500,
      liveFactChars: 61_000,
    });
    expect(String(body.context.methodology)).toMatch(/every live fact/i);
  });

  it("is admin-only, like the other operator figures", async () => {
    const { app, fakeDeps } = makeApp({}, null, { scopes: ["memory:read"] });
    const economy = vi.fn().mockResolvedValue({
      recalls: 1,
      servedCharsAvg: 1,
      servedCharsP95: 1,
      liveFacts: 1,
      liveFactChars: 1,
    });
    (fakeDeps.storage as unknown as Record<string, unknown>).getContextEconomy = economy;
    const body = (await (await app.request("/admin/stats")).json()) as Record<string, unknown>;
    expect(body.context).toBeUndefined();
    expect(economy).not.toHaveBeenCalled();
  });

  it("sizes live facts under the caller's ceiling", async () => {
    const { app, fakeDeps } = makeApp({}, null, { maxSensitivity: "public" });
    const economy = vi.fn().mockResolvedValue(null);
    (fakeDeps.storage as unknown as Record<string, unknown>).getContextEconomy = economy;
    await app.request("/admin/stats");
    expect(economy).toHaveBeenCalledWith(WORKSPACE_ID, 7, "public");
  });

  it("reports null, not zero, when the read is unavailable", async () => {
    const { app } = makeApp();
    const body = (await (await app.request("/admin/stats")).json()) as {
      context: Record<string, unknown>;
    };
    expect(body.context).toMatchObject({
      recalls7d: null,
      servedCharsAvg7d: null,
      liveFactChars: null,
    });
  });
});
