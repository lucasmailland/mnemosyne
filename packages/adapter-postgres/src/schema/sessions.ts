import { mnemoSchema } from "./mnemo_schema.js";
import {
  text,
  integer,
  real,
  timestamp,
  jsonb,
  uuid,
  numeric,
  index,
  boolean,
  bigint,
  uniqueIndex,
  check,
  foreignKey,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { factTable } from "./facts.js";

export const sessionTable = mnemoSchema.table(
  "mnemo_session",
  {
    // Slice 1 pt.2 (flatten-legacy-dual-core, design.md D1): physical has
    // `DEFAULT gen_random_uuid()` (0001_v3_complete_baseline.sql) on this
    // text column — the model never declared it.
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: text("workspace_id").notNull(),
    agentId: text("agent_id"),
    userId: text("user_id"),
    trafficOrigin: text("traffic_origin").notNull().default("unknown"),
    continuityRootId: text("continuity_root_id"),
    status: text("status").notNull().default("active"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    collapsedAt: timestamp("collapsed_at", { withTimezone: true, mode: "date" }),
    contextSnapshot: jsonb("context_snapshot").notNull().default({}),
    outcomeRating: text("outcome_rating"),
    factCount: integer("fact_count").notNull().default(0),
    metadata: jsonb("metadata").notNull().default({}),
    turnCount: integer("turn_count").notNull().default(0),
    tokenCount: integer("token_count").notNull().default(0),
    scratch: jsonb("scratch").notNull().default({}),
    /** §14 A/B measurement — the prompt version that was active when this session ran. */
    activePromptVersionId: text("active_prompt_version_id"),
    /** EPISODE-1: human-readable label, e.g. "Reunión con cliente 2026-06-12". */
    label: text("label"),
    sourceHost: text("source_host"),
    sourceSessionId: text("source_session_id"),
    sourceClientInstanceId: text("source_client_instance_id"),
    sourceGeneration: integer("source_generation").default(0),
    predecessorSessionId: text("predecessor_session_id"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: "date" }),
    closeKind: text("close_kind"),
    closeRequestedAt: timestamp("close_requested_at", { withTimezone: true, mode: "date" }),
    closeGraceDeadline: timestamp("close_grace_deadline", { withTimezone: true, mode: "date" }),
    terminalDigestVersion: integer("terminal_digest_version"),
    terminalMessageSetDigest: text("terminal_message_set_digest"),
    terminalMaxEnqueueSequence: bigint("terminal_max_enqueue_sequence", { mode: "number" }),
    sensitivity: text("sensitivity"),
    originActorId: text("origin_actor_id"),
    originActorType: text("origin_actor_type"),
    originUserId: text("origin_user_id"),
    originSensitivityCeiling: text("origin_sensitivity_ceiling"),
    collapseLeaseOwner: text("collapse_lease_owner"),
    collapseLeaseExpiresAt: timestamp("collapse_lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    collapseAttempts: integer("collapse_attempts").default(0),
    collapseNextAttemptAt: timestamp("collapse_next_attempt_at", {
      withTimezone: true,
      mode: "date",
    }),
    collapseOperationId: text("collapse_operation_id"),
    captureIncomplete: boolean("capture_incomplete").default(false),
    captureIncompleteReasons: jsonb("capture_incomplete_reasons").default([]),
    archiveReason: text("archive_reason"),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("idx_session_legacy_source_generation_unique")
      .on(t.workspaceId, t.sourceClientInstanceId, t.sourceSessionId, t.sourceGeneration)
      .where(
        sql`${t.sourceHost} IS NULL AND ${t.sourceClientInstanceId} IS NOT NULL AND ${t.sourceSessionId} IS NOT NULL`
      ),
    uniqueIndex("idx_session_legacy_successor_unique")
      .on(t.workspaceId, t.predecessorSessionId)
      .where(sql`${t.sourceHost} IS NULL AND ${t.predecessorSessionId} IS NOT NULL`),
    index("idx_session_workspace").on(t.workspaceId, t.status, t.startedAt),
    uniqueIndex("idx_session_workspace_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("idx_session_source_generation_unique")
      .on(
        t.workspaceId,
        t.sourceHost,
        t.sourceClientInstanceId,
        t.sourceSessionId,
        t.sourceGeneration
      )
      .where(
        sql`${t.sourceHost} IS NOT NULL AND ${t.sourceClientInstanceId} IS NOT NULL AND ${t.sourceSessionId} IS NOT NULL AND ${t.sourceGeneration} IS NOT NULL`
      ),
    index("idx_session_managed_activity")
      .on(t.workspaceId, t.lastActivityAt)
      .where(sql`${t.sourceHost} IS NOT NULL AND ${t.status} = 'active'`),
    index("idx_session_collapse_due")
      .on(t.workspaceId, t.collapseNextAttemptAt)
      .where(sql`${t.status} = 'collapse_pending'`),
    index("idx_session_terminal_retention")
      .on(t.workspaceId, sql`COALESCE(${t.collapsedAt}, ${t.archivedAt})`, t.id)
      .where(sql`${t.sourceHost} IS NOT NULL AND ${t.status} IN ('collapsed', 'archived')`),
    check(
      "mnemo_session_traffic_origin_check",
      sql`${t.trafficOrigin} IN ('organic', 'installer_verify', 'evaluation', 'unknown')`
    ),
    check(
      "mnemo_session_status_harness_check",
      sql`${t.status} = ANY (ARRAY['active'::text, 'collapse_pending'::text, 'collapsed'::text, 'archived'::text])`
    ),
    check(
      "mnemo_session_source_generation_safe_check",
      sql`${t.sourceGeneration} IS NULL OR ${t.sourceGeneration} BETWEEN 0 AND 2147483647`
    ),
    check(
      "mnemo_session_terminal_sequence_safe_check",
      sql`${t.terminalMaxEnqueueSequence} IS NULL OR ${t.terminalMaxEnqueueSequence} BETWEEN 1 AND 9007199254740991`
    ),
    check(
      "mnemo_session_managed_archive_reason_check",
      sql`(${t.archiveReason} IS NULL OR ${t.archiveReason} = ANY (ARRAY['empty_session'::text, 'incomplete_exchange'::text, 'too_few_turns'::text, 'low_recurrence_signal'::text, 'no_pin'::text]))`
    ),
  ]
);

export const sessionTurnTable = mnemoSchema.table(
  "mnemo_session_turn",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnIndex: integer("turn_index").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    turnOrigin: text("turn_origin").notNull().default("unknown"),
    turnOriginEvidence: text("turn_origin_evidence").notNull().default("unclassified"),
    continuityRootId: text("continuity_root_id"),
    tokenCount: integer("token_count"),
    pinned: boolean("pinned").notNull().default(false),
    hint: text("hint"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    sourceMessageId: text("source_message_id"),
    supersedesSourceMessageId: text("supersedes_source_message_id"),
    contentHash: text("content_hash"),
    retractedAt: timestamp("retracted_at", { withTimezone: true, mode: "date" }),
    retractionReason: text("retraction_reason"),
    ingestionEventWorkspaceId: text("ingestion_event_workspace_id")
      .notNull()
      .default(sql`current_setting('mnemosyne.workspace_id', true)`),
    ingestionEventId: uuid("ingestion_event_id"),
  },
  (t) => [
    uniqueIndex("idx_session_turn_legacy_occurrence_unique")
      .on(t.workspaceId, t.continuityRootId, t.sourceMessageId)
      .where(sql`${t.continuityRootId} IS NOT NULL AND ${t.sourceMessageId} IS NOT NULL`),
    index("idx_session_turn_session").on(t.sessionId, t.turnIndex),
    uniqueIndex("idx_session_turn_source_message_unique")
      .on(t.workspaceId, t.sessionId, t.sourceMessageId)
      .where(sql`${t.sourceMessageId} IS NOT NULL`),
    foreignKey({
      name: "mnemo_session_turn_session_workspace_fkey",
      columns: [t.ingestionEventWorkspaceId, t.sessionId],
      foreignColumns: [sessionTable.workspaceId, sessionTable.id],
    }).onDelete("cascade"),
    check(
      "mnemo_session_turn_origin_check",
      sql`${t.turnOrigin} IN ('human', 'agent_message', 'task_notification', 'pasted_content', 'assistant', 'unknown')`
    ),
    check(
      "mnemo_session_turn_ingestion_workspace_check",
      sql`${t.ingestionEventWorkspaceId} = ${t.workspaceId}::text`
    ),
  ]
);

export const recallRequestTable = mnemoSchema.table(
  "mnemo_recall_request",
  {
    workspaceId: uuid("workspace_id").notNull(),
    requestId: text("request_id").notNull(),
    requestMetadata: jsonb("request_metadata").notNull().default({}),
    queryHash: text("query_hash"),
    status: text("status").notNull().default("ok"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "mnemo_recall_request_pkey", columns: [t.workspaceId, t.requestId] })]
);

export const recallLogTable = mnemoSchema.table("mnemo_recall_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  // Nullable since 0058: non-fact recall hits carry memory_id only.
  factId: text("fact_id").references(() => factTable.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => sessionTable.id, { onDelete: "set null" }),
  recalledAt: timestamp("recalled_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  queryText: text("query_text"),
  hitRank: integer("hit_rank"),
  tdCredit: numeric("td_credit", { precision: 8, scale: 6 }).default("0"),
  activationScore: numeric("activation_score", { precision: 6, scale: 4 }),
  memoryId: text("memory_id"),
  requestId: text("request_id"),
  primitiveKind: text("primitive_kind"),
  recallScore: real("recall_score").notNull().default(0),
  // Since 0064: raw cosine of a semantic/hybrid hit, apart from the ranking score.
  similarity: real("similarity"),
  latencyMs: integer("latency_ms"),
});

export type SelectSession = typeof sessionTable.$inferSelect;
export type InsertSession = typeof sessionTable.$inferInsert;
export type SelectSessionTurn = typeof sessionTurnTable.$inferSelect;
export type InsertSessionTurn = typeof sessionTurnTable.$inferInsert;
export type SelectRecallRequest = typeof recallRequestTable.$inferSelect;
export type InsertRecallRequest = typeof recallRequestTable.$inferInsert;
export type SelectRecallLog = typeof recallLogTable.$inferSelect;
export type InsertRecallLog = typeof recallLogTable.$inferInsert;
