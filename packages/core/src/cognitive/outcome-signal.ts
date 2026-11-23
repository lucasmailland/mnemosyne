/**
 * outcome-signal.ts — 3-signal OutcomeSignal capture + confidence-weighted combiner.
 *
 * RDD-1 (MEMORY_MODEL.md §Resolved Design Decisions ~line 3404-3441):
 *   Outcome worth is fed by THREE combined signals, each `{source, score, confidence}`,
 *   merged by `computeOutcome()` = Σ(score·confidence)/Σ(confidence).
 *
 * Signal sources:
 *   1. "explicit"         — user explicitly rates the session (resolved/partial/abandoned/failed)
 *   2. "task_completion"  — proxy from linked tasks (all/some/none completed)
 *   3. "heuristic"        — session-shape signals (thanks→0.9, repeat→0.2, etc.)
 *
 * The confidence-weighted combiner is what makes heuristic updates move worth slowly
 * (low confidence 0.4) while explicit signals dominate (confidence 0.95).
 * Without this, worth only updates when users explicitly rate — sessions with no explicit
 * rating never update worth at all.
 *
 * This is pure domain logic (no I/O).
 */

// ─── Core types ───────────────────────────────────────────────────────────────

export interface OutcomeSignal {
  /** Where this signal came from. */
  source: "explicit" | "task_completion" | "heuristic";
  /** Normalized score 0.0–1.0 (1.0 = perfect success, 0.0 = total failure). */
  score: number;
  /** How much weight this signal gets in the combiner (0.0–1.0). */
  confidence: number;
}

// ─── Combiner ─────────────────────────────────────────────────────────────────

/**
 * Confidence-weighted average of all provided signals.
 *
 * computeOutcome(signals) = Σ(score·confidence) / Σ(confidence)
 *
 * Returns 0.5 (neutral) when no signals are provided.
 */
export function computeOutcome(signals: OutcomeSignal[]): number {
  const totalWeight = signals.reduce((s, x) => s + x.confidence, 0);
  if (totalWeight === 0) return 0.5;
  return signals.reduce((s, x) => s + x.score * x.confidence, 0) / totalWeight;
}

// ─── Signal factories ─────────────────────────────────────────────────────────

/**
 * Build an explicit signal from a session collapse outcome string.
 *
 * Score map (RDD-2 spec-compliant):
 *   resolved=1.0 | partial=0.7 | abandoned=0.3 | failed=0.0 | delegated=0.5
 * Confidence: 0.95 (high — user directly rated the session).
 */
export function explicitSignal(
  outcome: "resolved" | "partial" | "abandoned" | "failed" | "delegated",
): OutcomeSignal {
  const scoreMap: Record<string, number> = {
    resolved: 1.0,
    partial: 0.7,
    abandoned: 0.3, // RDD-2: mild failure, not 0
    failed: 0.0,
    delegated: 0.5,
  };
  const score = scoreMap[outcome] ?? 0.5;
  return { source: "explicit", score, confidence: 0.95 };
}

/**
 * Build a task_completion proxy signal from linked-task counts.
 *
 * Score:
 *   all completed (total===completed) → 1.0, conf 0.8
 *   some completed (completed>0)       → 0.6, conf 0.7
 *   none completed                     → 0.3, conf 0.6
 *
 * Returns null when total===0 (no tasks linked — skip this source).
 */
export function taskCompletionSignal(
  total: number,
  completed: number,
): OutcomeSignal | null {
  if (total === 0) return null;
  if (completed === total) return { source: "task_completion", score: 1.0, confidence: 0.8 };
  if (completed > 0)       return { source: "task_completion", score: 0.6, confidence: 0.7 };
  return { source: "task_completion", score: 0.3, confidence: 0.6 };
}

/**
 * Build a heuristic signal from session-shape indicators.
 *
 * Score heuristics (low confidence 0.4 — indirect proxy):
 *   endedWithThanks   → 0.9 (positive social signal)
 *   repeatedQuestion  → 0.2 (user kept asking = not satisfied)
 *   manyTurnsNoResolve → 0.3 (long conversation, no clear resolution)
 *   shortAndStopped   → 0.5 (neutral, not enough data)
 *   (none)            → 0.5 (neutral baseline)
 */
export function heuristicSignal(shape: {
  endedWithThanks?: boolean;
  repeatedQuestion?: boolean;
  manyTurnsNoResolve?: boolean;
  shortAndStopped?: boolean;
}): OutcomeSignal {
  let score = 0.5;
  if (shape.endedWithThanks)      score = 0.9;
  else if (shape.repeatedQuestion)  score = 0.2;
  else if (shape.manyTurnsNoResolve) score = 0.3;
  else if (shape.shortAndStopped)  score = 0.5;
  return { source: "heuristic", score, confidence: 0.4 };
}
