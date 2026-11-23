/**
 * UCE Knowledge-Type Scheduler (arXiv:2606.02304; spec MEMORY_IMPROVEMENT.md:944-972).
 * Detects which of the 10 cognitive primitive types are under-represented in a
 * workspace and biases the next extraction toward them. Pure: counts in, bias out.
 */

import type { RememberKind } from "@mnemo-ai/types";

export type KnowledgeType = RememberKind;

export interface KnowledgeScheduler {
  distribution: Record<KnowledgeType, number>;
  target: Record<KnowledgeType, number>;
  extractionBias: Record<KnowledgeType, number>;
}

const ALL_TYPES: KnowledgeType[] = [
  "fact", "decision", "strategy", "workflow", "skill",
  "episode", "entity", "task", "event", "reasoning",
  "hyperedge",
];

/**
 * Default target proportions. Deliberately over-weights the rarer procedural/
 * episodic types because extraction naturally over-produces facts; the target
 * counteracts that bias. Proportions are normalized internally, so absolute
 * values need not sum to 1.
 */
export const DEFAULT_TARGET: Record<KnowledgeType, number> = {
  fact: 0.30, decision: 0.15, strategy: 0.15, workflow: 0.10, skill: 0.05,
  episode: 0.10, entity: 0.05, task: 0.05, event: 0.03, reasoning: 0.02,
  // Hyperedges are structural primitives, not knowledge types to extract
  hyperedge: 0,
};

function fill(partial: Partial<Record<KnowledgeType, number>>): Record<KnowledgeType, number> {
  const out = {} as Record<KnowledgeType, number>;
  for (const t of ALL_TYPES) out[t] = partial[t] ?? 0;
  return out;
}

function normalize(counts: Record<KnowledgeType, number>): Record<KnowledgeType, number> {
  const total = ALL_TYPES.reduce((n, t) => n + counts[t], 0);
  const out = {} as Record<KnowledgeType, number>;
  for (const t of ALL_TYPES) out[t] = total > 0 ? counts[t] / total : 0;
  return out;
}

export function buildKnowledgeScheduler(
  distribution: Partial<Record<KnowledgeType, number>>,
  target: Partial<Record<KnowledgeType, number>> = DEFAULT_TARGET,
): KnowledgeScheduler {
  const dist = fill(distribution);
  const targetCounts = fill(target);
  const observed = normalize(dist);              // o_t
  const desired = normalize(targetCounts);       // p_t

  const extractionBias = {} as Record<KnowledgeType, number>;
  for (const t of ALL_TYPES) {
    // Deficit of type t vs its target proportion; clamp at 0 (no negative bias).
    extractionBias[t] = Math.max(0, desired[t] - observed[t]);
  }

  return { distribution: dist, target: desired, extractionBias };
}

/** Types ordered most→least underrepresented (descending bias). */
export function extractionPriority(s: KnowledgeScheduler): Array<{ type: KnowledgeType; bias: number }> {
  return ALL_TYPES
    .map((type) => ({ type, bias: s.extractionBias[type] }))
    .sort((a, b) => b.bias - a.bias);
}

/**
 * Build the extraction-prompt bias suffix from a distribution.
 *
 * Returns empty string when nothing is under-represented (balanced or empty
 * distribution). Pure — caller fetches the distribution and handles its own
 * try/catch. Safe to call with an empty object: returns "".
 */
export function extractionBiasHint(distribution: Partial<Record<KnowledgeType, number>>): string {
  // An empty distribution means no data yet — no bias signal, return "".
  const total = ALL_TYPES.reduce((n, t) => n + (distribution[t] ?? 0), 0);
  if (total === 0) return "";

  const sched = buildKnowledgeScheduler(distribution);
  const under = extractionPriority(sched)
    .filter((p) => p.bias > 0)
    .slice(0, 2)
    .map((p) => p.type);
  if (under.length === 0) return "";

  return [
    "",
    `KNOWLEDGE-TYPE BIAS: this workspace is under-represented in: ${under.join(", ")}.`,
    "When the input contains procedural patterns or rules, prefer extracting a",
    "STRATEGY or WORKFLOW over yet another fact.",
  ].join("\n");
}
