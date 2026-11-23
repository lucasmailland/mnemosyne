// ReplayValidator.test.ts
//
// B6.35 evaluative replay: validateMergedFact selects queries, runs recall, and
// returns a terminal status. It performs NO durable write. ValidatorStorage
// exposes only getRecentQueriesForFacts.

import { describe, it, expect, vi } from "vitest";
import type { MnemoFact } from "@mnemo-ai/types";
import { validateMergedFact } from "../ReplayValidator.js";
import type { ReplayValidatorContext, ValidatorStorage } from "../ReplayValidator.js";

// ─── Minimal fact factory ─────────────────────────────────────────────────────

function makeFact(overrides: Partial<MnemoFact> = {}): MnemoFact {
  return {
    id: "fact-merged",
    workspaceId: "ws-test",
    scope: "global",
    statement: "The capital of France is Paris.",
    subject: "France",
    kind: "other",
    confidence: 0.9,
    relevance: 0.8,
    hitCount: 5,
    worthSuccess: 3,
    worthFailure: 0,
    worthAlpha: 1,
    worthBeta: 1,
    worth: 0.5,
    memoryType: "semantic",
    memoryStrength: 0.8,
    memoryStability: 0.9,
    attribution: "objective_fact",
    sourceMessageIds: [],
    revisionCount: 0,
    protocolVersion: "3",
    status: "active",
    pinned: false,
    canonical: false,
    sensitivity: "public",
    validFrom: new Date("2025-01-01"),
    embeddingStale: false,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    linkedMemoryIds: [],
    metadata: {},
    ...overrides,
  };
}

function makeStorage(realQueries: string[]): ValidatorStorage {
  return { getRecentQueriesForFacts: vi.fn().mockResolvedValue(realQueries) };
}

/** LLM that returns exactly `count` synthetic queries as a JSON array. */
function fixedGen(queries: string[]) {
  return vi.fn().mockResolvedValue({
    content: JSON.stringify(queries),
    tokensUsed: { input: 10, output: 20 },
  });
}

/** Recall that hits (returns the survivor id) for the first `hits` distinct queries. */
function makeRecall(hitQueries: Set<string>, factId = "fact-merged") {
  return vi.fn(async ({ text }: { text: string }) =>
    hitQueries.has(text) ? [{ id: factId, score: 0.95 }] : []
  );
}

