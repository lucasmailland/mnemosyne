/**
 * Unit tests for /governance/* routes (API-1, API-2, API-3).
 *
 * Mirrors the pattern from metacognition-route.test.ts:
 *   - Build a minimal OpenAPIHono app with a fake auth middleware
 *   - Mount the governance sub-router with fake deps
 *   - Drive via app.request() — no real HTTP socket, no DB
 *   - Fake storage.getHealthSnapshot() (flatten-legacy-dual-core Phase 9,
 *     task 9.1 — was `vi.mock(@mnemo-ai/core)`'s `getHealthSnapshot`, ported
 *     to the v3 StorageAdapter port so the route no longer imports
 *     `@mnemo-ai/core` at all; every `expect(...)` below is unchanged from
 *     the pre-port version, only the mocking mechanism moved from a module
 *     mock to a deps fake)
 *
 * flatten-legacy-dual-core PR11: POST /governance/gate ported off
 * `deps.core.{getFact,pinFact}` to `deps.storage.{getFact,updateFact}` —
 * `deps.core` is no longer referenced anywhere in governance.ts. `pinFact`'s
 * call-shape assertions are updated (positional args, ports.ts:113); status
 * codes and response bodies are unchanged.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter, HealthSnapshot } from "@mnemo-ai/types";
import { mountGovernance } from "../../routes/governance.js";
import { toErrorBody } from "../../errors.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

// Minimal MnemoFact shape for queryFacts stub
// GOV_CANONICAL_WORTH=0.8, GOV_CANONICAL_CONF=0.7 → need alpha/beta producing
// worth > 0.8 AND wilsonLowerBound > 0.7. alpha=20, beta=2 → worth≈0.909.
function makeFact(overrides: Record<string, unknown> = {}) {
  return {
    id: "fact_01",
    workspaceId: WORKSPACE_ID,
    agentId: null,
    actorId: null,
    scope: "global" as const,
    scopeRef: null,
    kind: "preference" as const,
    subject: "test subject",
    statement: "test statement",
    confidence: 0.8,
    relevance: 0.7,
    hitCount: 10,
    lastRecalledAt: null,
    worthSuccess: 20,
    worthFailure: 2,
    worthAlpha: 20, // worth = 20/22 ≈ 0.909 > 0.8, confLower > 0.7 at n=22
    worthBeta: 2,
    worth: 20 / 22,
    memoryType: "semantic" as const,
    memoryStrength: 0.8,
    memoryStability: 0.9,
    attribution: "user_stated" as const,
    attributedTo: "user" as const,
    sourceMessageIds: [],
    revisionCount: 1,
    protocolVersion: "v3",
    status: "active" as const,
    sensitivity: "internal",
    mergedIntoId: null,
    pinned: false,
    validFrom: "2025-01-01T00:00:00.000Z",
    validTo: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeApp(
  storageOverrides: Partial<StorageAdapter> | undefined | null,
  gateOverrides: Partial<Pick<StorageAdapter, "getFact" | "updateFact">> = {}
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "tester");
    c.set("actorType", "user");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage:
      storageOverrides == null
        ? undefined
        : ({
            appendAuditEntry: vi.fn(async () => undefined),
            getFact: vi.fn().mockResolvedValue(null),
            updateFact: vi.fn().mockResolvedValue(null),
            getHealthSnapshot: vi.fn().mockResolvedValue(null),
            ...storageOverrides,
            ...gateOverrides,
          } as unknown as StorageAdapter),
  } as unknown as ServerDeps;

  mountGovernance(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return { app, fakeDeps };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /governance/worth", () => {
  it("returns 200 with empty items when no storage", async () => {
    // Pass undefined storage explicitly so the route sees !deps.storage
    const { app } = makeApp(undefined as unknown as Partial<StorageAdapter>);
    const res = await app.request("/governance/worth");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBe(WORKSPACE_ID);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });

  it("returns 200 with classified items — high-worth fact gets canonical action", async () => {
    const fact = makeFact({ worthAlpha: 20, worthBeta: 2, worth: 20 / 22 });
    const { app } = makeApp({
      queryFacts: vi.fn().mockResolvedValue({
        items: [fact],
        total: 1,
        nextCursor: null,
      }),
    });

    const res = await app.request("/governance/worth");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("fact_01");
    expect(body.items[0].action).toBe("canonical");
    expect(body.items[0].worth).toBeCloseTo(20 / 22, 2); // alpha=20, beta=2 → ≈0.909
    expect(typeof body.items[0].confidenceLower).toBe("number");
    expect(body.total).toBe(1);
    expect(body.hasMore).toBe(false);
  });

  it("filters by ?action=neutral — only neutral items returned", async () => {
    // canonical: worth≈0.909 (above thresholds)
    const canonicalFact = makeFact({ worthAlpha: 20, worthBeta: 2, worth: 20 / 22 });
    // neutral: Beta(2,2) prior, no evidence either way (lower≈0.15, upper≈0.85)
    const neutralFact = makeFact({
      id: "fact_02",
      worthAlpha: 2,
      worthBeta: 2,
      worth: 0.5,
    });
    const { app } = makeApp({
      queryFacts: vi.fn().mockResolvedValue({
        items: [canonicalFact, neutralFact],
        total: 2,
        nextCursor: null,
      }),
    });

    const res = await app.request("/governance/worth?action=neutral");
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const item of body.items) {
      expect(item.action).toBe("neutral");
    }
  });

  it("includes computedAt as ISO datetime", async () => {
    const { app } = makeApp({
      queryFacts: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }),
    });
    const res = await app.request("/governance/worth");
    const body = await res.json();
    expect(() => new Date(body.computedAt)).not.toThrow();
    expect(new Date(body.computedAt).toISOString()).toBe(body.computedAt);
  });
});

describe("POST /governance/gate", () => {
  it("pins fact when gate=canonical and fact exists", async () => {
    const fact = makeFact();
    const { app, fakeDeps } = makeApp(
      {},
      {
        getFact: vi.fn().mockResolvedValue(fact),
        updateFact: vi.fn().mockResolvedValue({ ...fact, pinned: true }),
      }
    );

    const res = await app.request("/governance/gate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factId: "fact_01", gate: "canonical" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.factId).toBe("fact_01");
    expect(body.gate).toBe("canonical");
    expect(body.pinned).toBe(true);
    // v3 `updateFact(id, workspaceId, {pinned})` call shape (ports.ts:113) —
    // legacy `pinFact({workspaceId, id, pinned})` took one options object.
    expect((fakeDeps.storage as StorageAdapter).updateFact).toHaveBeenCalledWith(
      "fact_01",
      WORKSPACE_ID,
      { pinned: true }
    );
  });

  it("releases fact when gate=release", async () => {
    const fact = makeFact({ pinned: true });
    const { app, fakeDeps } = makeApp(
      {},
      {
        getFact: vi.fn().mockResolvedValue(fact),
        updateFact: vi.fn().mockResolvedValue({ ...fact, pinned: false }),
      }
    );

    const res = await app.request("/governance/gate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factId: "fact_01", gate: "release" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pinned).toBe(false);
    expect((fakeDeps.storage as StorageAdapter).updateFact).toHaveBeenCalledWith(
      "fact_01",
      WORKSPACE_ID,
      { pinned: false }
    );
  });

  it("returns 404 when fact not found", async () => {
    const { app } = makeApp({}, { getFact: vi.fn().mockResolvedValue(null) });

    const res = await app.request("/governance/gate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factId: "no-such-fact", gate: "canonical" }),
    });
    expect(res.status).toBe(404);
  });

  it("p45 Slice C: emits an update audit entry carrying resolveProvenance()'s actor", async () => {
    const fact = makeFact();
    const { app, fakeDeps } = makeApp(
      {},
      {
        getFact: vi.fn().mockResolvedValue(fact),
        updateFact: vi.fn().mockResolvedValue({ ...fact, pinned: true }),
      }
    );

    const res = await app.request("/governance/gate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factId: "fact_01", gate: "canonical" }),
    });

    expect(res.status).toBe(200);
    const storage = fakeDeps.storage as unknown as { appendAuditEntry: ReturnType<typeof vi.fn> };
    expect(storage.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        actorId: "key:tester",
        actorType: "user",
        action: "update",
        resourceKind: "governance_gate",
        resourceId: "canonical",
      })
    );
  });
});

describe("GET /governance/drift", () => {
  it("returns 200 with null when no snapshot exists", async () => {
    const { app } = makeApp({});
    const res = await app.request("/governance/drift");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });

  it("returns 200 with ISO snapshotAt when snapshot exists", async () => {
    const snapshotAt = new Date("2025-06-01T12:00:00.000Z");
    const mockSnapshot: HealthSnapshot = {
      workspaceId: WORKSPACE_ID,
      snapshotAt,
      factCountActive: 42,
      factCountArchived: 10,
      factCountEmbedded: 38,
      factCountUnembedded: 4,
      decisionCountActive: 5,
      relationCountConflicts: 2,
      factsWithZeroHits: 3,
      recallHitRate30d: 0.75,
      extractionJobsFailed7d: 1,
      extractionJobsDeferred: 0,
      computedInMs: 12,
    };

    const { app } = makeApp({ getHealthSnapshot: vi.fn().mockResolvedValue(mockSnapshot) });
    const res = await app.request("/governance/drift");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBe(WORKSPACE_ID);
    expect(body.snapshotAt).toBe("2025-06-01T12:00:00.000Z");
    expect(body.factCountActive).toBe(42);
    expect(body.recallHitRate30d).toBeCloseTo(0.75);
    expect(body.extractionJobsFailed7d).toBe(1);
  });

  it("passes fresh=true to getHealthSnapshot", async () => {
    const getHealthSnapshot = vi.fn().mockResolvedValue(null);
    const { app } = makeApp({ getHealthSnapshot });
    await app.request("/governance/drift?fresh=true");
    expect(getHealthSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, fresh: true })
    );
  });
});
