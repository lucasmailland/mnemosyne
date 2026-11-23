/**
 * WP-3 — recall ranks by relevance first.
 *
 * RECALL-1 / AGENTSIM-1: the cold score gave 40% to an activation term that
 * ignores the query and grows with every recall. RECALL-2: hyperedge
 * co-members were injected at the trigger's score. RECALL-3: no floor applied
 * to every arm and no "nothing relevant" signal. RECALL-4: decisions were
 * damped ×0.85 below facts. CHAOS-11: cosine dedup hid distinct facts.
 * CHAOS-5: strict semantic with a dead embedder threw an untyped error.
 * RECALL-6: personal-only recall filtered after pagination. RECALL-8: the hot
 * tier answered one-term queries from whatever was warm.
 */
import { describe, it, expect, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { AuthContext, VectorSearchHit } from "@mnemo-ai/types";
import { recallCold } from "../recall-cold.js";
import { finalizeRecallObservation } from "../recall-observation.js";
import { tryHotTier } from "../recall-hot.js";
import {
  defaultRelevanceFloor,
  normalizeEmbedModel,
  SemanticSearchUnavailableError,
} from "../recall-relevance.js";
import type { CoreContext } from "../context.js";

vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));

const WS = "ws-rel";
const AUTH = {
  workspaceId: WS,
  actorId: "key:k1",
  actorType: "agent",
  userId: "u1",
  scopes: ["memory:read", "memory:write"],
} as AuthContext;

/** A unit vector at `cos` from the query axis [1, 0, 0]. */
function at(cos: number, side = 1): number[] {
  return [cos, Math.sqrt(1 - cos * cos) * side, 0];
}
const QUERY_VEC = new Float32Array([1, 0, 0]);

function makeCtx(storage: InMemoryStorageAdapter, vectors: Map<string, number[]>) {
  const cosine = (a: ArrayLike<number>, b: ArrayLike<number>) =>
    a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const embed = vi.fn(async (texts: string[]) => texts.map(() => QUERY_VEC));
  const ctx = {
    storage,
    vector: {
      search: vi.fn(async (input: { vector: Float32Array; minSimilarity?: number }) =>
        [...vectors.entries()]
          .map(([id, v]): VectorSearchHit => ({
            id,
            score: cosine(input.vector, v),
            primitiveKind: "other",
          }))
          .filter((h) => h.score >= (input.minSimilarity ?? 0))
          .sort((a, b) => b.score - a.score)
      ),
    },
    embed: {
      id: "test",
      model: "test-model",
      dimensions: 3,
      embedSingle: vi.fn(async () => QUERY_VEC),
      embed,
    },
    outbox: { append: vi.fn(async () => undefined) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    telemetry: {
      startSpan: () => ({ end: vi.fn(), setAttribute: vi.fn() }),
      histogram: vi.fn(),
      counter: vi.fn(),
      gauge: vi.fn(),
    },
    config: {},
  } as unknown as CoreContext;
  return { ctx, embed };
}

async function addFact(
  storage: InMemoryStorageAdapter,
  vectors: Map<string, number[]>,
  statement: string,
  vec: number[],
  extra: Record<string, unknown> = {}
) {
  const f = await storage.createFact({
    workspaceId: WS,
    scope: "global",
    statement,
    subject: "topic",
    kind: "other",
    ...extra,
  });
  vectors.set(f.id, vec);
  return f;
}

const q = (extra: Record<string, unknown> = {}) =>
  ({ workspaceId: WS, text: "the question", embedding: QUERY_VEC, limit: 10, ...extra }) as never;

describe("RECALL-1 / AGENTSIM-1 — activation is a tie-breaker, not a ranking signal", () => {
  it("a fresh 0.95 fact outranks a 0.55 fact recalled a dozen times, before and after", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    const hot = await addFact(storage, vectors, "the hot unrelated fact", at(0.55));
    // Twelve recalls that only the 0.55 fact answers: its activation saturates.
    for (let i = 0; i < 12; i++) await recallCold(ctx, q({ limit: 1 }), AUTH);
    const relevant = await addFact(storage, vectors, "the relevant fresh fact", at(0.95, -1));

    const res = await recallCold(ctx, q(), AUTH);

    expect(res.hits.map((h) => h.id)).toEqual([relevant.id, hot.id]);
    expect(res.hits[0]!.similarity).toBeCloseTo(0.95, 6);
    // And it stays first however often the pair is recalled together.
    for (let i = 0; i < 12; i++) await recallCold(ctx, q(), AUTH);
    expect((await recallCold(ctx, q(), AUTH)).hits[0]!.id).toBe(relevant.id);
  });

  it("logs only the hits it returns, in the order it returns them", async () => {
    // Recall logging moved from recallCold to the single observation written at
    // the recall boundary (finalizeRecallObservation), so cold must no longer
    // log by itself and the boundary must log exactly the returned page.
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    const best = await addFact(storage, vectors, "best", at(0.9));
    await addFact(storage, vectors, "second", at(0.8));
    await addFact(storage, vectors, "third", at(0.7));
    const recordRecall = vi.spyOn(storage, "recordRecall");
    const observe = vi.spyOn(storage, "recordRecallObservation");

    const res = await recallCold(ctx, q({ limit: 1 }), AUTH);
    expect(recordRecall).not.toHaveBeenCalled();
    await finalizeRecallObservation(ctx, {
      context: {
        requestId: "r1",
        trafficOrigin: "production",
        clientVersion: "unknown",
        pluginVersion: "unknown",
        serverVersion: "unknown",
      },
      query: q({ limit: 1 }),
      auth: AUTH,
      response: res,
    });

    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.calls[0]![1]).toEqual([
      expect.objectContaining({ memoryId: best.id, rank: 0, tdCredit: 1 }),
    ]);
  });
});

