import Redis from "ioredis";
import type {
  CacheAdapter,
  CacheInfo,
  CacheSetOpts,
  CacheCapabilities,
  HealthStatus,
  Logger,
} from "@mnemo-ai/types";
import { redisOperations, redisLatency } from "./metrics.js";

export interface RedisCacheAdapterConfig {
  host?: string;
  port?: number;
  url?: string; // alternative to host/port
  password?: string;
  db?: number;
  maxTtlSeconds?: number; // default: 259200 (72h)
  keyPrefix?: string; // default: '' (no prefix)
  /** A command with no reply after this long fails. Default: 1000 ms. */
  commandTimeoutMs?: number;
  /** A connection attempt fails after this long. Default: 2000 ms. */
  connectTimeoutMs?: number;
  /**
   * A connection with commands outstanding that receives nothing for this long
   * is dropped and reconnected. Default: 2000 ms.
   */
  socketTimeoutMs?: number;
}

const DEFAULT_MAX_TTL_SECONDS = 259200; // 72 hours

/**
 * CHAOS-4: with Redis down, recall and `/session/start` hung ~97 s: the
 * client queued every command offline and retried each up to 20 times before
 * failing. A cache must fail fast so callers degrade (hot tier → cold recall,
 * sessions → prompt 503): every command gets a deadline (it covers time spent
 * in the offline queue too), the queue is flushed after one failed retry, and
 * a connection attempt has its own deadline. The offline queue itself stays:
 * without it, commands issued while the client is still connecting (at boot,
 * right after a reconnect) fail instead of waiting a few milliseconds.
 * Reconnection keeps running in the background, so the cache comes back by
 * itself when Redis does.
 *
 * A command deadline only rejects the caller: ioredis keeps the command queued
 * until a reply arrives, and a connected-but-silent Redis never replies, so
 * sustained traffic grew that queue without bound. `socketTimeout` drops a
 * connection that has commands outstanding and receives nothing, and with
 * `autoResendUnfulfilledCommands` off the dropped commands (already failed
 * for their callers) are discarded instead of replayed on the next connection.
 */
function failFastOptions(config: RedisCacheAdapterConfig) {
  return {
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    commandTimeout: config.commandTimeoutMs ?? 1_000,
    connectTimeout: config.connectTimeoutMs ?? 2_000,
    socketTimeout: config.socketTimeoutMs ?? 2_000,
    autoResendUnfulfilledCommands: false,
  };
}

export class RedisCacheAdapter implements CacheAdapter {
  readonly id = "redis";
  readonly capabilities: CacheCapabilities = {
    sortedSets: true,
    pubSub: true,
    patterns: true,
    atomic: true,
    hashes: true,
  };

  private redis: Redis;
  private subscriber: Redis | null = null;
  private maxTtlSeconds: number;
  private logger: Logger | undefined;

  // ADP-1: without an 'error' listener, ioredis's async connection errors
  // (reset, refused, auth-fail after boot) are uncaught exceptions that crash
  // the whole process — defeating the "optional hot tier degrades to cold"
  // contract every caller of this adapter relies on.
  private attachErrorListener(client: Redis, label: string): void {
    client.on("error", (err: Error) => {
      this.logger?.warn(`RedisCacheAdapter: ${label} client error — degrading to cold path`, {
        error: { type: err.name, message: err.message },
      });
    });
  }

  constructor(config: RedisCacheAdapterConfig = {}, logger?: Logger) {
    this.maxTtlSeconds = config.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
    this.logger = logger;

    if (config.url) {
      this.redis = new Redis(config.url, {
        ...(config.password !== undefined && { password: config.password }),
        ...(config.db !== undefined && { db: config.db }),
        ...(config.keyPrefix !== undefined && { keyPrefix: config.keyPrefix }),
        lazyConnect: false,
        ...failFastOptions(config),
      });
    } else {
      this.redis = new Redis({
        host: config.host ?? "127.0.0.1",
        port: config.port ?? 6379,
        ...(config.password !== undefined && { password: config.password }),
        ...(config.db !== undefined && { db: config.db }),
        ...(config.keyPrefix !== undefined && { keyPrefix: config.keyPrefix }),
        lazyConnect: false,
        ...failFastOptions(config),
      });
    }
    this.attachErrorListener(this.redis, "primary");
  }

