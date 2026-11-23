import { trustScoreForAttribution } from "./trust.js";

export interface ConflictFact {
  attribution: string;
  worth: number;
  validFrom: Date;
}

export interface ConflictVerdict {
  winner: "local" | "incoming" | "undecided";
  reason: "trust_anchor" | "recency" | "worth" | "ambiguous";
  confidence: number;
}

const WORTH_GAP_THRESHOLD = 0.2;

export function resolveConflict(local: ConflictFact, incoming: ConflictFact): ConflictVerdict {
  const tl = trustScoreForAttribution(local.attribution);
  const ti = trustScoreForAttribution(incoming.attribution);

  if (tl !== ti) {
    return { winner: tl > ti ? "local" : "incoming", reason: "trust_anchor", confidence: 0.9 };
  }

  const ml = local.validFrom.getTime();
  const mi = incoming.validFrom.getTime();
  if (ml !== mi) {
    return { winner: ml > mi ? "local" : "incoming", reason: "recency", confidence: 0.7 };
  }

  if (Math.abs(local.worth - incoming.worth) > WORTH_GAP_THRESHOLD) {
    return { winner: local.worth > incoming.worth ? "local" : "incoming", reason: "worth", confidence: 0.6 };
  }

  return { winner: "undecided", reason: "ambiguous", confidence: 0 };
}
