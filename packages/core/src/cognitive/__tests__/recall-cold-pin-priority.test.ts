/**
 * Tool-promise audit — `memory_pin` (docs/archive/openspec/tool-promise-remediation/tools/memory_pin.md).
 *
 * The tool's MCP-facing description promises pinning "le da prioridad en
 * recall" (gives it priority in recall). This suite proves that promise is
 * FALSE for the actual live recall path: `memory_recall` → POST /recall →
 * `deps.cognitive.recall()` → `recallCold()` (this file, `../recall-cold.js`).
 *
 * Root cause (see below): `viewFact()` — the function that projects a raw
 * `MnemoFact` row into the `PrimitiveView` the Stage 5 scoring formula reads
 * — never copies `fact.pinned` onto the view. The blended-score formula
 * (`score = (tanh(A(t)) * 0.4 + cosine * 0.6) * worth`, recall-cold.ts:16)
 * has no `pinned` term at all. A pinned fact and an otherwise-identical
 * unpinned fact score IDENTICALLY.
 *
 * (Separate, unrelated legacy code path: `packages/core/src/recall/search.ts`
 * DOES compute a `pin_bonus` column in raw SQL — but that module backs
 * `CoreLike.recall()` / `searchMnemo()`, which is wired to `deps.core.recall`
 * (used by e.g. `memory_anticipate`'s internal query), NOT the `/recall`
 * route `memory_recall` and `memory_search` actually call. That dead-for-this-
 * purpose code is not a counter-proof; it's a different consumer entirely.)
 */
import { describe, it, expect, vi } from "vitest";
import { recallCold, viewFact } from "../recall-cold.js";
import type { AuthContext, MnemoFact } from "@mnemo-ai/types";

// Stub compositionality/injection so these tests don't need a real LLM and are deterministic.
vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));
vi.mock("../../security/injection.js", () => ({
  scoreInjection: vi.fn(() => ({ flagged: false, score: 0 })),
  DEFAULT_INJECTION_THRESHOLD: 0.5,
}));

function baseFact(id: string, pinned: boolean): MnemoFact {
  return {
    id,
    workspaceId: "ws",
    statement: `statement for ${id}`,
    kind: "preference",
    status: "active",
    sensitivity: "internal",
    // Identical worth/confidence inputs on both facts — the ONLY difference
    // between the two fixtures in the recallCold test below is `pinned`.
    worth: 0.8,
    worthAlpha: 8,
    worthBeta: 2,
    attribution: "user_stated",
    pinned,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    validFrom: new Date("2026-01-01T00:00:00Z"),
    validTo: null,
  } as unknown as MnemoFact;
}

describe("viewFact() drops `pinned` — Stage 5 scoring never sees it", () => {
  it("does not carry `pinned` onto the PrimitiveView for a pinned fact", () => {
    const view = viewFact(baseFact("f-pinned", true)) as Record<string, unknown>;
    expect(view["pinned"]).toBeUndefined();
  });

  it("produces byte-identical views (aside from documented fields) for a pinned vs. unpinned otherwise-equal fact", () => {
    const pinnedView = viewFact(baseFact("f1", true));
    const unpinnedView = viewFact(baseFact("f1", false));
    // Same id passed in both cases (only `pinned` differs on the input) — the
    // views must be deep-equal, proving `pinned` is not threaded through to
    // any field the scorer could key off of.
    expect(pinnedView).toEqual(unpinnedView);
  });
});

// ─── End-to-end: recallCold() scores a pinned and unpinned equivalent fact identically ───

const VECTOR_SCORE = 0.9; // identical vector-search score for both candidates

function makeCtx() {
  const facts: Record<string, MnemoFact> = {
    "f-unpinned": baseFact("f-unpinned", false),
    "f-pinned": baseFact("f-pinned", true),
  };

  const storage = {
    getFact: vi.fn(async (id: string) => facts[id] ?? null),
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
    // Identical (empty) recall history for both facts — isolates `pinned` as
    // the only independent variable between the two candidates.
    getRecallLog: vi.fn(async () => []),
  };

  // dedupByContent() (recall-cold.ts) batch-embeds each hit's *content* text
  // and drops any hit whose cosine similarity to an already-kept hit exceeds
  // 0.88 — orthogonal per-content vectors here keep both candidates distinct
  // through dedup so the scoring comparison below isn't masked by a dedup
  // collapse (unrelated to the `pinned` claim under test).
  const embed = {
    model: "test",
    dimensions: 4,
    embedSingle: vi.fn(async () => new Float32Array(4).fill(0.25)),
    embed: vi.fn(async (texts: string[]) =>
      texts.map((t) =>
        t.includes("f-pinned") ? new Float32Array([0, 1, 0, 0]) : new Float32Array([1, 0, 0, 0])
      )
    ),
  };

  const vector = {
    // Both candidates get the SAME vector-search score.
    search: vi.fn(async () => [
      { id: "f-unpinned", score: VECTOR_SCORE, primitiveKind: "fact" },
      { id: "f-pinned", score: VECTOR_SCORE, primitiveKind: "fact" },
    ]),
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

  return { storage, embed, vector, telemetry, logger, outbox, config: {} } as any;
}

const QUERY = {
  workspaceId: "ws",
  text: "test query",
  embedding: new Float32Array(4).fill(0.25),
  limit: 10,
  offset: 0,
  includeLowWorth: true,
};

const AUTH: AuthContext = {
  actorType: "agent",
  actorId: "a1",
  workspaceId: "ws",
  scopes: ["memory:read"],
  sessionId: "sess-1",
} as unknown as AuthContext;

describe("recallCold: pinned fact gets NO measurable recall-ranking boost (disproves tool promise)", () => {
  it("scores a pinned fact identically to an otherwise-equal unpinned fact", async () => {
    const ctx = makeCtx();
    const resp = await recallCold(ctx, QUERY as never, AUTH);

    expect(resp.hits).toHaveLength(2);
    const pinnedHit = resp.hits.find((h) => h.id === "f-pinned");
    const unpinnedHit = resp.hits.find((h) => h.id === "f-unpinned");
    expect(pinnedHit).toBeDefined();
    expect(unpinnedHit).toBeDefined();

    // The tool's promise ("le da prioridad en recall") requires
    // pinnedHit.score > unpinnedHit.score. It is in fact exactly equal —
    // the promise does not hold for this (the real, live) recall path.
    expect(pinnedHit!.score).toBeCloseTo(unpinnedHit!.score, 10);
  });
});