describe("exact ties come back in one order whatever order the index returns", () => {
  // Integration finding: two facts with the same vector scored exactly 1.0 and
  // their order followed whatever the HNSW scan returned, so two identical
  // recalls (semantic vs auto) disagreed now and then. Ties break by id.
  it("two facts with the same cosine are ordered by id on every call", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    const a = await addFact(storage, vectors, "twin statement one", at(0.9));
    const b = await addFact(storage, vectors, "twin statement two", at(0.9));
    const search = ctx.vector.search as unknown as ReturnType<typeof vi.fn>;
    const forward = search.getMockImplementation()!;
    const expected = [a.id, b.id].sort();

    const first = await recallCold(ctx, q(), AUTH);
    search.mockImplementation(async (input: unknown) =>
      [...((await forward(input)) as VectorSearchHit[])].reverse()
    );
    const second = await recallCold(ctx, q(), AUTH);

    expect(first.hits.map((h) => h.id)).toEqual(expected);
    expect(second.hits.map((h) => h.id)).toEqual(expected);
  });
});

describe("RECALL-4 — decisions rank with facts on the same cosine", () => {
  it("a relevant decision outranks weaker facts with the default kinds", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    const fact = await addFact(storage, vectors, "a weaker fact", at(0.6));
    const decision = await storage.createDecision({
      workspaceId: WS,
      kind: "decision",
      title: "We retry card charges three times",
      body: "with exponential backoff",
      topicKey: "atlas/retries",
      scopeRef: "atlas",
    });
    storage.setEmbedding(decision.id, at(0.8));

    const res = await recallCold(ctx, q(), AUTH);

    expect(res.hits.map((h) => h.id)).toEqual([decision.id, fact.id]);
    const hit = res.hits[0]!;
    expect(hit.primitive).toBe("decision");
    expect(hit.similarity).toBeCloseTo(0.8, 6);
    expect(hit.topicKey).toBe("atlas/retries");
    expect(hit.scopeRef).toBe("atlas");
    expect(hit.status).toBe("active");
  });

  it("equal cosine, equal relevance: a decision is not damped below a fact", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    await addFact(storage, vectors, "a fact", at(0.7));
    const decision = await storage.createDecision({
      workspaceId: WS,
      kind: "decision",
      title: "a decision",
      body: "",
    });
    storage.setEmbedding(decision.id, at(0.7, -1));

    const res = await recallCold(ctx, q(), AUTH);

    expect(res.hits).toHaveLength(2);
    expect(res.hits[0]!.score).toBeCloseTo(res.hits[1]!.score, 6);
  });
});

describe("RECALL-11 / AGENTSIM-14 — retrieval alone does not write graph structure", () => {
  async function servedTogether(config: Record<string, unknown>) {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    (ctx as { config: Record<string, unknown> }).config = config;
    for (const [i, c] of [0.9, 0.8, 0.7].entries()) await addFact(storage, vectors, `f${i}`, at(c));
    const createRelation = vi.spyOn(storage, "createRelation");
    const recordCoRecallStdp = vi.spyOn(storage, "recordCoRecallStdp");
    for (let i = 0; i < 4; i++) await recallCold(ctx, q(), AUTH);
    await new Promise((r) => setTimeout(r, 0));
    return { createRelation, recordCoRecallStdp };
  }

  it("by default, co-recall creates no `related` relations", async () => {
    const { createRelation, recordCoRecallStdp } = await servedTogether({});
    expect(createRelation).not.toHaveBeenCalled();
    expect(recordCoRecallStdp).not.toHaveBeenCalled();
  });

  it("a host that opts in (recallGraphLearning) still gets it", async () => {
    const { createRelation } = await servedTogether({ recallGraphLearning: true });
    expect(createRelation).toHaveBeenCalledWith(expect.objectContaining({ verb: "related" }));
  });
});

