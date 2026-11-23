// Wave X — X1.3: Write-time semantic anomaly scorer.
//
// Computes a composite anomaly score from three orthogonal signals:
//
//   distance     — isolation from existing knowledge (1 − mean cosine sim)
//   piiDensity   — estimated PII risk (supplied by caller from pii/detect)
//   contradiction — fraction of neighbours in the semantic contradiction zone
//                  [0.80, 0.97): high enough to be about the same topic but
//                  not close enough to be the same statement
//
// Weighted sum (W_DISTANCE + W_PII + W_CONTRADICTION = 1.0):
//
//   score = 0.5*distance + 0.3*piiDensity + 0.2*contradiction
//
// All inputs and outputs are in [0, 1].
//
// PURE MODULE — no host imports.

import type { AnomalyScore } from "@mnemo-ai/types";

export const DEFAULT_ANOMALY_THRESHOLD = 0.8;

const W_DISTANCE = 0.5;
const W_PII = 0.3;
const W_CONTRADICTION = 0.2;

/** Semantic cosine range considered a "contradiction zone" */
const CONTRADICTION_LO = 0.8;
const CONTRADICTION_HI = 0.97;

export interface AnomalyInput {
  /**
   * Cosine similarity scores from a vector search against existing memories
   * (typically the top-5 or top-10 neighbours). Empty = completely novel.
   */
  neighbourScores: number[];
  /**
   * PII risk estimate in [0, 1] produced by the caller (e.g. from pii/detect).
   * A value of 1.0 means the text is likely full of PII.
   */
  piiRiskScore: number;
  /**
   * Override the default threshold. Defaults to DEFAULT_ANOMALY_THRESHOLD.
   */
  threshold?: number;
}

/**
 * Score the semantic anomaly of a piece of text about to be written.
 *
 * Call this AFTER embedding but BEFORE committing to storage so a flagged
 * write can be routed to the outbox for human review.
 *
 * @param input - Neighbour scores + PII risk + optional threshold override.
 * @returns AnomalyScore with composite score, flag, and per-signal breakdown.
 */
export function scoreAnomaly(input: AnomalyInput): AnomalyScore {
  const { neighbourScores, piiRiskScore } = input;
  const threshold = input.threshold ?? DEFAULT_ANOMALY_THRESHOLD;

  // distance: 1 − mean(cosine sims), clamped to [0, 1]
  // If there are no neighbours, the write is completely novel → distance = 0.
  // (Novel writes are expected; novelty alone is not anomalous.)
  const distance =
    neighbourScores.length === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            1 -
              neighbourScores.reduce((a, b) => a + b, 0) / neighbourScores.length,
          ),
        );

  // contradiction: fraction of neighbours in the semantic contradiction zone
  const contradiction =
    neighbourScores.length === 0
      ? 0
      : neighbourScores.filter(
          (s) => s >= CONTRADICTION_LO && s < CONTRADICTION_HI,
        ).length / neighbourScores.length;

  // piiDensity: clamp the caller-supplied risk score to [0, 1]
  const piiDensity = Math.max(0, Math.min(1, piiRiskScore));

  // Weighted sum
  const score = Math.max(
    0,
    Math.min(
      1,
      W_DISTANCE * distance + W_PII * piiDensity + W_CONTRADICTION * contradiction,
    ),
  );

  return {
    score,
    flagged: score >= threshold,
    signals: { distance, piiDensity, contradiction },
  };
}
