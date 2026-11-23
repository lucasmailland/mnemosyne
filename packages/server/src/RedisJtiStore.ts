/**
 * Redis-backed JTI replay-protection store for multi-replica deployments.
 * Uses SETNX PX so a JTI seen by replica A is immediately rejected by replica B.
 * Key: mnemo:jti:{jti}  TTL = token's remaining lifetime.
 */
import Redis from "ioredis";
import type { JtiStore } from "@mnemo-ai/core";

export class RedisJtiStore implements JtiStore {
  private readonly redis: Redis;

  constructor(url: string) {
    // CHAOS-4: bounded per command, so a hung Redis fails the request instead of hanging it;
    // a silent connection is dropped (socketTimeout) and its commands are not replayed.
    this.redis = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      commandTimeout: 1_000,
      connectTimeout: 2_000,
      socketTimeout: 2_000,
      autoResendUnfulfilledCommands: false,
    });
  }

  async checkAndRecord(jti: string, exp: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const ttlMs = Math.max(1_000, (exp - now) * 1_000);
    const result = await this.redis.set(`mnemo:jti:${jti}`, "1", "PX", ttlMs, "NX");
    return result === "OK";
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
