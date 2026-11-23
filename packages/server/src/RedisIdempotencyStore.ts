/**
 * Redis-backed idempotency store for multi-replica deployments.
 * Keys: mnemo:{workspaceId}:idp:{key}  TTL 72h (spec §35 — long enough to cover
 * a weekend retry window while avoiding unbounded accumulation).
 * Uses a single Lua script for atomic begin() — no race between EXISTS + HMSET.
 */
import Redis from "ioredis";
import type { IdempotencyStore, BeginResult, RecoveryPoint } from "./idempotency.js";

/** §35 idempotency key TTL: 72h — covers weekend retry windows (spec §35). */
const IDP_TTL_SECONDS = 259_200;

// Atomic begin: create if absent (new), or read existing and return its state.
// KEYS[1]=hash key; ARGV[1]=requestHash; ARGV[2]=ttlSeconds; ARGV[3]=createdAtMs
const BEGIN_LUA = `
local key   = KEYS[1]
local rhash = ARGV[1]
local ttl   = tonumber(ARGV[2])
local ts    = ARGV[3]
if redis.call('EXISTS', key) == 0 then
  redis.call('HMSET', key, 'requestHash', rhash, 'state', 'in_flight', 'recoveryPoint', 'started', 'createdAt', ts)
  redis.call('EXPIRE', key, ttl)
  return {'new'}
end
local d = redis.call('HGETALL', key)
local h = {}
for i=1,#d,2 do h[d[i]]=d[i+1] end
if h['requestHash'] ~= rhash then return {'mismatch'} end
if h['state'] == 'in_flight'  then return {'in_flight'} end
return {'replay', h['responseCode'] or '200', h['responseBody'] or ''}
`;

type RedisWithBegin = Redis & {
  idpBegin(key: string, rh: string, ttl: number, ts: string): Promise<string[]>;
};

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly redis: RedisWithBegin;

  constructor(url: string) {
    // CHAOS-4: bounded per command, so a hung Redis fails the request instead of hanging it;
    // a silent connection is dropped (socketTimeout) and its commands are not replayed.
    const r = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      commandTimeout: 1_000,
      connectTimeout: 2_000,
      socketTimeout: 2_000,
      autoResendUnfulfilledCommands: false,
    });
    r.defineCommand("idpBegin", { numberOfKeys: 1, lua: BEGIN_LUA });
    this.redis = r as RedisWithBegin;
  }

  private k(workspaceId: string, key: string): string {
    return `mnemo:${workspaceId}:idp:${key}`;
  }

  async begin(workspaceId: string, key: string, requestHash: string): Promise<BeginResult> {
    const result = await this.redis.idpBegin(this.k(workspaceId, key), requestHash, IDP_TTL_SECONDS, String(Date.now()));
    const [state, ...rest] = result;
    if (state === "new")       return { state: "new" };
    if (state === "mismatch")  return { state: "mismatch" };
    if (state === "in_flight") return { state: "in_flight" };
    return { state: "replay", responseCode: Number(rest[0] ?? 200), responseBody: rest[1] ?? "" };
  }

  async complete(workspaceId: string, key: string, responseCode: number, responseBody: string): Promise<void> {
    const k = this.k(workspaceId, key);
    await this.redis.hmset(k, "state", "complete", "recoveryPoint", "completed", "responseCode", String(responseCode), "responseBody", responseBody);
    await this.redis.expire(k, IDP_TTL_SECONDS);
  }

  /**
   * Advance the recovery point. Guarded by EXISTS so we never resurrect a reaped
   * key (HSET would otherwise recreate the hash with no TTL). No-op if absent.
   */
  async recordPhase(workspaceId: string, key: string, phase: RecoveryPoint): Promise<void> {
    const k = this.k(workspaceId, key);
    if ((await this.redis.exists(k)) === 0) return;
    await this.redis.hset(k, "recoveryPoint", phase);
  }

  async getRecoveryPoint(workspaceId: string, key: string): Promise<RecoveryPoint | null> {
    const rp = await this.redis.hget(this.k(workspaceId, key), "recoveryPoint");
    return (rp as RecoveryPoint | null) ?? null;
  }

  async reap(): Promise<{ reaped: number }> {
    const cutoff = Date.now() - 72 * 3_600_000;
    let reaped = 0;
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", "mnemo:*:idp:*", "COUNT", 200);
      cursor = next;
      for (const k of keys) {
        const [state, createdAt] = await this.redis.hmget(k, "state", "createdAt");
        if (state === "in_flight" && createdAt && Number(createdAt) < cutoff) {
          await this.redis.del(k);
          reaped++;
        }
      }
    } while (cursor !== "0");
    return { reaped };
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
