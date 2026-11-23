/**
 * W5: Consolidation correctness at scale (B6.35).
 *
 * Proves scheduler correctness across multi-workspace, multi-cluster scenarios
 * using the real InMemoryStorageAdapter atomic consolidation operations and the
 * new terminal-result counter mapping.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { MnemoFact } from "@mnemo-ai/types";
import { runConsolidationTick } from "../scheduler.js";
import type { SchedulerContext, SchedulerStorage } from "../scheduler.js";
import type { ReplayValidatorContext } from "../ReplayValidator.js";
import {
  makeInMemoryStorage,
  seedCluster,
  validatorBoost,
  validatorFlag,
  TEST_SYSTEM_ACTOR,
} from "./helpers.js";

afterEach(() => vi.clearAllMocks());

/** A validator that hits whatever survivor is being replayed (id-agnostic boost). */
function validatorBoostAny(): ReplayValidatorContext {
  return {
    llm: {
      generate: vi
        .fn()
        .mockResolvedValue({
          content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
          tokensUsed: { input: 0, output: 0 },
        }),
    },
    // Return a hit whose id matches the query's implied survivor is hard; instead
    // return the whole active fact set so the survivor is always present.
    recall: { search: vi.fn(async () => [{ id: "__any__", score: 0.9 }]) },
    storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
  };
}

// ─── T1: Multi-workspace sweep ────────────────────────────────────────────────

describe("W5: multi-workspace correctness", () => {
  it("T1: sweeps 5 workspaces, retains 1 cluster each → 5 merges", async () => {
    const wsIds = ["ws-1", "ws-2", "ws-3", "ws-4", "ws-5"];
    const storage = makeInMemoryStorage();
    const survivors: Record<string, string> = {};
    for (const ws of wsIds) {
      const facts = await seedCluster(storage.adapter, ws, 9);
      survivors[ws] = facts[0]!.id;
    }
    // Validator whose recall returns every survivor id (all boosted).
    const validator: ReplayValidatorContext = {
      llm: {
        generate: vi
          .fn()
          .mockResolvedValue({
            content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
            tokensUsed: { input: 0, output: 0 },
          }),
      },
      recall: {
        search: vi.fn(async () => Object.values(survivors).map((id) => ({ id, score: 0.9 }))),
      },
      storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
    };
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => wsIds,
      replayValidator: validator,
    };

    const result = await runConsolidationTick(ctx);

    expect(result.workspaceCount).toBe(5);
    expect(result.mergedPairs).toBe(5);
    expect(result.skippedPairs).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.candidateCount).toBe(45);
  });
});

// ─── T2: CANDIDATE_LIMIT cap ─────────────────────────────────────────────────

describe("W5: CANDIDATE_LIMIT=20 enforced", () => {
  it("T2: queryFacts is called with limit=20", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 9);
    const queryFactsSpy = vi.fn(storage.queryFacts);
    storage.queryFacts = queryFactsSpy;
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validatorBoost(facts[0]!.id),
    };

    await runConsolidationTick(ctx);

    expect(queryFactsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, workspaceId: "ws-1" })
    );
  });
});

// ─── T3: survivor retained, absorbed merged ──────────────────────────────────

describe("W5: retained merge marks absorbed merged", () => {
  it("T3: absorbed facts are merged (not the survivor)", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 5);
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validatorBoost(facts[0]!.id),
    };

    const result = await runConsolidationTick(ctx, "ws-1");

    expect(result.mergedPairs).toBe(1);
    expect((await storage.adapter.getFact(facts[0]!.id, "ws-1"))?.status).toBe("active");
    for (const f of facts.slice(1)) {
      expect((await storage.adapter.getFact(f.id, "ws-1"))?.status).toBe("merged");
    }
  });
});

// ─── T4: Canonical exemption ─────────────────────────────────────────────────

describe("W5: canonical exemption blocks merge", () => {
  it("T4: any canonical member blocks the cluster", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 9);
    // Mark some canonical.
    for (const idx of [0, 4, 7]) {
      const stored = await storage.adapter.getFact(facts[idx]!.id, "ws-1");
      (stored as MnemoFact).canonical = true;
    }
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validatorBoost(facts[0]!.id),
    };

    const result = await runConsolidationTick(ctx, "ws-1");

    expect(result.mergedPairs).toBe(0);
    expect(result.skippedPairs).toBeGreaterThanOrEqual(1);
    for (const f of facts) {
      expect((await storage.adapter.getFact(f.id, "ws-1"))?.status).toBe("active");
    }
  });

  it("T4b: non-canonical cluster merges (control)", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 5);
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validatorBoost(facts[0]!.id),
    };
    const result = await runConsolidationTick(ctx, "ws-1");
    expect(result.mergedPairs).toBe(1);
  });
});

// ─── T5: Admin lock ──────────────────────────────────────────────────────────