  private async instrument<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      redisOperations.inc({ operation });
      redisLatency.observe({ operation }, (Date.now() - start) / 1000);
      return result;
    } catch (e) {
      redisOperations.inc({ operation });
      redisLatency.observe({ operation }, (Date.now() - start) / 1000);
      throw e;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    return this.instrument("get", async () => {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    });
  }

  async set<T>(key: string, value: T, opts?: CacheSetOpts): Promise<void> {
    return this.instrument("set", async () => {
      if (!opts?.ttlMs) {
        throw new Error("CacheAdapter.set() requires ttlMs — no PERSIST allowed (ARCH-01 fix)");
      }
      const ttlSeconds = Math.min(Math.ceil(opts.ttlMs / 1000), this.maxTtlSeconds);
      const serialized = JSON.stringify(value);
      if (opts.ifNotExists) {
        await this.redis.set(key, serialized, "EX", ttlSeconds, "NX");
      } else {
        await this.redis.set(key, serialized, "EX", ttlSeconds);
      }
    });
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async deletePattern(pattern: string): Promise<number> {
    // Use SCAN with cursor — never KEYS (which blocks Redis)
    let cursor = "0";
    let deleted = 0;
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== "0");
    return deleted;
  }

  /** Operation marker and score change share one Redis atomic execution. The
   * content-free marker has no TTL: a delayed effect retry must not increment twice.
   * Removing this ledger is an explicit cache-reset operation, not retention. */
  async applyManagedHotPromotion(input: {
    workspaceId: string;
    factId: string;
    effectId: string;
    maxSize: number;
  }): Promise<void> {
    if (
      !Number.isSafeInteger(input.maxSize) ||
      input.maxSize < 1 ||
      !input.effectId ||
      !input.factId ||
      !input.workspaceId
    )
      throw new Error("invalid_managed_hot_promotion");
    await this.redis.eval(
      `
      if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then return 0 end
      redis.call('ZINCRBY', KEYS[2], 1, ARGV[2])
      local excess = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[3])
      if excess > 0 then redis.call('ZREMRANGEBYRANK', KEYS[2], 0, excess - 1) end
      return 1
    `,
      2,
      `mnemo:${input.workspaceId}:managed:hot:applied`,
      `mnemo:${input.workspaceId}:hot:facts`,
      input.effectId,
      input.factId,
      input.maxSize
    );
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    return this.instrument("zadd", async () => {
      await this.redis.zadd(key, score, member);
    });
  }

  async zrangeByScore(key: string, min: number, max: number, limit?: number): Promise<string[]> {
    return this.instrument("zrangeByScore", async () => {
      const minStr = min === -Infinity ? "-inf" : String(min);
      const maxStr = max === Infinity ? "+inf" : String(max);
      if (limit !== undefined) {
        return this.redis.zrangebyscore(key, minStr, maxStr, "LIMIT", 0, limit);
      }
      return this.redis.zrangebyscore(key, minStr, maxStr);
    });
  }

  async zincrby(key: string, increment: number, member: string): Promise<number> {
    return this.instrument("zincrby", async () => {
      const result = await this.redis.zincrby(key, increment, member);
      return parseFloat(result);
    });
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.redis.zrem(key, ...members);
  }

  async lpush(key: string, value: string): Promise<number> {
    return this.redis.lpush(key, value);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.redis.lrange(key, start, stop);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.redis.ltrim(key, start, stop);
  }

  async lpushCapped(key: string, value: string, max: number, ttlSeconds: number): Promise<void> {
    const pipe = this.redis.multi();
    pipe.lpush(key, value);
    pipe.ltrim(key, 0, max - 1);
    pipe.expire(key, ttlSeconds);
    await pipe.exec();
  }

  async hSetWithTtl(key: string, field: string, value: string, ttlSeconds: number): Promise<void> {
    return this.instrument("hset", async () => {
      const clamped = Math.min(Math.max(1, Math.ceil(ttlSeconds)), this.maxTtlSeconds);
      const pipe = this.redis.multi();
      pipe.hset(key, field, value);
      pipe.expire(key, clamped);
      await pipe.exec();
    });
  }

  async hGet(key: string, field: string): Promise<string | null> {
    return this.instrument("hget", async () => {
      const raw = await this.redis.hget(key, field);
      return raw ?? null;
    });
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    return this.instrument("hgetall", async () => {
      return (await this.redis.hgetall(key)) ?? {};
    });
  }

  async hDel(key: string, ...fields: string[]): Promise<number> {
    if (fields.length === 0) return 0;
    return this.instrument("hdel", async () => {
      return this.redis.hdel(key, ...fields);
    });
  }

  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const clamped = Math.min(Math.max(1, Math.ceil(ttlSeconds)), this.maxTtlSeconds);
    const pipeline = this.redis.multi();
    pipeline.incr(key);
    pipeline.expire(key, clamped);
    const results = await pipeline.exec();
    const incrValue = results?.[0]?.[1];
    return typeof incrValue === "number" ? incrValue : Number(incrValue ?? 0);
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.redis.publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    // ioredis docs: subscriber clients cannot issue regular commands;
    // use a duplicated connection dedicated to subscriptions.
    if (!this.subscriber) {
      this.subscriber = this.redis.duplicate();
      this.attachErrorListener(this.subscriber, "subscriber");
    }
    await this.subscriber.subscribe(channel);
    this.subscriber.on("message", (ch: string, msg: string) => {
      if (ch === channel) handler(msg);
    });
  }

  async info(): Promise<CacheInfo> {
    const raw = await this.redis.info("memory");
    const match = String(raw).match(/used_memory:(\d+)/);
    return {
      usedMemoryBytes: match ? Number(match[1]) : null,
      connectedClients: null,
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      const result = await this.redis.ping();
      const latencyMs = Date.now() - start;
      if (result === "PONG") {
        return { status: "ok", latencyMs };
      }
      return { status: "degraded", latencyMs, detail: `Unexpected PING response: ${result}` };
    } catch (error) {
      const latencyMs = Date.now() - start;
      return {
        status: "down",
        latencyMs,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(): Promise<void> {
    if (this.subscriber) {
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    this.redis.disconnect();
  }
}
