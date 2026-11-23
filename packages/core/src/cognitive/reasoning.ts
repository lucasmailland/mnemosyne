/**
 * Pure CoT distillation cache decision module — spec §8.
 *
 * ZERO infrastructure imports. All logic is pure functions.
 * No drizzle-orm, pg, postgres, redis, or any I/O package may appear here.
 */

import { wilsonLowerBound } from "./worth.js";

export const RESOLVE_COSINE = 0.88;
export const RESOLVE_WORTH = 0.5;
export const RESOLVE_CONFIDENCE = 0.3;
export const DEDUP_COSINE = 0.95;
export const QUARANTINE_WORTH = 0.3;
export const GOLDEN_WORTH = 0.8;
export const GOLDEN_MIN_USES = 50;

export type ReasoningStatus = "active" | "archived" | "pruned" | "quarantined" | "golden";

export interface ReasoningCandidate {
  id: string;
  cosine: number;
  worth: number;
  successCount: number;
  failureCount: number;
  status: ReasoningStatus;
}

export interface ResolveHit {
  action: "hit";
  reasoningId: string;
  suggestedModel: "haiku";
  cosine: number;
}

export interface ResolveMiss {
  action: "execute";
  similarAttempts: Array<{ reasoningId: string; cosine: number }>;
}

export type ResolveDecision = ResolveHit | ResolveMiss;

/**
 * Spec §8c gate: cosine ≥ 0.88 ∧ worth > 0.5 ∧ wilsonLB > 0.3.
 * Only active or golden rows may be served — quarantined rows are never hit.
 */
export function resolveDecision(candidates: ReasoningCandidate[]): ResolveDecision {
  const top = candidates[0];
  if (
    top &&
    (top.status === "active" || top.status === "golden") &&
    top.cosine >= RESOLVE_COSINE &&
    top.worth > RESOLVE_WORTH &&
    wilsonLowerBound(top.successCount + 1, top.failureCount + 1) > RESOLVE_CONFIDENCE
  ) {
    return { action: "hit", reasoningId: top.id, suggestedModel: "haiku", cosine: top.cosine };
  }
  return {
    action: "execute",
    similarAttempts: candidates.slice(0, 3).map((c) => ({ reasoningId: c.id, cosine: c.cosine })),
  };
}

/**
 * Spec §8c topic-key fast-path gate. The O(1) exact-key lookup must enforce the
 * SAME confidence bar as the vector path (`resolveDecision`): a row is only a
 * cache hit when it is active|golden AND worth > 0.5 AND its Wilson lower bound
 * exceeds 0.3. The earlier topic-key path served on `worth > 0.5` alone, which
 * let a single lucky success (Beta(2,2), Wilson ≈ 0.15) serve a cached CoT — the
 * exact bug the Wilson gate exists to prevent. Pure: takes counts, returns bool.
 */
export function passesTopicKeyResolveGate(candidate: {
  status: ReasoningStatus;
  worth: number;
  successCount: number;
  failureCount: number;
}): boolean {
  return (
    (candidate.status === "active" || candidate.status === "golden") &&
    candidate.worth > RESOLVE_WORTH &&
    wilsonLowerBound(candidate.successCount + 1, candidate.failureCount + 1) > RESOLVE_CONFIDENCE
  );
}

export interface DedupUpsert {
  action: "upsert";
  reasoningId: string;
}

export interface DedupInsert {
  action: "insert";
}

export type DedupDecision = DedupUpsert | DedupInsert;

/**
 * Spec §8 RECORD step b: upsert when top cosine match ≥ 0.95.
 */
export function dedupDecision(candidates: ReasoningCandidate[]): DedupDecision {
  const top = candidates[0];
  if (top && top.cosine >= DEDUP_COSINE) return { action: "upsert", reasoningId: top.id };
  return { action: "insert" };
}

/**
 * Spec §8 FEEDBACK lifecycle transitions.
 * Returns the next status, or null if no transition is needed.
 */
export function lifecycleTransition(row: {
  worth: number;
  usageCount: number;
  status: ReasoningStatus;
}): ReasoningStatus | null {
  // Quarantine if worth falls below threshold (regardless of current status,
  // unless already quarantined — avoid re-triggering)
  if (row.worth < QUARANTINE_WORTH) {
    return row.status === "quarantined" ? null : "quarantined";
  }
  // Promote to golden if worth > 0.8 and has enough usage
  if (row.worth > GOLDEN_WORTH && row.usageCount >= GOLDEN_MIN_USES) {
    return row.status === "golden" ? null : "golden";
  }
  // Recover from quarantine if worth has climbed back above threshold
  if (row.status === "quarantined" && row.worth >= QUARANTINE_WORTH) {
    return "active";
  }
  return null;
}
