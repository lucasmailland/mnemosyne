/**
 * §9 L2/L3 Cache Layer tests — MEMORY_MODEL.md lines 766-803.
 *
 * Uses an in-test FakeCache (Map-backed) so no Redis is needed.
 * No imports from drizzle-orm / pg / redis / ioredis.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { HotCache } from "../hot-cache.js";
import type { CacheAdapter, CacheCapabilities, HealthStatus } from "@mnemo-ai/types";

const WS = "ws-1";

// ─── FakeCache ────────────────────────────────────────────────────────────────
// Minimal Map-backed CacheAdapter for HotCache tests.

class FakeCache implements CacheAdapter {
  readonly id = "fake-cache";
  readonly capabilities: CacheCapabilities = {
    sortedSets: true,
    pubSub: false,
    patterns: false,
    atomic: false,
  };

  readonly store = new Map<string, unknown>();
  readonly ttls = new Map<string, number>();
  private readonly zsets = new Map<string, Map<string, number>>();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }

  async set<T>(key: string, value: T, opts?: { ttlMs?: number }): Promise<void> {
    this.store.set(key, value);
    if (opts?.ttlMs !== undefined) this.ttls.set(key, opts.ttlMs);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.ttls.delete(key);
  }

  async deletePattern(_pattern: string): Promise<number> {
    return 0;
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    const m = this.zsets.get(key) ?? new Map<string, number>();
    m.set(member, score);
    this.zsets.set(key, m);
  }

  async zrangeByScore(
    key: string,
    min: number,
    max: number,
  ): Promise<string[]> {
    const m = this.zsets.get(key) ?? new Map<string, number>();
    return [...m.entries()]
      .filter(([, s]) => s >= min && s <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
  }

  async zincrby(key: string, increment: number, member: string): Promise<number> {
    const m = this.zsets.get(key) ?? new Map<string, number>();
    const next = (m.get(member) ?? 0) + increment;
    m.set(member, next);
    this.zsets.set(key, m);
    return next;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const m = this.zsets.get(key);
    if (!m) return 0;
    let removed = 0;
    for (const mem of members) {
      if (m.delete(mem)) removed++;
    }
    return removed;
  }

  async healthCheck(): Promise<HealthStatus> {
    return { status: "ok", latencyMs: 0 };
  }

  async close(): Promise<void> {}
}

// ─── HotCache unit tests ─────────────────────────────────────────────────────

describe("HotCache — §9 L2 (spec lines 766-773)", () => {
  let cache: FakeCache;
  let hot: HotCache;

  beforeEach(() => {
    cache = new FakeCache();
    hot = new HotCache(cache);
  });

  it("RBAC policy cache: 60s read-through, second call hits cache (loader not re-run)", async () => {
    let loads = 0;
    const loader = async () => {
      loads++;
      return { effect: "allow" };
    };
    const a = await hot.getRbacPolicy(WS, "agent-1", loader);
    const b = await hot.getRbacPolicy(WS, "agent-1", loader);
    expect(a).toEqual({ effect: "allow" });
    expect(b).toEqual({ effect: "allow" });
    expect(loads).toBe(1);
    expect([...cache.store.keys()]).toContain(`mnemo:${WS}:hot:rbac:agent-1`);
    expect(cache.ttls.get(`mnemo:${WS}:hot:rbac:agent-1`)).toBe(60_000);
  });

  it("RBAC policy: different agentIds use different keys", async () => {
    let loads = 0;
    const loader = async () => {
      loads++;
      return { effect: "allow", agent: loads };
    };
    const a = await hot.getRbacPolicy(WS, "agent-1", loader);
    const b = await hot.getRbacPolicy(WS, "agent-2", loader);
    expect(loads).toBe(2);
    expect(a).toEqual({ effect: "allow", agent: 1 });
    expect(b).toEqual({ effect: "allow", agent: 2 });
  });

  it("recent-recall cache: stores hits under a scope-aware query hash and returns them", async () => {
    const hits = [{ id: "f1", score: 0.9 }] as any;
    await hot.putRecall(WS, { text: "hello", scope: "global", agentId: "a", limit: 10 }, hits);
    const got = await hot.getRecall(WS, { text: "hello", scope: "global", agentId: "a", limit: 10 });
    expect(got).toEqual(hits);
    // Different scope → different key → miss
    const other = await hot.getRecall(WS, { text: "hello", scope: "team", agentId: "a", limit: 10 });
    expect(other).toBeNull();
  });

  it("recent-recall: different agentIds produce separate cache entries", async () => {
    const hits1 = [{ id: "f1", score: 0.9 }] as any;
    const hits2 = [{ id: "f2", score: 0.8 }] as any;
    await hot.putRecall(WS, { text: "hello", scope: "global", agentId: "a1", limit: 10 }, hits1);
    await hot.putRecall(WS, { text: "hello", scope: "global", agentId: "a2", limit: 10 }, hits2);
    expect(await hot.getRecall(WS, { text: "hello", scope: "global", agentId: "a1", limit: 10 })).toEqual(hits1);
    expect(await hot.getRecall(WS, { text: "hello", scope: "global", agentId: "a2", limit: 10 })).toEqual(hits2);
  });

  it("evictByActivation: drops the lowest-activation members beyond max via zrem", async () => {
    // Add k0..k4 in order — later touches get higher scores
    for (let i = 0; i < 5; i++) {
      await hot.touch(WS, `k${i}`);
    }
    await hot.evictByActivation(WS, 2);
    // After eviction only top-2 remain in LRU sorted set
    const remaining = await cache.zrangeByScore(
      `mnemo:${WS}:hot:lru`,
      -Infinity,
      Infinity,
    );
    expect(remaining.length).toBe(2);
    expect(remaining).not.toContain("k0"); // lowest evicted
    expect(remaining).not.toContain("k1"); // second lowest evicted
    expect(remaining).not.toContain("k2"); // third lowest evicted
  });

  it("evictByActivation: no-op when count <= max", async () => {
    for (let i = 0; i < 3; i++) await hot.touch(WS, `k${i}`);
    await hot.evictByActivation(WS, 5); // max > count
    const remaining = await cache.zrangeByScore(`mnemo:${WS}:hot:lru`, -Infinity, Infinity);
    expect(remaining.length).toBe(3);
  });

  it("degrades to no-op cold path when cache is null", async () => {
    const none = new HotCache(null);
    let loads = 0;
    const r = await none.getRbacPolicy(WS, "a", async () => {
      loads++;
      return { effect: "deny" };
    });
    expect(r).toEqual({ effect: "deny" });
    expect(loads).toBe(1);
    // recall returns null when no cache
    const got = await none.getRecall(WS, { text: "x", scope: "global", agentId: "a", limit: 1 });
    expect(got).toBeNull();
  });

  it("degrades gracefully when cache throws", async () => {
    const errorCache = {
      ...cache,
      get: async () => { throw new Error("redis down"); },
      set: async () => { throw new Error("redis down"); },
    } as any;
    const hotError = new HotCache(errorCache);
    let loads = 0;
    // Should not throw — should run the loader
    const r = await hotError.getRbacPolicy(WS, "a", async () => {
      loads++;
      return { effect: "allow" };
    });
    expect(r).toEqual({ effect: "allow" });
    expect(loads).toBe(1);
  });
});
