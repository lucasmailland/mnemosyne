/**
 * Spec §17: Cold tier "Always → promote top-3 to hot tier".
 * Tests that recallCold() fires coldBumpHotTier() for exactly the right ids.
 *
 * Strategy: mock heavyweight deps (embed, vector, storage, telemetry) and
 * verify that ctx.cache.zincrby is called with exactly the top-3 fact ids
 * that appear in the final response.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RecallQuery, AuthContext, RecallHit } from "@mnemo-ai/types";

// Stub compositionality so it doesn't need a real LLM.
vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));
// Stub injection so it doesn't produce scores that affect ordering unpredictably.
vi.mock("../../security/injection.js", () => ({
  scoreInjection: vi.fn(() => ({ flagged: false, score: 0 })),
  DEFAULT_INJECTION_THRESHOLD: 0.5,
}));

const { recallCold } = await import("../recall-cold.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Primitive = "fact" | "episode" | "decision";

interface FakeHit {
  id: string;
  primitive: Primitive;
  score: number;
}

/** Build a minimal ctx for cold-recall with configurable hits and an optional cache spy. */
function makeCtx(hits: FakeHit[], zincrby?: ReturnType<typeof vi.fn>) {
  // The vector adapter returns the pre-configured hits as search results.
  const vectorSearch = vi.fn(async () =>
    hits.map((h) => ({ id: h.id, score: h.score, primitiveKind: h.primitive }))
  );

  // A storage adapter that returns a minimal fact/episode for each hit id.
  const getFact = vi.fn(async (id: string, _ws: string) => {
    const h = hits.find((x) => x.id === id && x.primitive === "fact");
    if (!h) return null;
    return {
      id,
      workspaceId: "ws",
      statement: `content-${id}`,
      kind: "fact",
      sensitivity: "internal",
      worth: 0.9,
      worthAlpha: 20,
      worthBeta: 5,
      attribution: "user_stated",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validTo: null,
      status: "active",
    };
  });

  const storage = {
    getFact,
    getDecision: vi.fn(async () => null),
    getEpisode: vi.fn(async () => null),
    getEntity: vi.fn(async () => null),
    getStrategy: vi.fn(async () => null),
    getWorkflow: vi.fn(async () => null),
    getSkill: vi.fn(async () => null),
    getTask: vi.fn(async () => null),
    getEvent: vi.fn(async () => null),
    getReasoning: vi.fn(async () => null),
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

  // Give each text a distinct embedding so dedup (cosine > 0.88) does not collapse them.
  const embed = {
    embedSingle: vi.fn(async () => new Float32Array(4).fill(0.1)),
    embed: vi.fn(async (texts: string[]) =>
      texts.map((t, i) => {
        const arr = new Float32Array(4);
        arr[i % 4] = 1.0; // unit vector in a unique dimension → orthogonal to others
        return arr;
      })
    ),
  };

  const telemetry = {
    startSpan: vi.fn(() => ({ end: vi.fn(), setAttribute: vi.fn() })),
    histogram: vi.fn(),
  };

  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return this;
    },
  };

  const outbox = { append: vi.fn(async () => undefined) };

  const cache = zincrby
    ? {
        id: "fake-cache",
        capabilities: { sortedSets: true, pubSub: false, patterns: false, atomic: false },
        zincrby,
      }
    : undefined;

  return {
    ctx: {
      storage,
      embed,
      vector: { search: vectorSearch },
      telemetry,
      logger,
      outbox,
      cache,
    } as any,
    zincrby,
    vectorSearch,
  };
}

const QUERY: RecallQuery = {
  workspaceId: "ws",
  text: "test query",
  limit: 10,
  offset: 0,
};

