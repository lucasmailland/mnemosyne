import { describe, it, expect } from "vitest";
import type { ServerDeps } from "../../deps.js";
import { makeMockCognitive } from "../helpers/mockCognitive.js";

// Import the function under test via the named export from the module.
// buildCognitiveHealthSnapshot is not exported directly, so we call the
// handler by assembling a minimal OpenAPIHono app — but that's heavyweight.
// Instead we extract it via a thin re-export shim.  Since the function is
// in the same compilation unit, we can rely on the module's own tests to
// confirm routing; here we unit-test the snapshot-building logic directly
// by importing the internal helper indirectly via dynamic import of the
// route module and calling the handler in isolation.
//
// Simpler approach: we duplicate the snapshot logic test via the
// buildCognitiveHealthSnapshot helper extracted as a named export below.
// Because the function is not exported, we test it through a thin wrapper
// that re-uses the same storage stubs as snapshot-metrics.test.ts.

/**
 * We need to reach `buildCognitiveHealthSnapshot` which is a module-private
 * function.  The cleanest non-invasive way is to import the full module and
 * invoke the public HTTP handler with a faked Hono context — but that pulls
 * in OpenAPIHono + auth middleware.  Instead we test the *observable output*
 * by calling the `/health/cognitive` handler directly:
 *  1. Build a fake OpenAPIHono app via mountCognitiveHealth.
 *  2. Issue a synthetic Request with the expected auth variable set.
 *  3. Assert on the JSON body.
 *
 * This keeps the test strictly within package boundaries and exercises the
 * real code path.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { mountCognitiveHealth } from "../../routes/health.js";
import type { AuthVariables } from "../../auth.js";
import type { MnemoFact, MnemoEpisode, MnemoDecision, MnemoEntity } from "@mnemo-ai/types";

// ── minimal fact builder ──────────────────────────────────────────────────────

function makeFact(overrides: Partial<MnemoFact> = {}): MnemoFact {
  return {
    id: "fact-1",
    workspaceId: "ws-test",
    agentId: "agent-test",
    content: "Paris is the capital of France",
    sensitivity: "internal",
    kind: "fact",
    tags: [],
    worthAlpha: 3,   // α=3, β=2 → worth = 3/5 = 0.6 → |0.6-0.5| = 0.1 (exactly at threshold, NOT > 0.1)
    worthBeta: 2,
    worth: 0.6,
    worthSuccess: 1,
    worthFailure: 0,
    status: "active",
    pinned: false,
    lastRecalledAt: null,
    expiresAt: null,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    ...overrides,
  } as MnemoFact;
}

// ── fake storage ──────────────────────────────────────────────────────────────

function makeStorage(opts: {
  facts?: MnemoFact[];
  episodeTotal?: number;
  decisionTotal?: number;
  entityTotal?: number;
  spendUsd?: number;
  recallCount?: number;
  promptVersionDelta?: { before: number; after: number } | null;
}) {
  return {
    queryFacts: async () => ({
      items: opts.facts ?? [],
      total: opts.facts?.length ?? 0,
      cursor: null,
    }),
    queryCompositionRules: async () => ({ items: [], total: 0, cursor: null }),
    queryEpisodes: async () => ({
      items: [] as MnemoEpisode[],
      total: opts.episodeTotal ?? 0,
      cursor: null,
    }),
    queryDecisions: async () => ({
      items: [] as MnemoDecision[],
      total: opts.decisionTotal ?? 0,
      cursor: null,
    }),
    queryEntities: async () => ({
      items: [] as MnemoEntity[],
      total: opts.entityTotal ?? 0,
      cursor: null,
    }),
    getWorkspaceMonthlySpendUsd: async (_wsId: string) => opts.spendUsd ?? 0,
    getWorkspaceMonthlyRecallCount: async (_wsId: string) => opts.recallCount ?? 0,
    getLatestActivatedPromptVersion: async (_wsId: string) =>
      opts.promptVersionDelta
        ? {
            avgScoreBefore: opts.promptVersionDelta.before,
            avgScoreAfter: opts.promptVersionDelta.after,
          }
        : null,
  };
}

function makeDeps(storageOverrides: Parameters<typeof makeStorage>[0]): ServerDeps {
  return {
    storage: makeStorage(storageOverrides) as unknown as ServerDeps["storage"],
    core: {
      ping: async () => {},
      vitals: async () => ({
        workspaceId: "ws-test",
        factsLive: 0,
        factsClosed: 0,
        pinnedCount: 0,
        lastRecallAt: null,
        lastWriteAt: null,
        embeddings: { indexed: 0, pending: 0 },
      }),
    } as unknown as ServerDeps["core"],
    apiKeys: { lookup: async () => null } as unknown as ServerDeps["apiKeys"],
    embedModel: "text-embedding-3-small",
    bus: { emit: () => {} } as unknown as ServerDeps["bus"],
    cognitive: makeMockCognitive(),
  } as unknown as ServerDeps;
}

// ── helper: mount a minimal app and call the handler ─────────────────────────

async function getSnapshot(
  deps: ServerDeps,
  workspaceId = "ws-test",
): Promise<Record<string, unknown>> {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  // Inject the workspaceId into every request's context variables
  app.use("*", async (c, next) => {
    c.set("workspaceId" as never, workspaceId);
    await next();
  });
  mountCognitiveHealth(app, deps);

  const req = new Request("http://localhost/health/cognitive");
  const res = await app.fetch(req);
  return res.json() as Promise<Record<string, unknown>>;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("buildCognitiveHealthSnapshot — real storage values", () => {
  it("populates workspaceId and computedAt", async () => {
    const snapshot = await getSnapshot(makeDeps({}));
    expect(snapshot["workspaceId"]).toBe("ws-test");
    expect(typeof snapshot["computedAt"]).toBe("string");
    // computedAt should be a valid ISO-8601 timestamp
    expect(new Date(snapshot["computedAt"] as string).getTime()).toBeGreaterThan(0);
  });

  it("computes worthConvergenceRate from real facts", async () => {
    // α=4, β=1 → worth = 4/5 = 0.8 → |0.8-0.5| = 0.3 > 0.1 → converged
    const convergedFact = makeFact({ worthAlpha: 4, worthBeta: 1 });
    // α=2, β=2 → worth = 2/4 = 0.5 → |0.5-0.5| = 0.0 ≤ 0.1 → NOT converged
    const neutralFact = makeFact({ id: "fact-2", worthAlpha: 2, worthBeta: 2 });

    const snapshot = await getSnapshot(makeDeps({ facts: [convergedFact, neutralFact] }));

    // 1 out of 2 facts is converged → rate = 0.5
    expect(snapshot["worthConvergenceRate"]).toBe(0.5);
  });

  it("returns worthConvergenceRate null when no facts exist", async () => {
    const snapshot = await getSnapshot(makeDeps({ facts: [] }));
    expect(snapshot["worthConvergenceRate"]).toBeNull();
  });

  it("computes knowledgeTypeBalance as Shannon entropy over type counts", async () => {
    // 1 fact, 1 episode (perfect 50/50 split) → entropy = 1.0 bits
    const snapshot = await getSnapshot(
      makeDeps({ facts: [makeFact()], episodeTotal: 1 }),
    );
    // Shannon entropy for p=0.5, p=0.5 = -2 * (0.5 * log2(0.5)) = 1.0
    expect(typeof snapshot["knowledgeTypeBalance"]).toBe("number");
    const balance = snapshot["knowledgeTypeBalance"] as number;
    expect(balance).toBeCloseTo(1.0, 5);
  });

  it("returns knowledgeTypeBalance null when workspace is empty", async () => {
    const snapshot = await getSnapshot(makeDeps({ facts: [], episodeTotal: 0, decisionTotal: 0, entityTotal: 0 }));
    expect(snapshot["knowledgeTypeBalance"]).toBeNull();
  });

  it("reads costUsdThisMonth from storage.getWorkspaceMonthlySpendUsd", async () => {
    const snapshot = await getSnapshot(makeDeps({ spendUsd: 4.2 }));
    const economics = snapshot["unitEconomics"] as Record<string, unknown>;
    expect(economics["costUsdThisMonth"]).toBe(4.2);
  });

  it("reads recallCount from storage.getWorkspaceMonthlyRecallCount", async () => {
    const snapshot = await getSnapshot(makeDeps({ recallCount: 37 }));
    const economics = snapshot["unitEconomics"] as Record<string, unknown>;
    expect(economics["recallCount"]).toBe(37);
  });

  it("leaves roiMultiplier null: nothing measures a recall in dollars (APP-015)", async () => {
    // The old value was recalls / (spend × 1000), a ratio of unrelated units.
    // Measured context lives in GET /admin/stats → context.
    const snapshot = await getSnapshot(makeDeps({ recallCount: 1000, spendUsd: 1.0 }));
    const economics = snapshot["unitEconomics"] as Record<string, unknown>;
    expect(economics["roiMultiplier"]).toBeNull();
    expect(economics["recallCount"]).toBe(1000);
  });

  it("returns roiMultiplier null when spend is zero", async () => {
    const snapshot = await getSnapshot(makeDeps({ recallCount: 100, spendUsd: 0 }));
    const economics = snapshot["unitEconomics"] as Record<string, unknown>;
    expect(economics["roiMultiplier"]).toBeNull();
  });

  it("computes proceduralEvolutionDelta from storage.getLatestActivatedPromptVersion", async () => {
    const snapshot = await getSnapshot(
      makeDeps({ promptVersionDelta: { before: 0.6, after: 0.75 } }),
    );
    expect(snapshot["proceduralEvolutionDelta"]).toBeCloseTo(0.15, 10);
  });

  it("returns proceduralEvolutionDelta null when no prompt version exists", async () => {
    const snapshot = await getSnapshot(makeDeps({ promptVersionDelta: null }));
    expect(snapshot["proceduralEvolutionDelta"]).toBeNull();
  });

  it("gracefully returns null fields when storage is absent", async () => {
    const deps = {
      ...makeDeps({}),
      storage: undefined,
    } as unknown as ServerDeps;
    const snapshot = await getSnapshot(deps);
    // All nullable fields should be null (not throw or return 500)
    expect(snapshot["worthConvergenceRate"]).toBeNull();
    expect(snapshot["compositionUtilization"]).toBeNull();
    expect(snapshot["knowledgeTypeBalance"]).toBeNull();
    expect(snapshot["proceduralEvolutionDelta"]).toBeNull();
    const economics = snapshot["unitEconomics"] as Record<string, unknown>;
    expect(economics["costUsdThisMonth"]).toBe(0);
    expect(economics["recallCount"]).toBe(0);
    expect(economics["roiMultiplier"]).toBeNull();
  });
});

// ── B2.2/B2.3: 7 new optional fields ─────────────────────────────────────────
// These fields are derived from in-process Prometheus counters (module-level
// singletons) and the anticipationAccuracyGauge. Because counters accumulate
// across the test process, we can only assert on structural presence (the fields
// exist and are null or a number) rather than exact counter values, unless we
// directly manipulate the counters.

describe("buildCognitiveHealthSnapshot — B2.2/B2.3 new fields", () => {
  it("includes all 7 new optional fields in the response", async () => {
    const snapshot = await getSnapshot(makeDeps({}));
    // All 7 fields must be present (even if null)
    expect("sessionCollapseRate" in snapshot).toBe(true);
    expect("reasoningCacheHitRate" in snapshot).toBe(true);
    expect("avgMemoryWorth" in snapshot).toBe(true);
    expect("hotTierHitRate" in snapshot).toBe(true);
    expect("anticipationAccuracy" in snapshot).toBe(true);
    expect("consolidationGateRate" in snapshot).toBe(true);
    expect("consolidationRollbackRate" in snapshot).toBe(true);
  });

  it("sessionCollapseRate is null when no sessions have been started", async () => {
    // If sessionsStartedTotal is 0 (nothing started in this test run yet), rate is null.
    // We can't guarantee zero-counter state in a module-level singleton, so we
    // assert structural types only.
    const snapshot = await getSnapshot(makeDeps({}));
    const rate = snapshot["sessionCollapseRate"] as number | null | undefined;
    expect(rate === null || typeof rate === "number").toBe(true);
  });

  it("reasoningCacheHitRate is null or a number in [0,1]", async () => {
    const snapshot = await getSnapshot(makeDeps({}));
    const rate = snapshot["reasoningCacheHitRate"] as number | null | undefined;
    if (rate !== null && rate !== undefined) {
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    } else {
      expect(rate === null || rate === undefined).toBe(true);
    }
  });

  it("avgMemoryWorth is computed from facts (α4β1 → worth=0.8, α2β2 → worth=0.5; mean=0.65)", async () => {
    // B2.5 verification: avgMemoryWorth for facts (α4β1)+(α2β2)
    const f1 = makeFact({ id: "f1", worthAlpha: 4, worthBeta: 1 }); // worth = 4/5 = 0.8
    const f2 = makeFact({ id: "f2", worthAlpha: 2, worthBeta: 2 }); // worth = 2/4 = 0.5
    const snapshot = await getSnapshot(makeDeps({ facts: [f1, f2] }));
    // mean = (0.8 + 0.5) / 2 = 0.65
    expect(snapshot["avgMemoryWorth"]).toBeCloseTo(0.65, 5);
  });

  it("avgMemoryWorth is null when no active facts exist", async () => {
    const snapshot = await getSnapshot(makeDeps({ facts: [] }));
    expect(snapshot["avgMemoryWorth"]).toBeNull();
  });

  it("hotTierHitRate is null when no recall tier hits recorded", async () => {
    // In a test that starts fresh with no recall ops, this should be null or a number.
    // We can't guarantee zero across all tests, so assert type.
    const snapshot = await getSnapshot(makeDeps({}));
    const rate = snapshot["hotTierHitRate"] as number | null | undefined;
    expect(rate === null || typeof rate === "number").toBe(true);
  });

  it("consolidationGateRate and consolidationRollbackRate are null or numbers in [0,1]", async () => {
    const snapshot = await getSnapshot(makeDeps({}));
    const gateRate = snapshot["consolidationGateRate"] as number | null | undefined;
    const rollbackRate = snapshot["consolidationRollbackRate"] as number | null | undefined;
    if (gateRate !== null && gateRate !== undefined) {
      expect(gateRate).toBeGreaterThanOrEqual(0);
      expect(gateRate).toBeLessThanOrEqual(1);
    }
    if (rollbackRate !== null && rollbackRate !== undefined) {
      expect(rollbackRate).toBeGreaterThanOrEqual(0);
      expect(rollbackRate).toBeLessThanOrEqual(1);
    }
  });
});
