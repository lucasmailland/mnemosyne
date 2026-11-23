/**
 * Lexical decisions are filtered after hydration (lifecycle, filter,
 * sensitivity, worth), so fetching a request-sized window let rejected rows
 * empty the page.
 */
import { describe, it, expect, vi } from "vitest";
import { recallCold } from "../recall-cold.js";
import type { AuthContext, MnemoDecision, PrimitiveCandidate } from "@mnemo-ai/types";

vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));
vi.mock("../../security/injection.js", () => ({
  scoreInjection: vi.fn(() => ({ flagged: false, score: 0 })),
  DEFAULT_INJECTION_THRESHOLD: 0.5,
}));

const AUTH = {
  actorType: "agent",
  actorId: "a1",
  workspaceId: "ws",
  scopes: ["memory:read"],
} as unknown as AuthContext;

const FIXED = new Date("2026-01-01T00:00:00Z");

function decision(id: string, overrides: Partial<MnemoDecision> = {}): MnemoDecision {
  return {
    id,
    workspaceId: "ws",
    kind: "architecture",
    title: `Decision ${id}`,
    body: "Body.",
    revisionCount: 1,
    sensitivity: "internal",
    status: "active",
    validFrom: FIXED,
    validTo: null,
    createdAt: FIXED,
    updatedAt: FIXED,
    metadata: {},
    ...overrides,
  } as unknown as MnemoDecision;
}

function makeCtx(opts: {
  semanticDecisions?: PrimitiveCandidate[];
  lexicalDecisions?: PrimitiveCandidate[];
  decisions?: Record<string, MnemoDecision>;
  factHits?: Array<{ id: string; score: number; primitiveKind: string }>;
}) {
  const decisions = opts.decisions ?? {};
  const recallableCandidates = vi.fn(
    async (q: { embedding?: number[]; terms?: string[]; limit: number }) =>
      (q.embedding ? (opts.semanticDecisions ?? []) : (opts.lexicalDecisions ?? [])).slice(
        0,
        q.limit
      )
  );
  const storage = {
    ftsCandidates: vi.fn(async () => []),
    recallableCandidates,
    getFact: vi.fn(async (id: string) =>
      id === "f1"
        ? {
            id: "f1",
            workspaceId: "ws",
            statement: "A fact",
            kind: "preference",
            status: "active",
            sensitivity: "internal",
            worth: 0.5,
            createdAt: FIXED,
          }
        : null
    ),
    getDecision: vi.fn(async (id: string) => decisions[id] ?? null),
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
  };
  const embed = {
    id: "e",
    model: "m",
    dimensions: 4,
    embedSingle: vi.fn(async () => new Float32Array(4).fill(0.25)),
    // Orthogonal vectors, so the §17 content dedup keeps every hit.
    embed: vi.fn(async (texts: string[]) =>
      texts.map((_, i) => {
        const v = new Float32Array(16);
        v[i % 16] = 1;
        return v;
      })
    ),
    healthCheck: vi.fn(async () => ({ status: "ok" as const })),
  };
  const ctx = {
    storage,
    // recallCold mutates the returned array; hand each run its own copy.
    vector: { search: vi.fn(async () => (opts.factHits ?? []).map((hit) => ({ ...hit }))) },
    embed,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    telemetry: {
      startSpan: vi.fn(() => ({ setAttribute: vi.fn(), end: vi.fn() })),
      histogram: vi.fn(),
    },
    outbox: { append: vi.fn(async () => undefined) },
    config: {},
  } as any;
  return { ctx, recallableCandidates };
}

const QUERY = {
  workspaceId: "ws",
  text: "session collapse",
  limit: 10,
  offset: 0,
  includeLowWorth: true,
};

describe("lexical recall of decisions", () => {
  it("returns an accessible decision ranked below rejected ones even with limit 1", async () => {
    const restricted = Array.from({ length: 5 }, (_, i) => `r${i}`);
    const decisions: Record<string, MnemoDecision> = { ok: decision("ok") };
    for (const id of restricted) decisions[id] = decision(id, { sensitivity: "restricted" });
    const { ctx } = makeCtx({
      decisions,
      lexicalDecisions: [...restricted, "ok"].map((id) => ({
        id,
        kind: "decision",
        score: 0.5,
        sensitivity: decisions[id]!.sensitivity,
      })) as PrimitiveCandidate[],
    });

    const res = await recallCold(
      ctx,
      { ...QUERY, mode: "lexical", limit: 1, embedding: undefined },
      AUTH
    );

    expect(res.hits.map((h) => h.id)).toEqual(["ok"]);
  });
});