const AUTH: AuthContext = {
  actorId: "agent-1",
  workspaceId: "ws",
  scopes: ["memory:read"],
  sessionId: "sess-1",
} as unknown as AuthContext;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("§17 cold-tier hot-promotion: top-3 fact hits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("promotes exactly top-3 fact ids when ≥4 fact hits are returned", async () => {
    const zincrby = vi.fn(async (_key: string, _inc: number, _member: string) => 1);
    const hits: FakeHit[] = [
      { id: "f-1", primitive: "fact", score: 0.95 },
      { id: "f-2", primitive: "fact", score: 0.9 },
      { id: "f-3", primitive: "fact", score: 0.85 },
      { id: "f-4", primitive: "fact", score: 0.8 },
    ];
    const { ctx } = makeCtx(hits, zincrby);

    const resp = await recallCold(ctx, QUERY, AUTH);

    // Give the fire-and-forget Promise.allSettled a tick to resolve.
    await new Promise((r) => setTimeout(r, 0));

    expect(resp.hits.length).toBeGreaterThanOrEqual(3);

    // zincrby must be called exactly 3 times (top-3 only).
    expect(zincrby).toHaveBeenCalledTimes(3);

    // All 3 calls must use the correct hot-tier key format.
    const calledKey = `mnemo:ws:hot:facts`;
    for (const call of zincrby.mock.calls) {
      expect(call[0]).toBe(calledKey);
      expect(call[1]).toBe(1); // increment by 1
    }

    // The promoted member ids must be the top-3 from the final response.
    const promotedIds = zincrby.mock.calls.map((c) => c[2] as string);
    const topThreeIds = resp.hits.slice(0, 3).map((h: RecallHit) => h.id);
    expect(new Set(promotedIds)).toEqual(new Set(topThreeIds));
  });

  it("serves synthetic traffic without logging, promoting or learning from it", async () => {
    const zincrby = vi.fn(async () => 1);
    const hits: FakeHit[] = [
      { id: "f-1", primitive: "fact", score: 0.95 },
      { id: "f-2", primitive: "fact", score: 0.9 },
      { id: "f-3", primitive: "fact", score: 0.85 },
    ];
    const { ctx } = makeCtx(hits, zincrby);
    ctx.config = { recallGraphLearning: true };
    ctx.storage.recordCoRecallStdp = vi.fn(async () => undefined);
    ctx.storage.createHyperedge = vi.fn(async () => ({ id: "h" }));

    const resp = await recallCold(
      ctx,
      { ...QUERY, effects: { trafficOrigin: "evaluation", applyOrganicEffects: false } },
      AUTH
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(resp.hits.length).toBe(3);
    expect(ctx.storage.recordRecall).not.toHaveBeenCalled();
    expect(zincrby).not.toHaveBeenCalled();
    expect(ctx.storage.recordCoRecallStdp).not.toHaveBeenCalled();
    expect(ctx.storage.createHyperedge).not.toHaveBeenCalled();
  });

  it("promotes only what exists when fewer than 3 fact hits are returned", async () => {
    const zincrby = vi.fn(async () => 1);
    const hits: FakeHit[] = [
      { id: "f-1", primitive: "fact", score: 0.95 },
      { id: "f-2", primitive: "fact", score: 0.9 },
    ];
    const { ctx } = makeCtx(hits, zincrby);

    const resp = await recallCold(ctx, QUERY, AUTH);
    await new Promise((r) => setTimeout(r, 0));

    // Only 2 facts returned — expect exactly 2 promotions.
    const factHitsCount = resp.hits.filter((h: RecallHit) => h.primitive === "fact").length;
    expect(zincrby).toHaveBeenCalledTimes(Math.min(factHitsCount, 2));
  });

  it("does not throw when ctx.cache is absent", async () => {
    const hits: FakeHit[] = [
      { id: "f-1", primitive: "fact", score: 0.9 },
      { id: "f-2", primitive: "fact", score: 0.8 },
      { id: "f-3", primitive: "fact", score: 0.7 },
    ];
    // No cache → undefined
    const { ctx } = makeCtx(hits, undefined);

    await expect(recallCold(ctx, QUERY, AUTH)).resolves.toBeDefined();
  });

  it("does not throw when ctx.cache.zincrby is absent", async () => {
    const hits: FakeHit[] = [{ id: "f-1", primitive: "fact", score: 0.9 }];
    const { ctx } = makeCtx(hits, undefined);
    // Attach a cache without zincrby.
    ctx.cache = {
      id: "no-zset",
      capabilities: { sortedSets: false, pubSub: false, patterns: false, atomic: false },
      // zincrby is intentionally absent
    };

    await expect(recallCold(ctx, QUERY, AUTH)).resolves.toBeDefined();
  });

  it("does not promote non-fact hits (episodes, decisions)", async () => {
    const zincrby = vi.fn(async () => 1);
    // First 3 hits are non-facts; only 1 fact deeper in the list.
    const hits: FakeHit[] = [
      { id: "e-1", primitive: "episode", score: 0.99 },
      { id: "e-2", primitive: "episode", score: 0.98 },
      { id: "e-3", primitive: "episode", score: 0.97 },
      { id: "f-1", primitive: "fact", score: 0.8 },
    ];
    const { ctx } = makeCtx(hits, zincrby);

    await recallCold(ctx, QUERY, AUTH);
    await new Promise((r) => setTimeout(r, 0));

    // Episodes must never be promoted.
    const promotedIds = zincrby.mock.calls.map((c) => c[2] as string);
    for (const id of promotedIds) {
      expect(id).not.toMatch(/^e-/);
    }
  });
});
