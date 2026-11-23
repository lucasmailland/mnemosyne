/** Validated, write-free managed extraction output. The commit fence revalidates topic matches. */
import type { Sensitivity, WorthDelta } from "./common.js";
import type { ManagedSessionProvenance } from "./harness.js";
import type { ManagedArchiveReason } from "./session.js";
import type {
  CreateFactInput,
  CreateDecisionInput,
  CreateStrategyInput,
  CreateEpisodeInput,
} from "./ports.js";

export interface ManagedCandidateSupport {
  id: string;
  sourceMessageIds: string[];
  sensitivity: Sensitivity;
  topicKey?: string;
  /** Advisory snapshot only; commit resolves the active topic under a lock. */
  predecessorId?: string;
}
export type ManagedCollapseCandidate = ManagedCandidateSupport &
  (
    | { kind: "fact"; input: CreateFactInput }
    | { kind: "decision"; input: CreateDecisionInput }
    | { kind: "strategy"; input: CreateStrategyInput }
  );
export interface ManagedRejectedCandidate {
  id: string;
  kind: "fact" | "decision" | "strategy";
  topicKey?: string;
  requestedSensitivity: Sensitivity;
  contentHash: string;
  reason: "sensitivity_ceiling";
}
export type ManagedPostCommitEffectKind =
  | "session_buffer_cleanup"
  | "hot_tier_promotion"
  | "bus_delivery"
  | "webhook_delivery"
  | "td_credit"
  | "governance"
  | "graduation"
  | "reflection"
  | "anticipation_telemetry"
  | "llm_usage_telemetry";
export interface ManagedPostCommitEffect {
  effectKind: ManagedPostCommitEffectKind;
  targetKind: "session" | "fact" | "workspace" | "agent";
  targetId: string;
  payload: Record<string, unknown>;
}
export interface ManagedCollapsePlanBase {
  operationId: string;
  workspaceId: string;
  sessionId: string;
  generation: number;
  sourceMessageIds: string[];
  sensitivity: Sensitivity;
  provenance: ManagedSessionProvenance;
}
export interface ManagedPreparedCollapsePlan extends ManagedCollapsePlanBase {
  status: "prepared";
  candidates: ManagedCollapseCandidate[];
  rejectedCandidates: ManagedRejectedCandidate[];
  episode: {
    id: string;
    input: CreateEpisodeInput;
    sourceMessageIds: string[];
    sensitivity: Sensitivity;
  };
  /** Includes existing facts with this sessionId; commit must preserve stricter classification. */
  linkSessionFacts: true;
  predecessorSessionId?: string;
  relations: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    sourceType: "fact";
    targetType: "fact";
    verb: "related";
  }>;
  hyperedges: Array<{ id: string; memberIds: string[]; label: string; description: string }>;
  worthUpdates: Array<{ factId: string; delta: WorthDelta }>;
  counters: { factCount: number; sessionCount: 1; reflectionAgentId?: string };
  summary: {
    goal?: string;
    outcome: string;
    discoveries: string[];
    nextSteps: string[];
    relevantEntities: string[];
    keyDecisions: string[];
    turnsProcessed: number;
    pinsUsed: number;
    llmTokensUsed: number;
    collapseReason: string;
    episodeId: string;
  };
  indexJobs: Array<{
    eventType: "vector_upsert";
    targetKind: "fact" | "decision";
    targetId: string;
  }>;
  /** Commit materializes provenance, topic closures/supersedes, correction review rows,
   * lifecycle rows and these durable effects atomically with all output above. */
  postCommitEffects: ManagedPostCommitEffect[];
}
export type ManagedCollapsePlan =
  | ManagedPreparedCollapsePlan
  | (ManagedCollapsePlanBase & {
      status: "archive";
      reason: ManagedArchiveReason;
      postCommitEffects: ManagedPostCommitEffect[];
    })
  | (Omit<ManagedCollapsePlanBase, "sensitivity" | "provenance"> & {
      status: "retryable";
      reason:
        | "invalid_session"
        | "invalid_provenance"
        | "llm_unavailable"
        | "invalid_extraction"
        | "preparation_unavailable";
    });

/** Stable identity is allocated before a session's first collapse commit. */
export function managedCollapseOperationId(session: {
  workspaceId: string;
  id: string;
  sourceGeneration?: number | null;
  collapseOperationId?: string | null;
}): string {
  return (
    session.collapseOperationId ??
    `managed:${session.workspaceId}:${session.id}:${session.sourceGeneration ?? -1}`
  );
}

export interface ManagedEffectClaim extends Omit<ManagedPostCommitEffect, "effectKind"> {
  id: string;
  workspaceId: string;
  operationId: string;
  leaseOwner: string;
  effectKind: ManagedPostCommitEffectKind | "lifecycle_event" | "metrics" | "redis_cleanup";
}
