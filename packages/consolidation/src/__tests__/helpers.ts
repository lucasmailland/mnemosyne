// Shared test helpers for scheduler tests backed by the real InMemoryStorageAdapter.
//
// The scheduler no longer issues per-fact updateFact/updateWorth writes — it uses
// the six atomic consolidation operations. These helpers wire the InMemory adapter
// (which implements those operations with the same observable semantics as
// PostgreSQL) into the SchedulerStorage surface.

import { vi } from "vitest";
import type { MnemoFact, ActorProvenance } from "@mnemo-ai/types";
import { formatActorRef } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { SchedulerStorage } from "../scheduler.js";
import type { ReplayValidatorContext } from "../ReplayValidator.js";

type CreateRelationFn = NonNullable<SchedulerStorage["createRelation"]>;
type GetRelationsFn = SchedulerStorage["getRelations"];

/** Shared system actor for scheduler tests — mirrors `CONSOLIDATION_SYSTEM_ACTOR`. */
export const TEST_SYSTEM_ACTOR: ActorProvenance = {
  actorType: "system",
  actorId: formatActorRef("system", "consolidation"),
  userId: null,
};

export type TestSchedulerStorage = SchedulerStorage & {
  adapter: InMemoryStorageAdapter;
  createRelation: CreateRelationFn;
};

const UNIT_VEC = new Float32Array([1, 0, 0]);

export function makeInMemoryStorage(
  overrides: Partial<SchedulerStorage> = {}
): TestSchedulerStorage {
  const adapter = new InMemoryStorageAdapter();
  // Spy-wrapped, but backed by the real adapter — a memo lookup after a real
  // write must actually see the row (design.md's flagged test-double gap).
  const createRelation = vi.fn((input: Parameters<CreateRelationFn>[0]) =>
    adapter.createRelation(input)
  );
  const getRelations: GetRelationsFn = (f) => adapter.getRelations(f);

  const storage: SchedulerStorage = {
    queryFacts: (f) => adapter.queryFacts(f) as Promise<{ items: MnemoFact[] }>,
    applyConsolidationMerge: (i) => adapter.applyConsolidationMerge(i),
    rollbackConsolidationMerge: (i) => adapter.rollbackConsolidationMerge(i),
    finalizeConsolidationMerge: (i) => adapter.finalizeConsolidationMerge(i),
    refreshConsolidationMergeLease: (i) => adapter.refreshConsolidationMergeLease(i),
    inspectConsolidationMergeState: (s) => adapter.inspectConsolidationMergeState(s),
    recoverExpiredConsolidationMerges: (i) => adapter.recoverExpiredConsolidationMerges(i),
    createRelation: createRelation as unknown as CreateRelationFn,
    getRelations,
    ...overrides,
  };

  return Object.assign(storage, { adapter, createRelation }) as TestSchedulerStorage;
}

/**
 * Seed a gate-passing cluster of `n` facts sharing a unit-vector embedding.
 * Returns facts ordered survivor-first (highest hitCount).
 */
export async function seedCluster(
  adapter: InMemoryStorageAdapter,
  wsId: string,
  n: number,
  statements?: string[],
  sensitivity: MnemoFact["sensitivity"] = "internal"
): Promise<MnemoFact[]> {
  const facts: MnemoFact[] = [];
  for (let i = 0; i < n; i++) {
    const f = await adapter.createFact({
      workspaceId: wsId,
      statement: statements?.[i] ?? `cluster fact ${i}`,
      subject: "test",
      kind: "other",
      confidence: 0.5,
      sensitivity,
      embedding: UNIT_VEC,
    } as never);
    facts.push(f);
  }
  // Mutate stored rows to satisfy the gate deterministically.
  for (let i = 0; i < facts.length; i++) {
    const stored = await adapter.getFact(facts[i]!.id, wsId);
    Object.assign(stored as MnemoFact, {
      worth: 0.2,
      worthAlpha: 2,
      worthBeta: 5,
      hitCount: n - i,
      embedding: UNIT_VEC,
      lastRecalledAt: null,
      sensitivity,
    });
  }
  return facts;
}

/** A validator whose recall always hits the given survivor id → boosted. */
export function validatorBoost(survivorId: string): ReplayValidatorContext {
  return {
    llm: {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
        tokensUsed: { input: 0, output: 0 },
      }),
    },
    recall: { search: vi.fn(async () => [{ id: survivorId, score: 0.9 }]) },
    storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
  };
}

/** A validator whose recall always misses → flagged. */
export function validatorFlag(): ReplayValidatorContext {
  return {
    llm: {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
        tokensUsed: { input: 0, output: 0 },
      }),
    },
    recall: { search: vi.fn(async () => []) },
    storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
  };
}

/**
 * A validator using a mapped classification LLM (deep mode) whose replay recall
 * always hits so the merge is retained. `statementToClass` maps a statement
 * substring to its classification.
 */
export function validatorDeep(
  statementToClass: Record<string, "DUPLICATE" | "CONTRADICTION" | "COMPATIBLE">,
  survivorId: string
): ReplayValidatorContext {
  return {
    llm: {
      generate: vi.fn((opts: { messages: Array<{ content: string }> }) => {
        const content = opts.messages[0]?.content ?? "";
        // Classification prompts contain the fact statements; replay prompts ask for JSON.
        for (const [stmt, cls] of Object.entries(statementToClass)) {
          if (content.includes(stmt) && content.includes("Classify")) {
            return Promise.resolve({ content: cls, tokensUsed: { input: 10, output: 5 } });
          }
        }
        // Replay query generation
        return Promise.resolve({
          content: JSON.stringify(["q1", "q2", "q3", "q4", "q5"]),
          tokensUsed: { input: 10, output: 5 },
        });
      }),
    },
    recall: { search: vi.fn(async () => [{ id: survivorId, score: 0.9 }]) },
    storage: { getRecentQueriesForFacts: vi.fn().mockResolvedValue([]) },
  };
}
