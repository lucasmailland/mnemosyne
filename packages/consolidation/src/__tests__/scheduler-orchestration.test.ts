/**
 * Scheduler orchestration tests (B6.35).
 *
 * Covers:
 *   1. Per-workspace resolution order: recovery → admin-lock → validator → candidates.
 *   2. Validator resolver throw/undefined → validator_unavailable, no candidate/apply.
 *   3. The resolved validator instance is reused for classification + replay.
 *   4. Confidential/restricted exclusion before clustering/classification/replay.
 *   5. Lease keeper: serialized 30s heartbeat, progress refresh, no overlap,
 *      first-loss retained, cleanup in finally.
 *   6. Terminal-result → counter mapping for finalize/rollback conflicts.
 *   7. Single-flight scheduler (running set before runTick, cleared in finally).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MnemoFact } from "@mnemo-ai/types";
import type {
  ApplyConsolidationMergeInput,
  ConsolidationMergeSnapshot,
  ReplayFailureReview,
} from "@mnemo-ai/types";
import { runConsolidationTick, startConsolidationScheduler } from "../scheduler.js";
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

// ─── 1 + 2: Resolution order and validator unavailability ─────────────────────

describe("orchestration — per-workspace resolution order", () => {
  it("runs recovery → admin-lock → validator → candidate query in order", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3);
    const order: string[] = [];

    const recover = vi.fn(async () => {
      order.push("recover");
      return 0;
    });
    const locked = vi.fn(async () => {
      order.push("lock");
      return false;
    });
    const queryFacts = vi.fn(async (f: Parameters<SchedulerStorage["queryFacts"]>[0]) => {
      order.push("query");
      return storage.queryFacts(f);
    });
    const s = {
      ...storage,
      recoverExpiredConsolidationMerges: recover,
      isConsolidationLocked: locked,
      queryFacts,
    } as unknown as SchedulerStorage;

    const getReplayValidator = vi.fn(async () => {
      order.push("resolve");
      return validatorBoost(facts[0]!.id);
    });
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: s,
      listWorkspaceIds: async () => ["ws-1"],
      getReplayValidator,
    };

    await runConsolidationTick(ctx);

    expect(order).toEqual(["recover", "lock", "resolve", "query"]);
  });

  it("resolver throw → validator_unavailable, recovery still ran, no apply", async () => {
    const storage = makeInMemoryStorage();
    await seedCluster(storage.adapter, "ws-1", 3);
    const recover = vi.fn(async () => 0);
    const applySpy = vi.fn(storage.applyConsolidationMerge);
    const s = {
      ...storage,
      recoverExpiredConsolidationMerges: recover,
      applyConsolidationMerge: applySpy,
    } as unknown as SchedulerStorage;
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: s,
      listWorkspaceIds: async () => ["ws-1"],
      getReplayValidator: vi.fn(async () => {
        throw new Error("resolver boom");
      }),
    };

    const result = await runConsolidationTick(ctx);

    expect(recover).toHaveBeenCalledOnce();
    expect(applySpy).not.toHaveBeenCalled();
    expect(result.availability).toBe("validator_unavailable");
    expect(result.mergedPairs).toBe(0);
  });

  it("resolver undefined → validator_unavailable, no candidate query/apply", async () => {
    const storage = makeInMemoryStorage();
    await seedCluster(storage.adapter, "ws-1", 3);
    const queryFacts = vi.fn(storage.queryFacts);
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: { ...storage, queryFacts } as unknown as SchedulerStorage,
      listWorkspaceIds: async () => ["ws-1"],
      getReplayValidator: vi.fn(async () => undefined),
    };

    const result = await runConsolidationTick(ctx);

    expect(result.availability).toBe("validator_unavailable");
    expect(queryFacts).not.toHaveBeenCalled();
  });

  it("recovery runs even when validator resolution later fails", async () => {
    const storage = makeInMemoryStorage();
    const recover = vi.fn(async () => 2);
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: {
        ...storage,
        recoverExpiredConsolidationMerges: recover,
      } as unknown as SchedulerStorage,
      listWorkspaceIds: async () => ["ws-1"],
      getReplayValidator: vi.fn(async () => undefined),
    };
    await runConsolidationTick(ctx);
    expect(recover).toHaveBeenCalledWith({ workspaceId: "ws-1", expiredBefore: expect.any(Date) });
  });
});

// ─── 3: Validator reuse ───────────────────────────────────────────────────────

describe("orchestration — validator instance reuse", () => {
  it("resolves once per workspace and reuses for deep classification + replay", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3, ["A", "B", "C"]);
    const validator: ReplayValidatorContext = {
      llm: {
        generate: vi.fn((opts: { messages: Array<{ content: string }> }) => {
          const content = opts.messages[0]?.content ?? "";
          if (content.includes("Classify"))
            return Promise.resolve({ content: "DUPLICATE", tokensUsed: { input: 1, output: 1 } });
          return Promise.resolve({
            content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
            tokensUsed: { input: 1, output: 1 },
          });
        }),
      },
      recall: { search: vi.fn(async () => [{ id: facts[0]!.id, score: 0.9 }]) },
      storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
    };
    const getReplayValidator = vi.fn(async () => validator);
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1"],
      getReplayValidator,
      mode: "deep",
    };

    await runConsolidationTick(ctx);

    // Resolver called exactly once for the workspace.
    expect(getReplayValidator).toHaveBeenCalledTimes(1);
    // Same instance used for both classification and replay generation.
    const genMock = validator.llm.generate as ReturnType<typeof vi.fn>;
    const hadClassify = genMock.mock.calls.some((c) =>
      c[0].messages[0].content.includes("Classify")
    );
    const hadReplay = genMock.mock.calls.some(
      (c) => !c[0].messages[0].content.includes("Classify")
    );
    expect(hadClassify).toBe(true);
    expect(hadReplay).toBe(true);
  });

  it("fast mode resolves once and uses the validator for replay without re-resolving", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3);
    const getReplayValidator = vi.fn(async () => validatorBoost(facts[0]!.id));
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1"],
      getReplayValidator,
    };

    await runConsolidationTick(ctx);

    expect(getReplayValidator).toHaveBeenCalledTimes(1);
  });
});

// ─── 4: Sensitivity exclusion ─────────────────────────────────────────────────

describe("orchestration — sensitivity exclusion", () => {
  it("excludes confidential/restricted (even plaintext) before clustering", async () => {
    const storage = makeInMemoryStorage();
    const internal = await seedCluster(storage.adapter, "ws-1", 3);
    // Confidential facts with obviously-plaintext statements must still be excluded.
    await seedCluster(
      storage.adapter,
      "ws-1",
      3,
      ["plain c1", "plain c2", "plain c3"],
      "confidential"
    );
    await seedCluster(
      storage.adapter,
      "ws-1",
      3,
      ["plain r1", "plain r2", "plain r3"],
      "restricted"
    );

    const recall = vi.fn(async () => [{ id: internal[0]!.id, score: 0.9 }]);
    const validator: ReplayValidatorContext = {
      llm: {
        generate: vi
          .fn()
          .mockResolvedValue({
            content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
            tokensUsed: { input: 0, output: 0 },
          }),
      },
      recall: { search: recall },
      storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
    };
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validator,
    };

    const result = await runConsolidationTick(ctx, "ws-1");

    expect(result.candidateCount).toBe(3); // internal only
    expect(result.mergedPairs).toBe(1);
    // Confidential/restricted facts remain untouched.
    const all = await storage.adapter.queryFacts({ workspaceId: "ws-1" });
    const conf = all.items.filter(
      (f) => f.sensitivity === "confidential" || f.sensitivity === "restricted"
    );
    expect(conf).toHaveLength(6);
    for (const f of conf) expect(f.status).toBe("active");
  });
});

// ─── 5: Lease keeper (deterministic, fake timers) ─────────────────────────────

describe("orchestration — lease keeper", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("30s keeper extends the lease during a slow provider call", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3);
    const refreshCalls: Date[] = [];
    const refreshSpy = vi.fn(
      async (i: { snapshot: ConsolidationMergeSnapshot; leaseExpiresAt: Date }) => {
        refreshCalls.push(i.leaseExpiresAt);
        return storage.refreshConsolidationMergeLease(i);
      }
    );

    // Slow replay generate: blocks until we resolve it.
    let releaseGen!: () => void;
    const genGate = new Promise<void>((r) => {
      releaseGen = r;
    });
    const validator: ReplayValidatorContext = {
      llm: {
        generate: vi.fn(async () => {
          await genGate;
          return {
            content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
            tokensUsed: { input: 0, output: 0 },
          };
        }),
      },
      recall: { search: vi.fn(async () => [{ id: facts[0]!.id, score: 0.9 }]) },
      storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
    };
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: { ...storage, refreshConsolidationMergeLease: refreshSpy },
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validator,
    };

    const tick = runConsolidationTick(ctx, "ws-1");
    // Advance three heartbeat intervals while the slow generate is blocked.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refreshCalls.length).toBeGreaterThanOrEqual(3);
    // Each refresh extends to ~now + 15 minutes.
    const last = refreshCalls[refreshCalls.length - 1]!;
    expect(last.getTime() - Date.now()).toBeCloseTo(15 * 60_000, -3); // determinism-ok: test date

    releaseGen();
    await vi.runOnlyPendingTimersAsync();
    const result = await tick;
    expect(result.mergedPairs).toBe(1);
  });

  it("first lease loss is retained; keeper stops refreshing after conflict", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3);
    let refreshCount = 0;
    const refreshSpy = vi.fn(async () => {
      refreshCount++;
      return "conflict" as const; // ownership lost on first heartbeat
    });

    let releaseGen!: () => void;
    const genGate = new Promise<void>((r) => {
      releaseGen = r;
    });
    const validator: ReplayValidatorContext = {
      llm: {
        generate: vi.fn(async () => {
          await genGate;
          return {
            content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
            tokensUsed: { input: 0, output: 0 },
          };
        }),
      },
      recall: { search: vi.fn(async () => [{ id: facts[0]!.id, score: 0.9 }]) },
      storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
    };
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: { ...storage, refreshConsolidationMergeLease: refreshSpy },
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validator,
    };

    const tick = runConsolidationTick(ctx, "ws-1");
    await vi.advanceTimersByTimeAsync(120_000); // 4 heartbeats worth of time
    // After the first conflict, the keeper stops trying (refreshes never overlap).
    expect(refreshCount).toBe(1);
    releaseGen();
    await vi.runOnlyPendingTimersAsync();
    await tick; // no hang — cleanup happened in finally
  });

  it("onProgress triggers an immediate lease refresh without timer advance", async () => {
    const storage = makeInMemoryStorage();
    const facts = await seedCluster(storage.adapter, "ws-1", 3);
    const refreshSpy = vi.fn(async () => "refreshed" as const);
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: { ...storage, refreshConsolidationMergeLease: refreshSpy },
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validatorBoost(facts[0]!.id),
    };

    // Do NOT advance fake timers — heartbeat setInterval at 30 s cannot fire.
    // validateMergedFact calls onProgress once per replay query (5 planned queries).
    // Each onProgress call chains an immediate refresh onto the serialized keeper
    // chain, which is awaited before the next query proceeds.
    const result = await runConsolidationTick(ctx, "ws-1");

    // All refreshes were triggered by onProgress, not by the timer.
    expect(refreshSpy).toHaveBeenCalledTimes(5);
    expect(result.mergedPairs).toBe(1);
  });
});

// ─── 6: Terminal mapping via finalize/rollback conflicts ──────────────────────

/**
 * Storage decorator that lets a test force finalize/rollback to conflict and
 * pin the subsequent inspection state, using a real InMemory base for apply.
 */
