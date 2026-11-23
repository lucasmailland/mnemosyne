import { describe, it, expect, vi } from "vitest";
import { createCore } from "../index.js";
import type { AuthContext, RecallHit, RecallQuery } from "@mnemo-ai/types";
import { factTdCredits, finalizeRecallObservation } from "../recall-observation.js";

const tier = vi.hoisted(() => ({
  hot: null as unknown,
  ptr: null as unknown,
  effects: [] as unknown[],
}));
// prettier-ignore
vi.mock("../recall-hot.js", async (o) => ({ ...(await o<{}>()), tryHotTier: async (...a: unknown[]) => (tier.effects.push(["hot", a[4]]), tier.hot) }));
// prettier-ignore
vi.mock("../recall-pointer.js", async (o) => ({ ...(await o<{}>()), tryPointerTier: async (...a: unknown[]) => (tier.effects.push(["pointer", a[4]]), tier.ptr) }));
const KINDS = "fact decision episode entity strategy workflow skill task event reasoning".split(
  " "
);
const hit = (i: number, kind: string) =>
  ({
    id: kind === "fact" ? `u${i}` : `m${kind.slice(0, 3)}_${i}`,
    primitive: kind,
    score: 1,
  }) as RecallHit;
const query = { workspaceId: "w", text: "secret query text" } as RecallQuery;
const auth = { actorId: "a", actorType: "agent", scopes: ["memory:admin"] } as AuthContext;
const context = { requestId: "r1", clientVersion: "unknown" } as never;
const logger = { warn: vi.fn() } as never;

async function run(extra: object, record = vi.fn(async (..._a: unknown[]) => undefined)) {
  await finalizeRecallObservation(
    { storage: { recordRecallObservation: record }, logger },
    { context, query, auth, ...extra }
  );
  return record;
}