describe("CHAOS-11 — dedup removes exact copies, not distinct facts", () => {
  it("keeps two distinct facts whose embeddings are nearly identical, without re-embedding", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx, embed } = makeCtx(storage, vectors);
    await addFact(storage, vectors, "The BigQuery budget alert is 2,000 USD.", at(0.9));
    await addFact(storage, vectors, "The BigQuery budget alert is 3,500 USD.", at(0.9));

    const res = await recallCold(ctx, q(), AUTH);

    expect(res.hits).toHaveLength(2);
    expect(embed).not.toHaveBeenCalled();
  });

  it("keeps three distinct but near-identical facts — the chaos run lost 2 of 3", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    const ids = [];
    for (const [i, amount] of ["2,000", "3,500", "5,000"].entries()) {
      // Cosines 0.9 / 0.899 / 0.898 to the query and > 0.99 to each other.
      const f = await addFact(
        storage,
        vectors,
        `The Cygnus BigQuery monthly budget alert is set at ${amount} USD.`,
        at(0.9 - i * 0.001)
      );
      ids.push(f.id);
    }

    const res = await recallCold(ctx, q(), AUTH);

    expect(res.hits.map((h) => h.id).sort()).toEqual([...ids].sort());
  });

  it("collapses an exact copy and lets the next distinct hit take its slot", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    await addFact(storage, vectors, "Money is stored in cents.", at(0.9));
    await addFact(storage, vectors, "money is stored  in cents. ", at(0.89));
    const third = await addFact(storage, vectors, "Amounts are BIGINT.", at(0.5));

    const res = await recallCold(ctx, q({ limit: 2 }), AUTH);

    expect(res.hits).toHaveLength(2);
    expect(res.hits[1]!.id).toBe(third.id);
  });
});

describe("RECALL-3 / AGENTSIM-15 — nothingRelevant", () => {
  async function oneHit(cos: number, extra: Record<string, unknown> = {}) {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    await addFact(storage, vectors, "something", at(cos));
    return recallCold(ctx, q(extra), AUTH);
  }

  it("is true when no candidate clears the floor — the hits are still returned", async () => {
    const res = await oneHit(0.4, { relevanceFloor: 0.5 });
    expect(res.nothingRelevant).toBe(true);
    expect(res.hits).toHaveLength(1);
    expect(res.debug?.relevanceFloor).toBe(0.5);
  });

  it("is false when a candidate clears it", async () => {
    expect((await oneHit(0.6, { relevanceFloor: 0.5 })).nothingRelevant).toBe(false);
  });

  it("without a calibrated floor for the model, only an empty result counts", async () => {
    // embed.model is "test-model": no default floor.
    expect((await oneHit(0.2)).nothingRelevant).toBe(false);
    expect((await oneHit(0.2, { minSimilarity: 0.5 })).nothingRelevant).toBe(true);
  });

  it("APP-020: when something clears the floor, the hits under it are not served", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    const relevant = await addFact(storage, vectors, "the relevant one", at(0.7));
    await addFact(storage, vectors, "a weak neighbour", at(0.45, -1));
    await addFact(storage, vectors, "another weak one", at(0.33));

    const res = await recallCold(ctx, q({ relevanceFloor: 0.5 }), AUTH);

    expect(res.nothingRelevant).toBe(false);
    expect(res.hits.map((h) => h.id)).toEqual([relevant.id]);
  });

  it("is judged before pagination: an empty offset page is not 'nothing'", async () => {
    const res = await oneHit(0.9, { relevanceFloor: 0.5, offset: 5 });
    expect(res.hits).toHaveLength(0);
    expect(res.nothingRelevant).toBe(false);
  });

  it("knows bge-m3 under its usual names and nothing it was not calibrated for", () => {
    expect(normalizeEmbedModel("BAAI/bge-m3")).toBe("bge-m3");
    expect(defaultRelevanceFloor("bge-m3:latest")).toBe(0.5);
    expect(defaultRelevanceFloor("amazon.titan-embed-text-v2:0")).toBeUndefined();
  });
});

