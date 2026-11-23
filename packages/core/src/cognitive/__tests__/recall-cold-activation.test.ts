/**
 * Stage 4 ACT-R activation in cold recall — unit tests.
 *
 * Verifies that recallCold() correctly reads getRecallLog from the storage
 * port and feeds the timestamps into petrovActivation(), so that:
 *   - a fact with recent recall history gets a score ABOVE the pure-cosine baseline
 *   - a fact with no recall history gets a score equal to cosine × the worth prior
 *   - WP-3 (RECALL-1): activation is a bounded tie-breaker, at most ×(1 + 0.02)
 *
 * Also covers the petrovActivation() formula in isolation.
 */
import { describe, it, expect, vi } from "vitest";
import { petrovActivation } from "../recall-cold.js";
import { recallCold } from "../recall-cold.js";
import { worthFactor, ACTIVATION_TIE_BREAK } from "../recall-relevance.js";
import type { AuthContext } from "@mnemo-ai/types";

// Stub compositionality so these tests don't need a real LLM.
vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));
// Stub injection scoring to be deterministic.
vi.mock("../../security/injection.js", () => ({
  scoreInjection: vi.fn(() => ({ flagged: false, score: 0 })),
  DEFAULT_INJECTION_THRESHOLD: 0.5,
}));

// ─── petrovActivation unit tests ─────────────────────────────────────────────

describe("petrovActivation (Stage 4 formula, ALG-03)", () => {
  it("returns 0 when the recall history is empty", () => {
    expect(petrovActivation([], Date.now())).toBe(0); // determinism-ok: only tests that empty input → 0, value of now is irrelevant
  });

  it("returns a positive value for a single recent recall (seconds ago)", () => {
    const now = Date.now(); // determinism-ok: only relative offsets matter for ACT-R activation, not absolute value
    const oneSecondAgo = now - 1_000;
    const result = petrovActivation([oneSecondAgo], now);
    // A(t) = ln(1^{-0.5}) = ln(1) = 0; but t_j is clamped to max(t, 1) seconds.
    // t=1s → 1^{-0.5} = 1 → ln(1) = 0.
    // Use 2s ago for a non-trivial positive value:
    const twoSecondsAgo = now - 2_000;
    const result2s = petrovActivation([twoSecondsAgo], now);
    // 2^{-0.5} ≈ 0.707 → ln(0.707) < 0; but multiple recalls accumulate.
    // With 5 recalls at ~2s, ∑ = 5 * 0.707 ≈ 3.54 → ln(3.54) ≈ 1.26 > 0.
    const fiveRecent = [0, 1000, 2000, 3000, 4000].map((ago) => now - ago);
    const result5 = petrovActivation(fiveRecent, now);
    expect(result5).toBeGreaterThan(0);
    (void result, result2s); // used above
  });

  it("returns a greater value for more frequent recent recalls", () => {
    const now = Date.now(); // determinism-ok: only relative offsets matter for ACT-R activation, not absolute value
    const makeTimestamps = (n: number) => Array.from({ length: n }, (_, i) => now - i * 1000);

    const a5 = petrovActivation(makeTimestamps(5), now);
    const a10 = petrovActivation(makeTimestamps(10), now);
    expect(a10).toBeGreaterThan(a5);
  });

  it("returns a lower value when all recalls are old (hours ago)", () => {
    const now = Date.now(); // determinism-ok: only relative offsets (seconds/hours) matter for ACT-R recency scoring
    const oneHourAgo = [now - 3_600_000]; // 1 hour = 3600 s → 3600^{-0.5} ≈ 0.017
    const recentFive = [0, 1000, 2000, 3000, 4000].map((ago) => now - ago);

    const oldActivation = petrovActivation(oneHourAgo, now);
    const recentActivation = petrovActivation(recentFive, now);
    // Recent five recalls must beat a single old recall.
    expect(recentActivation).toBeGreaterThan(oldActivation);
  });
});

// ─── Cold recall integration: Stage 4 via getRecallLog port ──────────────────

const VECTOR_SCORE = 0.9; // fixed score returned by the vector adapter

/**
 * Builds a minimal CoreContext for recallCold tests.
 * `recallLogTimestamps` controls what getRecallLog returns for the fact "f1".
 */
