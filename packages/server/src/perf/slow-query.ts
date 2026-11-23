/**
 * AB7.4 — Slow-query thresholds + timing wrapper (spec §35 lines 4419–4420).
 *
 * SLOW_QUERY_THRESHOLDS defines per-operation budget in milliseconds.
 * withSlowQueryLog wraps an async operation and logs a warn if it exceeds
 * the threshold. Coordinates with Wave V's Prometheus metrics (does NOT
 * re-define the histogram — logs `slow_query` warning and can be wired
 * to a counter increment externally).
 */

export const SLOW_QUERY_THRESHOLDS = {
  /** Recall operations — 100ms budget (spec §35 line 4419). */
  recall: 100,
  /** Write/remember operations — 50ms budget. */
  write: 50,
  /** Admin/management operations — 500ms budget. */
  admin: 500,
} as const;

export type SlowQueryKind = keyof typeof SLOW_QUERY_THRESHOLDS;

export interface SlowQueryLogger {
  warn(msg: string, ctx: Record<string, unknown>): void;
}

/**
 * Wrap `fn` with a timing check. If the operation takes longer than the
 * threshold for `kind` (or `thresholdOverride` if provided), log a warn.
 * Always returns/throws the fn result — never swallows errors.
 *
 * @param kind         Operation kind key into SLOW_QUERY_THRESHOLDS.
 * @param fn           Async operation to time.
 * @param logger       Logger (defaults to console).
 * @param thresholdOverride  Override the threshold for this call (useful in tests).
 */
export async function withSlowQueryLog<T>(
  kind: SlowQueryKind,
  fn: () => Promise<T>,
  logger: SlowQueryLogger = console,
  thresholdOverride?: number,
): Promise<T> {
  const threshold = thresholdOverride ?? SLOW_QUERY_THRESHOLDS[kind];
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    if (elapsed > threshold) {
      logger.warn("slow_query", { kind, elapsedMs: elapsed, thresholdMs: threshold });
    }
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    if (elapsed > threshold) {
      logger.warn("slow_query", { kind, elapsedMs: elapsed, thresholdMs: threshold, error: true });
    }
    throw err;
  }
}
