// packages/core/src/session/__tests__/session-buffer.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CacheAdapter, StorageAdapter, SessionTurn } from "@mnemo-ai/types";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import {
  SessionBuffer,
  sessTurnsKey,
  sessScratchKey,
  sessActiveKey,
  type SessionScratchStore,
} from "../session-buffer.js";

// Redis-shaped fake implementing the List + Hash + ZSet ops SessionBuffer uses.
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
  expires = new Map<string, number>();
  down = false;

  private guard() {
    if (this.down) throw new Error("redis down");
  }

  async get<T>(): Promise<T | null> {
    this.guard();
    return null;
  }
  async set(): Promise<void> {
    this.guard();
  }
  async delete(key: string): Promise<void> {
    this.guard();
    this.lists.delete(key);
    this.hashes.delete(key);
    this.zsets.delete(key);
  }
  async deletePattern(): Promise<number> {
    this.guard();
    return 0;
  }

  async lpush(key: string, value: string): Promise<number> {
    this.guard();
    const arr = this.lists.get(key) ?? [];
    arr.unshift(value);
    this.lists.set(key, arr);
    return arr.length;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.guard();
    const arr = this.lists.get(key) ?? [];
    const end = stop === -1 ? arr.length : stop + 1;
    return arr.slice(start, end);
  }
  async ltrim(key: string, start: number, stop: number): Promise<void> {
    this.guard();
    const arr = this.lists.get(key) ?? [];
    const end = stop === -1 ? arr.length : stop + 1;
    this.lists.set(key, arr.slice(start, end));
  }
  async lpushCapped(key: string, value: string, max: number, ttlSeconds: number): Promise<void> {
    this.guard();
    await this.lpush(key, value);
    await this.ltrim(key, 0, max - 1);
    this.expires.set(key, Date.now() + ttlSeconds * 1000); // determinism-ok: internal fake Redis helper state, not asserted
  }

  async hSetWithTtl(key: string, field: string, value: string, ttlSeconds: number): Promise<void> {
    this.guard();
    const h = this.hashes.get(key) ?? {};
    h[field] = value;
    this.hashes.set(key, h);
    this.expires.set(key, Date.now() + ttlSeconds * 1000); // determinism-ok: internal fake Redis helper state, not asserted
  }
  async hGet(key: string, field: string): Promise<string | null> {
    this.guard();
    return this.hashes.get(key)?.[field] ?? null;
  }
  hGetAll = vi.fn(async (key: string): Promise<Record<string, string>> => {
    this.guard();
    return { ...(this.hashes.get(key) ?? {}) };
  });
  async hDel(key: string, ...fields: string[]): Promise<number> {
    this.guard();
    const h = this.hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) {
      if (f in h) {
        delete h[f];
        n++;
      }
    }
    return n;
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    this.guard();
    const z = this.zsets.get(key) ?? new Map();
    z.set(member, score);
    this.zsets.set(key, z);
  }
  async zrangeByScore(key: string, min: number, max: number, limit?: number): Promise<string[]> {
    this.guard();
    const z = this.zsets.get(key) ?? new Map<string, number>();
    let members = [...z.entries()]
      .filter(([, s]) => s >= min && s <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
    if (limit !== undefined) members = members.slice(0, limit);
    return members;
  }
  async zrem(key: string, ...members: string[]): Promise<number> {
    this.guard();
    const z = this.zsets.get(key);
    if (!z) return 0;
    let n = 0;
    for (const m of members) if (z.delete(m)) n++;
    return n;
  }

  async healthCheck() {
    return { status: this.down ? ("down" as const) : ("ok" as const), latencyMs: 0 };
  }
  async close(): Promise<void> {}
}

const WS = "11111111-1111-1111-1111-111111111111";

function turn(i: number, content: string): Omit<SessionTurn, "id" | "createdAt"> {
  return { workspaceId: WS, sessionId: "s1", turnIndex: i, role: "user", content };
}

