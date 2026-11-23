/**
 * Worth update — Beta-Bernoulli model with TD(λ) eligibility traces.
 * COGNITIVE_ALGORITHMS.md §6, AUDIT_REPORT.md NEW-03.
 *
 * Why Beta-Bernoulli instead of raw success ratio?
 *   Raw ratio (successes/total) is biased for facts with few observations: a fact
 *   recalled once successfully has ratio=1.0, beating a fact recalled 100 times at
 *   ratio=0.99. Beta-Bernoulli uses the Bayesian posterior mean α/(α+β) which starts
 *   at the Beta(2,2) prior (α₀=β₀=2, mean=0.5) and converges toward the true rate
 *   only as evidence accumulates. The (2,2) prior is deliberately more conservative
 *   than the uniform (1,1): it requires more evidence before a fact's worth moves
 *   far from 0.5, which suppresses single-observation noise. This provides
 *   regularization for free.
 *
 * Why TD(λ) eligibility traces?
 *   creditWeight = λ^k where k = steps between the outcome and the earlier recall.
 *   λ ∈ (0,1) (default 0.7) spreads credit backward in time across the recall
 *   history, not just to the most recent recall. This rewards facts that were
 *   consistently helpful across multiple steps of a multi-turn conversation.
 *
 * The actual math lives in StorageAdapter.updateWorth() because it runs in the same
 * DB transaction as the fact write. This function is a thin telemetry wrapper.
 *
 * DB columns affected: worth_alpha, worth_beta (NUMERIC, default 2.0 each).
 * worth = worth_alpha / NULLIF(worth_alpha + worth_beta, 0) — GENERATED, read-only
 * in TS. (worth_success / worth_failure are legacy counters kept for back-compat;
 * they do NOT drive the GENERATED worth column.)
 */

import type { PrimitiveKind, WorthDelta, AuthContext } from "@mnemo-ai/types";
import type { CoreContext } from "./context.js";

/**
 * Wilson-score lower bound for a Beta(alpha, beta) posterior.
 * Provides a conservative estimate of the true recall-success rate,
 * shrinking toward 0.5 for low-evidence facts.
 *
 * **Architectural decision — computed at serve time, NOT stored as GENERATED column.**
 *
 * The `confidence` field on the `RecallHit` wire type is populated by calling this
 * function at query/serve time rather than being persisted as a `GENERATED STORED`
 * column on the facts table. Rationale:
 *
 *   1. **Write cost**: A `STORED GENERATED` column re-evaluates its expression on
 *      every INSERT and UPDATE. `wilsonLowerBound` calls `Math.sqrt`, which adds
 *      non-trivial CPU overhead to every `updateWorth()` write — with zero index
 *      benefit, because no query ever filters on `confidence` (it is only read for
 *      display / serving-gate decisions that already have the row in memory).
 *
 *   2. **Migration stability**: The Wilson formula depends on `z` (z-score) and on
 *      the implicit Beta prior encoded in `alpha`/`beta`. Both are TypeScript
 *      constants (`z = 1.96`, prior `α₀ = β₀ = 1`). Changing either constant
 *      requires only a TS edit and a deploy — no migration, no backfill, no
 *      coordinated schema change. Storing a derived value in the DB would couple
 *      formula evolution to migration cadence unnecessarily.
 *
 * @param alpha - Beta distribution alpha (successes + prior)
 * @param beta  - Beta distribution beta  (failures  + prior)
 * @param z     - z-score for the confidence interval (default 1.96 → 95%)
 * @returns Lower bound in [0, 1]
 */
export function wilsonLowerBound(alpha: number, beta: number, z = 1.96): number {
  const n = alpha + beta;
  if (n <= 0) return 0;
  const pHat = alpha / n;
  const z2 = z * z;
  const numerator = pHat + z2 / (2 * n) - z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n));
  const denominator = 1 + z2 / n;
  return Math.max(0, Math.min(1, numerator / denominator));
}

/**
 * Wilson-score upper bound, the mirror of wilsonLowerBound. Governance demotes
 * a fact only when this is low: confident the true worth is small, not merely
 * that its mean is.
 */
export function wilsonUpperBound(alpha: number, beta: number, z = 1.96): number {
  const n = alpha + beta;
  if (n <= 0) return 1;
  const pHat = alpha / n;
  const z2 = z * z;
  const numerator = pHat + z2 / (2 * n) + z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n));
  const denominator = 1 + z2 / n;
  return Math.max(0, Math.min(1, numerator / denominator));
}

/** Eligibility-trace half-life in seconds. Credit decays as exp(-Δt/τ). */
const TD_TAU_SECONDS = 86_400; // 1 day

