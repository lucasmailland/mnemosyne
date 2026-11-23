/**
 * make-primitives-recallable (design.md D4, tasks.md Phase 6 / PR4) — the
 * behaviour flip: `recall-cold`'s non-fact arm now calls
 * `storage.recallableCandidates?()` for decisions.
 *
 * Covers:
 *   6.3 — Default-kinds pin (spec.md Requirement 4): no `kinds` filter
 *         returns decisions; `kinds:["fact"]` returns none (and issues no
 *         `recallableCandidates` call at all); `kinds:["decision"]` returns
 *         only decisions — the non-fact arm runs and no fact hit survives
 *         the post-filter, even though the (unconditional, untouched) fact
 *         arm above it still ran (design.md D4's "driven by kinds, not
 *         post-filtering" applies to the non-fact arm only — the fact arm's
 *         invariant, Requirement 3, is that it is NEVER conditioned on
 *         `kinds` so its own ranking cannot move).
 *   6.4 — Damping/gating maths (×0.85 reusing ENTITY_SCORE_DAMPEN,
 *         minSimilarity 0.35) and sensitivity ceiling applying to decision
 *         hits exactly as to facts/entities (SENSITIVITY_ORDER-based,
 *         S5/S6 unchanged — this file proves the recall-cold-layer half:
 *         a decision above the caller's ceiling is dropped from `hits`,
 *         the same `sensitivityAllowed()` gate entities/facts go through).
 */
import { describe, it, expect, vi } from "vitest";
import { recallCold } from "../recall-cold.js";
import type { AuthContext, MnemoDecision, PrimitiveCandidate } from "@mnemo-ai/types";
import { DEFAULT_RECALL_KINDS } from "@mnemo-ai/types";

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

