// packages/core/src/v3/__tests__/recall-cold-recmem-embeddings.test.ts
import { describe, it, expect, vi } from "vitest";
import { maybeRerank } from "../recall-cold.js";
import type { CoreContext } from "../context.js";
import { recallCold } from "../recall-cold.js";

// This test pins the contract WP4.2 establishes: when rerank is on and the
// served hits carry embeddings, the RecMem gate runs over REAL vectors and
// SKIPS the LLM for a thematically-scattered set (low recurrence signal).
describe("RecMem gate over populated hit embeddings (spec §1/§2)", () => {
  const hit = (id: string, score: number, embedding: number[]) => ({
    id,
    primitive: "fact" as const,
    content: id,
    score,
    sensitivity: "internal" as const,
    injectionScore: 0,
    provenance: "user_stated" as const,
    origin: "local" as const,
    contested: false,
    validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
    validTo: null,
    tags: [] as string[],
    relations: [] as never[],
    embedding,
  });

  it("skips the LLM when embeddings are scattered (orthogonal → low signal)", async () => {
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
    } as never;
    const hits = [hit("a", 0.9, [1, 0, 0]), hit("b", 0.8, [0, 1, 0]), hit("c", 0.7, [0, 0, 1])];
    const out = await maybeRerank(
      ctx,
      { text: "unrelated topics", rerank: true, recurrenceThreshold: 0.6 } as never,
      hits as never
    );
    expect(generate).not.toHaveBeenCalled();
    expect(out.map((h: { id: string }) => h.id)).toEqual(["a", "b", "c"]);
  });

  it("reaches the LLM when embeddings are coherent (near-parallel → high signal)", async () => {
    const generate = vi.fn().mockResolvedValue({
      content: JSON.stringify(["c", "b", "a"]),
      model: "gpt-x",
      tokensUsed: { input: 10, output: 3 },
      costUSD: 0,
    });
    const ctx = {
      id: "llm",
      llm: { id: "llm", generate },
      logger: {
        debug() {},
        info() {},
        child() {
          return this;
        },
      },
    } as never;
    const hits = [
      hit("a", 0.9, [1, 0, 0]),
      hit("b", 0.8, [0.99, 0.01, 0]),
      hit("c", 0.7, [0.98, 0.02, 0]),
    ];
    const out = await maybeRerank(
      ctx,
      { text: "database migration", rerank: true, recurrenceThreshold: 0.6 } as never,
      hits as never
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0].messages[0].content).toContain("Query: database migration");
    expect(out.map((h: { id: string }) => h.id)).toEqual(["c", "b", "a"]);
  });

  it("keeps hit order and skips the LLM without query text", async () => {
    const generate = vi.fn();
    const ctx = { llm: { generate } } as never;
    const hits = [hit("a", 0.9, [1, 0, 0]), hit("b", 0.8, [0.99, 0.01, 0])];

    const out = await maybeRerank(ctx, { rerank: true } as never, hits as never);

    expect(out).toBe(hits);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("recallCold populates hit.embedding when query.rerank===true", () => {
  it("attaches a same-length embedding to each served hit so RecMem can score it", async () => {
    const factEmb: Record<string, number[]> = { f1: [1, 0, 0], f2: [0.99, 0.01, 0] };
    const ctx = {
      storage: {
        getRelations: async () => [],
        queryHyperedges: async () => ({ items: [] }),
        recordRecall: async () => {},
        getFact: async (id: string) => ({
          id,
          workspaceId: "ws1",
          statement: id,
          status: "active",
          worth: 0.9,
          sensitivity: "internal",
          attribution: "user_stated",
          createdAt: new Date(), // determinism-ok: throwaway fixture, not asserted
          validFrom: new Date(), // determinism-ok: throwaway fixture, not asserted
          validTo: null,
          worthAlpha: 8,
          worthBeta: 2,
        }), // determinism-ok: throwaway fixture date, not asserted
      },
      vector: {
        search: async () => [
          { id: "f1", score: 0.9, primitiveKind: "fact" },
          { id: "f2", score: 0.8, primitiveKind: "fact" },
        ],
      },
      embed: {
        embed: async (xs: string[]) => xs.map((x) => factEmb[x] ?? [0, 0, 0]),
        embedSingle: async () => [1, 0, 0],
        model: "m",
        dimensions: 3,
      },
      outbox: { append: async () => {} },
      llm: undefined,
      config: {},
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      },
      telemetry: {
        startSpan: () => ({ end() {}, setAttribute() {}, recordException() {}, addEvent() {} }),
        histogram() {},
        counter() {},
        gauge() {},
      },
    } as unknown as CoreContext;

    const resp = await recallCold(
      ctx,
      {
        workspaceId: "ws1",
        text: "q",
        embedding: new Float32Array([1, 0, 0]),
        limit: 10,
        rerank: true,
      } as never,
      { workspaceId: "ws1", actorId: "a", actorType: "agent", scopes: ["memory:read"] } as never
    );
    for (const h of resp.hits) {
      expect(Array.isArray(h.embedding)).toBe(true);
      expect(h.embedding!.length).toBeGreaterThan(0);
    }
  });
});
