// packages/server/src/routes/__tests__/session-buffer-routes.test.ts
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { SessionBuffer } from "@mnemo-ai/core";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { CacheAdapter } from "@mnemo-ai/types";

// Minimal Redis-shaped fake (List + Hash + ZSet). Same shape as WP6.2's FakeCache.
class FakeCache implements CacheAdapter {
  readonly id = "fake";
  readonly capabilities = {
    sortedSets: true,
    pubSub: false,
    patterns: true,
    atomic: true,
    hashes: true,
  };
  lists = new Map<string, string[]>();
  hashes = new Map<string, Record<string, string>>();
  zsets = new Map<string, Map<string, number>>();
  async get<T>(): Promise<T | null> {
    return null;
  }
  async set(): Promise<void> {}
  async delete(k: string): Promise<void> {
    this.lists.delete(k);
    this.hashes.delete(k);
    this.zsets.delete(k);
  }
  async deletePattern(): Promise<number> {
    return 0;
  }
  async lpush(k: string, v: string): Promise<number> {
    const a = this.lists.get(k) ?? [];
    a.unshift(v);
    this.lists.set(k, a);
    return a.length;
  }
  async lrange(k: string, s: number, e: number): Promise<string[]> {
    const a = this.lists.get(k) ?? [];
    return a.slice(s, e === -1 ? a.length : e + 1);
  }
  async ltrim(k: string, s: number, e: number): Promise<void> {
    const a = this.lists.get(k) ?? [];
    this.lists.set(k, a.slice(s, e === -1 ? a.length : e + 1));
  }
  async lpushCapped(k: string, v: string, max: number): Promise<void> {
    await this.lpush(k, v);
    await this.ltrim(k, 0, max - 1);
  }
  async hSetWithTtl(k: string, f: string, v: string): Promise<void> {
    const h = this.hashes.get(k) ?? {};
    h[f] = v;
    this.hashes.set(k, h);
  }
  async hGet(k: string, f: string): Promise<string | null> {
    return this.hashes.get(k)?.[f] ?? null;
  }
  async hGetAll(k: string): Promise<Record<string, string>> {
    return { ...(this.hashes.get(k) ?? {}) };
  }
  async hDel(k: string, ...f: string[]): Promise<number> {
    const h = this.hashes.get(k);
    if (!h) return 0;
    let n = 0;
    for (const x of f) {
      if (x in h) {
        delete h[x];
        n++;
      }
    }
    return n;
  }
  async zadd(k: string, sc: number, m: string): Promise<void> {
    const z = this.zsets.get(k) ?? new Map();
    z.set(m, sc);
    this.zsets.set(k, z);
  }
  async zrangeByScore(k: string, min: number, max: number): Promise<string[]> {
    const z = this.zsets.get(k) ?? new Map<string, number>();
    return [...z.entries()]
      .filter(([, s]) => s >= min && s <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }
  async zrem(k: string, ...m: string[]): Promise<number> {
    const z = this.zsets.get(k);
    if (!z) return 0;
    let n = 0;
    for (const x of m) if (z.delete(x)) n++;
    return n;
  }
  async healthCheck() {
    return { status: "ok" as const, latencyMs: 0 };
  }
  async close(): Promise<void> {}
}

// This test exercises the SessionBuffer wiring contract the routes depend on:
// after a turn append through the buffer, the turn is in BOTH Redis and PG, and
// the sess:active ZSet has the session. (Route-level HTTP integration is covered
// by the existing session route suite; here we assert the buffer contract the
// handlers now use.)
describe("session routes via SessionBuffer (WP6.3 contract)", () => {
  const WS = "11111111-1111-1111-1111-111111111111";

  it("turn append through buffer is durable in PG and mirrored in Redis + sess:active", async () => {
    const cache = new FakeCache();
    const storage = new InMemoryStorageAdapter();
    const buf = new SessionBuffer(cache, storage, {
      replaceSessionScratch: async () => true,
      getSessionScratch: async () => null,
    });
    const s = await storage.createSession({ workspaceId: WS });

    await buf.appendTurn(WS, s.id, {
      workspaceId: WS,
      sessionId: s.id,
      turnIndex: 0,
      role: "user",
      content: "hi",
    });

    expect((await storage.listTurns(s.id, WS)).length).toBe(1); // PG durable
    expect(cache.lists.get(`mnemo:${WS}:sess:${s.id}:turns`)?.length).toBe(1); // Redis mirror
    expect(await buf.listActiveSessions(WS, 0, Date.now() + 1000)).toContain(s.id); // sweep index // determinism-ok: upper-bound sentinel
  });

  it("scratch through buffer uses the durable store and invalidates the legacy Redis Hash", async () => {
    const cache = new FakeCache();
    const storage = new InMemoryStorageAdapter();
    const scratch = new Map<string, Record<string, unknown>>();
    const buf = new SessionBuffer(cache, storage, {
      replaceSessionScratch: async ({ workspaceId, sessionId, scratch: replacement }) => {
        scratch.set(`${workspaceId}:${sessionId}`, { ...replacement });
        return true;
      },
      getSessionScratch: async ({ workspaceId, sessionId }) =>
        scratch.get(`${workspaceId}:${sessionId}`) ?? null,
    });
    const s = await storage.createSession({ workspaceId: WS });
    cache.hashes.set(`mnemo:${WS}:sess:${s.id}`, { stale: JSON.stringify(true) });

    await expect(buf.setScratch(WS, s.id, { hypothesis: "DNS?" })).resolves.toBe(true);
    expect(await buf.getScratch(WS, s.id)).toEqual({ hypothesis: "DNS?" });
    expect(cache.hashes.has(`mnemo:${WS}:sess:${s.id}`)).toBe(false);
  });
});

it("adapts the server logger before injecting it into SessionBuffer", () => {
  const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
  // flatten-legacy-dual-core Phase 7: `storageForDeps` (a `StorageAdapter`)
  // satisfies `SessionScratchStore` directly — the separate `scratchStore`
  // object (built from the legacy `core.{replaceSessionScratch,
  // getSessionScratch}` pair) is gone; `getSessionScratch` is now a v3
  // `StorageAdapter` port method (`@mnemo-ai/types` ports.ts) implemented
  // directly by `storageForDeps`.
  expect(source).toMatch(
    /new SessionBuffer\(\s*hotTierCache \?\? null,\s*storageForDeps,\s*storageForDeps,\s*v3Logger\s*\)/
  );
});