describe("CHAOS-5 — strict semantic with no embedder is a typed error", () => {
  it("a provider that does not answer → SemanticSearchUnavailableError with the cause", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage, new Map());
    const providerError = new Error("fetch failed");
    ctx.embed.embedSingle = vi.fn(async () => {
      throw providerError;
    });

    const err = await recallCold(
      ctx,
      { workspaceId: WS, text: "x", mode: "semantic" } as never,
      AUTH
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SemanticSearchUnavailableError);
    expect((err as SemanticSearchUnavailableError).code).toBe("semantic_search_unavailable");
    expect((err as { cause?: unknown }).cause).toBe(providerError);
  });

  it("an embedder configured as absent → the same typed error", async () => {
    const storage = new InMemoryStorageAdapter();
    const { ctx } = makeCtx(storage, new Map());
    (ctx.embed as { model: string }).model = "none";

    await expect(
      recallCold(ctx, { workspaceId: WS, text: "x", mode: "semantic" } as never, AUTH)
    ).rejects.toMatchObject({ code: "semantic_search_unavailable" });
  });
});

describe("AGENTSIM-4 — hits say what they are and whether they are disputed", () => {
  it("marks a hit on either end of an unresolved conflicts_with relation as contested", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    const old = await addFact(storage, vectors, "Marta approves invoice schema changes", at(0.9), {
      topicKey: "ledgerly/billing-owner",
    });
    const calm = await addFact(storage, vectors, "Runbooks live in Notion", at(0.5));
    (storage as unknown as { getUnresolvedConflictIds: unknown }).getUnresolvedConflictIds = vi.fn(
      async () => [old.id]
    );

    const res = await recallCold(ctx, q(), AUTH);

    const disputed = res.hits.find((h) => h.id === old.id)!;
    expect(disputed.status).toBe("contested");
    expect(disputed.contested).toBe(true);
    expect(disputed.topicKey).toBe("ledgerly/billing-owner");
    expect(disputed.subject).toBe("topic");
    expect(res.hits.find((h) => h.id === calm.id)!.status).toBe("active");
  });

  it("a closed row served under includeArchived reads as superseded", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    const f = await addFact(storage, vectors, "old value", at(0.9));
    await storage.archiveFact(f.id, WS);

    const res = await recallCold(ctx, q({ includeArchived: true }), AUTH);

    expect(res.hits[0]!.status).toBe("superseded");
  });
});

describe("graph context on hits", () => {
  it("lists only open relations — a closed one is history, not context", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    const f = await addFact(storage, vectors, "a fact", at(0.9));
    const relation = (id: string, validTo: Date | null) => ({
      id,
      workspaceId: WS,
      sourceId: f.id,
      sourceType: "fact",
      targetId: "other",
      targetType: "fact",
      verb: "conflicts_with",
      weight: 1,
      validTo,
    });
    vi.spyOn(storage, "getRecallStructures").mockResolvedValue({
      relations: [relation("open", null), relation("closed", new Date("2026-01-01"))],
      hyperedges: [],
    } as never);

    const res = await recallCold(ctx, q(), AUTH);

    expect(res.hits[0]!.relations.map((r) => r.id)).toEqual(["open"]);
  });
});

describe("RECALL-6 — ownership filters before pagination", () => {
  it("a personal fact far down the similarity order is still the answer to a personal-only recall", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    for (const [i, c] of [0.9, 0.85, 0.8].entries()) {
      await addFact(storage, vectors, `workspace fact ${i}`, at(c));
    }
    const mine = await addFact(storage, vectors, "My laptop is a MacBook Pro", at(0.4), {
      scopeOwner: "user:u1",
    });

    const res = await recallCold(ctx, q({ limit: 1, filter: { scopeOwner: "user:u1" } }), AUTH);

    expect(res.hits.map((h) => h.id)).toEqual([mine.id]);
    expect(res.hits[0]!.scopeOwner).toBe("user:u1");
  });
});

describe("RECALL-8 — the hot tier does not answer one-term queries", () => {
  it("falls through before fetching or reinforcing anything", async () => {
    const zrangeByScore = vi.fn(async () => ["f1", "f2", "f3"]);
    const zincrby = vi.fn(async () => 1);
    const ctx = {
      cache: { zrangeByScore, zincrby },
      storage: {},
      telemetry: { startSpan: () => ({ end() {}, setAttribute() {} }), histogram() {} },
      config: { maxHotTierSize: 100 },
    } as unknown as CoreContext;

    for (const text of ["Eos", "Eos?", "borealis://"]) {
      expect(await tryHotTier(ctx, { workspaceId: WS, text } as never, AUTH)).toBeNull();
    }
    expect(zrangeByScore).not.toHaveBeenCalled();
    expect(zincrby).not.toHaveBeenCalled();
  });
});

