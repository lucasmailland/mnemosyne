/**
 * P25 — Recall graceful degradation without embed provider.
 *
 * When ctx.embed.model === "none" and no precomputed embedding is supplied,
 * recallWithCaches() MUST NOT call embedSingle() (which would throw
 * NotImplementedError → 501). Instead it must delegate to recallCold() which
 * invokes ftsFallbackRecall() and returns results with searchMode="fts".
 *
 * Root cause: the embedding LRU read-through block in recallWithCaches ran
 * before the ctx.embed.model check that lives inside recallCold, so the
 * NoopEmbed stub threw before the FTS path was reached.
 */
import { describe, it, expect, vi } from "vitest";
import { createCore } from "../index.js";
import type { CoreDeps } from "../index.js";
import type { AuthContext } from "@mnemo-ai/types";

// ── Minimal infra-free fakes ────────────────────────────────────────────────

function makeNoEmbedAdapter() {
  const embedSingle = vi.fn().mockRejectedValue(
    new Error("NO_EMBED_ADAPTER: must not be called in FTS fallback path"),
  );
  return {
    id: "no-embed",
    model: "none" as const,
    dimensions: 1536,
    embed: vi.fn().mockRejectedValue(new Error("NO_EMBED_ADAPTER")),
    embedSingle,
    healthCheck: async () => ({ status: "degraded" as const, latencyMs: 0 }),
  };
}

function makeStorage(facts: Array<{ id: string; statement: string }>) {
  return {
    async getFact(id: string) {
      return facts.find((f) => f.id === id) ?? null;
    },
    async ftsCandidates(_ws: string, _text: string, limit: number) {
      return facts.slice(0, limit).map((f) => ({ id: f.id, score: 0.5 }));
    },
    async listFacts(_ws: string, opts: { ids: string[] }) {
      return facts.filter((f) => opts.ids.includes(f.id));
    },
    async getRecallLog() {
      return [];
    },
    async getCachedEmbedding() {
      return null;
    },
    putCachedEmbedding: undefined,
    lookupQueryCache: undefined,
    findSimilarEntities: undefined,
    appendAuditEntry: async () => undefined,
    getRelations: async () => [],
    async pointerCandidates() { return []; },
  } as unknown as CoreDeps["storage"];
}

function makeVector() {
  return {
    id: "fake-vector",
    search: vi.fn().mockResolvedValue([]),
    upsert: vi.fn(),
    delete: vi.fn(),
    healthCheck: async () => ({ status: "ok" as const, latencyMs: 0 }),
  } as unknown as CoreDeps["vector"];
}

function makeCache() {
  return {
    id: "fake-cache",
    capabilities: { sortedSets: true, pubSub: false, patterns: false, atomic: false, hashes: false },
    zrangeByScore: vi.fn().mockResolvedValue([]),
    zincrby: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
    del: vi.fn(),
    healthCheck: async () => ({ status: "ok" as const, latencyMs: 0 }),
  } as unknown as CoreDeps["cache"];
}

const NOOP_TELEMETRY = {
  startSpan: () => ({ end: () => {}, setAttribute: () => {}, recordException: () => {} }),
  counter: () => {},
  histogram: () => {},
  gauge: () => {},
  shutdown: async () => {},
} as unknown as CoreDeps["telemetry"];

const NOOP_LLM = {
  generate: vi.fn().mockResolvedValue({ text: "", tokensUsed: 0 }),
  embed: vi.fn().mockRejectedValue(new Error("no llm")),
  healthCheck: async () => ({ status: "ok" as const, latencyMs: 0 }),
} as unknown as CoreDeps["llm"];

const NOOP_OUTBOX = {
  append: vi.fn().mockResolvedValue(undefined),
  claim: vi.fn().mockResolvedValue([]),
  ack: vi.fn().mockResolvedValue(undefined),
  nack: vi.fn().mockResolvedValue(undefined),
} as unknown as CoreDeps["outbox"];

const NOOP_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => NOOP_LOGGER,
} as unknown as CoreDeps["logger"];

