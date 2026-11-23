import type {
  MnemoFact,
  PrimitiveKind,
  Provenance,
  RecallFilter,
  Sensitivity,
} from "@mnemo-ai/types";
import { scopeRefMatches } from "@mnemo-ai/types";

export interface RecallFilterCandidate {
  primitive: PrimitiveKind;
  tags?: string[];
  validFrom: Date;
  validTo?: Date | null;
  worth?: number;
  confidence?: number;
  sensitivity: Sensitivity;
  provenance?: Provenance;
  entityId?: string;
  entityIds?: string[];
  sessionId?: string;
  scope?: "global" | "conversation";
  scopeRef?: string;
  actorId?: string | null;
  scopeOwner?: string;
}

/** Evaluate the complete RecallFilter contract without performing I/O. */
export function matchesRecallFilter(
  candidate: MnemoFact | RecallFilterCandidate,
  filter?: RecallFilter
): boolean {
  if (!filter) return true;

  const isFact = "statement" in candidate;
  const primitive: PrimitiveKind = isFact ? "fact" : candidate.primitive;
  const metadataTags = isFact ? candidate.metadata?.tags : undefined;
  const tags = isFact
    ? Array.isArray(metadataTags) && metadataTags.every((tag) => typeof tag === "string")
      ? metadataTags
      : []
    : (candidate.tags ?? []);
  const provenance = isFact ? candidate.attribution : candidate.provenance;

  if (filter.kinds && !filter.kinds.includes(primitive)) return false;
  if (filter.tags && !filter.tags.every((tag) => tags.includes(tag))) return false;
  if (filter.validAfter && candidate.validFrom < filter.validAfter) return false;
  if (filter.validBefore && candidate.validFrom > filter.validBefore) return false;
  if (
    filter.minWorth !== undefined &&
    (candidate.worth === undefined || candidate.worth < filter.minWorth)
  )
    return false;
  if (
    filter.minConfidence !== undefined &&
    (candidate.confidence === undefined || candidate.confidence < filter.minConfidence)
  )
    return false;
  if (filter.sensitivity && !filter.sensitivity.includes(candidate.sensitivity)) return false;
  if (filter.provenance && (provenance === undefined || !filter.provenance.includes(provenance)))
    return false;
  if (
    filter.entityId &&
    candidate.entityId !== filter.entityId &&
    !("entityIds" in candidate && candidate.entityIds?.includes(filter.entityId))
  )
    return false;
  if (filter.sessionId && candidate.sessionId !== filter.sessionId) return false;
  if (filter.scope && candidate.scope !== filter.scope) return false;
  if (!scopeRefMatches(candidate.scopeRef, filter)) return false;
  if (filter.actorId && candidate.actorId !== filter.actorId) return false;
  // RECALL-6: exact ownership. A legacy row without a label never matches —
  // it is not anyone's personal memory just because nobody labelled it.
  if (filter.scopeOwner && candidate.scopeOwner !== filter.scopeOwner) return false;
  return true;
}
