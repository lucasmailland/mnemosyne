// packages/core/src/benchmark/quality-gates.ts
//
// §29 — ABSOLUTE quality gates (distinct from the relative perf-regression gate
// in check-regression.ts). Enforces the spec's v3.0 quality targets against a
// LongMemEval BenchmarkResult:
//   - recall quality ≥ 0.98   (v3.0 target, up from the v1.6 0.95 bar)
//   - answer coverage ≥ 0.98
//   - noise < 5%              (noise = 1 − precision@K)
//   - stale  < 2%             (fraction of returned hits that are stale/expired)
//   - cost   < $0.03 / query  (avg LLM cost per recall)
//
// Pure functions — no DB/network. Stale-rate and avg-cost are supplied by the
// caller (they come from the live pipeline, not the IR metrics), and are only
// gated when provided.

import type { BenchmarkResult } from "./metrics.js";

export interface QualityTargets {
  /** Minimum macro Recall@K. */
  recallAtKMin: number;
  /** Minimum answer-coverage fraction. */
  answerCoverageMin: number;
  /** Maximum noise rate (1 − precision@K). */
  noiseMax: number;
  /** Maximum stale-hit fraction (optional input). */
  staleMax: number;
  /** Maximum average LLM cost per query in USD (optional input). */
  costMaxUsd: number;
}

/** Spec v3.0 absolute targets (MEMORY_IMPROVEMENT.md §29). */
export const V3_QUALITY_TARGETS: QualityTargets = {
  recallAtKMin: 0.98,
  answerCoverageMin: 0.98,
  noiseMax: 0.05,
  staleMax: 0.02,
  costMaxUsd: 0.03,
};

/** Legacy v1.6 bar — kept for the version-comparison report. */
export const V1_6_QUALITY_TARGETS: QualityTargets = {
  recallAtKMin: 0.95,
  answerCoverageMin: 0.9,
  noiseMax: 0.1,
  staleMax: 0.05,
  costMaxUsd: 0.05,
};

export interface QualityGateInput {
  result: BenchmarkResult;
  /** Fraction of returned hits that were stale/expired (0–1). Optional. */
  staleRate?: number;
  /** Average LLM cost per query in USD. Optional. */
  avgCostUsd?: number;
}

export interface QualityGateReport {
  passed: boolean;
  failures: string[];
  metrics: {
    recallAtK: number;
    answerCoverage: number;
    noise: number;
    staleRate: number | null;
    avgCostUsd: number | null;
  };
}

/**
 * Evaluate a BenchmarkResult against absolute quality targets. Stale-rate and
 * cost are only checked when the caller supplies them (they are not derivable
 * from the IR metrics alone).
 */
export function evaluateQualityGate(
  input: QualityGateInput,
  targets: QualityTargets = V3_QUALITY_TARGETS,
): QualityGateReport {
  const { result, staleRate, avgCostUsd } = input;
  const noise = 1 - result.precisionAtK;
  const failures: string[] = [];

  if (result.recallAtK < targets.recallAtKMin) {
    failures.push(`recall@K ${(result.recallAtK * 100).toFixed(1)}% < target ${(targets.recallAtKMin * 100).toFixed(0)}%`);
  }
  if (result.answerCoverage < targets.answerCoverageMin) {
    failures.push(`answerCoverage ${(result.answerCoverage * 100).toFixed(1)}% < target ${(targets.answerCoverageMin * 100).toFixed(0)}%`);
  }
  if (noise > targets.noiseMax) {
    failures.push(`noise ${(noise * 100).toFixed(1)}% > max ${(targets.noiseMax * 100).toFixed(0)}%`);
  }
  if (staleRate !== undefined && staleRate > targets.staleMax) {
    failures.push(`staleRate ${(staleRate * 100).toFixed(1)}% > max ${(targets.staleMax * 100).toFixed(0)}%`);
  }
  if (avgCostUsd !== undefined && avgCostUsd > targets.costMaxUsd) {
    failures.push(`avgCost $${avgCostUsd.toFixed(4)} > max $${targets.costMaxUsd.toFixed(2)}`);
  }

  return {
    passed: failures.length === 0,
    failures,
    metrics: {
      recallAtK: result.recallAtK,
      answerCoverage: result.answerCoverage,
      noise,
      staleRate: staleRate ?? null,
      avgCostUsd: avgCostUsd ?? null,
    },
  };
}

export interface VersionComparison {
  metric: string;
  v1_6: number;
  v3_0: number;
  delta: number;
  improved: boolean;
}

/**
 * §29 — v1.6 ↔ v3.0 comparison. Returns per-metric deltas so CI can show the
 * generational improvement (recall/precision/F1/coverage/MRR), higher-is-better.
 */
export function compareVersions(
  v1_6: BenchmarkResult,
  v3_0: BenchmarkResult,
): VersionComparison[] {
  const pairs: Array<[string, number, number]> = [
    ["recallAtK", v1_6.recallAtK, v3_0.recallAtK],
    ["precisionAtK", v1_6.precisionAtK, v3_0.precisionAtK],
    ["f1AtK", v1_6.f1AtK, v3_0.f1AtK],
    ["answerCoverage", v1_6.answerCoverage, v3_0.answerCoverage],
    ["mrr", v1_6.mrr, v3_0.mrr],
  ];
  return pairs.map(([metric, a, b]) => ({
    metric,
    v1_6: a,
    v3_0: b,
    delta: b - a,
    improved: b >= a,
  }));
}

// ---------------------------------------------------------------------------
// §29 — LATENCY gates (hot <5ms, warm <15ms, cold <200ms, write <30ms)
// ---------------------------------------------------------------------------

/** Spec §29 absolute p99 latency budgets in milliseconds. */
export const V3_LATENCY_TARGETS_MS = {
  hot: 5,
  warm: 15,
  cold: 200,
  write: 30,
} as const;

export type LatencyMeasurements = {
  hot: number;
  warm: number;
  cold: number;
  write: number;
};

/**
 * Evaluate measured p99 latencies against budget targets.
 * Returns the same `{ passed, failures }` shape as `evaluateQualityGate`
 * for API consistency (the `metrics` field is omitted here because the
 * inputs *are* the metrics — no derived values).
 */
export function evaluateLatencyGate(
  measured: LatencyMeasurements,
  targets: typeof V3_LATENCY_TARGETS_MS = V3_LATENCY_TARGETS_MS,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const tier of ["hot", "warm", "cold", "write"] as const) {
    if (measured[tier] > targets[tier]) {
      failures.push(
        `${tier} p99 ${measured[tier]}ms exceeds budget ${targets[tier]}ms`,
      );
    }
  }
  return { passed: failures.length === 0, failures };
}

/** Format a quality-gate report for CI output. */
export function formatQualityGate(report: QualityGateReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `Quality gate: ${report.passed ? "PASS ✓" : "FAIL ✗"}`,
    `  recall@K      : ${pct(report.metrics.recallAtK)}`,
    `  answerCoverage: ${pct(report.metrics.answerCoverage)}`,
    `  noise         : ${pct(report.metrics.noise)}`,
  ];
  if (report.metrics.staleRate !== null) lines.push(`  staleRate     : ${pct(report.metrics.staleRate)}`);
  if (report.metrics.avgCostUsd !== null) lines.push(`  avgCost       : $${report.metrics.avgCostUsd.toFixed(4)}`);
  for (const f of report.failures) lines.push(`  ✗ ${f}`);
  return lines.join("\n");
}