describe("validateMergedFact — query selection (B6.35)", () => {
  it("uses up to 10 real queries and does NOT call the LLM when >= 5 distinct remain", async () => {
    const realQueries = ["q1", "q2", "q3", "q4", "q5", "q6"];
    const llm = fixedGen([]);
    const ctx: ReplayValidatorContext = {
      llm: { generate: llm },
      recall: { search: makeRecall(new Set(realQueries)) },
      storage: makeStorage(realQueries),
    };
    const result = await validateMergedFact(makeFact(), ctx, ["fact-absorbed-1"]);

    expect(llm).not.toHaveBeenCalled();
    expect(ctx.storage.getRecentQueriesForFacts).toHaveBeenCalledWith(
      "ws-test",
      expect.arrayContaining(["fact-merged", "fact-absorbed-1"]),
      10
    );
    expect(result.queriesUsed).toEqual(realQueries);
    expect(result.status).toBe("boosted"); // all 6 hit
  });

  it("trims and dedupes real queries, capping at 10", async () => {
    const noisy = [" a ", "a", "b", "", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
    const ctx: ReplayValidatorContext = {
      llm: { generate: fixedGen([]) },
      recall: { search: makeRecall(new Set()) }, // all miss → flagged, but we assert queriesUsed
      storage: makeStorage(noisy),
    };
    const result = await validateMergedFact(makeFact(), ctx, []);
    // "a" deduped and trimmed; empty dropped; capped at 10 distinct
    expect(result.queriesUsed).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
  });

  it("generates exactly the shortfall when fewer than 5 real queries remain", async () => {
    const real = ["r1", "r2"];
    const gen = fixedGen(["g1", "g2", "g3"]); // shortfall = 3
    const ctx: ReplayValidatorContext = {
      llm: { generate: gen },
      recall: { search: makeRecall(new Set(["r1", "r2", "g1", "g2", "g3"])) },
      storage: makeStorage(real),
    };
    const result = await validateMergedFact(makeFact(), ctx, []);
    expect(gen).toHaveBeenCalledOnce();
    // Prompt asks for exactly the shortfall (3)
    const promptArg = gen.mock.calls[0]![0].messages[0].content as string;
    expect(promptArg).toContain("3");
    expect(result.queriesUsed).toEqual(["r1", "r2", "g1", "g2", "g3"]);
    expect(result.queriesUsed).toHaveLength(5);
  });

  it("returns skipped when total distinct is below 5 after generation", async () => {
    const gen = fixedGen(["only-one"]); // not enough to reach 5
    const ctx: ReplayValidatorContext = {
      llm: { generate: gen },
      recall: { search: makeRecall(new Set()) },
      storage: makeStorage([]),
    };
    const result = await validateMergedFact(makeFact(), ctx, []);
    expect(result.status).toBe("skipped");
    expect(result.queriesUsed).toEqual([]);
  });
});

describe("validateMergedFact — completed replay outcomes (fail-first ratios)", () => {
  const five = ["c1", "c2", "c3", "c4", "c5"];

  function ctxWithHits(hits: string[]): ReplayValidatorContext {
    return {
      llm: { generate: fixedGen([]) },
      recall: { search: makeRecall(new Set(hits)) },
      storage: makeStorage(five),
    };
  }

  it("2/5 pass → 3/5 fail (0.60) → flagged", async () => {
    const result = await validateMergedFact(makeFact(), ctxWithHits(["c1", "c2"]), []);
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(3);
    expect(result.status).toBe("flagged");
    expect(result.queriesUsed).toEqual(five);
  });

  it("8/10 pass → boosted", async () => {
    const ten = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const hits = ten.slice(0, 8);
    const ctx: ReplayValidatorContext = {
      llm: { generate: fixedGen([]) },
      recall: { search: makeRecall(new Set(hits)) },
      storage: makeStorage(ten),
    };
    const result = await validateMergedFact(makeFact(), ctx, []);
    expect(result.passCount).toBe(8);
    expect(result.failCount).toBe(2);
    expect(result.status).toBe("boosted");
  });

  it("7/10 pass → neutral (below 0.80 boost, below 0.60 fail)", async () => {
    const ten = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const hits = ten.slice(0, 7);
    const ctx: ReplayValidatorContext = {
      llm: { generate: fixedGen([]) },
      recall: { search: makeRecall(new Set(hits)) },
      storage: makeStorage(ten),
    };
    const result = await validateMergedFact(makeFact(), ctx, []);
    expect(result.passCount).toBe(7);
    expect(result.status).toBe("neutral");
  });

  it("4/10 pass → 6/10 fail (0.60) → flagged", async () => {
    const ten = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const hits = ten.slice(0, 4);
    const ctx: ReplayValidatorContext = {
      llm: { generate: fixedGen([]) },
      recall: { search: makeRecall(new Set(hits)) },
      storage: makeStorage(ten),
    };
    const result = await validateMergedFact(makeFact(), ctx, []);
    expect(result.passCount).toBe(4);
    expect(result.failCount).toBe(6);
    expect(result.status).toBe("flagged");
  });

  it("returns the full planned sample in queriesUsed on completion", async () => {
    const result = await validateMergedFact(makeFact(), ctxWithHits(five), []);
    expect(result.status).toBe("boosted");
    expect(result.queriesUsed).toEqual(five);
  });
});

describe("validateMergedFact — infrastructure failures return skipped", () => {
  const five = ["c1", "c2", "c3", "c4", "c5"];

  it("generation rejection → skipped", async () => {
    const ctx: ReplayValidatorContext = {
      llm: { generate: vi.fn().mockRejectedValue(new Error("LLM down")) },
      recall: { search: makeRecall(new Set()) },
      storage: makeStorage([]),
    };
    const result = await validateMergedFact(makeFact(), ctx, []);
    expect(result.status).toBe("skipped");
  });

  it("malformed (non-array) generation → skipped", async () => {
    const ctx: ReplayValidatorContext = {
      llm: {
        generate: vi
          .fn()
          .mockResolvedValue({ content: "not json", tokensUsed: { input: 1, output: 1 } }),
      },
      recall: { search: makeRecall(new Set()) },
      storage: makeStorage([]),
    };
    const result = await validateMergedFact(makeFact(), ctx, []);
    expect(result.status).toBe("skipped");
  });

  it("non-string element in generation → skipped", async () => {
    const ctx: ReplayValidatorContext = {
      llm: {
        generate: vi
          .fn()
          .mockResolvedValue({
            content: JSON.stringify(["a", 5, "b"]),
            tokensUsed: { input: 1, output: 1 },
          }),
      },
      recall: { search: makeRecall(new Set()) },
      storage: makeStorage([]),
    };
    const result = await validateMergedFact(makeFact(), ctx, []);
    expect(result.status).toBe("skipped");
  });

  it("recall rejection → skipped, attempted prefix INCLUDES the failing query", async () => {
    let call = 0;
    const recall = vi.fn(async () => {
      call++;
      if (call === 3) throw new Error("recall failed");
      return [{ id: "fact-merged", score: 0.9 }];
    });
    const ctx: ReplayValidatorContext = {
      llm: { generate: fixedGen([]) },
      recall: { search: recall },
      storage: makeStorage(five),
    };
    const result = await validateMergedFact(makeFact(), ctx, []);
    expect(result.status).toBe("skipped");
    // First 3 queries attempted (the 3rd rejected recall is included)
    expect(result.queriesUsed).toEqual(["c1", "c2", "c3"]);
  });
});

describe("validateMergedFact — progress callback (interruption)", () => {
  const five = ["c1", "c2", "c3", "c4", "c5"];

  it("pre-query progress rejection → skipped, attempted prefix EXCLUDES the pending query", async () => {
    let call = 0;
    const onProgress = vi.fn(async () => {
      call++;
      if (call === 3) throw new Error("lease lost");
    });
    const ctx: ReplayValidatorContext = {
      llm: { generate: fixedGen([]) },
      recall: { search: makeRecall(new Set(five)) },
      storage: makeStorage(five),
    };
    const result = await validateMergedFact(makeFact(), ctx, [], { onProgress });
    expect(result.status).toBe("skipped");
    // Progress for c3 rejected BEFORE recall → c3 not appended
    expect(result.queriesUsed).toEqual(["c1", "c2"]);
  });

  it("progress runs before every recall query on a completed replay", async () => {
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const ctx: ReplayValidatorContext = {
      llm: { generate: fixedGen([]) },
      recall: { search: makeRecall(new Set(five)) },
      storage: makeStorage(five),
    };
    const result = await validateMergedFact(makeFact(), ctx, [], { onProgress });
    expect(onProgress).toHaveBeenCalledTimes(5);
    expect(result.status).toBe("boosted");
  });
});