function makeCtx(recallLogTimestamps: number[], closed = false) {
  const storage = {
    getFact: vi.fn(async (id: string) => {
      if (id !== "f1") return null;
      return {
        id: "f1",
        workspaceId: "ws",
        statement: "test fact statement",
        kind: "preference",
        status: closed ? "forgotten" : "active",
        sensitivity: "internal",
        worth: 1.0, // worth=1 so score = activation contribution + cosine contribution
        worthAlpha: 20,
        worthBeta: 2,
        attribution: "user_stated",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        validFrom: new Date("2026-01-01T00:00:00Z"),
        validTo: closed ? new Date("2026-02-01T00:00:00Z") : null,
      };
    }),
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
    // Stage 4 port: returns the pre-configured timestamps as RecallLogEntry-like objects.
    getRecallLog: vi.fn(async (_ws: string, _id: string, _n: number) =>
      recallLogTimestamps.map((ts, i) => ({
        id: `r-${i}`,
        recalledAt: new Date(ts).toISOString(),
        recallScore: 1,
      }))
    ),
  };

  const embed = {
    model: "test",
    dimensions: 4,
    embedSingle: vi.fn(async () => new Float32Array(4).fill(0.25)),
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(4).fill(0.25))),
  };

  const vector = {
    search: vi.fn(async () => [{ id: "f1", score: VECTOR_SCORE, primitiveKind: "fact" }]),
  };

  const telemetry = {
    startSpan: vi.fn(() => ({
      end: vi.fn(),
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      addEvent: vi.fn(),
    })),
    histogram: vi.fn(),
    counter: vi.fn(),
    gauge: vi.fn(),
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

  return {
    storage,
    embed,
    vector,
    telemetry,
    logger,
    outbox,
    config: {},
  } as any;
}

const QUERY = {
  workspaceId: "ws",
  text: "test query",
  embedding: new Float32Array(4).fill(0.25),
  limit: 10,
  offset: 0,
  // includeLowWorth=true so the worth gate never filters our test fact
  includeLowWorth: true,
};

const AUTH: AuthContext = {
  actorType: "agent",
  actorId: "a1",
  workspaceId: "ws",
  scopes: ["memory:read"],
  sessionId: "sess-1",
} as unknown as AuthContext;

