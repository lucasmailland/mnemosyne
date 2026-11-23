/**
 * OutcomeSignal — maps session collapse outcome → Beta-Bernoulli worth delta.
 *
 * This closes the learning loop:
 *   collapseSession() produces an outcome ("resolved", "partial", "abandoned", "failed", "delegated")
 *   → outcomeToWorthDelta() translates it into a WorthDelta
 *   → StorageAdapter.updateWorth() propagates it to the facts created in the session
 *
 * Design (per COGNITIVE_ALGORITHMS.md §6 + §7 step 7.5, MEMORY_MODEL.md §Resolved Design Decisions):
 *   - "resolved"  → pure success: all facts in the session were relevant (success=1, failure=0)
 *   - "partial"   → mixed signal: some facts were useful, some not (success=0.7, failure=0.3)
 *   - "abandoned" → mild failure: user walked away (success=0.3, failure=0.7) — NOT zero
 *   - "failed"    → pure failure: hard failure, no progress (success=0, failure=1)
 *   - "delegated" → neutral: facts may still be relevant, we don't know yet (success=0.5, failure=0.5)
 *
 * RDD-2: abandoned is 0.3 (not 0.0) — user abandoning is mild negative, not catastrophic.
 * "failed" is a distinct outcome for hard failures.
 *
 * The creditWeight is always 1.0 — direct outcome credit, not TD(λ) decayed.
 * TD(λ) propagation (propagateTdCredit) handles the temporal credit trace separately.
 */

import type { WorthDelta } from "@mnemo-ai/types";

export type CollapseOutcome = "resolved" | "partial" | "abandoned" | "failed" | "delegated";

export interface OutcomeWeight {
  success: number;
  failure: number;
}

/**
 * Configurable outcome → Beta weight mapping. Exported for observability.
 *
 * RDD-2 spec-compliant score map (MEMORY_MODEL.md §Resolved Design Decisions ~line 3417):
 *   resolved=1.0 | partial=0.7 | abandoned=0.3 (mild failure) | failed=0.0 | delegated=0.5 (neutral)
 */
export const OUTCOME_WEIGHTS: Record<CollapseOutcome, OutcomeWeight> = {
  resolved:  { success: 1.0, failure: 0.0 },
  partial:   { success: 0.7, failure: 0.3 },
  abandoned: { success: 0.3, failure: 0.7 },  // RDD-2: was {0,1}; spec says mild failure
  failed:    { success: 0.0, failure: 1.0 },  // RDD-2: added — hard failure distinct from abandon
  delegated: { success: 0.5, failure: 0.5 },  // retained: neutral, documented as impl extension
};

/**
 * Convert a session collapse outcome to a WorthDelta for Beta-Bernoulli update.
 *
 * @param outcome   - The outcome from SessionCollapseSummary.outcome
 * @param creditWeight - Optional override (default 1.0)
 */
export function outcomeToWorthDelta(
  outcome: CollapseOutcome,
  creditWeight = 1.0,
): WorthDelta {
  const w = OUTCOME_WEIGHTS[outcome];
  return {
    success: w.success,
    failure: w.failure,
    creditWeight,
  };
}
