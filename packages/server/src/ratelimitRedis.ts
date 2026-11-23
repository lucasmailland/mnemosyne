/**
 * Redis-backed rate-limit backend for production.
 *
 * Layer 1: token-bucket implemented as an atomic Lua script (one round-trip,
 *   SHA-cached by ioredis defineCommand).
 * Layer 2: concurrency counter via INCR/DECR with a 30 s TTL self-heal.
 * Layer 3+4: fleet/worker shedder signals — see ratelimit.ts fleetUtil option.
 *
 * Spec §35 lines 3972–4014.
 */
import Redis from "ioredis";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { RateLimitBackend } from "./ratelimit.js";
import { logger } from "./logging.js";

// Atomic token-bucket. KEYS[1]=bucket; ARGV=[rps, burst, nowMs].
// Refills (now-last)*rps/1000 tokens up to burst, then consumes 1 if available.
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local rps = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = burst; ts = now end
tokens = math.min(burst, tokens + (now - ts) * rps / 1000)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(burst / rps * 1000) + 1000)
local reset = math.ceil((1 - math.min(tokens, 1)) / rps)
return {allowed, math.floor(tokens), reset}
`;

type RedisWithBucket = Redis & {
  tokenbucket(
    key: string,
    rps: number,
    burst: number,
    now: number,
  ): Promise<[number, number, number]>;
};

export class RedisRateLimitBackend implements RateLimitBackend {
  private redis: RedisWithBucket;
  healthy = false;
  private loopLag = monitorEventLoopDelay({ resolution: 20 });

  constructor(url: string) {
    const r = new Redis(url, {
      lazyConnect: false,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      // CHAOS-4: a Redis that accepts connections but stops answering must not
      // hang every request; a timed-out command fails open like any other error.
      // A command deadline leaves the command queued, so a silent connection is
      // also dropped (socketTimeout) and its commands are not replayed.
      commandTimeout: 500,
      connectTimeout: 2_000,
      socketTimeout: 1_000,
      autoResendUnfulfilledCommands: false,
    });
    // Register the Lua as a named command (ioredis loads + caches its SHA).
    r.defineCommand("tokenbucket", {
      numberOfKeys: 1,
      lua: TOKEN_BUCKET_LUA,
    });
    this.redis = r as RedisWithBucket;
    this.redis.on("ready", () => {
      this.healthy = true;
    });
    this.redis.on("error", (err) => {
      this.healthy = false;
      logger.warn({ err }, "ratelimit.redis_error");
    });
    this.redis.on("end", () => {
      this.healthy = false;
    });
    this.loopLag.enable();
  }

  /** Worker-shedder signal: event-loop mean lag normalized to [0,1] (>=200ms → 1.0). */
  workerUtil(): number {
    return Math.min(1, this.loopLag.mean / 1e6 / 200);
  }

  async consumeToken(key: string, rps: number, burst: number) {
    const [allowed, remaining, reset] = await this.redis.tokenbucket(
      `${key}:tb`,
      rps,
      burst,
      Date.now(),
    );
    return { allowed: allowed === 1, remaining, resetSeconds: Math.max(1, reset) };
  }

  async acquireSlot(key: string, max: number) {
    const slotKey = `${key}:cc`;
    const inFlight = await this.redis.incr(slotKey);
    await this.redis.pexpire(slotKey, 30_000); // self-heal leaked slots after 30s
    if (inFlight > max) {
      await this.redis.decr(slotKey);
      return { acquired: false, inFlight: inFlight - 1 };
    }
    return { acquired: true, inFlight };
  }

  async releaseSlot(key: string) {
    const slotKey = `${key}:cc`;
    const v = await this.redis.decr(slotKey);
    if (v < 0) await this.redis.set(slotKey, "0");
  }

  async close() {
    this.loopLag.disable();
    this.redis.disconnect();
  }
}
