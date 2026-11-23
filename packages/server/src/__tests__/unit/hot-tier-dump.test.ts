/**
 * §37 Hot-tier dump engine unit tests.
 */
import { describe, it, expect, vi } from "vitest";
import { dumpToPg, rebuildFromPg, hotTierKey } from "../../resilience/hotTierDump.js";
import type { HotTierPersistence } from "../../resilience/hotTierDump.js";
import type { CacheAdapter } from "@mnemo-ai/types";

function makeCache(zsetEntries: Record<string, Array<{ member: string; score: number }>> = {}): CacheAdapter & {
  zadd: ReturnType<typeof vi.fn>;
  zrangeByScore: ReturnType<typeof vi.fn>;
} {
  const zadd = vi.fn();
  const zrangeByScore = vi.fn().mockImplementation(async (key: string) => {
    return zsetEntries[key] ?? [];
  });
  return {
    id: "test-cache",
    capabilities: { sortedSets: true, pubSub: false, patterns: false, atomic: false },
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
    delete: vi.fn(),
    deletePattern: vi.fn(),
    has: vi.fn().mockResolvedValue(false),
    incr: vi.fn().mockResolvedValue(0),
    incrWithTtl: vi.fn().mockResolvedValue(0),
    expire: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn().mockResolvedValue(() => {}),
    publish: vi.fn(),
    zadd,
    zrangeByScore,
    zincrby: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue({ status: "ok" as const, latencyMs: 0 }),
    close: vi.fn(),
  };
}

function makePersistence(existingRows: Parameters<HotTierPersistence["loadHotTierSnapshots"]>[0] extends string | undefined ? Awaited<ReturnType<HotTierPersistence["loadHotTierSnapshots"]>> : never = []): HotTierPersistence & {
  upserted: Array<Parameters<HotTierPersistence["upsertHotTierSnapshot"]>[0][number]>;
} {
  const upserted: Array<Parameters<HotTierPersistence["upsertHotTierSnapshot"]>[0][number]> = [];
  return {
    upserted,
    async upsertHotTierSnapshot(rows) { upserted.push(...rows); },
    async loadHotTierSnapshots() { return existingRows as Awaited<ReturnType<HotTierPersistence["loadHotTierSnapshots"]>>; },
  };
}

describe("§37 hotTierDump", () => {
  it("hotTierKey builds expected key", () => {
    expect(hotTierKey("ws-abc")).toBe("mnemo:ws-abc:hot");
  });

  it("dumpToPg skips when no sorted-set support", async () => {
    const cache = makeCache();
    (cache as { capabilities: { sortedSets: boolean } }).capabilities.sortedSets = false;
    const persistence = makePersistence([]);
    await dumpToPg(cache, persistence, async () => ["ws1"]);
    expect(persistence.upserted).toHaveLength(0);
  });

  it("dumpToPg reads ZSet entries and upserts them to PG", async () => {
    const key = hotTierKey("ws1");
    const cache = makeCache({ [key]: [{ member: "fact-1", score: 0.9 }, { member: "fact-2", score: 0.7 }] });
    const persistence = makePersistence([]);
    await dumpToPg(cache, persistence, async () => ["ws1"]);
    expect(persistence.upserted).toHaveLength(2);
    expect(persistence.upserted[0]!.workspaceId).toBe("ws1");
    expect(persistence.upserted[0]!.cacheKey).toBe("fact-1");
    expect(persistence.upserted[0]!.score).toBe(0.9);
  });

  it("rebuildFromPg loads PG rows back into Redis ZSet", async () => {
    const cache = makeCache();
    const persistence = makePersistence([
      { workspaceId: "ws1", cacheKey: "fact-1", score: 0.9, payload: {} },
      { workspaceId: "ws1", cacheKey: "fact-2", score: 0.5, payload: {} },
    ] as never);
    await rebuildFromPg(cache, persistence);
    expect(cache.zadd).toHaveBeenCalledTimes(2);
    expect(cache.zadd).toHaveBeenCalledWith(hotTierKey("ws1"), 0.9, "fact-1");
    expect(cache.zadd).toHaveBeenCalledWith(hotTierKey("ws1"), 0.5, "fact-2");
  });

  it("rebuildFromPg skips when no sorted-set support", async () => {
    const cache = makeCache();
    (cache as { capabilities: { sortedSets: boolean } }).capabilities.sortedSets = false;
    const persistence = makePersistence([
      { workspaceId: "ws1", cacheKey: "fact-1", score: 0.9, payload: {} },
    ] as never);
    await rebuildFromPg(cache, persistence);
    expect(cache.zadd).not.toHaveBeenCalled();
  });
});