function withConflict(
  base: ReturnType<typeof makeInMemoryStorage>,
  opts: {
    finalize?: "conflict";
    rollback?: "conflict";
    inspect?: "pending" | "restored" | "retained" | "divergent";
    inspectThrows?: boolean;
  }
): SchedulerStorage {
  return {
    ...base,
    finalizeConsolidationMerge:
      opts.finalize === "conflict"
        ? vi.fn(async () => "conflict" as const)
        : base.finalizeConsolidationMerge,
    rollbackConsolidationMerge:
      opts.rollback === "conflict"
        ? vi.fn(async () => "conflict" as const)
        : base.rollbackConsolidationMerge,
    inspectConsolidationMergeState: opts.inspectThrows
      ? vi.fn(async () => {
          throw new Error("inspect boom");
        })
      : opts.inspect
        ? vi.fn(async () => opts.inspect!)
        : base.inspectConsolidationMergeState,
  };
}

describe("orchestration — terminal mapping and counters", () => {
  async function run(storage: SchedulerStorage, validator: ReplayValidatorContext) {
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage,
      listWorkspaceIds: async () => ["ws-1"],
      replayValidator: validator,
    };
    return runConsolidationTick(ctx, "ws-1");
  }

  it("finalize conflict + inspection restored → already_restored → skipped", async () => {
    const base = makeInMemoryStorage();
    const facts = await seedCluster(base.adapter, "ws-1", 3);
    const result = await run(
      withConflict(base, { finalize: "conflict", inspect: "restored" }),
      validatorBoost(facts[0]!.id)
    );
    expect(result.skippedPairs).toBe(1);
    expect(result.mergedPairs).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("finalize conflict + inspection retained → finalize_failed_retained → merged+error", async () => {
    const base = makeInMemoryStorage();
    const facts = await seedCluster(base.adapter, "ws-1", 3);
    const result = await run(
      withConflict(base, { finalize: "conflict", inspect: "retained" }),
      validatorBoost(facts[0]!.id)
    );
    expect(result.mergedPairs).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("rollback conflict + inspection retained → rollback_failed_retained → merged+error", async () => {
    const base = makeInMemoryStorage();
    await seedCluster(base.adapter, "ws-1", 3);
    const result = await run(
      withConflict(base, { rollback: "conflict", inspect: "retained" }),
      validatorFlag()
    );
    expect(result.mergedPairs).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("rollback conflict + inspection pending → ownership_lost_pending → merged+error", async () => {
    const base = makeInMemoryStorage();
    await seedCluster(base.adapter, "ws-1", 3);
    const result = await run(
      withConflict(base, { rollback: "conflict", inspect: "pending" }),
      validatorFlag()
    );
    expect(result.mergedPairs).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("finalize conflict + inspection divergent → ownership_lost_unknown → error only", async () => {
    const base = makeInMemoryStorage();
    const facts = await seedCluster(base.adapter, "ws-1", 3);
    const result = await run(
      withConflict(base, { finalize: "conflict", inspect: "divergent" }),
      validatorBoost(facts[0]!.id)
    );
    expect(result.mergedPairs).toBe(0);
    expect(result.skippedPairs).toBe(0);
    expect(result.errors).toBe(1);
  });

  it("finalize conflict + inspection throws → ownership_lost_unknown → error only", async () => {
    const base = makeInMemoryStorage();
    const facts = await seedCluster(base.adapter, "ws-1", 3);
    const result = await run(
      withConflict(base, { finalize: "conflict", inspectThrows: true }),
      validatorBoost(facts[0]!.id)
    );
    expect(result.errors).toBe(1);
    expect(result.mergedPairs).toBe(0);
    expect(result.skippedPairs).toBe(0);
  });

  it("apply returns null → ineligible → skipped, no counter before settlement", async () => {
    const base = makeInMemoryStorage();
    const facts = await seedCluster(base.adapter, "ws-1", 3);
    const storage: SchedulerStorage = { ...base, applyConsolidationMerge: vi.fn(async () => null) };
    const result = await run(storage, validatorBoost(facts[0]!.id));
    expect(result.skippedPairs).toBe(1);
    expect(result.mergedPairs).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("skipped replay (runtime failure) → replay_failed_restored → skipped+error", async () => {
    const base = makeInMemoryStorage();
    await seedCluster(base.adapter, "ws-1", 3);
    // Validator whose recall rejects → skipped.
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
          throw new Error("recall down");
        }),
      },
      storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
    };
    const result = await run(base, validator);
    expect(result.skippedPairs).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.mergedPairs).toBe(0);
  });
});

// ─── 7: Single-flight scheduler ───────────────────────────────────────────────

describe("orchestration — single-flight scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not overlap ticks; a slow tick blocks the next interval", async () => {
    let active = 0;
    let maxConcurrent = 0;
    let releaseList!: () => void;
    const gate = new Promise<void>((r) => {
      releaseList = r;
    });

    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: makeInMemoryStorage(),
      listWorkspaceIds: vi.fn(async () => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await gate;
        active--;
        return [];
      }),
    };

    const handle = startConsolidationScheduler(ctx, 1_000);
    // Fire several intervals while the first tick is blocked in listWorkspaceIds.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(maxConcurrent).toBe(1); // single-flight — never overlapped

    releaseList();
    await vi.runOnlyPendingTimersAsync();
    handle.stop();
  });

  it("stop() clears future intervals", async () => {
    const listWorkspaceIds = vi.fn(async () => []);
    const ctx: SchedulerContext = {
      actor: TEST_SYSTEM_ACTOR,
      storage: makeInMemoryStorage(),
      listWorkspaceIds,
    };
    const handle = startConsolidationScheduler(ctx, 1_000);
    handle.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listWorkspaceIds).not.toHaveBeenCalled();
  });
});
