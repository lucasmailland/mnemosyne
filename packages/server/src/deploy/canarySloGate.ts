/**
 * Canary SLO Gate — spec §35 "Canary Deployment Strategy" (C9).
 *
 * Evaluates error-rate and recall-latency p99 against SLO thresholds.
 * Returns { allow: true } when metrics are within bounds, { allow: false }
 * when SLOs are violated.
 *
 * The gate reads from the same in-process Counter/Histogram objects that the
 * request middleware increments, so it works without an external Prometheus
 * dependency.  The CI canary workflow can call GET /canary/slo-gate on the
 * running canary instance for an authoritative, real-time answer.
 *
 * Design constraints:
 *  - No imports from drizzle-orm / pg / redis (hexagonal purity).
 *  - No `as any` casts — only typed APIs.
 *  - Counter/histogram references are injectable for unit-testing isolation.
 */

import { DEFAULT_CANARY_CONFIG } from "@mnemo-ai/core/cognitive";
import type { CanaryConfig } from "@mnemo-ai/core/cognitive";

// ── Minimal interfaces matching the public surface of our metric objects ───────

/** Subset of Counter surface consumed by the gate. */
export interface ReadableCounter {
  read(): IterableIterator<{ labels: Record<string, string>; value: number }>;
}

/** Subset of Histogram surface consumed by the gate. */
export interface QuantilableHistogram {
  quantile(q: number): number | null;
}

export interface SloGateResult {
  allow: boolean;
  reason: string;
  metrics: {
    errorRate: number | null;
    recallP99Ms: number | null;
    totalRequests: number;
    errorRequests: number;
  };
}

export interface SloGateSources {
  /** Counter for all HTTP requests — must be mnemo_requests_total or equivalent. */
  requestsCounter: ReadableCounter;
  /** Histogram for recall latency — must be mnemo_recall_duration_seconds. */
  recallHistogram: QuantilableHistogram;
}

/**
 * Evaluate in-process SLO metrics against canary thresholds.
 *
 * Error-rate: computed from `requestsCounter` 5xx status labels / total.
 * Recall p99: computed from `recallHistogram` quantile(0.99) × 1000ms.
 *
 * Returns allow=false (blocking promotion) when:
 *   - total requests < minRequests  → "insufficient_data"
 *   - error rate > cfg.errorRateDelta → "error_rate_exceeded"
 *   - recall p99 > cfg.p99LatencyDelta → "recall_p99_exceeded"
 *
 * @param sources       Metric objects to read from (injectable for tests).
 * @param cfg           CanaryConfig; defaults to DEFAULT_CANARY_CONFIG.
 * @param minRequests   Minimum request count before evaluating metrics (default 10).
 */
export function evaluateCanarySloGate(
  sources: SloGateSources,
  cfg: CanaryConfig = DEFAULT_CANARY_CONFIG,
  minRequests = 10,
): SloGateResult {
  // ── Tally requests ───────────────────────────────────────────────────────────
  let totalRequests = 0;
  let errorRequests = 0;
  for (const sample of sources.requestsCounter.read()) {
    const count = sample.value;
    totalRequests += count;
    const status = sample.labels["status"] ?? "";
    // 5xx = server errors
    if (status.length === 3 && status.startsWith("5")) {
      errorRequests += count;
    }
  }

  // ── Recall p99 (seconds → milliseconds) ─────────────────────────────────────
  const recallP99Seconds = sources.recallHistogram.quantile(0.99);
  const recallP99Ms = recallP99Seconds !== null ? recallP99Seconds * 1000 : null;

  const errorRate = totalRequests > 0 ? errorRequests / totalRequests : null;

  const baseMetrics = { errorRate, recallP99Ms, totalRequests, errorRequests };

  // ── Guard: insufficient data ─────────────────────────────────────────────────
  if (totalRequests < minRequests) {
    return {
      allow: false,
      reason: `insufficient_data: only ${totalRequests} requests observed (need ≥${minRequests})`,
      metrics: baseMetrics,
    };
  }

  // ── Error-rate check ─────────────────────────────────────────────────────────
  // In-process counters capture the canary instance only; no separate baseline
  // series. We compare the raw error rate against cfg.errorRateDelta (default 1%).
  if (errorRate !== null && errorRate > cfg.errorRateDelta) {
    return {
      allow: false,
      reason: `error_rate_exceeded: ${(errorRate * 100).toFixed(2)}% > ${(cfg.errorRateDelta * 100).toFixed(2)}% threshold`,
      metrics: baseMetrics,
    };
  }

  // ── Recall p99 latency check ─────────────────────────────────────────────────
  // cfg.p99LatencyDelta is max acceptable delta above zero baseline (in ms).
  if (recallP99Ms !== null && recallP99Ms > cfg.p99LatencyDelta) {
    return {
      allow: false,
      reason: `recall_p99_exceeded: ${recallP99Ms.toFixed(0)}ms > ${cfg.p99LatencyDelta}ms threshold`,
      metrics: baseMetrics,
    };
  }

  return {
    allow: true,
    reason: `slo_ok: error_rate=${errorRate !== null ? (errorRate * 100).toFixed(2) + "%" : "n/a"}, recall_p99=${recallP99Ms !== null ? recallP99Ms.toFixed(0) + "ms" : "n/a"}`,
    metrics: baseMetrics,
  };
}

/**
 * Factory that wires the gate to the real in-process metric singletons.
 * Use this in the HTTP handler; pass mock sources in unit tests.
 */
export async function makeCanarySloGateSources(): Promise<SloGateSources> {
  const { requestsTotal, recallLatency } = await import("../metrics/index.js");
  return { requestsCounter: requestsTotal, recallHistogram: recallLatency };
}
