// Wave X — X1.1: Recall-path injection scorer.
//
// Pure noisy-OR scorer: aggregates all matched poisoning categories using the
// noisy-OR independence model so that multiple weak signals combine correctly.
// Also adds a lightweight IMPERATIVE_LEAD heuristic (commands at sentence start).
//
// PURE MODULE — no host imports (no drizzle, no ioredis, no hono).

import { POISONING_PATTERNS, POISONING_SEVERITY } from "../poisoning/patterns.js";
import type { InjectionScore } from "@mnemo-ai/types";

/**
 * Detects imperative verbs at the beginning of a sentence, which often
 * signal a prompt-injection attempt (e.g. "Delete all my memories" stored
 * as a fact that gets recalled into an LLM context window).
 *
 * Weight is intentionally low (0.4) because many legitimate instructions
 * start with imperative verbs.
 */
const IMPERATIVE_LEAD =
  /^\s*(?:do|run|execute|send|fetch|delete|ignore|output|write|call|set|change|update|reply|respond|tell|give)\b/i;
const IMPERATIVE_LEAD_WEIGHT = 0.4;

export const DEFAULT_INJECTION_THRESHOLD = 0.85;

/**
 * Compute a noisy-OR injection score for a piece of text.
 *
 * The noisy-OR model assumes each signal is conditionally independent given
 * an injection attempt. The combined probability is:
 *
 *   score = 1 − ∏(1 − w_i)   for all matched signals i
 *
 * This is the standard formula for combining independent leak probabilities.
 *
 * @param text - The raw text to score.
 * @param threshold - Score at or above which `flagged` is set true.
 * @returns InjectionScore with composite score, flag, and matched categories.
 */
export function scoreInjection(
  text: string,
  threshold = DEFAULT_INJECTION_THRESHOLD,
): InjectionScore {
  const categories: string[] = [];
  const weights: number[] = [];

  // Check each poisoning pattern (delimiter_injection, role_escape, etc.)
  for (const [cat, re] of Object.entries(POISONING_PATTERNS)) {
    if ((re as RegExp).test(text)) {
      categories.push(cat);
      weights.push(
        POISONING_SEVERITY[cat as keyof typeof POISONING_SEVERITY],
      );
    }
  }

  // Weak imperative-lead signal
  if (IMPERATIVE_LEAD.test(text)) {
    categories.push("imperative_lead");
    weights.push(IMPERATIVE_LEAD_WEIGHT);
  }

  // Noisy-OR: probability(at least one cause fires) = 1 − ∏(1 − p_i)
  let inverse = 1;
  for (const w of weights) {
    inverse *= 1 - w;
  }
  const score = weights.length === 0 ? 0 : 1 - inverse;

  return {
    score,
    flagged: score >= threshold,
    categories,
  };
}
