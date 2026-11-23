import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mnemoSchema } from "./mnemo_schema.js";
import { sessionTable } from "./sessions.js";
import { workspaceTable } from "./tenants.js";

export const HOST_HARNESS_RAW_SQL_OWNED_FOREIGN_KEYS = [
  "mnemo_session_predecessor_workspace_fkey",
  "mnemo_session_turn_ingestion_event_workspace_fkey",
  "mnemo_harness_retraction_predecessor_workspace_fkey",
] as const;

export const harnessWorkspaceControlTable = mnemoSchema.table(
  "mnemo_harness_workspace_control",
  {
    workspaceId: text("workspace_id").primaryKey(),
    ingestionEnabled: boolean("ingestion_enabled").notNull().default(true),
    fenceEpoch: bigint("fence_epoch", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedBy: text("updated_by"),
    updateReason: text("update_reason"),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    check(
      "mnemo_harness_workspace_control_fence_epoch_check",
      sql`${t.fenceEpoch} BETWEEN 0 AND 9007199254740991`
    ),
    check(
      "mnemo_harness_workspace_control_fence_epoch_safe_check",
      sql`${t.fenceEpoch} BETWEEN 0 AND 9007199254740991`
    ),
    foreignKey({
      name: "mnemo_harness_workspace_control_workspace_fkey",
      columns: [t.workspaceId],
      foreignColumns: [workspaceTable.id],
    }).onDelete("cascade"),
  ]
);

export const harnessIngestionEventTable = mnemoSchema.table(
  "mnemo_harness_ingestion_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    eventId: text("event_id").notNull(),
    sourceHost: text("source_host").notNull(),
    sourceClientInstanceId: text("source_client_instance_id").notNull(),
    sourceSessionId: text("source_session_id").notNull(),
    sourceGeneration: integer("source_generation"),
    enqueueSequence: bigint("enqueue_sequence", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    normalizationVersion: integer("normalization_version").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    originActorId: text("origin_actor_id").notNull(),
    originActorType: text("origin_actor_type").notNull(),
    originUserId: text("origin_user_id"),
    originSensitivityCeiling: text("origin_sensitivity_ceiling").notNull(),
    sessionId: text("session_id"),
    ledgerState: text("ledger_state").notNull().default("retryable"),
    acknowledgement: jsonb("acknowledgement"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true, mode: "date" }),
    retryCode: text("retry_code"),
  },
  (t) => [
    uniqueIndex("idx_harness_event_id_unique").on(t.workspaceId, t.eventId),
    uniqueIndex("idx_harness_event_workspace_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("idx_harness_source_sequence_unique").on(
      t.workspaceId,
      t.sourceHost,
      t.sourceClientInstanceId,
      t.sourceSessionId,
      t.enqueueSequence
    ),
    index("idx_harness_event_retryable")
      .on(t.workspaceId, t.receivedAt)
      .where(sql`${t.ledgerState} = 'retryable'`),
    check(
      "mnemo_harness_ingestion_event_enqueue_sequence_check",
      sql`${t.enqueueSequence} BETWEEN 1 AND 9007199254740991`
    ),
    check(
      "mnemo_harness_ingestion_event_enqueue_sequence_safe_check",
      sql`${t.enqueueSequence} BETWEEN 1 AND 9007199254740991`
    ),
    check(
      "mnemo_harness_ingestion_event_source_generation_check",
      sql`${t.sourceGeneration} IS NULL OR ${t.sourceGeneration} BETWEEN 0 AND 2147483647`
    ),
    check(
      "mnemo_harness_ingestion_event_source_generation_safe_check",
      sql`${t.sourceGeneration} IS NULL OR ${t.sourceGeneration} BETWEEN 0 AND 2147483647`
    ),
    check(
      "mnemo_harness_ingestion_event_ledger_state_check",
      sql`${t.ledgerState} = ANY (ARRAY['retryable'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text])`
    ),
    foreignKey({
      name: "mnemo_harness_ingestion_event_session_workspace_fkey",
      columns: [t.workspaceId, t.sessionId],
      foreignColumns: [sessionTable.workspaceId, sessionTable.id],
    }),
  ]
);

export const harnessLossTable = mnemoSchema.table(
  "mnemo_harness_loss",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    sessionId: text("session_id").notNull(),
    ingestionEventId: uuid("ingestion_event_id").notNull(),
    sourceGeneration: integer("source_generation").notNull(),
    enqueueSequence: bigint("enqueue_sequence", { mode: "number" }).notNull(),
    lostEventType: text("lost_event_type").notNull(),
    lostSourceMessageId: text("lost_source_message_id").notNull(),
    lostRole: text("lost_role").notNull(),
    lostContentHash: text("lost_content_hash").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_harness_loss_session").on(t.workspaceId, t.sessionId),
    check(
      "mnemo_harness_loss_source_generation_check",
      sql`${t.sourceGeneration} BETWEEN 0 AND 2147483647`
    ),
    check(
      "mnemo_harness_loss_enqueue_sequence_check",
      sql`${t.enqueueSequence} BETWEEN 1 AND 9007199254740991`
    ),
    check(
      "mnemo_harness_loss_enqueue_sequence_safe_check",
      sql`${t.enqueueSequence} BETWEEN 1 AND 9007199254740991`
    ),
    foreignKey({
      name: "mnemo_harness_loss_session_workspace_fkey",
      columns: [t.workspaceId, t.sessionId],
      foreignColumns: [sessionTable.workspaceId, sessionTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "mnemo_harness_loss_event_workspace_fkey",
      columns: [t.workspaceId, t.ingestionEventId],
      foreignColumns: [harnessIngestionEventTable.workspaceId, harnessIngestionEventTable.id],
    }).onDelete("restrict"),
  ]
);