function makeScratchStore() {
  const values = new Map<string, Record<string, unknown>>();
  const replaceSessionScratch = vi.fn<SessionScratchStore["replaceSessionScratch"]>(
    async ({ workspaceId, sessionId, scratch }) => {
      values.set(`${workspaceId}:${sessionId}`, { ...scratch });
      return true;
    }
  );
  const getSessionScratch = vi.fn<SessionScratchStore["getSessionScratch"]>(
    async ({ workspaceId, sessionId }) => values.get(`${workspaceId}:${sessionId}`) ?? null
  );
  return { values, replaceSessionScratch, getSessionScratch };
}

describe("SessionBuffer (WP6.2)", () => {
  let cache: FakeCache;
  let storage: StorageAdapter;
  let scratchStore: ReturnType<typeof makeScratchStore>;
  let buf: SessionBuffer;

  beforeEach(async () => {
    cache = new FakeCache();
    storage = new InMemoryStorageAdapter();
    scratchStore = makeScratchStore();
    buf = new SessionBuffer(cache, storage, scratchStore);
    const s = await storage.createSession({ workspaceId: WS });
    // Force a deterministic id the test references.
    (s as { id: string }).id; // session id from storage; we use storage's id below
  });

  it("appendTurn writes through to PG AND is readable from the Redis turns List within TTL", async () => {
    const s = await storage.createSession({ workspaceId: WS });
    await buf.appendTurn(WS, s.id, {
      workspaceId: WS,
      sessionId: s.id,
      turnIndex: 0,
      role: "user",
      content: "hello",
    });

    // Redis copy
    const fromRedis = await buf.listTurns(WS, s.id);
    expect(fromRedis.map((t) => t.content)).toEqual(["hello"]);
    expect(cache.lists.get(sessTurnsKey(WS, s.id))?.length).toBe(1);

    // PG copy (durability)
    const fromPg = await storage.listTurns(s.id, WS);
    expect(fromPg.map((t) => t.content)).toEqual(["hello"]);
  });

  it("mirrors the turn index allocated by durable storage", async () => {
    const s = await storage.createSession({ workspaceId: WS });
    vi.spyOn(storage, "appendTurn").mockResolvedValueOnce(7 as never);

    await buf.appendTurn(WS, s.id, {
      workspaceId: WS,
      sessionId: s.id,
      turnIndex: 0,
      role: "user",
      content: "concurrent",
    });

    const cached = JSON.parse(cache.lists.get(sessTurnsKey(WS, s.id))![0]!) as SessionTurn;
    expect(cached.turnIndex).toBe(7);
  });

  it("appendTurn updates the sess:active SortedSet with last-activity score", async () => {
    const s = await storage.createSession({ workspaceId: WS });
    const before = Date.now(); // determinism-ok: lower bound sentinel, containment checked not value
    await buf.appendTurn(WS, s.id, {
      workspaceId: WS,
      sessionId: s.id,
      turnIndex: 0,
      role: "user",
      content: "x",
    });
    const active = await buf.listActiveSessions(WS, 0, before + 10_000);
    expect(active).toContain(s.id);
  });

  it("listTurns falls back to PG when the Redis List is empty (cache miss)", async () => {
    const s = await storage.createSession({ workspaceId: WS });
    // Write ONLY to PG (simulate a turn that predates the buffer).
    await storage.appendTurn(s.id, {
      workspaceId: WS,
      sessionId: s.id,
      turnIndex: 0,
      role: "user",
      content: "pg-only",
    });
    const turns = await buf.listTurns(WS, s.id);
    expect(turns.map((t) => t.content)).toEqual(["pg-only"]);
  });

  it("returns false without touching Redis when the durable row is absent", async () => {
    scratchStore.replaceSessionScratch.mockResolvedValueOnce(false);

    await expect(buf.setScratch(WS, "missing", { a: 1 })).resolves.toBe(false);

    expect(cache.hashes.size).toBe(0);
    expect(cache.zsets.size).toBe(0);
  });

  it("does not touch Redis when the durable replacement rejects", async () => {
    scratchStore.replaceSessionScratch.mockRejectedValueOnce(new Error("postgres down"));

    await expect(buf.setScratch(WS, "s1", { a: 1 })).rejects.toThrow("postgres down");

    expect(cache.hashes.size).toBe(0);
    expect(cache.zsets.size).toBe(0);
  });

  it("resolves the durable replacement before deleting the legacy scratch hash", async () => {
    let durableResolved = false;
    scratchStore.replaceSessionScratch.mockImplementationOnce(async () => {
      durableResolved = true;
      return true;
    });
    const deleteSpy = vi.spyOn(cache, "delete").mockImplementationOnce(async () => {
      expect(durableResolved).toBe(true);
    });

    await expect(buf.setScratch(WS, "s1", { a: 1 })).resolves.toBe(true);

    expect(deleteSpy).toHaveBeenCalledWith(sessScratchKey(WS, "s1"));
  });

  it("reads scratch only from the durable store", async () => {
    cache.hashes.set(sessScratchKey(WS, "s1"), { stale: "true" });
    scratchStore.values.set(`${WS}:s1`, { current: true });

    await expect(buf.getScratch(WS, "s1")).resolves.toEqual({ current: true });

    expect(scratchStore.getSessionScratch).toHaveBeenCalledOnce();
    expect(cache.hGetAll).not.toHaveBeenCalled();
  });

  it("maps an absent durable scratch row to an empty object", async () => {
    await expect(buf.getScratch(WS, "missing")).resolves.toEqual({});
  });

  it("deletes the legacy scratch hash and records activity after replacement", async () => {
    cache.hashes.set(sessScratchKey(WS, "s1"), { stale: "true" });

    await expect(buf.setScratch(WS, "s1", { current: true })).resolves.toBe(true);

    expect(cache.hashes.has(sessScratchKey(WS, "s1"))).toBe(false);
    expect(cache.zsets.get(sessActiveKey(WS))?.has("s1")).toBe(true);
  });

  it("attempts activity when legacy scratch deletion rejects", async () => {
    vi.spyOn(cache, "delete").mockRejectedValueOnce(new Error("delete failed"));
    const zaddSpy = vi.spyOn(cache, "zadd");

    await expect(buf.setScratch(WS, "s1", { a: 1 })).resolves.toBe(true);

    expect(zaddSpy).toHaveBeenCalledOnce();
  });

  it("deletes legacy scratch when zadd is absent", async () => {
    cache.hashes.set(sessScratchKey(WS, "s1"), { stale: "true" });
    cache.zadd = undefined;

    await expect(buf.setScratch(WS, "s1", { a: 1 })).resolves.toBe(true);

    expect(cache.hashes.has(sessScratchKey(WS, "s1"))).toBe(false);
  });

  it("keeps replacement successful when activity update rejects", async () => {
    const deleteSpy = vi.spyOn(cache, "delete");
    vi.spyOn(cache, "zadd").mockRejectedValueOnce(new Error("zadd failed"));

    await expect(buf.setScratch(WS, "s1", { a: 1 })).resolves.toBe(true);

    expect(deleteSpy).toHaveBeenCalledOnce();
  });

  it("passes an empty replacement unchanged to the durable writer", async () => {
    const scratch = {};

    await buf.setScratch(WS, "s1", scratch);

    expect(scratchStore.replaceSessionScratch).toHaveBeenCalledWith({
      workspaceId: WS,
      sessionId: "s1",
      scratch,
    });
  });

  it("Redis-down path: appendTurn still persists to PG and listTurns reads from PG (no throw)", async () => {
    const s = await storage.createSession({ workspaceId: WS });
    cache.down = true;
    await buf.appendTurn(WS, s.id, {
      workspaceId: WS,
      sessionId: s.id,
      turnIndex: 0,
      role: "user",
      content: "degraded",
    });
    const turns = await buf.listTurns(WS, s.id);
    expect(turns.map((t) => t.content)).toEqual(["degraded"]);
    const pg = await storage.listTurns(s.id, WS);
    expect(pg.length).toBe(1);
  });

  it("clear removes all three Redis keys for the session", async () => {
    const s = await storage.createSession({ workspaceId: WS });
    await buf.appendTurn(WS, s.id, {
      workspaceId: WS,
      sessionId: s.id,
      turnIndex: 0,
      role: "user",
      content: "a",
    });
    await buf.setScratch(WS, s.id, { k: 1 });
    await buf.clear(WS, s.id);
    expect(cache.lists.get(sessTurnsKey(WS, s.id))).toBeUndefined();
    expect(cache.hashes.get(sessScratchKey(WS, s.id))).toBeUndefined();
    const active = await buf.listActiveSessions(WS, 0, Date.now() + 10_000); // determinism-ok: upper bound sentinel, containment checked not value
    expect(active).not.toContain(s.id);
  });

  it("null-cache constructor degrades to PG-only with no throw", async () => {
    const pgOnly = new SessionBuffer(null, storage, scratchStore);
    const s = await storage.createSession({ workspaceId: WS });
    await pgOnly.appendTurn(WS, s.id, {
      workspaceId: WS,
      sessionId: s.id,
      turnIndex: 0,
      role: "user",
      content: "nocache",
    });
    const turns = await pgOnly.listTurns(WS, s.id);
    expect(turns.map((t) => t.content)).toEqual(["nocache"]);

    await expect(pgOnly.setScratch(WS, s.id, { durable: true })).resolves.toBe(true);
    await expect(pgOnly.getScratch(WS, s.id)).resolves.toEqual({ durable: true });
  });
});