describe("finalizeRecallObservation", () => {
  it("keeps ten kinds with prefixed ids and global ranks", async () => {
    const record = await run({ response: { hits: KINDS.map((k, i) => hit(i, k)) } });
    const [req, hits] = record.mock.calls[0] as any[];
    expect(req).toMatchObject({ resultCount: 10, status: "ok" });
    expect(hits.map((h: any) => h.rank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(hits[2]).toMatchObject({ primitiveKind: "episode", memoryId: "mepi_2" });
  });

  it("emits for empty and error requests with hashed query only", async () => {
    const empty = await run({ response: { hits: [] } });
    const err = await run({ error: new Error("boom") });
    expect(empty.mock.calls[0]![0]).toMatchObject({ status: "empty", sessionId: null });
    expect(err.mock.calls[0]![0]).toMatchObject({ status: "error", clientVersion: "unknown" });
    const json = JSON.stringify([empty.mock.calls, err.mock.calls]);
    expect(json).not.toContain("secret query text");
    expect(json).toMatch(/[0-9a-f]{64}/);
  });

  it("reports observation failure without throwing", async () => {
    const record = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(run({ response: { hits: [hit(0, "fact")] } }, record)).resolves.toBe(record);
    expect(logger.warn).toHaveBeenCalledWith(
      "recall.observation_failed",
      expect.objectContaining({ requestId: "r1" })
    );
  });

  it("carries TD credit on organic fact hits only, never on synthetic traffic", async () => {
    const hits = [hit(0, "episode"), hit(1, "fact")];
    const organic = await run({
      context: { ...context, trafficOrigin: "production" },
      response: { hits },
    });
    const synthetic = await run({
      context: { ...context, trafficOrigin: "synthetic" },
      response: { hits },
    });
    const credits = (r: any) => r.mock.calls[0][1].map((h: any) => h.tdCredit);
    expect(credits(organic)).toEqual([undefined, 0.7]);
    expect(credits(synthetic)).toEqual([undefined, undefined]);
  });

  it("gives a point-in-time (asOf) read no TD credit and no query text", async () => {
    const hits = [hit(0, "episode"), hit(1, "fact")];
    const past = await run({
      context: { ...context, trafficOrigin: "production" },
      query: { ...query, asOf: new Date("2026-07-05T00:00:00Z") },
      response: { hits },
    });
    const [request, observed] = past.mock.calls[0] as [any, any[]];
    expect(observed.map((h) => h.tdCredit)).toEqual([undefined, undefined]);
    expect(request.queryText).toBeUndefined();
    const legacy = vi.fn(async () => undefined);
    await finalizeRecallObservation({ storage: { recordRecall: legacy } as never, logger }, {
      context: { ...context, trafficOrigin: "production" },
      query: { ...query, asOf: new Date("2026-07-05T00:00:00Z") },
      auth,
      response: { hits },
    } as never);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("falls back to the legacy per-fact recordRecall when the observation port is absent", async () => {
    const recordRecall = vi.fn(async (..._a: unknown[]) => undefined);
    await finalizeRecallObservation(
      { storage: { recordRecall }, logger },
      {
        context: { ...context, trafficOrigin: "production" },
        query,
        auth,
        response: { hits: [hit(0, "episode"), hit(1, "fact")] },
      }
    );
    expect(recordRecall).toHaveBeenCalledTimes(1);
    expect(recordRecall.mock.calls[0]![0]).toMatchObject({
      workspaceId: "w",
      factId: "u1",
      hitRank: 1,
      tdCredit: 0.7,
      queryText: "secret query text",
    });
  });

  it("hands the query text to organic fact hits only (replay + conditional anticipation)", async () => {
    const hits = [hit(0, "episode"), hit(1, "fact")];
    const organic = await run({
      context: { ...context, trafficOrigin: "production" },
      response: { hits },
    });
    const synthetic = await run({
      context: { ...context, trafficOrigin: "test" },
      response: { hits },
    });
    const noFacts = await run({ response: { hits: [hit(0, "episode")] } });
    expect(organic.mock.calls[0]![0]).toMatchObject({ queryText: "secret query text" });
    expect(synthetic.mock.calls[0]![0]).not.toHaveProperty("queryText");
    expect(noFacts.mock.calls[0]![0]).not.toHaveProperty("queryText");
  });

  it("preserves the response's nothingRelevant verdict for nonempty weak recalls", async () => {
    const weak = await run({ response: { hits: [hit(0, "fact")], nothingRelevant: true } });
    expect(weak.mock.calls[0]![0]).toMatchObject({ nothingRelevant: true, resultCount: 1 });
    const fallback = await run({ response: { hits: [] } });
    expect(fallback.mock.calls[0]![0]).toMatchObject({ nothingRelevant: true });
  });

  it("applies TD credits to fact hits only at global ranks", () => {
    const credits = factTdCredits([
      hit(0, "episode"),
      hit(1, "fact"),
      hit(2, "entity"),
      hit(3, "fact"),
    ]);
    expect(credits.map((c) => c.hitRank)).toEqual([1, 3]);
    expect(credits[1]!.tdCredit).toBeCloseTo(0.343);
  });
});
const ok = { hits: [hit(0, "fact")], total: 1, query: { text: "q", limit: 10, offset: 0 } };
// prettier-ignore
function boot(embedSingle: any = async () => new Float32Array(4).fill(0.1)) {
  tier.hot = tier.ptr = null;
  tier.effects = [];
  const spy = { record: vi.fn(), recall: vi.fn(), zincrby: vi.fn() };
  const fact = { id: "f1", statement: "s", sensitivity: "internal", worth: 0.9, status: "active", validTo: null, createdAt: new Date(0) };
  const storage = { recordRecallObservation: spy.record, recordRecall: spy.recall, getRelations: async () => [], getFact: async () => fact,
    ftsCandidates: async () => [{ factId: "t1", statement: "s", rank: 1, worth: 0.9 }], queryHyperedges: async () => ({ items: [] }),
    getRecallLog: async () => [], lookupQueryCache: async () => null } as any;
  const ctx = { storage, embed: { model: "m", embedSingle }, outbox: { append: vi.fn() }, cache: { zincrby: spy.zincrby },
    logger: { debug() {}, info() {}, warn() {} }, vector: { search: async () => [{ id: "f1", score: 0.9, primitiveKind: "fact" }] },
    telemetry: { startSpan: () => ({ end() {}, setAttribute() {} }), histogram() {} } } as any;
  return { ...spy, storage, ctx, core: createCore(ctx) };
}
// prettier-ignore
const rows: Array<[string, object, string, (c: ReturnType<typeof boot>) => void]> = [
  ["hot", {}, "hot", () => (tier.hot = ok)], ["pointer", {}, "pointer", () => (tier.ptr = ok)], ["cold", {}, "cold", () => {}],
  ["hybrid", { mode: "hybrid" }, "cold", () => {}], ["fts", {}, "fts", (c) => (c.ctx.embed.model = "none")],
  ["L3", {}, "l3_cache", (c) => (c.storage.lookupQueryCache = async () => ({ resultIds: ["f1"], resultKinds: ["fact"] }))],
  ["budget-empty", { tokenBudget: 100 }, "none", () => {}],
];
// prettier-ignore
describe("createCore recall boundary finalization", () => {
  it.each(rows)("%s: one observation with final ids, ranks and phase time", async (_n, q, t, setup) => {
    const c = boot();
    setup(c);
    const res = await c.core.recall({ ...query, ...q }, auth);
    const [req, hits] = c.record.mock.calls[0] as any[];
    expect(c.record).toHaveBeenCalledTimes(1);
    expect(hits.map((h: any) => [h.memoryId, h.rank])).toEqual(res.hits.map((h, i) => [h.id, i]));
    expect(req).toMatchObject({ resultCount: res.hits.length, tiers: t === "none" ? [] : [t] });
    expect(typeof req.phaseDurationsMs.embedding).toBe(["fts", "none"].includes(t) ? "undefined" : "number");
    expect(c.recall).not.toHaveBeenCalled();
  });
  it("provider error: one error observation, error rethrown", async () => {
    const c = boot(vi.fn().mockRejectedValue(new Error("down")));
    await expect(c.core.recall({ ...query, mode: "semantic" }, auth)).rejects.toThrow();
    expect(c.record.mock.calls.map((a) => a[0])).toMatchObject([{ status: "error", resultCount: 0 }]);
  });
  it.each([[{}, 1, 1], [{ observation: { trafficOrigin: "synthetic" } }, 0, 1], [{ deferEffects: true }, 0, 0], [{ deferObservation: true }, 1, 0]])(
    "%j: %i cold promotions, %i observations", async (opts, promoted, observed) => {
      const c = boot();
      await c.core.recall(query, auth, opts as never);
      await new Promise((r) => setTimeout(r, 0));
      expect([c.zincrby.mock.calls.length, c.record.mock.calls.length]).toEqual([promoted, observed]);
    });
});

// prettier-ignore
describe("observation finalization at the outer recall boundary", () => {
  it("a stalled observation store cannot block a completed recall or its rethrow", async () => {
    const c = boot();
    c.record.mockImplementation(() => new Promise(() => undefined));
    await expect(c.core.recall(query, auth)).resolves.toMatchObject({ hits: expect.any(Array) });
    await expect(c.core.recall({ ...query, tokenBudget: 100 }, auth)).resolves.toMatchObject({ hits: [] });
    const failing = boot(vi.fn().mockRejectedValue(new Error("down")));
    failing.record.mockImplementation(() => new Promise(() => undefined));
    await expect(failing.core.recall({ ...query, mode: "semantic" }, auth)).rejects.toThrow();
  }, 2_000);
  it("total duration spans the whole cascade, embedding included, on success and error", async () => {
    const slow = (fail: boolean) => async () => {
      await new Promise((r) => setTimeout(r, 60));
      if (fail) throw new Error("down");
      return new Float32Array(4).fill(0.1);
    };
    const c = boot(slow(false));
    await c.core.recall(query, auth);
    const [req] = c.record.mock.calls[0] as any[];
    expect(req.totalDurationMs).toBeGreaterThanOrEqual(50);
    expect(req.totalDurationMs).toBeGreaterThanOrEqual(req.phaseDurationsMs.embedding);
    const e = boot(slow(true));
    await expect(e.core.recall({ ...query, mode: "semantic" }, auth)).rejects.toThrow();
    expect((e.record.mock.calls[0] as any[])[0].totalDurationMs).toBeGreaterThanOrEqual(50);
  });
});

// prettier-ignore
describe("effects gate reaches every tier", () => {
  it.each([[{}, true], [{ observation: { trafficOrigin: "synthetic" } }, false], [{ observation: { trafficOrigin: "test" } }, false], [{ deferEffects: true }, false]])(
    "%j: hot and pointer tiers receive runEffects=%s", async (opts, expected) => {
      const c = boot();
      await c.core.recall(query, auth, opts as never);
      expect(tier.effects).toEqual([["hot", expected], ["pointer", expected]]);
    });
  it("a query the server classified as non-organic trains no tier and is observed as synthetic", async () => {
    const c = boot();
    const effects = { trafficOrigin: "installer_verify", applyOrganicEffects: false } as const;
    await c.core.recall({ ...query, effects }, auth, { observation: { trafficOrigin: "unknown" } } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(tier.effects).toEqual([["hot", false], ["pointer", false]]);
    expect(c.zincrby).not.toHaveBeenCalled();
    expect((c.record.mock.calls[0] as any[])[0]).toMatchObject({ trafficOrigin: "synthetic" });
  });
});

// prettier-ignore
describe("deferred observation exposes measured serving metadata", () => {
  it.each(rows)("%s: onRecallMeta reports the actual tier, cache hit and phases", async (_n, q, t, setup) => {
    const c = boot();
    setup(c);
    const onRecallMeta = vi.fn();
    await c.core.recall({ ...query, ...q }, auth, { deferObservation: true, onRecallMeta });
    expect(c.record).not.toHaveBeenCalled();
    expect(onRecallMeta).toHaveBeenCalledTimes(1);
    const meta = onRecallMeta.mock.calls[0]![0];
    expect(meta).toMatchObject({ tiers: t === "none" ? [] : [t], cacheHit: t === "l3_cache" });
    expect(typeof meta.phaseDurationsMs.embedding).toBe(["fts", "none"].includes(t) ? "undefined" : "number");
  });
});

describe("hot/pointer deferred reinforcement", () => {
  const fh = (id: string, sensitivity: string) =>
    ({ ...hit(0, "fact"), id, sensitivity }) as RecallHit;
  const limited = { actorId: "a", actorType: "agent", scopes: ["memory:read"] } as AuthContext;
  const cx = () => {
    const zincrby = vi.fn(async () => 0);
    return { zincrby, ctx: { cache: { zincrby }, config: { maxHotTierSize: 10 } } as any };
  };

  it.each([
    [true, 1],
    [false, 0],
  ])("hot and pointer tiers: runEffects=%s -> %i bumps each", async (run, n) => {
    const actual = await vi.importActual<typeof import("../recall-hot.js")>("../recall-hot.js");
    const ptr =
      await vi.importActual<typeof import("../recall-pointer.js")>("../recall-pointer.js");
    const text = "alpha beta gamma";
    const emb = new Float32Array(4).fill(0.5);
    const fact = {
      id: "f1",
      statement: text,
      sensitivity: "internal",
      worth: 0.9,
      status: "active",
      validTo: null,
      createdAt: new Date(0),
    };
    const cand = (i: number) => ({
      ...fact,
      factId: `p${i}`,
      embedding: emb,
      attribution: "user_stated",
      tags: [],
    });
    const { zincrby, ctx } = cx();
    Object.assign(ctx, {
      embed: { embedSingle: async () => emb },
      telemetry: { startSpan: () => ({ end() {}, setAttribute() {} }), histogram() {} },
      logger: { debug() {}, warn() {} },
      storage: {
        getFact: async () => fact,
        pointerCandidates: async () => [cand(1), cand(2), cand(3)],
        getRelations: async () => [],
        getRecallLog: async () => [],
      },
    });
    ctx.cache.zrangeByScore = async () => ["f1"];
    const q = { workspaceId: "w", text, limit: 1 } as RecallQuery;
    await actual.tryHotTier(ctx, q, auth, undefined, run).catch(() => null);
    expect(zincrby).toHaveBeenCalledTimes(n);
    zincrby.mockClear();
    await actual.recallHot(ctx, "w", auth, 10, true, undefined, 0, run);
    expect(zincrby).toHaveBeenCalledTimes(n);
    zincrby.mockClear();
    await ptr.tryPointerTier(ctx, q, auth, undefined, run);
    await new Promise((r) => setTimeout(r, 0));
    expect(zincrby).toHaveBeenCalledTimes(n);
  });

  it("organic finalization bumps delivered eligible facts once, skipping filtered ones", async () => {
    const { zincrby, ctx } = cx();
    const actual = await vi.importActual<typeof import("../recall-hot.js")>("../recall-hot.js");
    const hits = [
      fh("a", "internal"),
      fh("a", "internal"),
      fh("s", "restricted"),
      hit(1, "episode"),
    ];
    expect(actual.hotReinforcementIds(hits, limited)).toEqual(["a"]);
    await actual.reinforceDeliveredHot(ctx, "w", hits, limited);
    expect(zincrby.mock.calls).toEqual([["mnemo:w:hot:facts", 1, "a"]]);
  });
});