const AUTH_ADMIN: AuthContext = {
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

function makeDecision(overrides: Partial<MnemoDecision> = {}): MnemoDecision {
  return {
    id: "d1",
    workspaceId: "ws",
    kind: "architecture",
    title: "Use Postgres",
    body: "We chose Postgres for durability.",
    topicKey: undefined,
    revisionCount: 1,
    sensitivity: "internal",
    status: "active",
    validFrom: new Date("2026-01-01T00:00:00Z"),
    validTo: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    metadata: {},
    ...overrides,
  } as unknown as MnemoDecision;
}

/**
 * Build a minimal CoreContext where:
 *  - ctx.vector.search returns the given fact hits (default: none)
 *  - ctx.storage.recallableCandidates returns the given decision candidates
 *  - ctx.storage.getDecision returns a mock decision for id "d1"
 */
function makeCtx(
  decisionCandidates: PrimitiveCandidate[],
  decisionOverride: Partial<MnemoDecision> = {},
  factHits: Array<{ id: string; score: number; primitiveKind: string }> = []
) {
  const storage = {
    getFact: vi.fn(async () => null),
    getDecision: vi.fn(async (id: string) => (id === "d1" ? makeDecision(decisionOverride) : null)),
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
    getRecallLog: vi.fn(async () => []),
    findSimilarEntities: vi.fn(async () => []),
    recallableCandidates: vi.fn(async () => decisionCandidates),
  };

  const embed = {
    model: "test",
    dimensions: 4,
    embedSingle: vi.fn(async () => new Float32Array(4).fill(0.25)),
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(4).fill(0.25))),
  };

  const vector = {
    search: vi.fn(async () => factHits),
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

// ─── 6.3 Default-kinds pin ────────────────────────────────────────────────

describe("make-primitives-recallable — default-kinds pin (spec Req 4)", () => {
  it("returns a decision from lexical search without an embedding", async () => {
    const ctx = makeCtx([{ id: "d1", kind: "decision", score: 0.8, sensitivity: "internal" }]);
    ctx.storage.ftsCandidates = vi.fn(async () => []);
    const res = await recallCold(
      ctx,
      { ...QUERY, embedding: undefined, mode: "lexical", text: "session collapse write error" },
      AUTH
    );
    expect(res.hits.map((hit) => hit.id)).toEqual(["d1"]);
    expect(ctx.storage.recallableCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        terms: ["session", "collapse", "write", "error"],
        kinds: DEFAULT_RECALL_KINDS.filter((kind) => kind !== "fact"),
      })
    );
    expect(ctx.vector.search).not.toHaveBeenCalled();
  });

  it("excludes a withdrawn lexical decision", async () => {
    const ctx = makeCtx([{ id: "d1", kind: "decision", score: 0.8, sensitivity: "internal" }], {
      status: "withdrawn",
      validTo: new Date("2026-02-01T00:00:00Z"),
    });
    ctx.storage.ftsCandidates = vi.fn(async () => []);
    const res = await recallCold(ctx, { ...QUERY, embedding: undefined, mode: "lexical" }, AUTH);
    expect(res.hits).toEqual([]);
  });

  it("excludes a lexical decision above the caller's sensitivity ceiling", async () => {
    const ctx = makeCtx([{ id: "d1", kind: "decision", score: 0.8, sensitivity: "restricted" }], {
      sensitivity: "restricted",
    });
    ctx.storage.ftsCandidates = vi.fn(async () => []);
    const res = await recallCold(ctx, { ...QUERY, embedding: undefined, mode: "lexical" }, AUTH);
    expect(res.hits).toEqual([]);
  });

  it("DEFAULT_RECALL_KINDS includes both fact and decision (asserts the constant so it cannot drift silently)", () => {
    expect(DEFAULT_RECALL_KINDS).toContain("fact");
    expect(DEFAULT_RECALL_KINDS).toContain("decision");
  });

  it("no `kinds` filter → decisions are returned by default", async () => {
    const ctx = makeCtx([{ id: "d1", kind: "decision", score: 1.0, sensitivity: "internal" }]);
    const res = await recallCold(ctx, QUERY, AUTH);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]!.id).toBe("d1");
    expect(res.hits[0]!.primitive).toBe("decision");
    expect(ctx.storage.recallableCandidates).toHaveBeenCalledTimes(1);
    expect(ctx.storage.recallableCandidates).toHaveBeenCalledWith(
      // P65: DEFAULT_RECALL_KINDS gained `strategy` and `workflow`, so the
      // non-fact arm now asks for all three. Pinned against the constant
      // instead of a literal list, so the next kind added does not need this
      // assertion rewritten — and cannot silently drop out of the default set
      // either.
      expect.objectContaining({
        workspaceId: "ws",
        kinds: DEFAULT_RECALL_KINDS.filter((k) => k !== "fact"),
      })
    );
  });

  it("kinds:['fact'] → no decisions returned, and recallableCandidates is never called", async () => {
    const ctx = makeCtx([{ id: "d1", kind: "decision", score: 1.0, sensitivity: "internal" }]);
    const query = { ...QUERY, filter: { kinds: ["fact" as const] } };
    const res = await recallCold(ctx, query, AUTH);
    expect(res.hits).toHaveLength(0);
    expect(ctx.storage.recallableCandidates).not.toHaveBeenCalled();
  });

  it("kinds:['decision'] → the non-fact arm runs and only decisions are returned (fact hits from the unconditional fact arm are post-filtered out)", async () => {
    const ctx = makeCtx([{ id: "d1", kind: "decision", score: 1.0, sensitivity: "internal" }], {}, [
      { id: "f1", score: 0.9, primitiveKind: "fact" },
    ]);
    ctx.storage.getFact.mockResolvedValue({
      id: "f1",
      workspaceId: "ws",
      statement: "a fact that should not survive the kinds:['decision'] filter",
      kind: "other",
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
    const query = { ...QUERY, filter: { kinds: ["decision" as const] } };
    const res = await recallCold(ctx, query, AUTH);
    // The fact arm above is unconditional and untouched (Requirement 3) — it
    // still ran (ctx.vector.search was called and returned f1) — but no fact
    // hit is present in the final result once `kinds` excludes "fact".
    expect(ctx.vector.search).toHaveBeenCalledTimes(1);
    expect(res.hits.every((h) => h.primitive === "decision")).toBe(true);
    expect(res.hits.map((h) => h.id)).toEqual(["d1"]);
    expect(ctx.storage.recallableCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: ["decision"] })
    );
  });

  it("viewDecision content is `${title}\\n\\n${body}` — matches what was indexed (PRIMITIVE_TEXT_PROJECTION)", async () => {
    const ctx = makeCtx([{ id: "d1", kind: "decision", score: 1.0, sensitivity: "internal" }], {
      title: "Adopt pgvector",
      body: "Use pgvector for embedding storage.",
    });
    const res = await recallCold(ctx, QUERY, AUTH);
    expect(res.hits[0]!.content).toBe("Adopt pgvector\n\nUse pgvector for embedding storage.");
  });
});

