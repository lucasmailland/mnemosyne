// Consolidation gate (spec §12, MEMORY_IMPROVEMENT.md lines 1062–1092).
//
// Cluster gate: a cluster of >= 3 facts may be merged ONLY if ALL conditions hold.
// Any single failure aborts the merge. This is intentionally conservative —
// spec: "don't merge pairs — too aggressive".

import { wilsonLowerBound } from "@mnemo-ai/core/cognitive";
import { cosineSimilarity } from "./utils.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** The fact fields the gate inspects. Structurally a subset of MnemoFact. */
export interface GateFact {
  id: string;
  worth: number;
  worthAlpha: number;
  worthBeta: number;
  pinned: boolean;
  /** §11 governance: canonical facts are exempt from consolidation merging (line 1045). */
  canonical: boolean;
  contested: boolean;
  sensitivity: string;
  hitCount: number;
  lastRecalledAt: Date | null;
  embedding?: number[];
}

export interface GateInput {
  /** The cluster of candidate facts (must be >= 3 to pass). */
  members: GateFact[];
}

export type FailedCondition =
  | "cluster_too_small"
  | "high_worth"
  | "recently_recalled"
  | "high_confidence"
  | "low_similarity"
  | "pinned"
  | "contested"
  | "sensitivity_mismatch"
  | "missing_embeddings"
  /** §11 governance condition 7: a canonical fact is exempt from merging (line 1045). */
  | "canonical";

export interface GateResult {
  passed: boolean;
  failedCondition?: FailedCondition;
  /** Minimum pairwise cosine across the cluster (diagnostic). */
  minCosine?: number;
}

// ─── Condition thresholds (spec §12) ──────────────────────────────────────────

const MIN_CLUSTER_SIZE = 3;
const WORTH_CEILING = 0.5;          // merge only when ALL members have worth < 0.5
const RECENCY_WINDOW_MS = 14 * 86_400_000; // no member recalled in the last 14 days
const CONFIDENCE_CEILING = 0.7;    // no member with Wilson lower bound > 0.7
const COSINE_THRESHOLD = 0.85;     // all pairwise similarities must exceed this

// ─── Gate ─────────────────────────────────────────────────────────────────────

export function runConsolidationGate(input: GateInput): GateResult {
  const { members } = input;

  // Condition 0 — cluster size >= 3.
  if (members.length < MIN_CLUSTER_SIZE) {
    return { passed: false, failedCondition: "cluster_too_small" };
  }

  // Condition 7 (§11 line 1045) — canonical facts are exempt from merging.
  // Checked early (before similarity math) for efficiency.
  if (members.some((m) => m.canonical)) {
    return { passed: false, failedCondition: "canonical" };
  }

  // Condition 1 — every member has worth < 0.5 (merge only LOW-worth facts).
  if (members.some((m) => m.worth >= WORTH_CEILING)) {
    return { passed: false, failedCondition: "high_worth" };
  }

  // Condition 3 — no member recalled within the last 14 days.
  const now = Date.now();
  if (members.some((m) => m.lastRecalledAt !== null && now - m.lastRecalledAt.getTime() < RECENCY_WINDOW_MS)) {
    return { passed: false, failedCondition: "recently_recalled" };
  }

  // Condition 4 — no member with Wilson-confidence lower bound > 0.7.
  if (members.some((m) => wilsonLowerBound(m.worthAlpha, m.worthBeta) > CONFIDENCE_CEILING)) {
    return { passed: false, failedCondition: "high_confidence" };
  }

  // Condition 2 (pinned) — no member pinned.
  if (members.some((m) => m.pinned)) {
    return { passed: false, failedCondition: "pinned" };
  }

  // Condition (contested) — no member contested.
  if (members.some((m) => m.contested)) {
    return { passed: false, failedCondition: "contested" };
  }

  // Condition (sensitivity) — all members share the same sensitivity level.
  if (new Set(members.map((m) => m.sensitivity)).size > 1) {
    return { passed: false, failedCondition: "sensitivity_mismatch" };
  }

  // Condition 5 — all pairwise cosine similarities exceed 0.85.
  if (members.some((m) => !m.embedding || m.embedding.length === 0)) {
    return { passed: false, failedCondition: "missing_embeddings" };
  }
  let minCosine = 1;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const c = cosineSimilarity(members[i]!.embedding!, members[j]!.embedding!);
      if (c < minCosine) minCosine = c;
    }
  }
  // Spec §12 cond 5 is ">= 0.85" — exact 0.85 must PASS, reject only when strictly below.
  if (minCosine < COSINE_THRESHOLD) {
    return { passed: false, failedCondition: "low_similarity", minCosine };
  }

  return { passed: true, minCosine };
}
