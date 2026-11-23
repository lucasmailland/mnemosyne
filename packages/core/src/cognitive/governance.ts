/**
 * §11 RL-native governance ACTIONS — MEMORY_MODEL.md lines 1004-1046.
 *
 * The worth SIGNAL (Beta-Bernoulli mean + Wilson CI) is computed in worth.ts.
 * This module turns that signal into ACTIONS:
 *   - canonical : worth>0.8 ∧ confLower>0.7 → exempt from consolidation merging
 *   - promote   : worth>0.7 ∧ confLower>0.5 → pin + activation boost
 *   - demote    : Wilson UPPER bound < 0.3 → activation decrease + archive candidate
 *   - neutral   : everything else (mid-band worth, or not enough evidence either way)
 *
 * The spec writes demote as `worth<0.3 ∧ confidence>0.5`, with the same
 * lower-bound confidence as promote. Taken literally it can never fire: the
 * Wilson lower bound of a worth under 0.3 is itself under 0.3. The spirit is
 * "demote what we are confident is worth little", and the bound that measures
 * that is the UPPER one: upper<0.3 means a worth of 0.3 or more is implausible
 * at 95%. From the Beta(2,2) prior that takes ~17 unreinforced recalls, so a
 * 1-of-1 failure (upper≈0.77) never demotes.
 *
 * Promotion uses the Wilson LOWER bound (conservative) so a 1-of-1 success
 * cannot trigger it (rationale D2); demotion mirrors it with the UPPER bound.
 *
 * Pure: zero I/O. The action layer (applyGovernance, in index.ts) executes the
 * decision through ports.
 */

import type { WorthDelta } from "@mnemo-ai/types";
import type { CoreContext } from "./context.js";

export type GovernanceAction = "canonical" | "promote" | "demote" | "neutral";

/** Hard cap on TD provenance-DAG hops (spec line 1037). */
export const GOVERNANCE_MAX_HOPS = 5;

/** Thresholds — spec lines 1005-1007, 1045. */
export const GOV_CANONICAL_WORTH = 0.8;
export const GOV_CANONICAL_CONF = 0.7;
export const GOV_PROMOTE_WORTH = 0.7;
export const GOV_PROMOTE_CONF = 0.5;
export const GOV_DEMOTE_WORTH = 0.3; // demote when the Wilson upper bound is below this

/**
 * Classify what governance action a fact's worth signal implies.
 * @param worth      - posterior mean α/(α+β), [0,1]
 * @param confLower  - Wilson lower bound from wilsonLowerBound(alpha,beta), [0,1]
 * @param confUpper  - Wilson upper bound from wilsonUpperBound(alpha,beta), [0,1]
 */
export function classifyGovernance(
  worth: number,
  confLower: number,
  confUpper: number
): GovernanceAction {
  if (worth > GOV_CANONICAL_WORTH && confLower > GOV_CANONICAL_CONF) return "canonical";
  if (worth > GOV_PROMOTE_WORTH && confLower > GOV_PROMOTE_CONF) return "promote";
  if (confUpper < GOV_DEMOTE_WORTH) return "demote";
  return "neutral";
}

/**
 * §11 governance.propagate (lines 1034-1039): after a rated collapse, get the
 * facts recalled in the session, walk the provenance DAG backward ≤5 hops, and
 * update each predecessor's worth with lambda^depth-decayed credit.
 * No-ops silently if sessionId is empty or storage walks fail.
 */
export async function propagateGovernanceForSession(
  ctx: CoreContext,
  workspaceId: string,
  sessionId: string,
  delta: WorthDelta,
  lambda: number
): Promise<void> {
  if (!sessionId) return;
  const terminals = await ctx.storage.getRecalledFactIds(workspaceId, sessionId).catch(() => []);
  if (terminals.length === 0) return;
  const credited = await ctx.storage
    .getProvenanceCredit(workspaceId, terminals, lambda, GOVERNANCE_MAX_HOPS)
    .catch(() => []);
  await Promise.allSettled(
    credited
      .filter((c) => c.credit > 0)
      .map((c) =>
        ctx.storage.updateWorth(c.factId, workspaceId, "fact", {
          success: delta.success,
          failure: delta.failure,
          creditWeight: (delta.creditWeight ?? 1) * c.credit,
        })
      )
  );
}
