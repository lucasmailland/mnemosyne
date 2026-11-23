import { describe, expect, it, vi } from "vitest";
import type { AuthContext, RecallQuery } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { createCore } from "../index.js";

const WORKSPACE_ID = "ws-cache-sensitivity";
const EMBEDDING = new Float32Array([0.2, 0.4, 0.6, 0.8]);

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return this;
  },
} as never;

const telemetry = {
  startSpan: () => ({ setAttribute() {}, setStatus() {}, end() {} }),
  counter() {},
  histogram() {},
  gauge() {},
  async shutdown() {},
} as never;

function auth(maxSensitivity: AuthContext["maxSensitivity"]): AuthContext {
  return {
    workspaceId: WORKSPACE_ID,
    actorId: "admin-1",
    actorType: "agent",
    scopes: ["memory:read", "memory:admin"],
    maxSensitivity,
  } as AuthContext;
}

describe("L3 recall cache sensitivity", () => {
  it("goes straight to cold cosine retrieval when minSimilarity is set", async () => {
    const storage = new InMemoryStorageAdapter();
    const fact = await createFact(storage, "cold floor", "public");
    const lookup = vi.spyOn(storage, "lookupQueryCache");
    const pointer = vi.spyOn(storage, "pointerCandidates");
    const vectorSearch = vi
      .fn()
      .mockResolvedValue([{ id: fact.id, score: 0.8, primitiveKind: "other" }]);
    const response = await makeCore(storage, vectorSearch).recall(
      {
        workspaceId: WORKSPACE_ID,
        text: "cold floor",
        embedding: EMBEDDING,
        tokenBudget: 1000,
        minSimilarity: 0.7,
      },
      auth("restricted")
    );
    expect(response.hits.map((hit) => hit.id)).toContain(fact.id);
    expect(vectorSearch).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
    expect(pointer).not.toHaveBeenCalled();
  });
  it("keeps an unrestricted admin cache isolated across a lower-ceiling caller", async () => {
    const storage = new InMemoryStorageAdapter();
    const restricted = await createFact(storage, "admin cached", "restricted");
    const publicFact = await createFact(storage, "public cascade", "public");
    await strengthen(storage, restricted.id);
    await strengthen(storage, publicFact.id);
    const vectorSearch = vi
      .fn()
      .mockResolvedValueOnce([{ id: restricted.id, score: 1, primitiveKind: "fact" }])
      .mockResolvedValueOnce([{ id: publicFact.id, score: 1, primitiveKind: "fact" }]);
    const lookup = vi.spyOn(storage, "lookupQueryCache");
    const write = vi.spyOn(storage, "insertQueryCache");
    const core = makeCore(storage, vectorSearch);
    const query = { workspaceId: WORKSPACE_ID, text: "shared query", embedding: EMBEDDING };
    const unrestrictedAdmin = auth(undefined);

    const firstHigh = await core.recall(query, unrestrictedAdmin);
    const low = await core.recall(query, { ...auth("public"), scopes: ["memory:read"] });
    const secondHigh = await core.recall(query, unrestrictedAdmin);

    expect(firstHigh.hits.map((hit) => hit.id)).toEqual([restricted.id]);
    expect(low.hits.map((hit) => hit.id)).toEqual([publicFact.id]);
    expect(secondHigh.hits.map((hit) => hit.id)).toEqual([restricted.id]);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(vectorSearch).toHaveBeenCalledTimes(2);
  });

  it("treats a cached fact that decayed below the default worth gate as a full miss", async () => {
    const storage = new InMemoryStorageAdapter();
    const decayed = await createFact(storage, "decayed cached", "public");
    const fallback = await createFact(storage, "worth fallback", "public");
    await strengthen(storage, fallback.id);
    await storage.updateWorth(decayed.id, WORKSPACE_ID, "fact", {
      success: 0,
      failure: 100,
      creditWeight: 1,
    });
    await storage.insertQueryCache({
      workspaceId: WORKSPACE_ID,
      embedding: EMBEDDING,
      resultIds: [decayed.id],
      resultKinds: ["fact"],
      topK: 10,
    });
    const vectorSearch = vi
      .fn()
      .mockResolvedValue([{ id: fallback.id, score: 1, primitiveKind: "fact" }]);

    const result = await makeCore(storage, vectorSearch).recall(
      { workspaceId: WORKSPACE_ID, text: "worth query", embedding: EMBEDDING },
      auth(undefined)
    );

    expect(vectorSearch).toHaveBeenCalledOnce();
    expect(result.hits.map((hit) => hit.id)).toEqual([fallback.id]);
  });

  it("does not write mixed primitive kinds to the fact-only L3 cache", async () => {
    const storage = new InMemoryStorageAdapter();
    const factHit = await createFact(storage, "primitive fact", "public");
    await strengthen(storage, factHit.id);
    const decision = await storage.createDecision({
      workspaceId: WORKSPACE_ID,
      kind: "decision",
      title: "Primitive decision",
      body: "Do not hydrate this through getFact",
    });
    const write = vi.spyOn(storage, "insertQueryCache");
    const vectorSearch = vi.fn().mockResolvedValue([
      { id: factHit.id, score: 1, primitiveKind: "fact" },
      { id: decision.id, score: 0.9, primitiveKind: "decision" },
    ]);

    const result = await makeCore(storage, vectorSearch, undefined, async (texts) =>
      texts.map((_text, index) => {
        const vector = new Float32Array(texts.length);
        vector[index] = 1;
        return vector;
      })
    ).recall(
      { workspaceId: WORKSPACE_ID, text: "mixed kinds", embedding: EMBEDDING },
      auth(undefined)
    );

    expect(result.hits.map((hit) => hit.primitive)).toEqual(
      expect.arrayContaining(["fact", "decision"])
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("bypasses L3 for admins with an explicit lower ceiling", async () => {
    const storage = new InMemoryStorageAdapter();
    const confidential = await storage.createFact({
      workspaceId: WORKSPACE_ID,
      scope: "global",
      statement: "confidential cached fact",
      subject: "security",
      kind: "other",
      attribution: "user_stated",
      sensitivity: "confidential",
    });
    await storage.insertQueryCache({
      workspaceId: WORKSPACE_ID,
      embedding: EMBEDDING,
      resultIds: [confidential.id],
      resultKinds: ["fact"],
      topK: 10,
    });

    const vectorSearch = vi.fn().mockResolvedValue([]);
    const core = createCore({
      storage,
      vector: { search: vectorSearch } as never,
      embed: { model: "test", embedSingle: vi.fn().mockResolvedValue(EMBEDDING) } as never,
      outbox: { append: vi.fn().mockResolvedValue(undefined) } as never,
      logger,
      telemetry,
    });
    const query = { workspaceId: WORKSPACE_ID, text: "cached query", embedding: EMBEDDING };

    const adminResult = await core.recall(query, auth("confidential"));
    const loweredResult = await core.recall(query, auth("public"));

    expect(adminResult.hits).toEqual([]);
    expect(loweredResult.hits).toEqual([]);
    expect(vectorSearch).toHaveBeenCalledTimes(2);
  });

  it("falls through the full cascade when one cached hit is rejected by sensitivity", async () => {
    const storage = new InMemoryStorageAdapter();
    const cachedPublic = await createFact(storage, "cached public", "public");
    const cachedConfidential = await createFact(storage, "cached confidential", "confidential");
    const cascadePublic = await createFact(storage, "cascade public", "public");
    await strengthen(storage, cascadePublic.id);
    await storage.insertQueryCache({
      workspaceId: WORKSPACE_ID,
      embedding: EMBEDDING,
      resultIds: [cachedPublic.id, cachedConfidential.id],
      resultKinds: ["fact", "fact"],
      topK: 10,
    });
    const vectorSearch = vi
      .fn()
      .mockResolvedValue([{ id: cascadePublic.id, score: 1, primitiveKind: "fact" }]);
    const core = makeCore(storage, vectorSearch);

    const result = await core.recall(
      { workspaceId: WORKSPACE_ID, text: "mixed cache", embedding: EMBEDDING },
      { ...auth("restricted"), scopes: ["memory:read"] }
    );

    expect(vectorSearch).toHaveBeenCalledOnce();
    expect(result.hits.map((hit) => hit.id)).toEqual([cascadePublic.id]);
  });

  it.each([
    [
      "missing fact",
      async (storage: InMemoryStorageAdapter, validId: string) => ({
        resultIds: [validId, "missing"],
        resultKinds: ["fact", "fact"],
      }),
    ],
    [
      "inactive fact",
      async (storage: InMemoryStorageAdapter, validId: string) => {
        const inactive = await createFact(storage, "inactive", "public");
        await storage.updateFact(inactive.id, WORKSPACE_ID, { status: "merged" });
        return { resultIds: [validId, inactive.id], resultKinds: ["fact", "fact"] };
      },
    ],
    [
      "non-fact kind",
      async (_storage: InMemoryStorageAdapter, validId: string) => ({
        resultIds: [validId],
        resultKinds: ["decision"],
      }),
    ],
    [
      "mismatched kind count",
      async (_storage: InMemoryStorageAdapter, validId: string) => ({
        resultIds: [validId],
        resultKinds: [],
      }),
    ],
  ] as const)(
    "treats an entry containing a %s as a complete cache miss",
    async (_name, cachedEntry) => {
      const storage = new InMemoryStorageAdapter();
      const valid = await createFact(storage, "valid cached", "public");
      const cascade = await createFact(storage, "cascade replacement", "public");
      await strengthen(storage, cascade.id);
      const cached = await cachedEntry(storage, valid.id);
      await storage.insertQueryCache({
        workspaceId: WORKSPACE_ID,
        embedding: EMBEDDING,
        ...cached,
        topK: 10,
      });
      const vectorSearch = vi
        .fn()
        .mockResolvedValue([{ id: cascade.id, score: 1, primitiveKind: "fact" }]);

      const result = await makeCore(storage, vectorSearch).recall(
        { workspaceId: WORKSPACE_ID, text: "invalid cache", embedding: EMBEDDING },
        auth("public")
      );

      expect(vectorSearch).toHaveBeenCalledOnce();
      expect(result.hits.map((hit) => hit.id)).toEqual([cascade.id]);
    }
  );

  it.each([
    ["filter.kinds", { filter: { kinds: ["decision"] } }],
    ["filter.scopeRef", { filter: { scopeRef: "project-1" } }],
    ["filter.actorId", { filter: { actorId: "actor-2" } }],
    ["includeArchived", { includeArchived: true }],
    ["includeLowWorth", { includeLowWorth: true }],
    ["offset", { offset: 1 }],
    ["non-default limit", { limit: 5 }],
    ["materialiseInferences", { materialiseInferences: true }],
    ["conversationId", { conversationId: "conversation-1" }],
    ["tokenBudget", { tokenBudget: 10_000 }],
    ["rerank", { rerank: true }],
    ["recurrenceThreshold", { recurrenceThreshold: 0.7 }],
    ["hyde", { hyde: true }],
    ["hybridFts", { hybridFts: true }],
    ["minSimilarity", { minSimilarity: 0.7 }],
    ["embeddingMigrationActive", { embeddingMigrationActive: true }],
  ] satisfies Array<[string, Partial<RecallQuery>]>)(
    "bypasses L3 result lookup and write for %s",
    async (_name, queryFlag) => {
      const storage = new InMemoryStorageAdapter();
      const lookup = vi.spyOn(storage, "lookupQueryCache");
      const write = vi.spyOn(storage, "insertQueryCache");
      const vectorSearch = vi.fn().mockResolvedValue([]);

      await makeCore(storage, vectorSearch).recall(
        {
          workspaceId: WORKSPACE_ID,
          text: "filtered query",
          embedding: EMBEDDING,
          ...queryFlag,
        },
        auth("restricted")
      );

      expect(lookup).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(vectorSearch).toHaveBeenCalledOnce();
    }
  );

  it("still reads the embedding cache when L3 result caching is bypassed", async () => {
    const storage = new InMemoryStorageAdapter();
    const embeddingLookup = vi.spyOn(storage, "getCachedEmbedding").mockResolvedValue(EMBEDDING);
    const embedSingle = vi.fn().mockResolvedValue(new Float32Array([9, 9, 9, 9]));
    const vectorSearch = vi.fn().mockResolvedValue([]);

    await makeCore(storage, vectorSearch, embedSingle).recall(
      {
        workspaceId: WORKSPACE_ID,
        text: "filtered embedding cache query",
        filter: { kinds: ["decision"] },
      },
      auth("restricted")
    );

    expect(embeddingLookup).toHaveBeenCalledOnce();
    expect(embedSingle).not.toHaveBeenCalled();
    expect(vectorSearch).toHaveBeenCalledOnce();
  });
});

async function createFact(
  storage: InMemoryStorageAdapter,
  statement: string,
  sensitivity: "public" | "confidential" | "restricted"
) {
  return storage.createFact({
    workspaceId: WORKSPACE_ID,
    scope: "global",
    statement,
    subject: "security",
    kind: "other",
    attribution: "user_stated",
    sensitivity,
  });
}

async function strengthen(storage: InMemoryStorageAdapter, id: string): Promise<void> {
  await storage.updateWorth(id, WORKSPACE_ID, "fact", {
    success: 100,
    failure: 0,
    creditWeight: 1,
  });
}

function makeCore(
  storage: InMemoryStorageAdapter,
  vectorSearch: ReturnType<typeof vi.fn>,
  embedSingle = vi.fn().mockResolvedValue(EMBEDDING),
  embed = async (texts: string[]) => texts.map(() => EMBEDDING)
) {
  return createCore({
    storage,
    vector: { search: vectorSearch } as never,
    embed: {
      model: "test",
      embedSingle,
      embed: vi.fn(embed),
    } as never,
    outbox: { append: vi.fn().mockResolvedValue(undefined) } as never,
    logger,
    telemetry,
  });
}
