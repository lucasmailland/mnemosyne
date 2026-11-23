// P59 (docs/archive/openspec/p59-query-cache-l3-fix, design.md §4 "Observability — the
// silent-failure fix"): the L3 query-result cache and the sibling embedding
// LRU cache both degrade failures with a bare `.catch(() => null)` /
// `.catch(() => undefined)` in `cognitive/index.ts` — zero log, zero metric.
// That silence is exactly why the original broken-SQL bug (and PR1's own
// reintroduced drizzle array-binding bug, see apply-progress.md) went
// undetected: a permanently-failing cache free-rides as invisible latency
// instead of surfacing anywhere. This module makes every cache failure
// observable without ever propagating it to the caller — a cache is an
// optimization, so failures must always degrade gracefully (D15), but they
// must never again be silent (D14).
//
// Port-only, zero infrastructure imports — scanned by v3-purity.test.ts.

import type { CoreContext } from "./context.js";

/**
 * The caches this module instruments. `hot_tier` is the Redis activation set
 * read at the top of the recall cascade (CHAOS-4).
 */
export type CacheName = "l3_query" | "embedding_lru" | "hot_tier";

/** The four cache operations that can fail — one per swallowed `.catch()` in index.ts. */
export type CacheOp = "lookup" | "insert" | "get" | "put";

/** One cache-port failure, reported through {@link CoreContext.onCacheError}. */
export interface CacheErrorReport {
  cache: CacheName;
  op: CacheOp;
  message: string;
}

const WARN_THROTTLE_MS = 60_000;

/** Module-level throttle state: last-warned timestamp per `cache:op` pair. */
let lastWarnedAt = new Map<string, number>();

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown cache error";
  }
}

/**
 * Report a cache-port failure. Never throws or rethrows — each side effect is
 * individually try/caught so a broken logger/telemetry/hook can never turn a
 * degraded-but-working cache path into a hard failure of the calling
 * operation (D15).
 *
 * 1. `ctx.telemetry.counter(...)` — every occurrence, unthrottled.
 * 2. `ctx.onCacheError?.(...)` — every occurrence, fire-and-forget, same
 *    contract as {@link CoreContext.onHotTierEvict}.
 * 3. `ctx.logger.warn(...)` — throttled to once per 60s per `cache:op` pair,
 *    so a permanently-broken cache emits one warning per minute instead of
 *    one per recall. The first occurrence for a given pair always logs.
 */
export function reportCacheFailure(
  ctx: CoreContext,
  cache: CacheName,
  op: CacheOp,
  err: unknown
): void {
  const message = errorMessage(err);
  const report: CacheErrorReport = { cache, op, message };

  try {
    ctx.telemetry.counter("mnemo.cache_errors", 1, { cache, op });
  } catch {
    // never let a broken telemetry sink affect the caller
  }

  try {
    ctx.onCacheError?.(report);
  } catch {
    // never let a broken host hook affect the caller
  }

  try {
    const key = `${cache}:${op}`;
    const now = Date.now(); // determinism-ok: throttle window anchored to wall clock
    const last = lastWarnedAt.get(key);
    if (last === undefined || now - last >= WARN_THROTTLE_MS) {
      lastWarnedAt.set(key, now);
      ctx.logger.warn("cache operation failed — degrading to uncached path", {
        operation: `${cache}:${op}`,
        error: { type: "CacheError", message },
      });
    }
  } catch {
    // never let a broken logger affect the caller
  }
}

/** Test seam — resets the warn throttle so tests can assert first-occurrence behaviour deterministically. */
export function resetCacheFailureThrottle(): void {
  lastWarnedAt = new Map<string, number>();
}
