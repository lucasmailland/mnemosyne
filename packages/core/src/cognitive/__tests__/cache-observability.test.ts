import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { createCore } from "../index.js";
import { reportCacheFailure, resetCacheFailureThrottle } from "../cache-observability.js";
import type { CoreContext } from "../context.js";

// P59 (docs/archive/openspec/p59-query-cache-l3-fix, design.md §4, tasks.md Phase 6): proves
// the silent-failure fix actually fires — a rejecting cache-port call still
// returns a correct recall AND emits exactly one warn + one counter + one
// onCacheError per failure, the throttle bounds warn volume without bounding
// the counter, and reportCacheFailure never throws even when every sink it
// touches throws.

const WORKSPACE_ID = "ws-cache-observability";
const EMBEDDING = new Float32Array([0.1, 0.2, 0.3, 0.4]);

function auth(): AuthContext {
  return {
    workspaceId: WORKSPACE_ID,
    actorId: "admin-1",
    actorType: "agent",
    scopes: ["memory:read", "memory:admin"],
    maxSensitivity: undefined,
  } as AuthContext;
}

function makeTelemetry() {
  return {
    startSpan: () => ({ setAttribute() {}, setStatus() {}, end() {} }),
    counter: vi.fn(),
    histogram() {},
    gauge() {},
    async shutdown() {},
  };
}

function makeLogger() {
  return {
    debug() {},
    info() {},
    warn: vi.fn(),
    error() {},
    fatal() {},
    child() {
      return this;
    },
  };
}

async function createFact(storage: InMemoryStorageAdapter, statement: string) {
  const fact = await storage.createFact({
    workspaceId: WORKSPACE_ID,
    scope: "global",
    statement,
    subject: "security",
    kind: "other",
    attribution: "user_stated",
    sensitivity: "public",
  });
  await storage.updateWorth(fact.id, WORKSPACE_ID, "fact", {
    success: 100,
    failure: 0,
    creditWeight: 1,
  });
  return fact;
}

