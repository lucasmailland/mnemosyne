import { describe, it, expect, vi } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";

// composeInferences is exercised elsewhere; stub it so the hot-tier case isolates the trace.
vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));

const { recallCold } = await import("../recall-cold.js");
const { tryHotTier, hotTierKey } = await import("../recall-hot.js");

const ORDER = [
  "embed",
  "hot_tier",
  "pointer_tier",
  "cache",
  "vector",
  "lexical",
  "nonfact_candidates",
  "fusion",
  "eligibility",
  "dedup",
  "activation",
  "graph",
  "rerank",
  "response",
];

const AUTH: AuthContext = {
  workspaceId: "ws-1",
  actorId: "actor-1",
  scopes: ["memory:read", "memory:write"],
};

const FACT = (id: string, statement: string) => ({
  id,
  workspaceId: "ws-1",
  statement,
  kind: "preference",
  status: "active",
  sensitivity: "internal",
  worth: 0.9,
  createdAt: new Date("2026-01-01T00:00:00Z"), // determinism-ok: fixed test date
});

function makeColdCtx() {
  const facts: Record<string, ReturnType<typeof FACT>> = {
    a: FACT("a", "alpha statement about coffee"),
    b: FACT("b", "beta statement about tea"),
  };
  const nullGet = vi.fn(async () => null);
  const storage = {
    ftsCandidates: vi.fn(async () => [
      { factId: "a", workspaceId: "ws-1", statement: facts.a!.statement, rank: 0.9 },
    ]),
    getFact: vi.fn(async (id: string) => facts[id] ?? null),
    getDecision: nullGet,
    getEpisode: nullGet,
    getEntity: nullGet,
    getStrategy: nullGet,
    getWorkflow: nullGet,
    getSkill: nullGet,
    getTask: nullGet,
    getEvent: nullGet,
    getReasoning: nullGet,
    getRelations: vi.fn(async () => []),
    queryHyperedges: vi.fn(async () => ({
      items: [],
      total: 0,
      offset: 0,
      limit: 10,
      hasMore: false,
    })),
    recordRecall: vi.fn(async () => undefined),
  };
  const vector = {
    search: vi.fn(async () => [
      { id: "a", score: 0.85, primitiveKind: "fact" },
      { id: "b", score: 0.8, primitiveKind: "fact" },
    ]),
  };
  const embed = {
    id: "test-embedder",
    model: "text-embedding-3-small",
    dimensions: 4,
    embedSingle: vi.fn(async () => new Float32Array(4).fill(0.1)),
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(4).fill(0.1))),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const telemetry = {
    startSpan: vi.fn(() => ({ setAttribute: vi.fn(), end: vi.fn() })),
    histogram: vi.fn(),
  };
  const outbox = { append: vi.fn(async () => undefined) };
  return { storage, vector, embed, logger, telemetry, outbox, config: {} } as any;
}

