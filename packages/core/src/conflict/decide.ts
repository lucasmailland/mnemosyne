// packages/core/src/conflict/decide.ts
//
// §33 Distributed Consensus — PURE deterministic conflict resolver.
//
// This module is intentionally infrastructure-free: NO drizzle, NO pg, NO
// adapter imports. It holds only the deterministic verdict logic so that the
// port-only paths (core/v3) can run §33 auto-resolution without dragging the
// SQL-bound saveFactWithAutoResolve wrapper (and its drizzle import) into the
// pure core. The transaction-bound wrapper in ./auto-resolve.ts re-exports
// these symbols, so existing consumers are unaffected.
//
// NOTE: trust-score logic is inlined from §33 ATTRIBUTION_TRUST_MAP rather than
// imported from @mnemo-ai/federation to avoid a circular workspace dependency
// (federation → core → federation).

/** Minimal view of a fact needed by the deterministic conflict resolver. */
export interface ConflictFactView {
  attribution: string;
  worth: number;
  validFrom: Date;
}

// ---------------------------------------------------------------------------
// Inline trust score — mirrors packages/federation/src/trust.ts
// objective_fact → 100, user_stated → 90, user_belief → 60, inferred → 40
// Unknown → 20 (federation_received floor)
// ---------------------------------------------------------------------------
const ATTRIBUTION_TRUST: Record<string, number> = {
  objective_fact: 100,
  user_stated:     90,
  user_belief:     60,
  inferred:        40,
};

function trustScore(attribution: string): number {
  return ATTRIBUTION_TRUST[attribution] ?? 20;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoResolveAction =
  | { action: "supersede"; reason: string }
  | { action: "reject"; reason: string }
  | { action: "review"; reason: string };

/** Internal verdict mirroring packages/federation/src/resolveConflict.ts */
interface Verdict {
  winner: "local" | "incoming" | "undecided";
  reason: "trust_anchor" | "recency" | "worth" | "ambiguous";
  confidence: number;
}

const WORTH_GAP_THRESHOLD = 0.2;
const AUTO_CONFIDENCE_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Internal verdict computation — same 4 rules as resolveConflict.ts
// (inlined to avoid circular workspace dependency: federation → core → federation)
// ---------------------------------------------------------------------------

function computeVerdict(
  existing: ConflictFactView,
  incoming: ConflictFactView,
): Verdict {
  const te = trustScore(existing.attribution);
  const ti = trustScore(incoming.attribution);

  // Rule 1 — trust anchor (confidence 0.9)
  if (te !== ti) {
    return {
      winner: ti > te ? "incoming" : "local",
      reason: "trust_anchor",
      confidence: 0.9,
    };
  }

  // Rule 2 — recency (confidence 0.7 — equals threshold, not above)
  const me = existing.validFrom.getTime();
  const mi = incoming.validFrom.getTime();
  if (me !== mi) {
    return {
      winner: mi > me ? "incoming" : "local",
      reason: "recency",
      confidence: 0.7,
    };
  }

  // Rule 3 — worth gap (confidence 0.6)
  if (Math.abs(existing.worth - incoming.worth) > WORTH_GAP_THRESHOLD) {
    return {
      winner: incoming.worth > existing.worth ? "incoming" : "local",
      reason: "worth",
      confidence: 0.6,
    };
  }

  // Rule 4 — ambiguous
  return { winner: "undecided", reason: "ambiguous", confidence: 0 };
}

// ---------------------------------------------------------------------------
// Pure function — §33 lines 3343–3352
// ---------------------------------------------------------------------------

/**
 * Decide whether to supersede the existing fact, reject the incoming one,
 * or enqueue for human review. The result is purely deterministic — no I/O.
 *
 * Computes a full {winner, reason, confidence} verdict, then gates on
 * confidence > 0.7 before issuing an auto-supersede or auto-reject.
 *
 * Rules (in priority order):
 *   1. Trust anchor differs → conf 0.9 > 0.7 → auto-supersede or auto-reject
 *   2. Equal trust, different validFrom → recency conf 0.7 → enqueue review (≤ threshold)
 *   3. Equal trust + recency, worth gap > 0.2 → worth conf 0.6 → enqueue review
 *   4. All equal → ambiguous conf 0 → enqueue review
 */
export function decideAutoResolution(
  existing: ConflictFactView,
  incoming: ConflictFactView,
): AutoResolveAction {
  const verdict = computeVerdict(existing, incoming);

  if (verdict.winner === "incoming" && verdict.confidence > AUTO_CONFIDENCE_THRESHOLD) {
    return { action: "supersede", reason: verdict.reason };
  }

  if (verdict.winner === "local" && verdict.confidence > AUTO_CONFIDENCE_THRESHOLD) {
    return { action: "reject", reason: verdict.reason };
  }

  return { action: "review", reason: verdict.reason };
}
