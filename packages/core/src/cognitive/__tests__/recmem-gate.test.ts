import { describe, it, expect, vi } from "vitest";
import { recurrenceSignal, decideRecmem } from "../recmem.js";

describe("recurrenceSignal (spec §1/§2 RecMem, MEMORY_IMPROVEMENT.md:84)", () => {
  it("returns 1.0 for fewer than 2 vectors (trivially coherent)", () => {
    expect(recurrenceSignal([])).toBe(1.0);
    expect(recurrenceSignal([[1, 0, 0]])).toBe(1.0);
  });

  it("is high for a thematically coherent set (all near-parallel)", () => {
    const s = recurrenceSignal([
      [1, 0, 0],
      [0.99, 0.01, 0],
      [0.98, 0.02, 0],
    ]);
    expect(s).toBeGreaterThan(0.9);
  });

  it("is low for scattered orthogonal vectors", () => {
    const s = recurrenceSignal([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(s).toBeLessThan(0.2);
  });

  it("treats zero-norm vectors as cosine 0 (no NaN)", () => {
    const s = recurrenceSignal([
      [0, 0, 0],
      [1, 0, 0],
      [0.9, 0.1, 0],
    ]);
    expect(Number.isNaN(s)).toBe(false);
  });
});

describe("decideRecmem — measurable skip below threshold", () => {
  it("skips (no LLM) when signal < threshold and skipIfBelow=true", () => {
    const d = decideRecmem(
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      {
        recurrenceThreshold: 0.6,
        skipLlmIfBelowThreshold: true,
        wouldBePromptChars: 4000,
      }
    );
    expect(d.skipped).toBe(true);
    expect(d.estimatedTokensSaved).toBe(1000); // 4000 chars / 4
  });

  it("proceeds (LLM runs) when signal >= threshold", () => {
    const d = decideRecmem(
      [
        [1, 0, 0],
        [0.99, 0.01, 0],
        [0.98, 0.02, 0],
      ],
      {
        recurrenceThreshold: 0.6,
        skipLlmIfBelowThreshold: true,
        wouldBePromptChars: 4000,
      }
    );
    expect(d.skipped).toBe(false);
    expect(d.estimatedTokensSaved).toBe(0);
  });

  it("never skips when skipIfBelow=false even on a low signal", () => {
    const d = decideRecmem(
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
      {
        recurrenceThreshold: 0.6,
        skipLlmIfBelowThreshold: false,
        wouldBePromptChars: 100,
      }
    );
    expect(d.skipped).toBe(false);
  });
});

import { collapseSession } from "../../session/collapse.js";

describe("collapseSession RecMem gate — LLM skipped below threshold (spec §7:561)", () => {
  it("does NOT call ctx.llm.generate when turns are thematically scattered", async () => {
    const generate = vi.fn();
    const turns = [
      { role: "user", content: "weather in paris", turnIndex: 0 },
      { role: "user", content: "tax law in brazil", turnIndex: 1 },
      { role: "user", content: "how to bake bread", turnIndex: 2 },
    ];
    // Orthogonal embeddings → low recurrence signal → gate skips.
    const embMap: Record<string, number[]> = {
      "weather in paris": [1, 0, 0],
      "tax law in brazil": [0, 1, 0],
      "how to bake bread": [0, 0, 1],
    };
    const ctx = {
      storage: {
        getSession: async () => ({ id: "s1", workspaceId: "ws1", agentId: "a1" }),
        listTurns: async () => turns,
      },
      embed: { embed: async (xs: string[]) => xs.map((x) => embMap[x] ?? [0, 0, 0]) },
      vector: { search: async () => [] },
      llm: { generate },
      outbox: { append: async () => {} },
      config: { surpriseThreshold: 0.3 },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      },
    } as any;

    // P115: `reason` was "explicit" here, which was incidental to what this test
    // asserts (scattered turns must not reach the LLM) and is now the one case
    // the gate deliberately does NOT judge — an explicit collapse is a caller
    // spending their own tokens on purpose. The automatic sweep is where the
    // saving belongs, so the reason moves to "inactivity" and the original
    // intent is preserved exactly. Gate-bypass cases live in
    // session/__tests__/collapse-p115-recmem-gate.test.ts.
    const res = await collapseSession(
      { sessionId: "s1", workspaceId: "ws1", reason: "inactivity" },
      ctx,
      { actorId: "system", actorType: "system", workspaceId: "ws1", scopes: [] } as any
    );

    expect(res.status).toBe("skipped");
    expect(res.skipReason).toBe("low_recurrence_signal");
    expect(generate).not.toHaveBeenCalled();
  });
});

import { maybeRerank, RERANK_TIMEOUT_MS } from "../recall-cold.js";

describe("maybeRerank — RecMem-gated recall rerank (spec :140)", () => {
  const baseHit = (id: string, score: number, embedding: number[]) => ({
    id,
    primitive: "fact",
    content: id,
    score,
    embedding,
    sensitivity: "internal",
    injectionScore: 0,
    provenance: "user_stated",
    origin: "local",
    contested: false,
    validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
    validTo: null,
    tags: [],
    relations: [],
  });

  it("skips the LLM rerank when candidate hits are scattered (low signal)", async () => {
    const generate = vi.fn();
    const ctx = {
      llm: { generate },
      logger: {
        debug() {},
        info() {},
        child() {
          return this;
        },
      },
    } as any;
    const hits = [
      baseHit("a", 0.9, [1, 0, 0]),
      baseHit("b", 0.8, [0, 1, 0]),
      baseHit("c", 0.7, [0, 0, 1]),
    ];
    const out = await maybeRerank(
      ctx,
      { text: "unrelated topics", rerank: true, recurrenceThreshold: 0.6 } as any,
      hits as any
    );
    expect(generate).not.toHaveBeenCalled();
    expect(out.map((h: any) => h.id)).toEqual(["a", "b", "c"]); // deterministic order preserved
  });

  // V-1: a busy LLM must cost recall a bounded wait, then degrade to the
  // un-reranked order and say so.
  const llmCtx = (generate: unknown) =>
    ({
      llm: { generate },
      logger: {
        debug() {},
        info() {},
        warn() {},
        child() {
          return this;
        },
      },
    }) as any;
  const coherentHits = () => [
    baseHit("a", 0.9, [1, 0, 0]),
    baseHit("b", 0.8, [0.99, 0.01, 0]),
    baseHit("c", 0.7, [0.98, 0.02, 0]),
  ];

  it("degrades to the un-reranked order when the LLM does not answer in time", async () => {
    vi.useFakeTimers();
    try {
      const generate = vi.fn(() => new Promise(() => {}));
      const outcome: { degraded?: boolean } = {};
      const pending = maybeRerank(
        llmCtx(generate),
        { text: "q", rerank: true, recurrenceThreshold: 0.6 } as any,
        coherentHits() as any,
        outcome
      );
      await vi.advanceTimersByTimeAsync(RERANK_TIMEOUT_MS + 10);
      const out = await pending;
      expect(generate).toHaveBeenCalled();
      expect(out.map((h: any) => h.id)).toEqual(["a", "b", "c"]);
      expect(outcome.degraded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades and flags when the LLM call throws", async () => {
    const outcome: { degraded?: boolean } = {};
    const out = await maybeRerank(
      llmCtx(vi.fn(async () => Promise.reject(new Error("ollama down")))),
      { text: "q", rerank: true, recurrenceThreshold: 0.6 } as any,
      coherentHits() as any,
      outcome
    );
    expect(out.map((h: any) => h.id)).toEqual(["a", "b", "c"]);
    expect(outcome.degraded).toBe(true);
  });

  it("never sends a page holding confidential text to the LLM", async () => {
    const generate = vi.fn();
    const hits = coherentHits();
    hits[1] = { ...hits[1]!, sensitivity: "confidential" };
    const out = await maybeRerank(
      llmCtx(generate),
      { text: "q", rerank: true, recurrenceThreshold: 0.6 } as any,
      hits as any
    );
    expect(generate).not.toHaveBeenCalled();
    expect(out.map((h: any) => h.id)).toEqual(["a", "b", "c"]);
  });

  it("treats a hit with no sensitivity tier as sealed and skips the LLM", async () => {
    const generate = vi.fn();
    const hits = coherentHits();
    const { sensitivity: _drop, ...bare } = hits[0] as Record<string, unknown>;
    hits[0] = bare as (typeof hits)[number];
    await maybeRerank(
      llmCtx(generate),
      { text: "q", rerank: true, recurrenceThreshold: 0.6 } as any,
      hits as any
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not flag a rerank that worked", async () => {
    const outcome: { degraded?: boolean } = {};
    const out = await maybeRerank(
      llmCtx(
        vi.fn(async () => ({
          content: '["c","a","b"]',
          model: "m",
          tokensUsed: { input: 1, output: 1 },
          costUSD: 0,
        }))
      ),
      { text: "q", rerank: true, recurrenceThreshold: 0.6 } as any,
      coherentHits() as any,
      outcome
    );
    expect(out.map((h: any) => h.id)).toEqual(["c", "a", "b"]);
    expect(outcome.degraded).toBeUndefined();
  });

  it("is a no-op when query.rerank is falsy", async () => {
    const generate = vi.fn();
    const ctx = {
      llm: { generate },
      logger: {
        debug() {},
        child() {
          return this;
        },
      },
    } as any;
    const hits = [baseHit("a", 0.9, [1, 0, 0]), baseHit("b", 0.8, [0.99, 0.01, 0])];
    const out = await maybeRerank(ctx, {} as any, hits as any);
    expect(generate).not.toHaveBeenCalled();
    expect(out).toBe(hits);
  });
});
