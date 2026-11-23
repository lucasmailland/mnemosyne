/**
 * P16 — Entity embedding recall unit tests.
 *
 * Covers:
 *   7.1 — Entity hit merged with x0.85 dampening (score = cosine * ENTITY_SCORE_DAMPEN;
 *         WP-3 removed the 0.6 activation blend and the multiplicative worth)
 *   7.2 — viewEntity() returns real sensitivity (not hardcoded "internal")
 *   7.3 — findSimilarEntities is called once per recallCold invocation (Stage 2 parallel)
 */
import { describe, it, expect, vi } from "vitest";
import { recallCold } from "../recall-cold.js";
import type { AuthContext, MnemoEntity } from "@mnemo-ai/types";

// Stub compositionality so these tests don't need a real LLM.
vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));
// Stub injection scoring to be deterministic (no flagging).
vi.mock("../../security/injection.js", () => ({
  scoreInjection: vi.fn(() => ({ flagged: false, score: 0 })),
  DEFAULT_INJECTION_THRESHOLD: 0.5,
}));

const AUTH: AuthContext = {
  actorType: "agent",
  actorId: "a1",
  workspaceId: "ws",
  scopes: ["memory:read"],
  sessionId: "sess-1",
} as unknown as AuthContext;

const AUTH_CONFIDENTIAL: AuthContext = {
  ...AUTH,
  scopes: ["memory:read", "memory:admin"],
} as unknown as AuthContext;

const QUERY = {
  workspaceId: "ws",
  text: "test query",
  embedding: new Float32Array(4).fill(0.25),
  limit: 10,
  offset: 0,
  includeLowWorth: true,
};

/** Minimal entity record for mock getEntity responses. */
function makeEntity(overrides: Partial<MnemoEntity> = {}): MnemoEntity {
  return {
    id: "e1",
    workspaceId: "ws",
    name: "Qubo",
    kind: "organization",
    description: "Edge AI hardware company",
    aliases: [],
    sensitivity: "internal",
    mentionCount: 1,
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    metadata: {},
    ...overrides,
  } as unknown as MnemoEntity;
}

/**
 * Build a minimal CoreContext where:
 *  - ctx.vector.search returns no fact hits
 *  - ctx.storage.findSimilarEntities returns the given entity hits
 *  - ctx.storage.getEntity returns a mock entity for id "e1"
 */
