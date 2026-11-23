// packages/federation/src/trust.ts
// §33 Distributed Consensus — TRUST_ANCHORS and weight helpers (Wave I).

/**
 * Trust anchor hierarchy from §12.2 of FEDERATION.md.
 * Used to compare the intrinsic credibility of competing fact attributions
 * and to weight votes in federated consensus.
 */
export const TRUST_ANCHORS = Object.freeze({
  codebase_verified:  100,
  user_stated:         90,
  user_confirmed:      85,
  api_response:        80,
  document_extracted:  70,
  agent_observed:      60,
  agent_inferred:      40,
  llm_generated:       30,
  federation_received: 20,
} as const);

/**
 * Return the raw trust score for an attribution string.
 * Unknown attributions default to federation_received (20) — the most
 * conservative assumption for an unrecognised provenance.
 */
export function baseWeightFor(attribution: string): number {
  const anchors = TRUST_ANCHORS as Record<string, number>;
  return anchors[attribution] ?? TRUST_ANCHORS.federation_received;
}

/**
 * Effective trust weight: raw anchor score × local peer trust weight.
 * The localTrustWeight comes from the LOCAL PeerConfig.trustWeight entry
 * (never from the peer itself — peers must not self-report trust).
 *
 * Result is in [0, 100].
 */
export function effectiveWeight(attribution: string, localTrustWeight: number): number {
  return baseWeightFor(attribution) * localTrustWeight;
}

/**
 * Map the MnemoFact.attribution domain enum onto the TRUST_ANCHORS credibility scale.
 * objective_fact → codebase_verified(100), user_stated → user_stated(90),
 * user_belief → agent_observed(60), inferred → agent_inferred(40).
 * Unknown/federation-sourced → federation_received(20).
 */
export const ATTRIBUTION_TRUST_MAP = Object.freeze({
  objective_fact: TRUST_ANCHORS.codebase_verified,
  user_stated:    TRUST_ANCHORS.user_stated,
  user_belief:    TRUST_ANCHORS.agent_observed,
  inferred:       TRUST_ANCHORS.agent_inferred,
} as const);

export function trustScoreForAttribution(attribution: string): number {
  const mapped = (ATTRIBUTION_TRUST_MAP as Record<string, number>)[attribution];
  if (mapped !== undefined) return mapped;
  return baseWeightFor(attribution);
}
