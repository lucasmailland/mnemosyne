/**
 * CHAOS-4: with Redis down, every recall failed (500 after ~97 s), although
 * the hot tier is only a cache and the cold path needs no Redis. Now that the
 * cache client fails fast, a hot-tier read failure must count as a miss: the
 * recall falls through to the cold path, and the failure is reported, not
 * swallowed silently.
 */
import { describe, expect, it, vi } from "vitest";
import type { AuthContext, CacheAdapter } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { createCore } from "../index.js";

const WS = "ws-cache-down";
const EMBEDDING = new Float32Array([0.1, 0.2, 0.3, 0.4]);

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

/** A Redis-backed cache whose every command fails, as with Redis stopped. */
function downCache(): CacheAdapter {
  const base = {
    id: "redis-down",
    capabilities: { sortedSets: true, pubSub: true, patterns: true, atomic: true, hashes: true },
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
      if (prop === "then") return undefined;
      return () => Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
    },
  }) as unknown as CacheAdapter;
}

describe("recall with the cache down (CHAOS-4)", () => {
  it("falls back to the cold path instead of failing", async () => {
    const storage = new InMemoryStorageAdapter();
    const fact = await storage.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "the cold path still answers when redis is down",
      subject: "cache-down",
      kind: "other",
      attribution: "user_stated",
      sensitivity: "public",
    });
    const onCacheError = vi.fn();
    const core = createCore({
      storage,
      vector: {
        search: vi.fn().mockResolvedValue([{ id: fact.id, score: 1, primitiveKind: "fact" }]),
      } as never,
      embed: { model: "test", embedSingle: vi.fn().mockResolvedValue(EMBEDDING) } as never,
      outbox: { append: vi.fn().mockResolvedValue(undefined) } as never,
      cache: downCache(),
      logger,
      telemetry,
      onCacheError,
    } as never);

    const res = await core.recall(
      { workspaceId: WS, text: "redis is down", embedding: EMBEDDING },
      {
        workspaceId: WS,
        actorId: "agent-1",
        actorType: "agent",
        scopes: ["memory:read"],
      } as AuthContext
    );

    expect(res.hits.map((h) => h.id)).toContain(fact.id);
    expect(onCacheError).toHaveBeenCalledWith(
      expect.objectContaining({ cache: "hot_tier", op: "lookup" })
    );
  });
});