describe("cache-observability", () => {
  beforeEach(() => {
    resetCacheFailureThrottle();
  });

  it("reports a lookupQueryCache failure without breaking the recall", async () => {
    const storage = new InMemoryStorageAdapter();
    const fact = await createFact(storage, "observed lookup failure");
    vi.spyOn(storage, "lookupQueryCache").mockRejectedValue(new Error("lookup boom"));
    const telemetry = makeTelemetry();
    const logger = makeLogger();
    const onCacheError = vi.fn();
    const vectorSearch = vi
      .fn()
      .mockResolvedValue([{ id: fact.id, score: 1, primitiveKind: "fact" }]);

    const core = createCore({
      storage,
      vector: { search: vectorSearch } as never,
      embed: { model: "test", embedSingle: vi.fn().mockResolvedValue(EMBEDDING) } as never,
      outbox: { append: vi.fn().mockResolvedValue(undefined) } as never,
      logger: logger as never,
      telemetry: telemetry as never,
      onCacheError,
    });

    const result = await core.recall(
      { workspaceId: WORKSPACE_ID, text: "lookup failure query", embedding: EMBEDDING },
      auth()
    );

    expect(result.hits.map((h) => h.id)).toEqual([fact.id]);
    expect(telemetry.counter).toHaveBeenCalledTimes(1);
    expect(telemetry.counter).toHaveBeenCalledWith("mnemo.cache_errors", 1, {
      cache: "l3_query",
      op: "lookup",
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(onCacheError).toHaveBeenCalledTimes(1);
    expect(onCacheError).toHaveBeenCalledWith({
      cache: "l3_query",
      op: "lookup",
      message: "lookup boom",
    });
  });

  it("reports an insertQueryCache failure without breaking the recall", async () => {
    const storage = new InMemoryStorageAdapter();
    const fact = await createFact(storage, "observed insert failure");
    vi.spyOn(storage, "insertQueryCache").mockRejectedValue(new Error("insert boom"));
    const telemetry = makeTelemetry();
    const logger = makeLogger();
    const onCacheError = vi.fn();
    const vectorSearch = vi
      .fn()
      .mockResolvedValue([{ id: fact.id, score: 1, primitiveKind: "fact" }]);

    const core = createCore({
      storage,
      vector: { search: vectorSearch } as never,
      embed: { model: "test", embedSingle: vi.fn().mockResolvedValue(EMBEDDING) } as never,
      outbox: { append: vi.fn().mockResolvedValue(undefined) } as never,
      logger: logger as never,
      telemetry: telemetry as never,
      onCacheError,
    });

    const result = await core.recall(
      { workspaceId: WORKSPACE_ID, text: "insert failure query", embedding: EMBEDDING },
      auth()
    );

    expect(result.hits.map((h) => h.id)).toEqual([fact.id]);
    expect(telemetry.counter).toHaveBeenCalledTimes(1);
    expect(telemetry.counter).toHaveBeenCalledWith("mnemo.cache_errors", 1, {
      cache: "l3_query",
      op: "insert",
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(onCacheError).toHaveBeenCalledTimes(1);
    expect(onCacheError).toHaveBeenCalledWith({
      cache: "l3_query",
      op: "insert",
      message: "insert boom",
    });
  });

  it("reports a getCachedEmbedding failure without breaking the recall", async () => {
    const storage = new InMemoryStorageAdapter();
    const fact = await createFact(storage, "observed get failure");
    vi.spyOn(storage, "getCachedEmbedding").mockRejectedValue(new Error("get boom"));
    const telemetry = makeTelemetry();
    const logger = makeLogger();
    const onCacheError = vi.fn();
    const embedSingle = vi.fn().mockResolvedValue(EMBEDDING);
    const vectorSearch = vi
      .fn()
      .mockResolvedValue([{ id: fact.id, score: 1, primitiveKind: "fact" }]);

    const core = createCore({
      storage,
      vector: { search: vectorSearch } as never,
      embed: { model: "test", embedSingle } as never,
      outbox: { append: vi.fn().mockResolvedValue(undefined) } as never,
      logger: logger as never,
      telemetry: telemetry as never,
      onCacheError,
    });

    // No precomputed embedding — forces the embedding-LRU read-through path.
    const result = await core.recall(
      { workspaceId: WORKSPACE_ID, text: "get failure query" },
      auth()
    );

    expect(embedSingle).toHaveBeenCalledOnce();
    expect(result.hits.map((h) => h.id)).toEqual([fact.id]);
    expect(telemetry.counter).toHaveBeenCalledTimes(1);
    expect(telemetry.counter).toHaveBeenCalledWith("mnemo.cache_errors", 1, {
      cache: "embedding_lru",
      op: "get",
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(onCacheError).toHaveBeenCalledTimes(1);
    expect(onCacheError).toHaveBeenCalledWith({
      cache: "embedding_lru",
      op: "get",
      message: "get boom",
    });
  });

  it("reports a putCachedEmbedding failure without breaking the recall", async () => {
    const storage = new InMemoryStorageAdapter();
    const fact = await createFact(storage, "observed put failure");
    vi.spyOn(storage, "putCachedEmbedding").mockRejectedValue(new Error("put boom"));
    const telemetry = makeTelemetry();
    const logger = makeLogger();
    const onCacheError = vi.fn();
    const embedSingle = vi.fn().mockResolvedValue(EMBEDDING);
    const vectorSearch = vi
      .fn()
      .mockResolvedValue([{ id: fact.id, score: 1, primitiveKind: "fact" }]);

    const core = createCore({
      storage,
      vector: { search: vectorSearch } as never,
      embed: { model: "test", embedSingle } as never,
      outbox: { append: vi.fn().mockResolvedValue(undefined) } as never,
      logger: logger as never,
      telemetry: telemetry as never,
      onCacheError,
    });

    // No precomputed embedding — miss on getCachedEmbedding (empty cache),
    // computes via embedSingle, then fails the putCachedEmbedding write.
    const result = await core.recall(
      { workspaceId: WORKSPACE_ID, text: "put failure query" },
      auth()
    );

    expect(embedSingle).toHaveBeenCalledOnce();
    expect(result.hits.map((h) => h.id)).toEqual([fact.id]);
    expect(telemetry.counter).toHaveBeenCalledTimes(1);
    expect(telemetry.counter).toHaveBeenCalledWith("mnemo.cache_errors", 1, {
      cache: "embedding_lru",
      op: "put",
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(onCacheError).toHaveBeenCalledTimes(1);
    expect(onCacheError).toHaveBeenCalledWith({
      cache: "embedding_lru",
      op: "put",
      message: "put boom",
    });
  });

  it("throttles warn logging to once per 60s per cache:op pair, independent of the counter and hook", () => {
    const telemetry = makeTelemetry();
    const logger = makeLogger();
    const onCacheError = vi.fn();
    const ctx = { telemetry, logger, onCacheError } as unknown as CoreContext;

    for (let i = 0; i < 100; i++) {
      reportCacheFailure(ctx, "l3_query", "lookup", new Error(`boom ${i}`));
    }

    expect(telemetry.counter).toHaveBeenCalledTimes(100);
    expect(onCacheError).toHaveBeenCalledTimes(100);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    resetCacheFailureThrottle();
    reportCacheFailure(ctx, "l3_query", "lookup", new Error("after reset"));

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(telemetry.counter).toHaveBeenCalledTimes(101);
  });

  it("throttles independently per cache:op pair — a different op logs immediately", () => {
    const telemetry = makeTelemetry();
    const logger = makeLogger();
    const ctx = { telemetry, logger } as unknown as CoreContext;

    reportCacheFailure(ctx, "l3_query", "lookup", new Error("lookup boom"));
    reportCacheFailure(ctx, "l3_query", "insert", new Error("insert boom"));
    reportCacheFailure(ctx, "embedding_lru", "get", new Error("get boom"));

    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it("never throws even when logger, telemetry, and the host hook all throw", () => {
    const ctx = {
      telemetry: {
        counter: () => {
          throw new Error("telemetry boom");
        },
      },
      logger: {
        warn: () => {
          throw new Error("logger boom");
        },
      },
      onCacheError: () => {
        throw new Error("hook boom");
      },
    } as unknown as CoreContext;

    expect(() => reportCacheFailure(ctx, "embedding_lru", "get", new Error("x"))).not.toThrow();
  });

  it("degrades to a safe message for a non-Error thrown value", () => {
    const telemetry = makeTelemetry();
    const logger = makeLogger();
    const onCacheError = vi.fn();
    const ctx = { telemetry, logger, onCacheError } as unknown as CoreContext;

    reportCacheFailure(ctx, "l3_query", "lookup", "plain string rejection");

    expect(onCacheError).toHaveBeenCalledWith({
      cache: "l3_query",
      op: "lookup",
      message: "plain string rejection",
    });
  });
});