function makeCtx(
  entityResults: Array<{ id: string; cosine: number }>,
  entityOverride: Partial<MnemoEntity> = {}
) {
  const storage = {
    getFact: vi.fn(async () => null),
    getDecision: vi.fn(async () => null),
    getEpisode: vi.fn(async () => null),
    getEntity: vi.fn(async (id: string) => (id === "e1" ? makeEntity(entityOverride) : null)),
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
    getRecallLog: vi.fn(async () => []),
    findSimilarEntities: vi.fn(async () => entityResults),
  };

  const embed = {
    model: "test",
    dimensions: 4,
    embedSingle: vi.fn(async () => new Float32Array(4).fill(0.25)),
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(4).fill(0.25))),
  };

  const vector = {
    // Return no fact hits so only entity hits come through.
    search: vi.fn(async () => []),
  };

  const telemetry = {
    startSpan: vi.fn(() => ({
      end: vi.fn(),
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
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

  return { storage, embed, vector, telemetry, logger, outbox, config: {} } as any;
}

// ─── 7.1 Entity score dampening ──────────────────────────────────────────────

describe("P16 — Stage 2: entity hits merged with x0.85 dampening", () => {
  it("entity with cosine 1.0 produces score 1.0 × 0.85 and keeps the raw cosine as similarity", async () => {
    const ctx = makeCtx([{ id: "e1", cosine: 1.0 }]);
    const res = await recallCold(ctx, QUERY, AUTH);
    // WP-3: score = cosine × ENTITY_SCORE_DAMPEN × worth prior (entities have
    // no worth → 1.0) × activation tie-break (no history → 1.0).
    expect(res.hits).toHaveLength(1);
    const hit = res.hits[0]!;
    expect(hit.id).toBe("e1");
    expect(hit.primitive).toBe("entity");
    expect(hit.score).toBeCloseTo(0.85, 3);
    // The damping is a ranking weight; the evidence stays raw.
    expect(hit.similarity).toBe(1.0);
  });

  it("entity with cosine 0.5 produces score 0.5 × 0.85 = 0.425", async () => {
    const ctx = makeCtx([{ id: "e1", cosine: 0.5 }]);
    const res = await recallCold(ctx, QUERY, AUTH);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]!.score).toBeCloseTo(0.425, 3);
  });
});

// ─── 7.2 viewEntity sensitivity fix ─────────────────────────────────────────

describe("P16 — viewEntity propagates real sensitivity (not hardcoded internal)", () => {
  it("confidential entity returns sensitivity='confidential'", async () => {
    const ctx = makeCtx([{ id: "e1", cosine: 0.9 }], { sensitivity: "confidential" });
    // AUTH_CONFIDENTIAL has memory:admin scope so confidential is allowed.
    const res = await recallCold(ctx, QUERY, AUTH_CONFIDENTIAL);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]!.sensitivity).toBe("confidential");
  });

  it("internal caller cannot see confidential entity (ceiling filter)", async () => {
    const ctx = makeCtx([{ id: "e1", cosine: 0.9 }], { sensitivity: "confidential" });
    // AUTH only has memory:read (ceiling = internal) — should get 0 hits.
    const res = await recallCold(ctx, QUERY, AUTH);
    expect(res.hits).toHaveLength(0);
  });

  it("internal entity is visible to internal caller", async () => {
    const ctx = makeCtx([{ id: "e1", cosine: 0.9 }], { sensitivity: "internal" });
    const res = await recallCold(ctx, QUERY, AUTH);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]!.sensitivity).toBe("internal");
  });

  it("null sensitivity defaults to internal", async () => {
    // Simulate pre-P15 row where sensitivity column is null.
    const ctx = makeCtx([{ id: "e1", cosine: 0.9 }], { sensitivity: undefined as any });
    const res = await recallCold(ctx, QUERY, AUTH);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]!.sensitivity).toBe("internal");
  });
});

// ─── 7.3 Concurrent calls ────────────────────────────────────────────────────

describe("P16 — Stage 2 calls findSimilarEntities concurrently (Promise.all)", () => {
  it("findSimilarEntities is called exactly once per recallCold invocation", async () => {
    const ctx = makeCtx([{ id: "e1", cosine: 0.8 }]);
    await recallCold(ctx, QUERY, AUTH);
    expect(ctx.storage.findSimilarEntities).toHaveBeenCalledTimes(1);
    expect(ctx.storage.findSimilarEntities).toHaveBeenCalledWith(
      "ws",
      expect.any(Array),
      1000,
      0.3
    );
  });

  it("vector.search is also called once in the same Stage 2", async () => {
    const ctx = makeCtx([]);
    await recallCold(ctx, QUERY, AUTH);
    expect(ctx.vector.search).toHaveBeenCalledTimes(1);
  });

  it("empty findSimilarEntities still returns fact-only results without error", async () => {
    // Vector returns one fact hit; findSimilarEntities returns empty.
    const ctx = makeCtx([]);
    ctx.vector.search.mockResolvedValue([{ id: "f1", score: 0.8, primitiveKind: "fact" }]);
    ctx.storage.getFact.mockResolvedValue({
      id: "f1",
      workspaceId: "ws",
      statement: "test",
      kind: "preference",
      sensitivity: "internal",
      worth: 1.0,
      worthAlpha: 20,
      worthBeta: 2,
      attribution: "user_stated",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validTo: null,
      status: "active",
    });
    ctx.storage.getRecallLog.mockResolvedValue([]);
    const res = await recallCold(ctx, QUERY, AUTH);
    // Should return the one fact hit, no error.
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]!.primitive).toBe("fact");
  });
});
