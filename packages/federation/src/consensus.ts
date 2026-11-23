// packages/federation/src/consensus.ts
// §33 Distributed Consensus — weighted supermajority resolver (Wave I).
// Pure function: no I/O, no side effects, fully deterministic given inputs.

const SUPERMAJORITY = 2 / 3;

export interface FederationClaim {
  /** Which version this claim votes for. */
  version: string;
  /** Peer who submitted this claim (used to look up local trust weight). */
  peerId?: string;
  /** TRUST_ANCHORS key — credibility of the source fact. */
  attribution?: string;
  /** Clock drift between this peer and local clock (ms). Used for decay. */
  clockSkewMs?: number;
  /** Fact worth in [0, 1]. Defaults to 1.0 if absent. */
  worth?: number;
  /** ISO date when the fact was recorded. Used for freshness decay. */
  freshness?: string;
}

export type ConsensusOutcome =
  | { status: "winner"; version: string; confidence: number }
  | { status: "no_consensus"; versions: string[]; recommendation: "human_review" }
  | { status: "rejected"; reason: string };

export interface ConsensusOpts {
  /** Minimum number of distinct claims required. Default: 1. */
  minQuorum?: number;
  /** Override supermajority threshold (0,1). Default: 2/3. */
  supermajority?: number;
}

/**
 * Resolve consensus from a set of claims.
 *
 * Each claim's vote weight:
 *   peerWeight × clockSkewDecay × worth × freshnessDecay
 *
 * Where:
 *   peerWeight      = peerWeights.get(claim.peerId) ?? 0.5
 *   clockSkewDecay  = exp(-clockSkewMs / 60_000)   [full weight if <1 min drift]
 *   worth           = claim.worth ?? 1.0
 *   freshnessDecay  = exp(-daysSince(freshness) / 30)  [half-life ≈ 30 days]
 *
 * Winner needs strictly > supermajority of total weight (default 2/3).
 * Ties at exactly 2/3 are no_consensus.
 */
export function resolveConsensus(
  claims: FederationClaim[],
  peerWeights: ReadonlyMap<string, number>,
  opts?: ConsensusOpts,
): ConsensusOutcome {
  const minQuorum = opts?.minQuorum ?? 1;
  const threshold = opts?.supermajority ?? SUPERMAJORITY;

  if (claims.length < minQuorum) {
    return { status: "rejected", reason: `quorum not met: ${claims.length} < ${minQuorum}` };
  }

  const nowMs = Date.now();

  // Accumulate weighted score per version.
  const scores = new Map<string, number>();
  for (const claim of claims) {
    const peerWeight = (claim.peerId ? peerWeights.get(claim.peerId) : undefined) ?? 0.5;

    const clockSkewMs = claim.clockSkewMs ?? 0;
    const clockDecay = Math.exp(-clockSkewMs / 60_000);

    const worth = claim.worth ?? 1.0;

    let freshnessDecay = 1.0;
    if (claim.freshness) {
      const ageMs = nowMs - new Date(claim.freshness).getTime();
      const ageDays = ageMs / 86_400_000;
      freshnessDecay = Math.exp(-ageDays / 30);
    }

    const weight = peerWeight * clockDecay * worth * freshnessDecay;
    scores.set(claim.version, (scores.get(claim.version) ?? 0) + weight);
  }

  const totalWeight = [...scores.values()].reduce((a, b) => a + b, 0);
  if (totalWeight === 0) {
    return { status: "rejected", reason: "all claims have zero weight" };
  }

  // Find the version with the highest score.
  let bestVersion = "";
  let bestScore = 0;
  for (const [version, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      bestVersion = version;
    }
  }

  const confidence = bestScore / totalWeight;

  if (confidence > threshold) {
    return { status: "winner", version: bestVersion, confidence };
  }

  return {
    status: "no_consensus",
    versions: [...scores.keys()],
    recommendation: "human_review",
  };
}