// ─── 6.4 Damping / gating maths ────────────────────────────────────────────

describe("WP-3 (RECALL-4) — decisions rank on the same cosine scale as facts (no ×0.85 damping)", () => {
  it("a decision with cosine 1.0 scores its cosine, and carries it as `similarity`", async () => {
    const ctx = makeCtx([{ id: "d1", kind: "decision", score: 1.0, sensitivity: "internal" }]);
    const res = await recallCold(ctx, QUERY, AUTH);
    // worth absent → prior 1.0, no history → no tie-break: score = cosine.
    expect(res.hits[0]!.score).toBeCloseTo(1.0, 5);
    expect(res.hits[0]!.similarity).toBe(1.0);
  });

  it("a decision with cosine 0.5 scores 0.5 — it used to be 0.5 × 0.85 × 0.6 × 0.5", async () => {
    const ctx = makeCtx([{ id: "d1", kind: "decision", score: 0.5, sensitivity: "internal" }]);
    const res = await recallCold(ctx, QUERY, AUTH);
    expect(res.hits[0]!.score).toBeCloseTo(0.5, 5);
  });
});

describe("make-primitives-recallable — decision semantic gate (minSimilarity 0.35, stricter than facts' 0.1)", () => {
  it("recallableCandidates is called with minSimilarity: 0.35, not facts' 0.1", async () => {
    const ctx = makeCtx([]);
    await recallCold(ctx, QUERY, AUTH);
    expect(ctx.storage.recallableCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ minSimilarity: 0.35 })
    );
  });
});

// ─── 6.4 Sensitivity ceiling — decisions go through the same gate as facts/entities ──

describe("make-primitives-recallable — sensitivity ceiling applies to decision hits exactly as to facts (S5/S6 unchanged)", () => {
  it("confidential decision is hidden from an internal-only caller (SENSITIVITY_ORDER ceiling)", async () => {
    const ctx = makeCtx([{ id: "d1", kind: "decision", score: 0.9, sensitivity: "confidential" }], {
      sensitivity: "confidential",
    });
    const res = await recallCold(ctx, QUERY, AUTH);
    expect(res.hits).toHaveLength(0);
  });

  it("confidential decision is visible to a memory:admin caller", async () => {
    const ctx = makeCtx([{ id: "d1", kind: "decision", score: 0.9, sensitivity: "confidential" }], {
      sensitivity: "confidential",
    });
    const res = await recallCold(ctx, QUERY, AUTH_ADMIN);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]!.sensitivity).toBe("confidential");
  });

  it("internal decision is visible to an internal-only caller", async () => {
    const ctx = makeCtx([{ id: "d1", kind: "decision", score: 0.9, sensitivity: "internal" }], {
      sensitivity: "internal",
    });
    const res = await recallCold(ctx, QUERY, AUTH);
    expect(res.hits).toHaveLength(1);
  });
});