describe("W5: admin lock", () => {
  it("T5: locked workspace is skipped; queryFacts never called for it", async () => {
    const storage = makeInMemoryStorage();
    const openFacts = await seedCluster(storage.adapter, "ws-open", 9);
    await seedCluster(storage.adapter, "ws-locked", 9);
    const isConsolidationLocked = vi.fn(async (wsId: string) => wsId === "ws-locked");
    const queryFactsSpy = vi.fn(storage.queryFacts);
    const storageWithLock: SchedulerStorage = {
      ...storage,
      isConsolidationLocked,
      queryFacts: queryFactsSpy,
    };
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: storageWithLock,
      listWorkspaceIds: async () => ["ws-locked", "ws-open"],
      replayValidator: validatorBoost(openFacts[0]!.id),
    };

    const result = await runConsolidationTick(ctx);

    expect(isConsolidationLocked).toHaveBeenCalledTimes(2);
    const queriedWs = queryFactsSpy.mock.calls.map(
      (c) => (c[0] as { workspaceId: string }).workspaceId
    );
    expect(queriedWs).toContain("ws-open");
    expect(queriedWs).not.toContain("ws-locked");
    expect(result.mergedPairs).toBe(1);
  });

  it("T5b: isConsolidationLocked DB error → fail-closed (skip, no merge)", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 9);
    const isConsolidationLocked = vi.fn(async () => {
      throw new Error("DB error");
    });
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: { ...storage, isConsolidationLocked },
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validatorBoost(facts[0]!.id),
    };

    const result = await runConsolidationTick(ctx, "ws-1");

    expect(result.mergedPairs).toBe(0);
    for (const f of facts) {
      expect((await storage.adapter.getFact(f.id, "ws-1"))?.status).toBe("active");
    }
  });
});

// ─── T6: Sensitivity ─────────────────────────────────────────────────────────

describe("W5: sensitivity exclusion + gate", () => {
  it("T6: confidential/restricted facts are excluded before clustering", async () => {
    const storage = makeInMemoryStorage();
    // 5 internal (cluster) + 3 confidential + 2 restricted (excluded).
    const internal = await seedCluster(storage.adapter, "ws-1", 5);
    await seedCluster(storage.adapter, "ws-1", 3, undefined, "confidential");
    await seedCluster(storage.adapter, "ws-1", 2, undefined, "restricted");
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validatorBoost(internal[0]!.id),
    };

    const result = await runConsolidationTick(ctx, "ws-1");

    // Only the 5 internal facts survive the sensitivity filter.
    expect(result.candidateCount).toBe(5);
    expect(result.mergedPairs).toBe(1);
  });
});

// ─── T7: Write error isolation ───────────────────────────────────────────────

describe("W5: apply failure isolation", () => {
  it("T7: apply throwing for ws-2 counts an error; ws-1 and ws-3 still merge", async () => {
    const storage = makeInMemoryStorage();
    const f1 = await seedCluster(storage.adapter, "ws-1", 5);
    await seedCluster(storage.adapter, "ws-2", 5);
    const f3 = await seedCluster(storage.adapter, "ws-3", 5);

    const realApply = storage.applyConsolidationMerge;
    storage.applyConsolidationMerge = vi.fn(async (i) => {
      if (i.workspaceId === "ws-2") throw new Error("apply failure");
      return realApply(i);
    });

    // Validator hits all survivors.
    const validator: ReplayValidatorContext = {
      llm: {
        generate: vi
          .fn()
          .mockResolvedValue({
            content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
            tokensUsed: { input: 0, output: 0 },
          }),
      },
      recall: {
        search: vi.fn(async () => [f1[0]!.id, f3[0]!.id].map((id) => ({ id, score: 0.9 }))),
      },
      storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
    };
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1", "ws-2", "ws-3"],
      replayValidator: validator,
    };

    const result = await runConsolidationTick(ctx);

    expect(result.mergedPairs).toBe(2);
    // ws-2 apply_failed → skipped+error.
    expect(result.errors).toBe(1);
    expect(result.skippedPairs).toBe(1);
  });
});

// ─── T8: Awaited replay ──────────────────────────────────────────────────────

describe("W5: replay is awaited", () => {
  it("T8: tick resolves only after replay recall completes", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 5);
    let replayDone = false;
    const validator: ReplayValidatorContext = {
      llm: {
        generate: vi
          .fn()
          .mockResolvedValue({
            content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
            tokensUsed: { input: 0, output: 0 },
          }),
      },
      recall: {
        search: vi.fn(async () => {
          replayDone = true;
          return [{ id: facts[0]!.id, score: 0.9 }];
        }),
      },
      storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
    };
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validator,
    };

    const result = await runConsolidationTick(ctx, "ws-1");

    expect(replayDone).toBe(true);
    expect(result.mergedPairs).toBe(1);
  });
});

// ─── T9: Flagged → restored ──────────────────────────────────────────────────

describe("W5: flagged replay restores the cluster", () => {
  it("T9: flagged replay restores absorbed facts and records a review", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 4);
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validatorFlag(),
    };

    const result = await runConsolidationTick(ctx, "ws-1");

    expect(result.mergedPairs).toBe(0);
    expect(result.skippedPairs).toBe(1);
    for (const f of facts) {
      expect((await storage.adapter.getFact(f.id, "ws-1"))?.status).toBe("active");
    }
    expect(storage.adapter.consolidationReviews).toHaveLength(1);
  });
});

// ─── T10: worth ceiling filter ───────────────────────────────────────────────

describe("W5: WORTH_CANDIDATE_CEILING client filter", () => {
  it("T10: facts with worth > 0.4 are excluded", async () => {
    const storage = makeInMemoryStorage();
    const low = await seedCluster(storage.adapter, "ws-1", 5);
    const high = await seedCluster(storage.adapter, "ws-1", 5);
    for (const f of high) {
      const stored = await storage.adapter.getFact(f.id, "ws-1");
      (stored as MnemoFact).worth = 0.6;
    }
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validatorBoost(low[0]!.id),
    };

    const result = await runConsolidationTick(ctx, "ws-1");

    expect(result.candidateCount).toBe(5);
    expect(result.mergedPairs).toBe(1);
  });
});