describe("WP-3 review — the floor holds on every path", () => {
  it("hybrid: a decision the lexical arm matched below minSimilarity stays out", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    const relevant = await addFact(storage, vectors, "relevant fact", at(0.95));
    const weak = await storage.createDecision({
      workspaceId: WS,
      kind: "decision",
      title: "We retry card charges three times",
      body: "",
    });
    storage.setEmbedding(weak.id, at(0.4));

    const floored = await recallCold(
      ctx,
      q({ text: "retry card charges", mode: "hybrid", minSimilarity: 0.9 }),
      AUTH
    );
    expect(floored.hits.map((h) => h.id)).toEqual([relevant.id]);

    // Without a floor the same lexical match is served, carrying its cosine.
    const open = await recallCold(ctx, q({ text: "retry card charges", mode: "hybrid" }), AUTH);
    expect(open.hits.find((h) => h.id === weak.id)?.similarity).toBeCloseTo(0.4, 6);
  });

  it("hybrid: an FTS-only fact (outside the vector window) is measured and floored too", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    // Cosine 0.05: under the vector arm's 0.1 gather bound, so only FTS finds it.
    const faint = await addFact(storage, vectors, "retry policy notes", at(0.05));
    storage.setEmbedding(faint.id, at(0.05)); // the row's stored vector, as FTS returns it

    const floored = await recallCold(
      ctx,
      q({ text: "retry policy", mode: "hybrid", minSimilarity: 0.5 }),
      AUTH
    );
    expect(floored.hits.map((h) => h.id)).not.toContain(faint.id);

    const open = await recallCold(ctx, q({ text: "retry policy", mode: "hybrid" }), AUTH);
    expect(open.hits.find((h) => h.id === faint.id)?.similarity).toBeCloseTo(0.05, 6);
  });

  it("RECALL-6: the ownership filter reaches the semantic queries, before their limits", async () => {
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    const recallableCandidates = vi.spyOn(storage, "recallableCandidates");

    await recallCold(ctx, q({ filter: { scopeOwner: "user:u1" } }), AUTH);

    expect(ctx.vector.search).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { scopeOwner: "user:u1" }, limit: 1000 })
    );
    expect(recallableCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ scopeOwner: "user:u1" })
    );
  });
});

describe("WP-3 review — the L3 query cache keeps the verdict", () => {
  async function core(floorFact: number) {
    const { createCore } = await import("../index.js");
    const storage = new InMemoryStorageAdapter();
    const vectors = new Map<string, number[]>();
    const { ctx } = makeCtx(storage, vectors);
    const f = await addFact(storage, vectors, "the only fact", at(floorFact));
    storage.setFactEmbedding(f.id, at(floorFact));
    const insert = vi.spyOn(storage, "insertQueryCache");
    const lookup = vi.spyOn(storage, "lookupQueryCache");
    const mnemo = createCore(ctx as never);
    // An unrestricted caller: the only kind of auth L3 serves.
    const admin = { ...AUTH, scopes: ["memory:read", "memory:admin"] } as AuthContext;
    const ask = (relevanceFloor: number) =>
      mnemo.recall({ workspaceId: WS, text: "same question", relevanceFloor }, admin);
    return { ask, insert, lookup, ctx };
  }

  it("a 'nothing relevant' answer is not cached, so asking again says the same", async () => {
    const { ask, insert } = await core(0.3);

    const first = await ask(0.5);
    const second = await ask(0.5);

    expect(first.nothingRelevant).toBe(true);
    expect(second.nothingRelevant).toBe(true);
    expect(insert).not.toHaveBeenCalled();
  });

  it("a relevant answer is cached and re-judged from the stored vectors on the way out", async () => {
    const { ask, insert, ctx } = await core(0.8);

    const cold = await ask(0.5);
    expect(cold.nothingRelevant).toBe(false);
    expect(insert).toHaveBeenCalledOnce();
    const searches = vi.mocked(ctx.vector.search).mock.calls.length;

    const cached = await ask(0.5);
    expect(vi.mocked(ctx.vector.search).mock.calls.length).toBe(searches);
    expect(cached.nothingRelevant).toBe(false);
    expect(cached.hits[0]!.similarity).toBeCloseTo(0.8, 6);

    // Same cached ids, a stricter floor: the verdict is recomputed, not copied.
    expect((await ask(0.9)).nothingRelevant).toBe(true);
  });
});