export const harnessRetractionTable = mnemoSchema.table(
  "mnemo_harness_retraction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    sessionId: text("session_id").notNull(),
    ingestionEventId: uuid("ingestion_event_id").notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    predecessorSessionId: text("predecessor_session_id"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_harness_retraction_session").on(t.workspaceId, t.sessionId),
    foreignKey({
      name: "mnemo_harness_retraction_session_workspace_fkey",
      columns: [t.workspaceId, t.sessionId],
      foreignColumns: [sessionTable.workspaceId, sessionTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "mnemo_harness_retraction_event_workspace_fkey",
      columns: [t.workspaceId, t.ingestionEventId],
      foreignColumns: [harnessIngestionEventTable.workspaceId, harnessIngestionEventTable.id],
    }).onDelete("restrict"),
  ]
);

export const harnessMessageTombstoneTable = mnemoSchema.table(
  "mnemo_harness_message_tombstone",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    sessionId: text("session_id").notNull(),
    sourceHost: text("source_host").notNull(),
    sourceClientInstanceId: text("source_client_instance_id").notNull(),
    sourceSessionId: text("source_session_id").notNull(),
    sourceGeneration: integer("source_generation").notNull(),
    eventId: text("event_id").notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    acknowledgement: jsonb("acknowledgement").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_harness_tombstone_source_message_unique").on(
      t.workspaceId,
      t.sourceHost,
      t.sourceClientInstanceId,
      t.sourceSessionId,
      t.sourceGeneration,
      t.sourceMessageId
    ),
    index("idx_harness_tombstone_session").on(t.workspaceId, t.sessionId),
    check(
      "mnemo_harness_message_tombstone_source_generation_check",
      sql`${t.sourceGeneration} BETWEEN 0 AND 2147483647`
    ),
    foreignKey({
      name: "mnemo_harness_tombstone_session_workspace_fkey",
      columns: [t.workspaceId, t.sessionId],
      foreignColumns: [sessionTable.workspaceId, sessionTable.id],
    }),
  ]
);

export const harnessMessageChunkTable = mnemoSchema.table(
  "mnemo_harness_message_chunk",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    sessionId: text("session_id").notNull(),
    ingestionEventId: uuid("ingestion_event_id").notNull(),
    sourceHost: text("source_host").notNull(),
    sourceClientInstanceId: text("source_client_instance_id").notNull(),
    sourceSessionId: text("source_session_id").notNull(),
    sourceGeneration: integer("source_generation").notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    supersedesSourceMessageId: text("supersedes_source_message_id"),
    role: text("role").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    chunkContentHash: text("chunk_content_hash").notNull(),
    messageContentHash: text("message_content_hash").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_harness_message_chunk_unique").on(
      t.workspaceId,
      t.sourceHost,
      t.sourceClientInstanceId,
      t.sourceSessionId,
      t.sourceGeneration,
      t.sourceMessageId,
      t.chunkIndex
    ),
    index("idx_harness_message_chunk_session").on(t.workspaceId, t.sessionId),
    check(
      "mnemo_harness_message_chunk_source_generation_check",
      sql`${t.sourceGeneration} BETWEEN 0 AND 2147483647`
    ),
    check("mnemo_harness_message_chunk_role_check", sql`${t.role} IN ('user', 'assistant')`),
    check("mnemo_harness_message_chunk_count_check", sql`${t.chunkCount} BETWEEN 2 AND 256`),
    check(
      "mnemo_harness_message_chunk_index_check",
      sql`${t.chunkIndex} >= 0 AND ${t.chunkIndex} < ${t.chunkCount}`
    ),
    foreignKey({
      name: "mnemo_harness_message_chunk_session_workspace_fkey",
      columns: [t.workspaceId, t.sessionId],
      foreignColumns: [sessionTable.workspaceId, sessionTable.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "mnemo_harness_message_chunk_event_workspace_fkey",
      columns: [t.workspaceId, t.ingestionEventId],
      foreignColumns: [harnessIngestionEventTable.workspaceId, harnessIngestionEventTable.id],
    }).onDelete("cascade"),
  ]
);

