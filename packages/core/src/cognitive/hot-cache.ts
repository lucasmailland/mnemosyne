/**
 * §9 L2 HOT CACHE (Redis) — MEMORY_MODEL.md lines 766-773.
 * Application-level cache semantics over the CacheAdapter port:
 *   - RBAC policy cache (per agent, 60s TTL)        line 770
 *   - Recent recall results (scope-aware query hash) line 768
 *   - LRU-by-activation eviction                     line 773
 *
 * Pure wrt infrastructure: takes a CacheAdapter | null. When null (no Redis) or
 * any verb throws, it degrades to the cold path (loader runs, gets return null) —
 * this is the "recall works on L3+L4 only" half of the degradation ladder.
 *
 * Cardinal rule: NO infrastructure deps. Banned packages (drizzle-orm, pg,
 * ioredis, redis, @neondatabase) must never appear here. Pure port usage only.
 */
import { createHash } from "node:crypto";
import type { CacheAdapter, RecallHit } from "@mnemo-ai/types";

const RBAC_TTL_MS = 60_000;     // spec line 770
const RECALL_TTL_MS = 300_000;  // 5 min — spec L2 lower bound (line 766)

export interface RecallCacheKey {
  text: string;
  scope: string;
  agentId: string;
  limit: number;
}

function hashRecallKey(k: RecallCacheKey): string {
  return createHash("sha256")
    .update(`${k.text.trim().toLowerCase()}|${k.scope}|${k.agentId}|${k.limit}`)
    .digest("hex")
    .slice(0, 32);
}

export class HotCache {
  constructor(private readonly cache: CacheAdapter | null) {}

  // ── RBAC policy (60s) ──────────────────────────────────────────────────────

  async getRbacPolicy<T>(
    workspaceId: string,
    agentId: string,
    loader: () => Promise<T>,
  ): Promise<T> {
    const key = `mnemo:${workspaceId}:hot:rbac:${agentId}`;
    if (this.cache) {
      const hit = await this.cache.get<T>(key).catch(() => null);
      if (hit !== null) return hit;
    }
    const fresh = await loader();
    if (this.cache) {
      await this.cache.set(key, fresh, { ttlMs: RBAC_TTL_MS }).catch(() => undefined);
    }
    return fresh;
  }

  async invalidateRbac(workspaceId: string, agentId: string): Promise<void> {
    if (this.cache) {
      await this.cache.delete(`mnemo:${workspaceId}:hot:rbac:${agentId}`).catch(() => undefined);
    }
  }

  // ── Recent recall (scope-aware) ────────────────────────────────────────────

  async getRecall(
    workspaceId: string,
    key: RecallCacheKey,
  ): Promise<RecallHit[] | null> {
    if (!this.cache) return null;
    const k = `mnemo:${workspaceId}:hot:recall:${hashRecallKey(key)}`;
    const hit = await this.cache.get<RecallHit[]>(k).catch(() => null);
    if (hit) await this.touch(workspaceId, k).catch(() => undefined);
    return hit ?? null;
  }

  async putRecall(
    workspaceId: string,
    key: RecallCacheKey,
    hits: RecallHit[],
  ): Promise<void> {
    if (!this.cache) return;
    const k = `mnemo:${workspaceId}:hot:recall:${hashRecallKey(key)}`;
    await this.cache.set(k, hits, { ttlMs: RECALL_TTL_MS }).catch(() => undefined);
    await this.touch(workspaceId, k).catch(() => undefined);
  }

  // ── LRU-by-activation eviction (line 773) ──────────────────────────────────

  /** Record an access — bumps the activation score for this cache key. */
  async touch(workspaceId: string, member: string): Promise<void> {
    if (!this.cache?.zincrby) return;
    await this.cache.zincrby(
      `mnemo:${workspaceId}:hot:lru`,
      Date.now() / 1000,
      member,
    );
  }

  /**
   * Drop the lowest-activation members of this workspace's hot namespace until
   * only `max` remain. Uses `zrangeByScore` (ascending) to find stale members
   * and `zrem` to remove them from both the sorted set and the value store.
   */
  async evictByActivation(workspaceId: string, max: number): Promise<void> {
    if (!this.cache?.zrangeByScore || !this.cache.zrem) return;
    const lruKey = `mnemo:${workspaceId}:hot:lru`;
    const all = await this.cache.zrangeByScore(lruKey, -Infinity, Infinity); // ascending by score
    if (all.length <= max) return;
    const toEvict = all.slice(0, all.length - max); // lowest-activation members
    await Promise.all(toEvict.map((m) => this.cache!.delete(m).catch(() => undefined)));
    await this.cache.zrem(lruKey, ...toEvict).catch(() => undefined);
  }
}
