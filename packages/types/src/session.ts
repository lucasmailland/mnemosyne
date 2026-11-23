// Session types — DATA_MODEL.md §4 (mnemo_session + mnemo_session_turn)

import type { Sensitivity } from "./common.js";
import type { ActorType } from "./provenance.js";

export const TRAFFIC_ORIGINS = ["organic", "installer_verify", "evaluation", "unknown"] as const;
export type TrafficOrigin = (typeof TRAFFIC_ORIGINS)[number];
export const TURN_ORIGINS = [
  "human",
  "agent_message",
  "task_notification",
  "pasted_content",
  "assistant",
  "unknown",
] as const;
export type TurnOrigin = (typeof TURN_ORIGINS)[number];

/** Content origin is evidence about a message, never authentication of its author. */
export function classifyTurnOrigin(
  role: SessionTurn["role"],
  content: string,
  native?: { turnOrigin?: TurnOrigin; turnOriginEvidence?: string }
): { turnOrigin: TurnOrigin; turnOriginEvidence: string } {
  if (native?.turnOrigin && TURN_ORIGINS.includes(native.turnOrigin))
    return {
      turnOrigin: native.turnOrigin,
      turnOriginEvidence:
        typeof native.turnOriginEvidence === "string"
          ? native.turnOriginEvidence.slice(0, 256)
          : "caller:typed_origin",
    };
  if (role === "assistant")
    return { turnOrigin: "assistant", turnOriginEvidence: "role:assistant" };
  const text = content.trim();
  for (const [tag, origin] of [
    ["agent-message", "agent_message"],
    ["task-notification", "task_notification"],
    ["pasted_content", "pasted_content"],
  ] as const) {
    if (new RegExp(`^<${tag}(?:\\s[^>]*)?>[\\s\\S]*</${tag}>$`).test(text))
      return { turnOrigin: origin, turnOriginEvidence: `text:whole_wrapper:${tag}` };
  }
  return { turnOrigin: "unknown", turnOriginEvidence: "unclassified" };
}

export type SessionStatus = "active" | "collapse_pending" | "collapsed" | "archived";
export type ManagedCloseKind = "authoritative" | "provisional";
export type ManagedArchiveReason =
  "empty_session" | "incomplete_exchange" | "too_few_turns" | "low_recurrence_signal" | "no_pin";

export const RECOVERABLE_MANAGED_ARCHIVE_REASONS = [
  "too_few_turns",
  "low_recurrence_signal",
  "no_pin",
] as const satisfies readonly ManagedArchiveReason[];

export interface MnemoSession {
  id: string;
  workspaceId: string;
  agentId?: string;
  actorId?: string;

  trafficOrigin?: TrafficOrigin;
  continuityRootId?: string | null;
  status: SessionStatus;
  turnCount: number;
  tokenCount: number;

  /** kept as optional for backward-compat with any stored snapshots */
  collapseTriggeredAt?: Date;
  collapsedAt?: Date;

  openedAt: Date;
  scratch?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  /** §14 A/B measurement — which prompt version was active when this session ran. */
  activePromptVersionId?: string | null;
  /**
   * Explicit user rating for the session, mirroring `mnemo_session.outcome_rating`
   * and its CHECK constraint. Read by `mnemo_metacognition_trends`
   * (`sessionCollapseQuality`), PluginRepository's §14 scored trajectories and
   * MeteringRepository; written by POST /session/:id/feedback.
   *
   * The column and all three readers predate this field — the domain type never
   * modelled it, which is precisely why no write path could set it.
   */
  outcomeRating?: "success" | "failure" | "neutral" | null;
  /** EPISODE-1: human-readable label, e.g. "Reunión con cliente 2026-06-12". */
  label?: string | null;
  sourceHost?: string | null;
  sourceSessionId?: string | null;
  sourceClientInstanceId?: string | null;
  sourceGeneration?: number | null;
  predecessorSessionId?: string | null;
  lastActivityAt?: Date | null;
  closeKind?: ManagedCloseKind | null;
  closeRequestedAt?: Date | null;
  closeGraceDeadline?: Date | null;
  terminalDigestVersion?: number | null;
  terminalMessageSetDigest?: string | null;
  terminalMaxEnqueueSequence?: number | null;
  sensitivity?: Sensitivity | null;
  originActorId?: string | null;
  originActorType?: ActorType | null;
  originUserId?: string | null;
  originSensitivityCeiling?: Sensitivity | null;
  collapseLeaseOwner?: string | null;
  collapseLeaseExpiresAt?: Date | null;
  collapseAttempts?: number;
  collapseNextAttemptAt?: Date | null;
  collapseOperationId?: string | null;
  captureIncomplete?: boolean;
  captureIncompleteReasons?: string[];
  archiveReason?: string | null;
  archivedAt?: Date | null;
  /** LIFECYCLE-14: `mnemo_session.fact_count`, written by a completed collapse. */
  factCount?: number | null;
  /** LIFECYCLE-14: the persisted collapse summary (`context_snapshot`); null before one. */
  collapseSummary?: Record<string, unknown> | null;
}

export interface SessionTurn {
  id: string;
  workspaceId: string;
  sessionId: string;
  turnIndex: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  turnOrigin?: TurnOrigin;
  turnOriginEvidence?: string;
  tokenCount?: number;
  pinned?: boolean;
  hint?: string;
  sourceMessageId?: string;
  supersedesSourceMessageId?: string;
  contentHash?: string;
  retractedAt?: Date;
  retractionReason?: string;
  ingestionEventId?: string;
  createdAt: Date;
}

export interface ManagedSessionClaim {
  session: MnemoSession;
  leaseOwner: string;
  leaseExpiresAt: Date;
}

export interface ManagedCollapseRetry {
  attempts: number;
  nextAttemptAt: Date;
}

export interface ManagedLifecycleQuiesceResult {
  pendingCount: number;
  liveLeaseCount: number;
  reactivatedCount: number;
}