/**
 * Propagate TD(λ) credit backward to predecessor recalls in the same session.
 * Each predecessor's worth is updated with credit decayed by its stored tdCredit
 * AND by an exponential time-decay term exp(-Δt/τ) where τ = 1 day (spec §11,
 * lines 1000–1018 λ-drift). Facts recalled long ago contribute less credit even
 * at the same hop distance.
 *
 * No-ops silently if sessionId is empty, or if getTdPredecessors fails.
 */
export async function propagateTdCredit(
  ctx: CoreContext,
  workspaceId: string,
  sessionId: string,
  triggeredFactId: string,
  delta: WorthDelta
): Promise<void> {
  if (!sessionId) return;

  const predecessors = await ctx.storage
    .getTdPredecessors(workspaceId, sessionId, triggeredFactId)
    .catch(() => [] as Array<{ factId: string; tdCredit: number; recalledAt: Date }>);

  const now = Date.now();

  await Promise.allSettled(
    predecessors
      .filter((p) => p.tdCredit > 0)
      .map((p) => {
        const dtSeconds = Math.max(0, (now - p.recalledAt.getTime()) / 1000);
        const timeDecay = Math.exp(-dtSeconds / TD_TAU_SECONDS);
        return ctx.storage.updateWorth(p.factId, workspaceId, "fact", {
          success: delta.success,
          failure: delta.failure,
          creditWeight: delta.creditWeight * p.tdCredit * timeDecay,
        });
      })
  );
}

/**
 * Serving gate (spec §11, lines 728–730). Only fact hits are gated; other
 * primitives pass through. A fact is served only when its posterior mean
 * worth exceeds 0.5 AND its Wilson lower bound is at least 0.3 — the lower
 * bound naturally encodes the spec's "≥5 uses" requirement, since a Beta(2,2)
 * fact with no evidence has a Wilson bound of ≈0.15 (< 0.3) and is dropped.
 *
 * BUGFIX (2026-07-22): the thresholds above are meant to suppress facts that
 * have *accumulated evidence* of being unhelpful (recalled but not reinforced).
 * A brand-new fact sits at the exact Beta(2,2) neutral prior (worth=0.5,
 * lb≈0.15) purely because it has never been observed — that is an absence of
 * evidence, not evidence of low quality. Applying this gate to it created a
 * bootstrapping deadlock: a fact can only earn worth > 0.5 via recordRecall(),
 * which only runs on facts that already passed the gate, so a freshly
 * remember()'d fact could never be recalled for the first time. `isUntested`
 * (worthAlpha/worthBeta still both at the (2,2) prior — zero observations
 * either way) exempts never-observed facts from the gate; a fact that has
 * been recalled and judged unhelpful even once no longer qualifies and is
 * gated normally.
 */
/**
 * A fact is untested when nobody has judged it yet: zero success and zero
 * failure observations. The Beta parameters cannot answer that question, because
 * the decay job relaxes worth_alpha/worth_beta toward (1,1) as a fact ages: an
 * unjudged fact at (1.9988, 1.9988) still has worth 0.5 and no evidence, yet an
 * exact `alpha === 2 && beta === 2` test called it tested and the gate dropped
 * it (90% of the live workspace's facts, 2026-11-19). Callers without the
 * counters fall back to the prior check.
 */
export function isUntestedWorth(w: {
  worthSuccess?: number;
  worthFailure?: number;
  worthAlpha?: number;
  worthBeta?: number;
}): boolean {
  if (w.worthSuccess !== undefined || w.worthFailure !== undefined) {
    return (w.worthSuccess ?? 0) === 0 && (w.worthFailure ?? 0) === 0;
  }
  return (w.worthAlpha ?? 2) === 2 && (w.worthBeta ?? 2) === 2;
}

export function passesWorthGate(
  hit: {
    primitive: string;
    worth?: number;
    worthLowerBound?: number;
  },
  isUntested = false
): boolean {
  if (hit.primitive !== "fact") return true;
  if (isUntested) return true;
  const worth = hit.worth ?? 0;
  const lb = hit.worthLowerBound ?? 0;
  return worth > 0.5 && lb >= 0.3;
}

export async function updateWorth(
  ctx: CoreContext,
  id: string,
  kind: PrimitiveKind,
  delta: WorthDelta,
  auth: AuthContext
): Promise<void> {
  const span = ctx.telemetry.startSpan("mnemo.worth.update", {
    attributes: { id, kind, workspaceId: auth.workspaceId },
  });

  try {
    await ctx.storage.updateWorth(id, auth.workspaceId, kind, delta);

    ctx.logger.debug("worth updated", {
      workspaceId: auth.workspaceId,
      id,
      kind,
      success: delta.success,
      failure: delta.failure,
      creditWeight: delta.creditWeight,
    });
  } finally {
    span.end();
  }
}
