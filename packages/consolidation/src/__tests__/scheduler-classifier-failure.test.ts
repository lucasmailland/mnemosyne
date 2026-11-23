/**
 * LIFECYCLE-14 (conflict-classifier slice) — a classifier failure must never
 * be recorded as a verdict.
 *
 * `classifyFactPair` used to swallow an LLM error (or an unreadable reply) and
 * return COMPATIBLE. Deep mode persists COMPATIBLE as a `not_conflict`
 * relation and never classifies that pair again, so a model outage left
 * permanent "these do not conflict" judgments behind, and the scheduler's own
 * failure branch ("classifyFactPair error — skipping fact") could never run.
 *
 * Unlike scheduler-deep-mode.test.ts, this file does NOT mock the classifier:
 * the point is what the real one does when the model fails.
 */

import { describe, it, expect, vi } from "vitest";
import { runConsolidationTick } from "../scheduler.js";
import type { SchedulerContext } from "../scheduler.js";
import type { ReplayValidatorContext } from "../ReplayValidator.js";
import { makeInMemoryStorage, seedCluster, TEST_SYSTEM_ACTOR } from "./helpers.js";

function validatorWithClassifierReply(
  reply: () => Promise<{ content: string; tokensUsed: { input: number; output: number } }>,
  survivorId: string
): ReplayValidatorContext {
  return {
    llm: {
      generate: vi.fn((opts: { messages: Array<{ content: string }> }) => {
        const content = opts.messages[0]?.content ?? "";
        if (content.includes("Classify")) return reply();
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

describe("consolidation deep mode — classifier failures are not verdicts", () => {
  for (const [label, reply] of [
    ["the LLM throws", () => Promise.reject(new Error("model unavailable"))],
    [
      "the LLM answers something unreadable",
      () => Promise.resolve({ content: "MAYBE", tokensUsed: { input: 10, output: 5 } }),
    ],
  ] as const) {
    it(`${label}: no not_conflict relation, no merge`, async () => {
      const storage = makeInMemoryStorage();
      const facts = await seedCluster(storage.adapter, "ws-1", 3, [
        "Pablo likes coffee",
        "Pablo prefers espresso",
        "Pablo drinks coffee daily",
      ]);
      const ctx: SchedulerContext = {
        storage,
        listWorkspaceIds: vi.fn().mockResolvedValue(["ws-1"]),
        replayValidator: validatorWithClassifierReply(reply, facts[0]!.id),
        mode: "deep",
        actor: TEST_SYSTEM_ACTOR,
      };

      const result = await runConsolidationTick(ctx);

      expect(storage.createRelation).not.toHaveBeenCalled();
      expect(result.mergedPairs).toBe(0);
      for (const f of facts) {
        expect((await storage.adapter.getFact(f.id, "ws-1"))?.status).toBe("active");
      }
    });
  }
});