const AUTH: AuthContext = {
  workspaceId: "ws_test",
  actorId: "agent",
  actorType: "agent",
  scopes: ["memory:read"],
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("P25 — recall FTS fallback when embed adapter is absent", () => {
  const facts = [
    { id: "f1", statement: "Pablo prefers TypeScript strict mode" },
    { id: "f2", statement: "Use pnpm for all package management" },
  ];

  it("does NOT call embedSingle when embed.model is 'none'", async () => {
    const noEmbed = makeNoEmbedAdapter();
    const core = createCore({
      storage: makeStorage(facts),
      vector: makeVector(),
      cache: makeCache(),
      embed: noEmbed,
      llm: NOOP_LLM,
      telemetry: NOOP_TELEMETRY,
      outbox: NOOP_OUTBOX,
      logger: NOOP_LOGGER,
    });

    await core.recall({ workspaceId: "ws_test", text: "TypeScript preferences", limit: 5 }, AUTH);

    expect(noEmbed.embedSingle).not.toHaveBeenCalled();
  });

  it("returns results (searchMode fts) without throwing", async () => {
    const noEmbed = makeNoEmbedAdapter();
    const core = createCore({
      storage: makeStorage(facts),
      vector: makeVector(),
      cache: makeCache(),
      embed: noEmbed,
      llm: NOOP_LLM,
      telemetry: NOOP_TELEMETRY,
      outbox: NOOP_OUTBOX,
      logger: NOOP_LOGGER,
    });

    const resp = await core.recall(
      { workspaceId: "ws_test", text: "TypeScript preferences", limit: 5 },
      AUTH,
    );

    expect(resp.hits).toBeInstanceOf(Array);
    expect(resp.searchMode).toBe("fts");
  });

  it("does NOT call embedSingle when a precomputed embedding is provided (no regression)", async () => {
    const noEmbed = makeNoEmbedAdapter();
    const core = createCore({
      storage: makeStorage(facts),
      vector: makeVector(),
      cache: makeCache(),
      embed: noEmbed,
      llm: NOOP_LLM,
      telemetry: NOOP_TELEMETRY,
      outbox: NOOP_OUTBOX,
      logger: NOOP_LOGGER,
    });

    const fakeVec = new Array(1536).fill(0.1);
    await core.recall(
      { workspaceId: "ws_test", text: "TypeScript", embedding: new Float32Array(fakeVec), limit: 5 },
      AUTH,
    );

    // Precomputed vector is passed directly — embedSingle should never be called.
    expect(noEmbed.embedSingle).not.toHaveBeenCalled();
  });

  it("requests enough bounded FTS candidates to serve a deep offset", async () => {
    const noEmbed = makeNoEmbedAdapter();
    const candidates = Array.from({ length: 75 }, (_, index) => ({
      factId: `f-${index}`,
      statement: `typescript candidate ${index}`,
      sensitivity: "internal",
      worth: 0.9,
      worthAlpha: 20,
      worthBeta: 2,
      attribution: "user_stated",
      createdAt: new Date(), // determinism-ok: test date
      validFrom: new Date(), // determinism-ok: test date
      status: "active",
      validTo: null,
      confidence: 0.9,
      rank: 75 - index,
      embedding: null,
    }));
    const ftsCandidates = vi.fn(async (query: { limit: number }) => candidates.slice(0, query.limit));
    const core = createCore({
      storage: { ...makeStorage([]), ftsCandidates } as never,
      vector: makeVector(), cache: makeCache(), embed: noEmbed, llm: NOOP_LLM,
      telemetry: NOOP_TELEMETRY, outbox: NOOP_OUTBOX, logger: NOOP_LOGGER,
    });

    const response = await core.recall({
      workspaceId: "ws_test", text: "typescript", offset: 60, limit: 5,
    }, AUTH);

    expect(response.hits.map((hit) => hit.id)).toEqual([
      "f-60", "f-61", "f-62", "f-63", "f-64",
    ]);
    expect(ftsCandidates.mock.calls[0]?.[0].limit).toBeGreaterThanOrEqual(65);
  });
});
