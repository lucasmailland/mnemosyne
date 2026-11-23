/**
 * Canary deploy decision function — spec §35 "Canary Deployment Strategy" lines 2086–2110.
 *
 * Pure decision logic: consumes baseline + canary metrics snapshots and returns
 * promote / hold / rollback.
 *
 * This is intentionally pure (no DB/metrics-scraping) so it's testable
 * and reusable by both the SloRollbackMonitor and the migration-window rollback.
 */

/** Canary deployment configuration (spec lines 2089–2109). */
export interface CanaryConfig {
  /** Traffic split steps in order, e.g. [5, 25, 50, 100]. */
  promotionSteps: number[];
  /** Max acceptable error rate delta (canary - baseline). 0.01 = 1%. */
  errorRateDelta: number;
  /** Max acceptable p99 latency delta in milliseconds. */
  p99LatencyDelta: number;
  /** Observation window per step, in seconds. */
  observationWindow: number;
  /** Post-100% monitor window, in seconds (spec line 4467). */
  postFullWindow: number;
}

export const DEFAULT_CANARY_CONFIG: CanaryConfig = {
  promotionSteps: [5, 25, 50, 100],
  errorRateDelta: 0.01,
  p99LatencyDelta: 100,
  observationWindow: 600,
  postFullWindow: 3600,
};

export interface MetricsSnapshot {
  /** Error rate, 0–1 fraction. */
  errorRate: number;
  /** p99 latency in milliseconds. */
  p99: number;
}

export type CanaryDecision = "promote" | "hold" | "rollback";

/**
 * Evaluate canary vs baseline and return a routing decision.
 *
 * @param baseline Baseline metrics snapshot. null = no data (hold).
 * @param canary   Canary metrics snapshot. null = no data (hold).
 * @param cfg      Canary configuration.
 * @returns "promote" if canary is within acceptable bounds, "rollback" if degraded, "hold" if no data.
 */
export function evaluateCanary(
  baseline: MetricsSnapshot | null,
  canary: MetricsSnapshot | null,
  cfg: CanaryConfig = DEFAULT_CANARY_CONFIG,
): CanaryDecision {
  if (baseline === null || canary === null) {
    return "hold";
  }

  const errorRateDelta = canary.errorRate - baseline.errorRate;
  const p99Delta = canary.p99 - baseline.p99;

  // Rollback if either threshold is breached
  if (errorRateDelta > cfg.errorRateDelta) {
    return "rollback";
  }
  if (p99Delta > cfg.p99LatencyDelta) {
    return "rollback";
  }

  return "promote";
}
