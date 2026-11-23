import { describe, it, expect, vi } from "vitest";
import type { MnemoFact } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { runConsolidationTick } from "../scheduler.js";
import type { SchedulerContext, SchedulerStorage } from "../scheduler.js";
import type { ReplayValidatorContext } from "../ReplayValidator.js";
import { TEST_SYSTEM_ACTOR } from "./helpers.js";

// ─── Storage backed by InMemoryStorageAdapter (real atomic ops) ───────────────

function makeStorage(): SchedulerStorage & { adapter: InMemoryStorageAdapter } {
  const adapter = new InMemoryStorageAdapter();
  return {
    adapter,
    queryFacts: (f) => adapter.queryFacts(f) as Promise<{ items: MnemoFact[] }>,
    applyConsolidationMerge: (i) => adapter.applyConsolidationMerge(i),
    rollbackConsolidationMerge: (i) => adapter.rollbackConsolidationMerge(i),
    finalizeConsolidationMerge: (i) => adapter.finalizeConsolidationMerge(i),
    refreshConsolidationMergeLease: (i) => adapter.refreshConsolidationMergeLease(i),
    inspectConsolidationMergeState: (s) => adapter.inspectConsolidationMergeState(s),
    recoverExpiredConsolidationMerges: (i) => adapter.recoverExpiredConsolidationMerges(i),
    getRelations: (f) => adapter.getRelations(f),
  };
}

async function seedCluster(
  adapter: InMemoryStorageAdapter,
  wsId: string,
  n: number
): Promise<MnemoFact[]> {
  const emb = new Float32Array([1, 0, 0]);
  const facts: MnemoFact[] = [];
  for (let i = 0; i < n; i++) {
    const f = await adapter.createFact({
      workspaceId: wsId,
      statement: `cluster fact ${i}`,
      subject: "test",
      kind: "other",
      confidence: 0.5,
      sensitivity: "internal",
      embedding: emb,
    } as never);
    // Force low worth + high hitCount ordering for a stable survivor.
    facts.push(f);
  }
  // Mutate stored facts directly to satisfy the gate (low worth, hitCount desc, embedding).
  for (let i = 0; i < facts.length; i++) {
    const stored = await adapter.getFact(facts[i]!.id, wsId);
    Object.assign(stored as MnemoFact, {
      worth: 0.2,
      worthAlpha: 2,
      worthBeta: 5,
      hitCount: n - i,
      embedding: emb,
      lastRecalledAt: null,
    });
  }
  return facts;
}

function validatorHitAll(): ReplayValidatorContext {
  return {
    llm: {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
        tokensUsed: { input: 0, output: 0 },
      }),
    },
    // Recall always hits every fact id → boosted
    recall: { search: vi.fn(async () => [{ id: "any", score: 0.9 }]) },
    storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
  };
}

describe("consolidation scheduler — replay validator (B6.35)", () => {
  it("reports validator_unavailable and merges nothing when no validator is present", async () => {
    const storage = makeStorage();
    await seedCluster(storage.adapter, "ws-test", 5);
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-test"]),
      // No replayValidator
    };
    const result = await runConsolidationTick(ctx);
    expect(result.availability).toBe("validator_unavailable");
    expect(result.mergedPairs).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("does not call the validator when there are no candidates", async () => {
    const storage = makeStorage();
    const gen = vi.fn();
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-test"]),
      replayValidator: {
        llm: { generate: gen },
        recall: { search: vi.fn().mockResolvedValue([]) },
        storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
      },
    };
    const result = await runConsolidationTick(ctx);
    expect(result.mergedPairs).toBe(0);
    expect(gen).not.toHaveBeenCalled();
  });

  it("retains a merge and finalizes when replay boosts (survivor recalled)", async () => {
    const storage = makeStorage();
    const facts = await seedCluster(storage.adapter, "ws-test", 5);
    const survivorId = facts[0]!.id;
    const validator: ReplayValidatorContext = {
      llm: {
        generate: vi.fn().mockResolvedValue({
          content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
          tokensUsed: { input: 0, output: 0 },
        }),
      },
      recall: { search: vi.fn(async () => [{ id: survivorId, score: 0.9 }]) },
      storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
    };
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-test"]),
      replayValidator: validator,
    };
    const result = await runConsolidationTick(ctx, "ws-test");
    expect(result.availability).toBe("ready");
    expect(result.mergedPairs).toBe(1);
    expect(result.errors).toBe(0);
    // Absorbed facts are merged/closed; no pending marker remains.
    for (const f of facts.slice(1)) {
      const stored = await storage.adapter.getFact(f.id, "ws-test");
      expect(stored?.status).toBe("merged");
    }
  });

  it("rolls back (restores) when replay flags the merge (survivor never recalled)", async () => {
    const storage = makeStorage();
    const facts = await seedCluster(storage.adapter, "ws-test", 4);
    const validator: ReplayValidatorContext = {
      llm: {
        generate: vi.fn().mockResolvedValue({
          content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
          tokensUsed: { input: 0, output: 0 },
        }),
      },
      recall: { search: vi.fn(async () => []) }, // all miss → flagged
      storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
    };
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-test"]),
      replayValidator: validator,
    };
    const result = await runConsolidationTick(ctx, "ws-test");
    expect(result.mergedPairs).toBe(0);
    expect(result.skippedPairs).toBe(1); // restored
    expect(result.errors).toBe(0);
    // All facts restored to active.
    for (const f of facts) {
      const stored = await storage.adapter.getFact(f.id, "ws-test");
      expect(stored?.status).toBe("active");
    }
    // One review row recorded.
    expect(storage.adapter.consolidationReviews).toHaveLength(1);
    expect(storage.adapter.consolidationReviews[0]!.review.reason).toBe("replay_validation_failed");
  });

  it("awaits replay — tick resolves only after finalize (no fire-and-forget)", async () => {
    const storage = makeStorage();
    await seedCluster(storage.adapter, "ws-test", 5);
    let recallDone = false;
    const validator: ReplayValidatorContext = {
      llm: {
        generate: vi.fn().mockResolvedValue({
          content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
          tokensUsed: { input: 0, output: 0 },
        }),
      },
      recall: {
        search: vi.fn(async () => {
          recallDone = true;
          return [{ id: "x", score: 0.9 }];
        }),
      },
      storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
    };
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue(["ws-test"]),
      replayValidator: validator,
    };
    await runConsolidationTick(ctx, "ws-test");
    expect(recallDone).toBe(true); // replay completed before tick returned
  });

  it("uses the global validatorHitAll helper without throwing on single-workspace shortcut", async () => {
    const storage = makeStorage();
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: vi.fn().mockResolvedValue([]),
      replayValidator: validatorHitAll(),
    };
    const result = await runConsolidationTick(ctx, "ws-specific");
    expect(result).toBeDefined();
    expect(result.errors).toBe(0);
  });
});
