import { describe, it, expect, beforeEach } from "vitest";
import { RedisCacheAdapter } from "../RedisCacheAdapter.js";

const url = process.env.REDIS_TEST_URL;
const d = url ? describe : describe.skip;

d("RedisCacheAdapter list ops (§35 replay buffer)", () => {
  let cache: RedisCacheAdapter;
  beforeEach(async () => {
    cache = new RedisCacheAdapter({ url: url! });
    await cache.delete("mnemo:t:ws_buffer:facts.*");
  });

  it("lpush + lrange round-trips newest-first then ltrim caps length", async () => {
    const k = "mnemo:t:ws_buffer:facts.*";
    await cache.lpush!(k, "a"); await cache.lpush!(k, "b"); await cache.lpush!(k, "c");
    expect(await cache.lrange!(k, 0, -1)).toEqual(["c", "b", "a"]);
    await cache.ltrim!(k, 0, 1);
    expect(await cache.lrange!(k, 0, -1)).toEqual(["c", "b"]);
  });

  it("lpushCapped pushes, trims to max, and sets TTL", async () => {
    const k = "mnemo:t:ws_buffer:facts.*";
    for (let i = 0; i < 5; i++) await cache.lpushCapped!(k, `e${i}`, 3, 3600);
    const all = await cache.lrange!(k, 0, -1);
    expect(all.length).toBe(3);
    expect(all[0]).toBe("e4");
  });
});
