// packages/server/src/metrics.ts
// Lightweight in-process counters/gauges for operational telemetry.
// No prom-client dependency — these are simple mutable objects incremented
// by server code and read back by the /metrics route (or a future Prometheus
// scrape shim). Counters never reset; gauges are overwritten.
//
// Wave O2: adds mnemo_tokens_saved_estimated_total{mechanism} + mnemo_anticipation_accuracy.
// B1.1: incTokensSaved now also emits to the Prometheus tokensSavedTotal counter.

import { tokensSavedTotal } from "./metrics/index.js";

/** Estimated LLM tokens saved per mechanism (additive counter). */
export const tokensSavedByMechanism: Record<string, number> = {};

// p60-corecall-stdp-convergence PR2 (design.md D3): cumulative in-process
// accumulator for the co-recall tail measurement, mirroring
// tokensSavedByMechanism above. The Prometheus counters (metrics/index.ts)
// are the scrape-facing surface; this object backs the JSON /metrics
// snapshot the same way tokens_saved_by_mechanism does.
const coRecallTailTotals = {
  events: 0,
  eventsOverCap: 0,
  pairsProcessed: 0,
  pairsSkipped: 0,
};

/** Shape of one co-recall tail measurement (mirrors CoRecallTailReport from @mnemo-ai/core). */
export interface CoRecallTailReportLike {
  workspaceId: string;
  candidateFacts: number;
  capK: number;
  processedPairs: number;
  skippedPairs: number;
}

/**
 * Accumulate a co-recall tail measurement into the cumulative in-process
 * counters. Called from CoreDeps.onCoRecallTail (packages/server/src/index.ts),
 * unlabeled (no per-workspace granularity — see design.md D3: the Option 3
 * cap-raise decision is a global one).
 */
export function recordCoRecallTail(report: CoRecallTailReportLike): void {
  coRecallTailTotals.events += 1;
  if (report.candidateFacts > report.capK) coRecallTailTotals.eventsOverCap += 1;
  coRecallTailTotals.pairsProcessed += report.processedPairs;
  coRecallTailTotals.pairsSkipped += report.skippedPairs;
}

/** Per-workspace fraction of pre-staged anticipated memories that were
 *  subsequently recalled in the same session. Updated by the anticipation
 *  feedback loop when a session collapses. */
const anticipationAccuracyByWorkspace = new Map<string, number>();

/** Estimated tokens saved per pre-injected anticipation hit (avoids a
 *  full-context recall round-trip to the LLM). Spec §30 estimate. */
export const ANTICIPATION_TOKENS_PER_RECALL = 400;

/** Increment the tokens-saved counter for a named mechanism.
 *  B1.1: also emits to mnemo_tokens_saved_estimated_total{mechanism} Prometheus counter. */
export function incTokensSaved(mechanism: string, tokens: number): void {
  tokensSavedByMechanism[mechanism] = (tokensSavedByMechanism[mechanism] ?? 0) + tokens;
  tokensSavedTotal.inc({ mechanism }, tokens);
}

/** Update the per-workspace anticipation accuracy gauge (called at session collapse). */
export function setAnticipationAccuracy(workspaceId: string, fraction: number): void {
  anticipationAccuracyByWorkspace.set(workspaceId, Math.max(0, Math.min(1, fraction)));
}

/** Read the per-workspace anticipation accuracy. Returns null when no measurement exists. */
export function getAnticipationAccuracy(workspaceId: string): number | null {
  const v = anticipationAccuracyByWorkspace.get(workspaceId);
  return v !== undefined && v > 0 ? v : null;
}

/** Snapshot for inclusion in the /metrics JSON payload. */
export function getMetricsSnapshot(): {
  tokens_saved_by_mechanism: Record<string, number>;
  anticipation_accuracy_by_workspace: Record<string, number>;
  co_recall_tail: {
    events: number;
    events_over_cap: number;
    pairs_processed: number;
    pairs_skipped: number;
  };
} {
  return {
    tokens_saved_by_mechanism: { ...tokensSavedByMechanism },
    anticipation_accuracy_by_workspace: Object.fromEntries(anticipationAccuracyByWorkspace),
    co_recall_tail: {
      events: coRecallTailTotals.events,
      events_over_cap: coRecallTailTotals.eventsOverCap,
      pairs_processed: coRecallTailTotals.pairsProcessed,
      pairs_skipped: coRecallTailTotals.pairsSkipped,
    },
  };
}
