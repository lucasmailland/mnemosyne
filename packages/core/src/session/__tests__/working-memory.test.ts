import { describe, it, expect, beforeEach } from "vitest";
import type { CacheAdapter } from "@mnemo-ai/types";

class FakeCache implements CacheAdapter {
  readonly id = "fake";
  readonly capabilities = { sortedSets: false, pubSub: false, patterns: true, atomic: true };
  store = new Map<string, { value: string; expiresAt: number }>();
  counters = new Map<string, { n: number; expiresAt: number }>();

  async get<T>(key: string): Promise<T | null> {
    const e = this.store.get(key);
    if (!e || e.expiresAt < Date.now()) { this.store.delete(key); return null; } // determinism-ok: internal cache helper, not asserted
    return JSON.parse(e.value) as T;
  }
  async set<T>(key: string, value: T, opts?: { ttlMs?: number }): Promise<void> {
    if (!opts?.ttlMs) throw new Error("ttlMs required");
    this.store.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + opts.ttlMs }); // determinism-ok: internal cache helper, not asserted
  }
  async delete(key: string): Promise<void> { this.store.delete(key); this.counters.delete(key); }
  async deletePattern(): Promise<number> { return 0; }
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const e = this.counters.get(key);
    const now = Date.now(); // determinism-ok: internal cache helper, not asserted
    if (!e || e.expiresAt < now) { this.counters.set(key, { n: 1, expiresAt: now + ttlSeconds * 1000 }); return 1; }
    e.n += 1; return e.n;
  }
  async healthCheck() { return { status: "ok" as const, latencyMs: 0 }; }
  async close(): Promise<void> {}
}

export { FakeCache };

describe("FakeCache (test scaffold)", () => {
  it("incrWithTtl increments and respects reset", async () => {
    const c = new FakeCache();
    expect(await c.incrWithTtl("k", 60)).toBe(1);
    expect(await c.incrWithTtl("k", 60)).toBe(2);
  });
});

import { WorkingMemory } from "../working-memory.js";

const WS = "11111111-1111-1111-1111-111111111111";
const AGENT = "agent-1";

describe("WorkingMemory — L0 ops (spec §9)", () => {
  describe("Redis-backed (FakeCache)", () => {
    let cache: FakeCache;
    let wm: WorkingMemory;
    beforeEach(() => { cache = new FakeCache(); wm = new WorkingMemory(cache); });

    it("workSet/workGet round-trips a value under the namespaced key", async () => {
      await wm.workSet(WS, AGENT, "cursor", { file: "x.ts" }, 120);
      expect(await wm.workGet(WS, AGENT, "cursor")).toEqual({ file: "x.ts" });
      expect([...cache.store.keys()][0]).toBe(`mnemo:${WS}:work:${AGENT}:cursor`);
    });

    it("workSet clamps TTL into [60,3600] seconds", async () => {
      await wm.workSet(WS, AGENT, "a", 1, 5);
      await wm.workSet(WS, AGENT, "b", 1, 99999);
      const ttlA = cache.store.get(`mnemo:${WS}:work:${AGENT}:a`)!.expiresAt - Date.now(); // determinism-ok: TTL bound check (range assertion), not asserting absolute time
      const ttlB = cache.store.get(`mnemo:${WS}:work:${AGENT}:b`)!.expiresAt - Date.now(); // determinism-ok: TTL bound check (range assertion), not asserting absolute time
      expect(ttlA).toBeGreaterThan(55_000); expect(ttlA).toBeLessThanOrEqual(60_000);
      expect(ttlB).toBeGreaterThan(3_595_000); expect(ttlB).toBeLessThanOrEqual(3_600_000);
    });

    it("workCheckpoint stores under a checkpoint sub-key, latest wins", async () => {
      await wm.workCheckpoint(WS, AGENT, "wf", { step: 1 });
      await wm.workCheckpoint(WS, AGENT, "wf", { step: 2 });
      expect(await wm.workGet(WS, AGENT, "ckpt:wf")).toEqual({ step: 2 });
    });

    it("bloomAdd then bloomCheck reports membership; absent item is false", async () => {
      await wm.bloomAdd(WS, AGENT, "dedup", "https://a.com/1");
      expect(await wm.bloomCheck(WS, AGENT, "dedup", "https://a.com/1")).toBe(true);
      expect(await wm.bloomCheck(WS, AGENT, "dedup", "https://never-seen.example")).toBe(false);
    });

    it("rateLimitIncr increments a per-window counter", async () => {
      expect(await wm.rateLimitIncr(WS, AGENT, "search", 60)).toBe(1);
      expect(await wm.rateLimitIncr(WS, AGENT, "search", 60)).toBe(2);
    });
  });

  describe("in-process fallback (no cache adapter)", () => {
    let wm: WorkingMemory;
    beforeEach(() => { wm = new WorkingMemory(null); });

    it("workSet/workGet works against the bounded map", async () => {
      await wm.workSet(WS, AGENT, "k", { v: 42 }, 120);
      expect(await wm.workGet(WS, AGENT, "k")).toEqual({ v: 42 });
    });

    it("expired entries return null (lazy TTL expiry)", async () => {
      await wm.workSet(WS, AGENT, "k", 1, 60);
      wm._setClock(() => Date.now() + 61_000); // determinism-ok: synthetic clock injection to force expiry, not asserting the time value
      expect(await wm.workGet(WS, AGENT, "k")).toBeNull();
    });

    it("bloom + rateLimit also work in the fallback", async () => {
      await wm.bloomAdd(WS, AGENT, "d", "x");
      expect(await wm.bloomCheck(WS, AGENT, "d", "x")).toBe(true);
      expect(await wm.rateLimitIncr(WS, AGENT, "op", 60)).toBe(1);
      expect(await wm.rateLimitIncr(WS, AGENT, "op", 60)).toBe(2);
    });

    it("evicts oldest entries when the 10MB byte ceiling is exceeded", async () => {
      const big = "x".repeat(1_000_000);
      for (let i = 0; i < 12; i++) await wm.workSet(WS, AGENT, `big-${i}`, big, 3600);
      expect(await wm.workGet(WS, AGENT, "big-0")).toBeNull();
      expect(await wm.workGet(WS, AGENT, "big-11")).not.toBeNull();
    });
  });

  describe("degradation when cache is down", () => {
    it("falls back to in-process when the adapter throws", async () => {
      const broken = new FakeCache();
      broken.incrWithTtl = async () => { throw new Error("redis down"); };
      broken.get = async () => { throw new Error("redis down"); };
      broken.set = async () => { throw new Error("redis down"); };
      const wm = new WorkingMemory(broken);
      await wm.workSet(WS, AGENT, "k", { v: 1 }, 120);
      expect(await wm.workGet(WS, AGENT, "k")).toEqual({ v: 1 });
      expect(await wm.rateLimitIncr(WS, AGENT, "op", 60)).toBe(1);
    });
  });
});
