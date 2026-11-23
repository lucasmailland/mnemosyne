import { describe, it, expect, vi } from "vitest";
import { recallCold } from "../recall-cold.js";
import type { AuthContext } from "@mnemo-ai/types";

const AUTH: AuthContext = {
  workspaceId: "ws-1",
  actorId: "actor-1",
  scopes: ["memory:read", "memory:write"],
};

function makeCtx() {
  const ftsCandidates = vi.fn(async () => [
    {
      factId: "f-fts-1",
      workspaceId: "ws-1",
      statement: "FTS lexical result statement",
      kind: "preference",
      status: "active",
      sensitivity: "internal",
      worth: 0.9,
      rank: 0.95,
      createdAt: new Date("2026-01-01T00:00:00Z"), // determinism-ok: fixed test date
    },
  ]);

  const search = vi.fn(async () => [
    {
      id: "f-vec-1",
      score: 0.85,
      primitiveKind: "fact",
    },
  ]);

  const storage = {
    ftsCandidates,
    getFact: vi.fn(async (id: string) => {
      if (id === "f-fts-1") {
        return {
          id: "f-fts-1",
          workspaceId: "ws-1",
          statement: "FTS lexical result statement",
          kind: "preference",
          status: "active",
          sensitivity: "internal",
          worth: 0.9,
          createdAt: new Date("2026-01-01T00:00:00Z"), // determinism-ok: fixed test date
        };
      }
      if (id === "f-vec-1") {
        return {
          id: "f-vec-1",
          workspaceId: "ws-1",
          statement: "Vector semantic result statement",
          kind: "preference",
          status: "active",
          sensitivity: "internal",
          worth: 0.85,
          createdAt: new Date("2026-01-01T00:00:00Z"), // determinism-ok: fixed test date
        };
      }
      return null;
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
  };

  const vector = { search };
  const embed = {
    id: "test-embedder",
    model: "text-embedding-3-small",
    dimensions: 1536,
    embedSingle: vi.fn(async () => new Float32Array(1536).fill(0.1)),
    embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(1536).fill(0.1))),
    healthCheck: vi.fn(async () => ({ status: "ok" as const })),
  };

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const telemetry = {
    startSpan: vi.fn(() => ({ setAttribute: vi.fn(), end: vi.fn() })),
    histogram: vi.fn(),
  };

  const outbox = {
    append: vi.fn(async () => undefined),
  };

  return {
    ctx: { storage, vector, embed, logger, telemetry, outbox, config: {} } as any,
    ftsCandidates,
    search,
  };
}