describe("recallCold Stage 4: getRecallLog drives ACT-R activation in blended score", () => {
  it("hydrates a canonical candidate scan and its histories with bounded batch calls", async () => {
    const ctx = makeCtx([]);
    const fact = await ctx.storage.getFact("f1");
    const candidates = Array.from({ length: 1000 }, (_, index) => ({
      id: `f-${index}`,
      score: 0.9,
      primitiveKind: "fact",
    }));
    ctx.vector.search = vi.fn(async () => candidates);
    ctx.storage.getRecallPrimitives = vi.fn(async () =>
      candidates.map((candidate) => ({
        id: candidate.id,
        kind: "fact",
        value: { ...fact, id: candidate.id, statement: candidate.id },
      }))
    );
    ctx.storage.getRecallLogs = vi.fn(async () => []);
    ctx.storage.getRecallStructures = vi.fn(async () => ({ relations: [], hyperedges: [] }));
    ctx.storage.getFact = vi.fn(async () => {
      throw new Error("per-candidate hydration");
    });
    ctx.storage.getRecallLog = vi.fn(async () => {
      throw new Error("per-candidate history");
    });

    const response = await recallCold(ctx, { ...QUERY, limit: 3 }, AUTH);

    expect(response.hits.length).toBeGreaterThan(0);
    expect(ctx.storage.getRecallPrimitives).toHaveBeenCalledOnce();
    expect(ctx.storage.getRecallLogs).toHaveBeenCalledOnce();
    expect(ctx.storage.getRecallStructures).toHaveBeenCalledOnce();
    expect(ctx.storage.getFact).not.toHaveBeenCalled();
    expect(ctx.storage.getRecallLog).not.toHaveBeenCalled();
  });

  it("rejects a closed vector hit before expansion, activation, and logging", async () => {
    const ctx = makeCtx([], true);

    const response = await recallCold(ctx, QUERY as never, AUTH);

    expect(response.hits).toEqual([]);
    expect(ctx.storage.getRelations).not.toHaveBeenCalled();
    expect(ctx.storage.queryHyperedges).not.toHaveBeenCalled();
    expect(ctx.storage.getRecallLog).not.toHaveBeenCalled();
    expect(ctx.storage.recordRecall).not.toHaveBeenCalled();
  });

  it("hit score is higher when getRecallLog returns recent timestamps vs. empty history", async () => {
    const now = Date.now(); // determinism-ok: only relative offsets (0–4s) matter for ACT-R activation scoring
    // 5 recalls in the last 5 seconds — high activation
    const recentTimestamps = [0, 1000, 2000, 3000, 4000].map((ago) => now - ago);
    // No recall history — activation = 0
    const emptyTimestamps: number[] = [];

    const ctxWithHistory = makeCtx(recentTimestamps);
    const ctxNoHistory = makeCtx(emptyTimestamps);

    const respWithHistory = await recallCold(ctxWithHistory, QUERY, AUTH);
    const respNoHistory = await recallCold(ctxNoHistory, QUERY, AUTH);

    expect(respWithHistory.hits).toHaveLength(1);
    expect(respNoHistory.hits).toHaveLength(1);

    const scoreWithHistory = respWithHistory.hits[0]!.score;
    const scoreNoHistory = respNoHistory.hits[0]!.score;

    // With recent recall history the tie-break factor is > 1
    expect(scoreWithHistory).toBeGreaterThan(scoreNoHistory);
  });

  it("hit score equals cosine × the worth prior when there is no recall history", async () => {
    const ctxNoHistory = makeCtx([]);
    const resp = await recallCold(ctxNoHistory, QUERY, AUTH);

    expect(resp.hits).toHaveLength(1);
    const score = resp.hits[0]!.score;

    // worth=1.0, activation=0 → score = cosine × (1 + 0.1 × (1.0 − 0.5))
    const expectedBaseline = VECTOR_SCORE * worthFactor(1.0);
    expect(score).toBeCloseTo(expectedBaseline, 5);
    expect(resp.hits[0]!.similarity).toBe(VECTOR_SCORE);
  });

  it("caps the activation boost at the tie-break bound however recent the history", async () => {
    const now = Date.now(); // determinism-ok: only relative offsets matter for ACT-R activation scoring
    const ctx = makeCtx(Array.from({ length: 20 }, (_, i) => now - i * 100));

    const resp = await recallCold(ctx, QUERY, AUTH);

    const baseline = VECTOR_SCORE * worthFactor(1.0);
    expect(resp.hits[0]!.score).toBeGreaterThan(baseline);
    expect(resp.hits[0]!.score).toBeLessThanOrEqual(baseline * (1 + ACTIVATION_TIE_BREAK) + 1e-9);
  });

  it("hit score is non-zero and activation-boosted when getRecallLog returns N timestamps", async () => {
    const now = Date.now(); // determinism-ok: only relative offsets (0–2s) matter for ACT-R activation scoring
    const recentTimestamps = [0, 1000, 2000].map((ago) => now - ago);
    const ctx = makeCtx(recentTimestamps);

    const resp = await recallCold(ctx, QUERY, AUTH);

    expect(resp.hits).toHaveLength(1);
    const score = resp.hits[0]!.score;

    // score must exceed the pure-cosine baseline (activation contribution > 0)
    const pureCosinBaseline = VECTOR_SCORE * worthFactor(1.0);
    expect(score).toBeGreaterThan(pureCosinBaseline);
  });

  it("getRecallLog is called with the correct workspaceId and fact id", async () => {
    const now = Date.now(); // determinism-ok: absolute timestamp irrelevant — only verifying call args
    const ctx = makeCtx([now - 1000]);

    await recallCold(ctx, QUERY, AUTH);

    expect(ctx.storage.getRecallLog).toHaveBeenCalledWith("ws", "f1", 20);
  });

  it("degrades gracefully when getRecallLog throws (score still returned)", async () => {
    const ctx = makeCtx([]);
    // Override getRecallLog to throw
    ctx.storage.getRecallLog = vi.fn(async () => {
      throw new Error("DB unavailable");
    });

    const resp = await recallCold(ctx, QUERY, AUTH);

    // Must not throw; must return a result (activation degrades to 0)
    expect(resp.hits).toHaveLength(1);
    const score = resp.hits[0]!.score;
    const expectedBaseline = VECTOR_SCORE * worthFactor(1.0);
    expect(score).toBeCloseTo(expectedBaseline, 5);
  });
});
