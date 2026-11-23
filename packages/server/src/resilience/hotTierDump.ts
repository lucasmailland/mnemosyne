/**
 * §37 Hot-tier dump engine: ZSet → PG → reload on boot.
 *
 * On graceful shutdown, we dump the Redis hot-tier ZSet entries for all
 * workspaces into `mnemo_hot_tier_snapshot` (migration 0034). On startup,
 * we reload them back into Redis so the cache survives process restarts.
 *
 * Design:
 *   dumpToPg(cache, storage, listWorkspaceIds) — iterates all workspace hot-tier
 *     ZSet keys, reads all members with scores, upserts into PG.
 *   rebuildFromPg(cache, storage) — reads all PG snapshot rows, loads back
 *     into Redis ZSet. Called at boot before serving traffic.
 *
 * Both operations are best-effort: errors are logged, never thrown.
 * The hot tier is an optimisation; losing it on crash degrades to cold recall.
 *
 * Key pattern: `mnemo:{workspaceId}:hot` (ZSet, score = recall score, member = factId)
 */

import type { CacheAdapter } from "@mnemo-ai/types";
import { logger } from "../logging.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HotTierSnapshot {
  workspaceId: string;
  cacheKey: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface HotTierPersistence {
  upsertHotTierSnapshot(rows: HotTierSnapshot[]): Promise<void>;
  loadHotTierSnapshots(workspaceId?: string): Promise<HotTierSnapshot[]>;
}

// ─── Hot-tier ZSet key convention ─────────────────────────────────────────────

export function hotTierKey(workspaceId: string): string {
  return `mnemo:${workspaceId}:hot`;
}

// ─── ZSet accessor helpers (uses optional CacheAdapter.zadd / zrangeByScore) ─

// Hot-tier ZSet entry as this engine consumes it: member + score (the
// score-carrying form mocked by the unit tests and produced by the Redis
// WITHSCORES read). The base CacheAdapter.zrangeByScore port is typed as the
// leaner `Promise<string[]>`; this module reads the richer shape, so we carry
// a dedicated element type and annotate the read site (see dumpToPg) rather
// than relying on the port's return type.
interface HotTierZSetEntry {
  member: string;
  score: number;
}

type CacheWithSortedSets = CacheAdapter & {
  zadd(key: string, score: number, member: string): Promise<void>;
  zrangeByScore(key: string, min: number, max: number, opts?: { limit?: number }): Promise<HotTierZSetEntry[]>;
};

function hasSortedSets(cache: CacheAdapter): cache is CacheWithSortedSets {
  return cache.capabilities.sortedSets && typeof (cache as { zadd?: unknown }).zadd === "function";
}

// ─── Dump ─────────────────────────────────────────────────────────────────────

/**
 * Dump hot-tier ZSet entries from Redis → PG.
 * Called during graceful shutdown; errors are swallowed.
 */
export async function dumpToPg(
  cache: CacheAdapter,
  persistence: HotTierPersistence,
  listWorkspaceIds: () => Promise<string[]>,
): Promise<void> {
  if (!hasSortedSets(cache)) {
    logger.debug("hot_tier_dump.skip — no sorted-set support");
    return;
  }

  let workspaceIds: string[];
  try {
    workspaceIds = await listWorkspaceIds();
  } catch (err) {
    logger.warn({ err }, "hot_tier_dump.list_workspaces_failed");
    return;
  }

  const rows: HotTierSnapshot[] = [];
  for (const workspaceId of workspaceIds) {
    const key = hotTierKey(workspaceId);
    try {
      // The intersection's zrangeByScore resolves to the base port's leaner
      // `string[]` overload, but this engine reads the WITHSCORES form
      // (member + score) — the shape the unit tests mock and assert. Annotate
      // the read with the score-carrying element type via `unknown`.
      const entries = (await cache.zrangeByScore(key, -Infinity, Infinity)) as unknown as HotTierZSetEntry[];
      for (const { member, score } of entries) {
        rows.push({ workspaceId, cacheKey: member, score, payload: {} });
      }
    } catch (err) {
      logger.warn({ err, workspaceId }, "hot_tier_dump.read_zset_failed");
    }
  }

  if (rows.length === 0) return;

  try {
    await persistence.upsertHotTierSnapshot(rows);
    logger.info({ count: rows.length }, "hot_tier_dump.persisted");
  } catch (err) {
    logger.warn({ err }, "hot_tier_dump.persist_failed");
  }
}

// ─── Rebuild ──────────────────────────────────────────────────────────────────

/**
 * Reload hot-tier entries from PG → Redis.
 * Called during boot before serving traffic; errors are swallowed.
 */
export async function rebuildFromPg(
  cache: CacheAdapter,
  persistence: HotTierPersistence,
): Promise<void> {
  if (!hasSortedSets(cache)) {
    logger.debug("hot_tier_rebuild.skip — no sorted-set support");
    return;
  }

  let rows: HotTierSnapshot[];
  try {
    rows = await persistence.loadHotTierSnapshots();
  } catch (err) {
    logger.warn({ err }, "hot_tier_rebuild.load_failed");
    return;
  }

  if (rows.length === 0) return;

  let loaded = 0;
  for (const { workspaceId, cacheKey, score } of rows) {
    const key = hotTierKey(workspaceId);
    try {
      await cache.zadd(key, score, cacheKey);
      loaded++;
    } catch (err) {
      logger.warn({ err, workspaceId, cacheKey }, "hot_tier_rebuild.zadd_failed");
    }
  }

  logger.info({ count: loaded }, "hot_tier_rebuild.loaded");
}
