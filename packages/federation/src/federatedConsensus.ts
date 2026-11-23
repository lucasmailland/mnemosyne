import { trustScoreForAttribution } from "./trust.js";

export interface FederationVote {
  instanceId: string;
  factVersion: string;
  trustAnchor: string;
  worth: number;
  freshness: string;
}

export type ConsensusResult =
  | { status: "consensus"; adoptedVersion: string; confidence: number }
  | { status: "contested"; versions: string[]; recommendation: "human_review" };

export interface FederatedConsensusOpts {
  supermajority?: number;
  /**
   * Per-instance trust weights sourced from the LOCAL PeerStore config
   * (PeerConfig.trustWeight), keyed by FederationVote.instanceId. NEVER derived
   * from the vote payload — a compromised peer must not be able to inflate its
   * own weight. When a voter's instanceId is absent from the map the default
   * `1` is used (intrinsic anchor/worth/freshness weighting only), preserving
   * the original pure-vote behaviour for callers that pass no weights.
   */
  peerTrustWeights?: ReadonlyMap<string, number>;
}

const SUPERMAJORITY = 0.66;
const FRESHNESS_HALFLIFE_DAYS = 30;

function freshnessDecay(iso: string, nowMs: number): number {
  const ageDays = (nowMs - new Date(iso).getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays)) return 0;
  return Math.exp(-Math.max(0, ageDays) / FRESHNESS_HALFLIFE_DAYS);
}

export function federatedConsensus(
  votes: FederationVote[],
  opts?: FederatedConsensusOpts,
): ConsensusResult {
  const threshold = opts?.supermajority ?? SUPERMAJORITY;
  const peerTrustWeights = opts?.peerTrustWeights;
  const nowMs = Date.now();

  const scores = new Map<string, number>();
  for (const v of votes) {
    // Local trust weight (never self-reported): 1 when this voter is unknown to
    // the local PeerStore, so intrinsic weighting still applies.
    const localTrustWeight = peerTrustWeights?.get(v.instanceId) ?? 1;
    const weight =
      trustScoreForAttribution(v.trustAnchor) * v.worth * freshnessDecay(v.freshness, nowMs) * localTrustWeight;
    scores.set(v.factVersion, (scores.get(v.factVersion) ?? 0) + weight);
  }

  const versions = [...scores.keys()];
  const totalWeight = [...scores.values()].reduce((a, b) => a + b, 0);

  if (totalWeight > 0) {
    let best = "";
    let bestScore = 0;
    for (const [version, score] of scores) {
      if (score > bestScore) { bestScore = score; best = version; }
    }
    const confidence = bestScore / totalWeight;
    if (confidence > threshold) {
      return { status: "consensus", adoptedVersion: best, confidence };
    }
  }

  return { status: "contested", versions, recommendation: "human_review" };
}