it("key helpers match the spec key shapes", () => {
  expect(sessTurnsKey(WS, "s1")).toBe(`mnemo:${WS}:sess:s1:turns`);
  expect(sessScratchKey(WS, "s1")).toBe(`mnemo:${WS}:sess:s1`);
  expect(sessActiveKey(WS)).toBe(`mnemo:${WS}:sess:active`);
});

describe("capture origin fidelity", () => {
  it("preserves typed origin and its evidence in Redis and durable fallback", async () => {
    const cache = new FakeCache();
    const storage = new InMemoryStorageAdapter();
    const buffer = new SessionBuffer(cache, storage, makeScratchStore());
    const session = await storage.createSession({ workspaceId: WS });
    const content = "<task-notification>result</task-notification>";
    await buffer.appendTurn(WS, session.id, {
      workspaceId: WS,
      sessionId: session.id,
      turnIndex: 0,
      role: "user",
      content,
      turnOrigin: "task_notification",
      turnOriginEvidence: "host:native_type",
    });
    const [cached] = await buffer.listTurns(WS, session.id);
    cache.down = true;
    const [durable] = await buffer.listTurns(WS, session.id);
    for (const turn of [cached, durable])
      expect(turn).toMatchObject({
        role: "user",
        content,
        turnOrigin: "task_notification",
        turnOriginEvidence: "host:native_type",
      });
  });

  it("does not mirror a replay into Redis or expose a partial segment", async () => {
    const cache = new FakeCache();
    const storage = new InMemoryStorageAdapter();
    const buffer = new SessionBuffer(cache, storage, makeScratchStore());
    const session = await storage.createSession({ workspaceId: WS });
    const turn = {
      workspaceId: WS,
      sessionId: session.id,
      turnIndex: 0,
      role: "user" as const,
      content: "yes",
      sourceMessageId: "occurrence",
    };
    await buffer.appendTurn(WS, session.id, turn);
    await buffer.appendTurn(WS, session.id, turn);
    expect(await buffer.listTurns(WS, session.id)).toHaveLength(1);
  });

  it("keeps serving durable turns after an ordinary append follows a replayed occurrence", async () => {
    const cache = new FakeCache();
    const storage = new InMemoryStorageAdapter();
    const buffer = new SessionBuffer(cache, storage, makeScratchStore());
    const session = await storage.createSession({ workspaceId: WS });
    const base = { workspaceId: WS, sessionId: session.id, role: "user" as const };
    await buffer.appendTurn(WS, session.id, {
      ...base,
      turnIndex: 0,
      content: "first",
      sourceMessageId: "occurrence",
    });
    await buffer.appendTurn(WS, session.id, { ...base, turnIndex: 1, content: "second" });
    await buffer.appendTurn(WS, session.id, { ...base, turnIndex: 2, content: "third" });
    expect((await buffer.listTurns(WS, session.id)).map((t) => t.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