export const managedCollapseOperationTable = mnemoSchema.table(
  "mnemo_managed_collapse_operation",
  {
    operationId: text("operation_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sessionId: text("session_id").notNull(),
    sourceGeneration: integer("source_generation").notNull(),
    status: text("status").notNull().default("prepared"),
    leaseOwner: text("lease_owner").notNull(),
    result: jsonb("result"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    committedAt: timestamp("committed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("idx_managed_collapse_operation_workspace_id_unique").on(
      t.workspaceId,
      t.operationId
    ),
    uniqueIndex("idx_managed_collapse_session_generation_unique").on(
      t.workspaceId,
      t.sessionId,
      t.sourceGeneration
    ),
    check(
      "mnemo_managed_collapse_operation_source_generation_check",
      sql`${t.sourceGeneration} BETWEEN 0 AND 2147483647`
    ),
    check(
      "mnemo_managed_collapse_operation_status_check",
      sql`${t.status} = ANY (ARRAY['prepared'::text, 'committed'::text, 'failed'::text])`
    ),
    foreignKey({
      name: "mnemo_managed_collapse_operation_session_workspace_fkey",
      columns: [t.workspaceId, t.sessionId],
      foreignColumns: [sessionTable.workspaceId, sessionTable.id],
    }).onDelete("restrict"),
  ]
);

export const managedCollapseEffectTable = mnemoSchema.table(
  "mnemo_managed_collapse_effect",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    collapseOperationId: text("collapse_operation_id").notNull(),
    effectKind: text("effect_kind").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_managed_collapse_effect_unique").on(
      t.collapseOperationId,
      t.effectKind,
      t.targetKind,
      t.targetId
    ),
    index("idx_managed_collapse_effect_pending")
      .on(t.workspaceId, t.nextAttemptAt)
      .where(sql`${t.status} IN ('pending', 'failed')`),
    check("mnemo_managed_collapse_effect_attempts_check", sql`${t.attempts} >= 0`),
    check(
      "mnemo_managed_collapse_effect_status_check",
      sql`${t.status} = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text])`
    ),
    foreignKey({
      name: "mnemo_managed_collapse_effect_operation_workspace_fkey",
      columns: [t.workspaceId, t.collapseOperationId],
      foreignColumns: [
        managedCollapseOperationTable.workspaceId,
        managedCollapseOperationTable.operationId,
      ],
    }).onDelete("cascade"),
  ]
);

export const extractionProvenanceTable = mnemoSchema.table(
  "mnemo_extraction_provenance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: text("workspace_id").notNull(),
    collapseOperationId: text("collapse_operation_id").notNull(),
    sessionId: text("session_id").notNull(),
    primitiveKind: text("primitive_kind").notNull(),
    primitiveId: text("primitive_id").notNull(),
    sourceMessageIds: text("source_message_ids").array().notNull().default([]),
    originActorId: text("origin_actor_id").notNull(),
    originActorType: text("origin_actor_type").notNull(),
    originUserId: text("origin_user_id"),
    sensitivity: text("sensitivity").notNull(),
    sensitivityCeiling: text("sensitivity_ceiling").notNull(),
    candidateHash: text("candidate_hash"),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_extraction_provenance_primitive").on(t.workspaceId, t.primitiveKind, t.primitiveId),
    foreignKey({
      name: "mnemo_extraction_provenance_operation_workspace_fkey",
      columns: [t.workspaceId, t.collapseOperationId],
      foreignColumns: [
        managedCollapseOperationTable.workspaceId,
        managedCollapseOperationTable.operationId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "mnemo_extraction_provenance_session_workspace_fkey",
      columns: [t.workspaceId, t.sessionId],
      foreignColumns: [sessionTable.workspaceId, sessionTable.id],
    }).onDelete("restrict"),
  ]
);

export type SelectHarnessWorkspaceControl = typeof harnessWorkspaceControlTable.$inferSelect;
export type InsertHarnessWorkspaceControl = typeof harnessWorkspaceControlTable.$inferInsert;
export type SelectHarnessIngestionEvent = typeof harnessIngestionEventTable.$inferSelect;
export type InsertHarnessIngestionEvent = typeof harnessIngestionEventTable.$inferInsert;
export type SelectHarnessLoss = typeof harnessLossTable.$inferSelect;
export type InsertHarnessLoss = typeof harnessLossTable.$inferInsert;
export type SelectHarnessRetraction = typeof harnessRetractionTable.$inferSelect;
export type InsertHarnessRetraction = typeof harnessRetractionTable.$inferInsert;
export type SelectHarnessMessageTombstone = typeof harnessMessageTombstoneTable.$inferSelect;
export type InsertHarnessMessageTombstone = typeof harnessMessageTombstoneTable.$inferInsert;
export type SelectManagedCollapseOperation = typeof managedCollapseOperationTable.$inferSelect;
export type InsertManagedCollapseOperation = typeof managedCollapseOperationTable.$inferInsert;
export type SelectManagedCollapseEffect = typeof managedCollapseEffectTable.$inferSelect;
export type InsertManagedCollapseEffect = typeof managedCollapseEffectTable.$inferInsert;
export type SelectExtractionProvenance = typeof extractionProvenanceTable.$inferSelect;
export type InsertExtractionProvenance = typeof extractionProvenanceTable.$inferInsert;
