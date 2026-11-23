// packages/adapter-redis/src/__tests__/RedisCacheAdapter.hash.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RedisCacheAdapter } from "../RedisCacheAdapter.js";

// Integration test — requires REDIS_URL (or REDIS_TEST_URL) pointing at a
// real Redis. Skips the entire suite when neither is set, matching the
// RedisListOps.test.ts convention so the unit-test CI job (no Redis) stays green.
const REDIS_URL = process.env.REDIS_URL ?? process.env.REDIS_TEST_URL;
const d = REDIS_URL ? describe : describe.skip;

d("RedisCacheAdapter — Hash ops (WP6.1)", () => {
  let cache: RedisCacheAdapter;

  beforeAll(async () => {
    cache = new RedisCacheAdapter({ url: REDIS_URL! });
  });

  afterAll(async () => {
    await cache.delete("wp6test:hash");
    await cache.close();
  });

  it("hSetWithTtl + hGet + hGetAll round-trips fields with a TTL", async () => {
    const key = "wp6test:hash";
    await cache.delete(key);
    await cache.hSetWithTtl(key, "hypothesis", "DNS?", 60);
    await cache.hSetWithTtl(key, "ruled_out", "true", 60);

    expect(await cache.hGet(key, "hypothesis")).toBe("DNS?");
    expect(await cache.hGet(key, "missing")).toBeNull();

    const all = await cache.hGetAll(key);
    expect(all).toEqual({ hypothesis: "DNS?", ruled_out: "true" });
  });

  it("hDel removes a field", async () => {
    const key = "wp6test:hash";
    await cache.hSetWithTtl(key, "tmp", "x", 60);
    expect(await cache.hGet(key, "tmp")).toBe("x");
    await cache.hDel(key, "tmp");
    expect(await cache.hGet(key, "tmp")).toBeNull();
  });

  it("capabilities advertises hashes:true", () => {
    expect(cache.capabilities.hashes).toBe(true);
  });
});