describe("B5 — Explicit Search Modes and Debug Metadata (B5.1, B5.3, B5.4, B5.5, B5.10)", () => {
  it("rejects a semantic fact below the raw floor before worth and recall logging", async () => {
    const { ctx, search } = makeCtx();
    search.mockResolvedValue([{ id: "f-vec-1", score: 0.4, primitiveKind: "preference" }]);
    const originalGetFact = ctx.storage.getFact;
    ctx.storage.getFact = vi.fn(async (id: string) => ({
      ...(await originalGetFact(id)),
      worth: 1,
      worthAlpha: 30,
      worthBeta: 2,
    }));
    ctx.storage.getRecallLog = vi.fn(
      async () => Array.from({ length: 20 }, () => ({ recalledAt: new Date().toISOString() })) // determinism-ok: recent recalls, relative to the recall clock
    );
    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", minSimilarity: 0.5 },
      AUTH
    );
    expect(response.hits).toHaveLength(0);
    expect(ctx.storage.recordRecall).not.toHaveBeenCalled();
  });

  it("leaves the original candidate behavior when the floor is omitted", async () => {
    const { ctx, search } = makeCtx();
    search.mockResolvedValue([{ id: "f-vec-1", score: 0.4, primitiveKind: "preference" }]);
    const response = await recallCold(ctx, { workspaceId: "ws-1", text: "query" }, AUTH);
    expect(response.hits.map((h) => h.id)).toContain("f-vec-1");
  });

  it("keeps a lexical-only candidate (no cosine measured) under a semantic floor", async () => {
    const { ctx, ftsCandidates, search } = makeCtx();
    // The vector arm never returned f-fts-1: no cosine was measured for it.
    search.mockResolvedValue([{ id: "f-vec-1", score: 0.85, primitiveKind: "other" }]);
    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "hybrid", minSimilarity: 0.5 },
      AUTH
    );
    expect(ftsCandidates).toHaveBeenCalled();
    expect(response.hits.map((h) => h.id)).toContain("f-fts-1");
    expect(response.hits.find((h) => h.id === "f-fts-1")?.similarity).toBeUndefined();
  });

  it("RECALL-3: drops a candidate the semantic arm measured below the floor, even when FTS matched it", async () => {
    // It used to be spliced out of the vector results and re-added by the FTS
    // arm as "lexical-only", so the floor never applied to it.
    const { ctx, ftsCandidates, search } = makeCtx();
    search.mockResolvedValue([{ id: "f-fts-1", score: 0.2, primitiveKind: "other" }]);
    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "hybrid", minSimilarity: 0.5 },
      AUTH
    );
    expect(ftsCandidates).toHaveBeenCalled();
    expect(response.hits.map((h) => h.id)).not.toContain("f-fts-1");
  });

  it("retains semantic facts above the floor and exposes raw similarity", async () => {
    const { ctx, search } = makeCtx();
    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", minSimilarity: 0.5 },
      AUTH
    );
    expect(response.hits.find((h) => h.id === "f-vec-1")?.similarity).toBe(0.85);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ minSimilarity: 0.1 }));
  });

  it("floors an ambiguous hit hydrated as a primitive like any other kind", async () => {
    // WP-3: an explicit floor applies to the semantic evidence of every kind;
    // it used to skip anything that was not a fact.
    const { ctx, search } = makeCtx();
    search.mockImplementation(async () => [
      { id: "skill-1", score: 0.3, primitiveKind: "skill" },
      { id: "f-vec-1", score: 0.8, primitiveKind: "fact" },
    ]);
    ctx.storage.getSkill = vi.fn(async () => ({
      id: "skill-1",
      workspaceId: "ws-1",
      name: "A skill",
      promptTemplate: "Skill content",
      status: "active",
      worth: 1,
      sensitivity: "internal",
      createdAt: new Date("2026-01-01"),
    }));
    const floored = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", minSimilarity: 0.5 },
      AUTH
    );
    expect(floored.hits.map((hit) => hit.id)).toEqual(["f-vec-1"]);

    const unfloored = await recallCold(ctx, { workspaceId: "ws-1", text: "query" }, AUTH);
    const skill = unfloored.hits.find((hit) => hit.id === "skill-1");
    expect(skill?.primitive).toBe("skill");
    expect(skill?.similarity).toBe(0.3);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ minSimilarity: 0.1 }));
  });

  it("fuses every kind under one rule in hybrid (P162)", async () => {
    const { ctx, search, ftsCandidates } = makeCtx();
    search.mockImplementation(async () => [
      { id: "skill-1", score: 0.9, primitiveKind: "skill" },
      { id: "f-vec-1", score: 0.8, primitiveKind: "fact" },
    ]);
    ctx.storage.getSkill = vi.fn(async () => ({
      id: "skill-1",
      workspaceId: "ws-1",
      name: "A skill",
      promptTemplate: "Skill content",
      status: "active",
      sensitivity: "internal",
      createdAt: new Date("2026-01-01"),
    }));
    ftsCandidates.mockResolvedValue([{ factId: "f-vec-1", rank: 1 }] as never);
    const result = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "hybrid" },
      AUTH
    );
    const skill = result.hits.find((hit) => hit.id === "skill-1")!;
    const fact = result.hits.find((hit) => hit.id === "f-vec-1")!;
    // Both scores are RRF values, not a cosine next to a fused rank: the fact
    // matched both arms, the skill only the semantic one.
    expect(result.debug?.fusionApplied).toBe(true);
    expect(fact.score).toBeGreaterThan(skill.score);
    expect(skill.similarity).toBe(0.9);
  });

  it("floors an ambiguous hit before hydrating it", async () => {
    const { ctx, search } = makeCtx();
    search.mockImplementation(async () => [{ id: "f-vec-1", score: 0.3, primitiveKind: "skill" }]);
    const result = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", minSimilarity: 0.5 },
      AUTH
    );
    expect(result.hits).toEqual([]);
    expect(result.nothingRelevant).toBe(true);
    expect(ctx.storage.getFact).not.toHaveBeenCalled();
    expect(ctx.storage.recordRecall).not.toHaveBeenCalled();
  });

  it("weights each RRF arm separately during migration", async () => {
    const { ctx, search, ftsCandidates } = makeCtx();
    ctx.embed.embed = vi.fn(async (texts: string[]) =>
      texts.map((_, index) => {
        const vector = new Float32Array(texts.length);
        vector[index] = 1;
        return vector;
      })
    );
    const originalGetFact = ctx.storage.getFact;
    ctx.storage.getFact = vi.fn(async (id: string) => ({
      ...(await originalGetFact(id)),
      worth: 1,
    }));
    search.mockImplementation(async () => [{ id: "f-vec-1", score: 0.8, primitiveKind: "fact" }]);
    ftsCandidates.mockResolvedValue([
      { factId: "f-vec-1", rank: 2 },
      { factId: "f-fts-1", rank: 1 },
    ] as never);
    const result = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "hybrid", embeddingMigrationActive: true },
      AUTH
    );
    expect(result.hits.find((hit) => hit.id === "f-vec-1")!.score).toBeGreaterThan(
      result.hits.find((hit) => hit.id === "f-fts-1")!.score
    );
  });

  it("keeps hybrid identical to auto when lexical arm is empty", async () => {
    const { ctx, ftsCandidates } = makeCtx();
    ftsCandidates.mockResolvedValue([]);
    const auto = await recallCold(ctx, { workspaceId: "ws-1", text: "query", mode: "auto" }, AUTH);
    const hybrid = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "hybrid" },
      AUTH
    );
    expect(hybrid.hits.map((h) => [h.id, h.score])).toEqual(auto.hits.map((h) => [h.id, h.score]));
  });

  it("credits a fact found by both semantic and lexical arms", async () => {
    const { ctx, ftsCandidates } = makeCtx();
    ftsCandidates.mockResolvedValue([{ factId: "f-vec-1", rank: 0.1 }] as never);
    const result = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "hybrid" },
      AUTH
    );
    expect(result.hits[0]?.similarity).toBe(0.85);
    expect(result.hits[0]?.score).toBeGreaterThan(0.85 * 0.6 * 0.85);
  });

  it("uses lexical rank rather than rank magnitude for hybrid fusion", async () => {
    const { ctx, ftsCandidates, search } = makeCtx();
    search.mockImplementation(async () => [
      { id: "f-vec-1", score: 0.7, primitiveKind: "fact" },
      { id: "f-fts-1", score: 0.6, primitiveKind: "fact" },
    ]);
    ftsCandidates.mockResolvedValue([
      { factId: "f-fts-1", rank: 0.2 },
      { factId: "f-vec-1", rank: 0.1 },
    ] as never);
    const first = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "hybrid" },
      AUTH
    );
    ftsCandidates.mockResolvedValue([
      { factId: "f-fts-1", rank: 200 },
      { factId: "f-vec-1", rank: 100 },
    ] as never);
    const second = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "hybrid" },
      AUTH
    );
    expect(second.hits.map((h) => [h.id, h.score])).toEqual(first.hits.map((h) => [h.id, h.score]));
  });
  it("mode = 'lexical' runs FTS search directly without vector search", async () => {
    const { ctx, ftsCandidates, search } = makeCtx();

    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "lexical" },
      AUTH
    );

    expect(ftsCandidates).toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(response.searchMode).toBe("lexical");
    expect(response.debug).toBeDefined();
    expect(response.debug?.modeRequested).toBe("lexical");
    expect(response.debug?.modeUsed).toBe("lexical");
  });

  it("mode = 'semantic' runs vector search without FTS search", async () => {
    const { ctx, ftsCandidates, search } = makeCtx();

    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "semantic" },
      AUTH
    );

    expect(search).toHaveBeenCalled();
    expect(ftsCandidates).not.toHaveBeenCalled();
    expect(response.searchMode).toBe("semantic");
    expect(response.debug).toBeDefined();
    expect(response.debug?.modeRequested).toBe("semantic");
    expect(response.debug?.modeUsed).toBe("semantic");
  });

  it("mode = 'hybrid' runs both vector search and FTS search", async () => {
    const { ctx, ftsCandidates, search } = makeCtx();

    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "hybrid" },
      AUTH
    );

    expect(search).toHaveBeenCalled();
    expect(ftsCandidates).toHaveBeenCalled();
    expect(response.searchMode).toBe("hybrid");
    expect(response.debug).toBeDefined();
    expect(response.debug?.modeRequested).toBe("hybrid");
    expect(response.debug?.modeUsed).toBe("hybrid");
    expect(response.debug?.fusionApplied).toBe(true);
    expect(response.debug?.lexicalCandidateCount).toBe(1);
    expect(response.debug?.ftsFailed).toBe(false);
  });

  it("reports semantic execution when the hybrid lexical arm is empty", async () => {
    const { ctx, ftsCandidates } = makeCtx();
    ftsCandidates.mockResolvedValue([]);
    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "hybrid" },
      AUTH
    );
    expect(response.searchMode).toBe("semantic");
    expect(response.debug).toMatchObject({
      fusionApplied: false,
      lexicalCandidateCount: 0,
      ftsFailed: false,
    });
  });

  it("logs an FTS failure and reports it in hybrid debug metadata", async () => {
    const { ctx, ftsCandidates } = makeCtx();
    ftsCandidates.mockRejectedValue(new Error("fts unavailable"));
    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "hybrid" },
      AUTH
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "recall.fts_failed",
      expect.objectContaining({ workspaceId: "ws-1" })
    );
    expect(response.debug).toMatchObject({
      fusionApplied: false,
      lexicalCandidateCount: 0,
      ftsFailed: true,
    });
  });

  it("logs an FTS failure and reports it in lexical debug metadata", async () => {
    const { ctx, ftsCandidates } = makeCtx();
    ftsCandidates.mockRejectedValue(new Error("fts unavailable"));
    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "lexical" },
      AUTH
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "recall.fts_failed",
      expect.objectContaining({ workspaceId: "ws-1" })
    );
    expect(response.debug).toMatchObject({
      fusionApplied: false,
      lexicalCandidateCount: 0,
      ftsFailed: true,
    });
  });

  it("legacy vectorWeight = 0 maps to 'lexical' mode", async () => {
    const { ctx, ftsCandidates, search } = makeCtx();

    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", vectorWeight: 0 },
      AUTH
    );

    expect(ftsCandidates).toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(response.debug?.modeRequested).toBe("lexical");
  });

  it("B5.8 — queries hasActiveEmbeddingMigration when embeddingMigrationActive is undefined", async () => {
    const { ctx } = makeCtx();
    ctx.storage.hasActiveEmbeddingMigration = vi.fn(async () => true);

    const response = await recallCold(
      ctx,
      { workspaceId: "ws-1", text: "query", mode: "hybrid" },
      AUTH
    );

    // P111: the call now carries the current embed model. "Stale" is only
    // meaningful relative to the model recall is about to embed with — the
    // one-argument form could have consulted nothing but the `embedding_stale`
    // flag, whose only writer has never had a caller, so it would have answered
    // `false` forever even once an adapter implemented it.
    expect(ctx.storage.hasActiveEmbeddingMigration).toHaveBeenCalledWith("ws-1", ctx.embed.model);
    expect(response.debug).toBeDefined();
  });

  it("B4.11 — lshBands incorporates spaceId into band hashes", async () => {
    const { lshBands } = await import("../lsh.js");
    const vector = new Float32Array(64).fill(0.5);

    const defaultBands = lshBands(vector);
    const spaceABands = lshBands(vector, "space-a");
    const spaceBBands = lshBands(vector, "space-b");

    expect(defaultBands[0]?.bandHash).not.toEqual(spaceABands[0]?.bandHash);
    expect(spaceABands[0]?.bandHash).not.toEqual(spaceBBands[0]?.bandHash);
  });
});
