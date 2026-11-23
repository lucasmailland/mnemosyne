// Branded ID types — prevent accidental ID mix-ups at compile time.
// All IDs are cuid2 strings at runtime; the brand is erased post-compilation.

export type WorkspaceId  = string & { readonly _brand: "WorkspaceId" };
export type FactId       = string & { readonly _brand: "FactId" };
export type DecisionId   = string & { readonly _brand: "DecisionId" };
export type EpisodeId    = string & { readonly _brand: "EpisodeId" };
export type EntityId     = string & { readonly _brand: "EntityId" };
export type StrategyId   = string & { readonly _brand: "StrategyId" };
export type WorkflowId   = string & { readonly _brand: "WorkflowId" };
export type SkillId      = string & { readonly _brand: "SkillId" };
export type TaskId       = string & { readonly _brand: "TaskId" };
export type EventId      = string & { readonly _brand: "EventId" };
export type ReasoningId  = string & { readonly _brand: "ReasoningId" };
export type SessionId    = string & { readonly _brand: "SessionId" };
export type RelationId   = string & { readonly _brand: "RelationId" };
export type HyperedgeId  = string & { readonly _brand: "HyperedgeId" };

// Type-safe cast helpers — use at trust boundaries (DB reads, API responses).
export const asWorkspaceId = (s: string): WorkspaceId => s as WorkspaceId;
export const asFactId      = (s: string): FactId      => s as FactId;
export const asDecisionId  = (s: string): DecisionId  => s as DecisionId;
export const asEpisodeId   = (s: string): EpisodeId   => s as EpisodeId;
export const asEntityId    = (s: string): EntityId    => s as EntityId;
export const asStrategyId  = (s: string): StrategyId  => s as StrategyId;
export const asWorkflowId  = (s: string): WorkflowId  => s as WorkflowId;
export const asSkillId     = (s: string): SkillId     => s as SkillId;
export const asTaskId      = (s: string): TaskId      => s as TaskId;
export const asEventId     = (s: string): EventId     => s as EventId;
export const asReasoningId = (s: string): ReasoningId => s as ReasoningId;
export const asSessionId   = (s: string): SessionId   => s as SessionId;
export const asRelationId  = (s: string): RelationId  => s as RelationId;

// UUID guard — used to reject non-UUID workspace IDs before any DB cast.
const WORKSPACE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns true iff `s` is a well-formed UUID (any version, case-insensitive). */
export function isWorkspaceId(s: string): boolean {
  return WORKSPACE_UUID_RE.test(s);
}