describe("recall trace (debug: true)", () => {
  it("lists the stages that ran, in pipeline order, with sane counts", async () => {
    const res = await recallCold(
      makeColdCtx(),
      { workspaceId: "ws-1", text: "coffee", mode: "hybrid", debug: true },
      AUTH
    );
    const trace = res.debug!.trace!;
    const names = trace.map((s) => s.name);
    expect(names.length).toBeGreaterThan(0);
    // a subsequence of the canonical order, ending at the response
    const idx = names.map((n) => ORDER.indexOf(n));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((x, y) => x - y)).toEqual(idx);
    expect(names).toEqual(
      expect.arrayContaining(["vector", "lexical", "eligibility", "dedup", "response"])
    );
    expect(names.at(-1)).toBe("response");
    for (const s of trace) expect(s.ms).toBeGreaterThanOrEqual(0);
    for (const n of ["eligibility", "dedup"]) {
      const s = trace.find((x) => x.name === n)!;
      expect(s.candidatesOut).toBeLessThanOrEqual(s.candidatesIn);
    }
  });

  // C1: the vector port has no sensitivity filter, so a count taken before the
  // ceiling would tell a limited caller that a hidden memory sits near the query.
  function withRestrictedHit(vectorIds: string[]) {
    const ctx = makeColdCtx();
    const facts: Record<string, unknown> = {
      a: FACT("a", "alpha statement about coffee"),
      r: { ...FACT("r", "restricted statement about coffee"), sensitivity: "restricted" },
    };
    ctx.storage.getFact = vi.fn(async (id: string) => facts[id] ?? null);
    ctx.vector.search = vi.fn(async () =>
      vectorIds.map((id) => ({ id, score: 0.9, primitiveKind: "fact" }))
    );
    return ctx;
  }
  const BEFORE_ELIGIBILITY = ORDER.slice(0, ORDER.indexOf("eligibility"));
  const ADMIN: AuthContext = { ...AUTH, scopes: ["memory:read", "memory:admin"] };
  const coldTrace = async (ctx: unknown, auth: AuthContext, minSimilarity?: number) =>
    (
      await recallCold(
        ctx as never,
        {
          workspaceId: "ws-1",
          text: "coffee",
          debug: true,
          includeArchived: true,
          includeLowWorth: true,
          ...(minSimilarity !== undefined ? { minSimilarity } : {}),
        },
        auth
      )
    ).debug!.trace!;

  it("a limited caller sees no pre-ceiling counts, and eligibility excludes the hidden hit", async () => {
    const trace = await coldTrace(withRestrictedHit(["a", "r"]), AUTH);
    const early = trace.filter((s) => BEFORE_ELIGIBILITY.includes(s.name));
    expect(early.map((s) => s.name)).toContain("vector");
    for (const s of early) {
      expect(s.candidatesIn).toBeNull();
      expect(s.candidatesOut).toBeNull();
      expect(s.ms).toBeGreaterThanOrEqual(0);
    }
    const eligibility = trace.find((s) => s.name === "eligibility")!;
    expect(eligibility).toMatchObject({ candidatesIn: 1, candidatesOut: 1 });
  });

  it("an admin caller still sees the raw counts", async () => {
    const trace = await coldTrace(withRestrictedHit(["a", "r"]), ADMIN);
    expect(trace.find((s) => s.name === "vector")).toMatchObject({
      candidatesIn: 2,
      candidatesOut: 2,
    });
    expect(trace.find((s) => s.name === "eligibility")).toMatchObject({
      candidatesIn: 2,
      candidatesOut: 2,
    });
  });

  it("a limited caller's trace has the same stages whether or not a hidden hit is near", async () => {
    const names = async (ids: string[]) =>
      (await coldTrace(withRestrictedHit(ids), AUTH, 0.5)).map((s) => s.name);
    expect(await names(["r"])).toEqual(await names([]));
  });

  it("adds no trace and takes no timings when debug is absent", async () => {
    const spy = vi.spyOn(performance, "now");
    const res = await recallCold(makeColdCtx(), { workspaceId: "ws-1", text: "coffee" }, AUTH);
    expect(res.debug).toBeDefined();
    expect(res.debug!.trace).toBeUndefined();
    expect("trace" in res.debug!).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a hot-tier answer with debug: true carries a hot_tier stage", async () => {
    const ids = ["h1", "h2", "h3"];
    const z = new Map(ids.map((id, i) => [id, i + 1] as const));
    const cache = {
      capabilities: { sortedSets: true },
      zincrby: vi.fn(async () => undefined),
      zrangeByScore: vi.fn(async () => [...z.keys()]),
    };
    const now = Date.now(); // determinism-ok: only relative recency offsets matter
    const storage = {
      getFact: vi.fn(async (id: string) => ({
        ...FACT(id, `hot statement ${id}`),
        validFrom: new Date("2026-01-01T00:00:00Z"),
        worthAlpha: 20,
        worthBeta: 5,
        attribution: "user_stated",
      })),
      getRecallLog: vi.fn(async () =>
        [0, 1000, 2000, 3000, 4000].map((ago, i) => ({
          id: `r-${i}`,
          recalledAt: new Date(now - ago).toISOString(),
          recallScore: 1,
        }))
      ),
    };
    const ctx = {
      cache,
      storage,
      config: { maxHotTierSize: 1000 },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      },
      telemetry: { startSpan: () => ({ end() {} }), histogram: () => {} },
    } as any;
    void hotTierKey;
    const res = await tryHotTier(ctx, { workspaceId: "ws", text: "", debug: true }, AUTH);
    expect(res?.fromHotTier).toBe(true);
    const hot = res!.debug!.trace!.find((s) => s.name === "hot_tier");
    expect(hot).toBeDefined();
    // Before eligibility: a limited caller gets the stage and its time, not its counts.
    expect(hot).toMatchObject({ candidatesIn: null, candidatesOut: null });
    const admin = await tryHotTier(
      ctx,
      { workspaceId: "ws", text: "", debug: true },
      { ...AUTH, scopes: ["memory:read", "memory:admin"] }
    );
    expect(admin!.debug!.trace!.find((s) => s.name === "hot_tier")!.candidatesIn).toBe(3);
    const plain = await tryHotTier(ctx, { workspaceId: "ws", text: "" }, AUTH);
    expect(plain?.debug).toBeUndefined();
  });
});
