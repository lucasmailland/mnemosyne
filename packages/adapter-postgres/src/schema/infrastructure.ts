import { mnemoSchema } from "./mnemo_schema.js";
import {
  bigint,
  text,
  integer,
  real,
  numeric,
  boolean,
  timestamp,
  jsonb,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { halfvec, bytea } from "./_custom-types.js";

/**
 * mnemo_query_cache — semantic query result cache (§9 L3).
 *
 * Slice 1 pt.2 (flatten-legacy-dual-core, design.md D1): this table was never
 * used via the Drizzle query builder anywhere (grep-confirmed) — the live L3
 * cache path (`FactRepository.lookupQueryCache`/`insertQueryCache`) writes
 * and reads this table exclusively through raw SQL. Reconciled to the real
 * columns 0001_v3_complete_baseline.sql actually created (query embedding +
 * result arrays keyed by embedding similarity, LRU eviction via
 * last_used_at/hit_count — no query_hash/query_text/expires_at columns exist
 * physically). See schema-truth.json for the full physical shape.
 *
 * NOTE (fixed — P59, docs/archive/openspec/p59-query-cache-l3-fix): the raw SQL in
 * FactRepository.ts's lookupQueryCache/insertQueryCache (formerly
 * upsertQueryCache) previously referenced query_hash/result_ids/
 * result_kinds/expires_at, none of which exist on the real table, so both
 * methods raised `column does not exist` on every invocation since the
 * legacy `0022` migration. Both statements are now rewritten against the
 * real columns declared below (query_embedding/result_memory_ids/
 * result_memory_kinds/scope/scope_ref/agent_id/top_k/hit_count/
 * last_used_at), insert-only (no unique key exists to upsert against). See
 * `docs/archive/openspec/p59-query-cache-l3-fix/design.md` for the full rationale.
 */
export const queryCacheTable = mnemoSchema.table("mnemo_query_cache", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  queryEmbedding: halfvec("query_embedding").notNull(),
  resultMemoryIds: text("result_memory_ids").array().notNull(),
  resultMemoryKinds: text("result_memory_kinds").array().notNull(),
  scope: text("scope"),
  scopeRef: text("scope_ref"),
  agentId: text("agent_id"),
  topK: integer("top_k").notNull(),
  hitCount: integer("hit_count").notNull().default(1),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/**
 * mnemo_review_queue — primitives flagged for human/LLM review.
 *
 * Slice 1 pt.2 (flatten-legacy-dual-core, design.md D1): never used via the
 * Drizzle query builder (grep-confirmed) — the live v3 write path
 * (`ConsolidationRepository.ts`) inserts via raw SQL against the real
 * columns (id/workspace_id/fact_id/reason), which this model never declared.
 * Reconciled to the physical shape from 0001_v3_complete_baseline.sql
 * (decision_id/fact_id/resolution/resolved_at/resolved_by — no generic
 * primitive_kind+primitive_id+priority+review_outcome columns exist).
 */
export const reviewQueueTable = mnemoSchema.table("mnemo_review_queue", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  decisionId: text("decision_id"),
  factId: text("fact_id"),
  reason: text("reason").notNull(),
  resolution: text("resolution"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  resolvedBy: text("resolved_by"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/**
 * mnemo_health — health snapshot rows (§ops health cron).
 *
 * Slice 1 pt.2 (flatten-legacy-dual-core, design.md D1): never used via the
 * Drizzle query builder (grep-confirmed) — health snapshotting today still
 * lives entirely in legacy `packages/core/src/health/` (ported to v3 in
 * Phase 4/Slice 3a per tasks.md 4.3). Reconciled to the real aggregate-
 * snapshot columns 0001_v3_complete_baseline.sql created (generated_at/
 * snapshot_at + fact/decision/relation counters) — no generic
 * check_name+status+value+message shape exists physically.
 */
export const healthTable = mnemoSchema.table("mnemo_health", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  factCountActive: integer("fact_count_active").notNull(),
  factCountArchived: integer("fact_count_archived").notNull(),
  factCountEmbedded: integer("fact_count_embedded").notNull(),
  factCountUnembedded: integer("fact_count_unembedded").notNull(),
  decisionCountActive: integer("decision_count_active").notNull(),
  relationCountConflicts: integer("relation_count_conflicts").notNull(),
  factsWithZeroHits: integer("facts_with_zero_hits").notNull(),
  recallHitRate30d: numeric("recall_hit_rate_30d", { precision: 4, scale: 3 }),
  extractionJobsFailed7d: integer("extraction_jobs_failed_7d").notNull(),
  extractionJobsDeferred: integer("extraction_jobs_deferred").notNull(),
  computedInMs: integer("computed_in_ms").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

/**
 * mnemo_api_keys — API key registry.
 */
export const apiKeysTable = mnemoSchema.table("mnemo_api_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  name: text("name").notNull(),
  scopes: text("scopes")
    .array()
    .notNull()
    .default(sql`'{}'`),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  /** Plan tier for rate-limit layers (spec §35, 0036_api_key_plan.sql). */
  plan: text("plan").notNull().default("free"),
});

/**
 * mnemo_access_policy — per-(workspace, agent) capability policy, read/written
 * by `DrizzleAccessPolicyStore` (§5 `AccessPolicyStore` port).
 *
 * Slice 1 pt.2 (flatten-legacy-dual-core, design.md D1): this model was never
 * used — `DrizzleAccessPolicyStore.ts` already reads/writes this table
 * exclusively via raw SQL against the real columns (read_scopes/write_scopes/
 * self_edit/task_scopes/limits/require_approval_for/federation_access/
 * namespaces), confirmed by reading that file. The old resource/action/
 * effect/conditions/priority shape here was a stale ABAC-rules design that
 * physical was never migrated to. Reconciled to 0001_v3_complete_baseline.sql's
 * real columns and defaults (also carries a
 * `federation_access IN ('none','read','read_write')` CHECK not modeled here —
 * out of this mechanical diff-driven pass's scope, same discipline as facts.ts
 * only declaring what's been verified).
 */
export const accessPolicyTable = mnemoSchema.table("mnemo_access_policy", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentId: text("agent_id").notNull(),
  readScopes: text("read_scopes")
    .array()
    .notNull()
    .default(sql`'{}'`),
  writeScopes: text("write_scopes")
    .array()
    .notNull()
    .default(sql`'{}'`),
  selfEdit: jsonb("self_edit").notNull().default({ enabled: false }),
  taskScopes: jsonb("task_scopes")
    .notNull()
    .default({ canCreate: false, canDelegate: false, canDelegateTo: [] }),
  limits: jsonb("limits").notNull().default({
    maxWritesPerMinute: 120,
    maxRecallsPerMinute: 600,
    maxSessionsConcurrent: 10,
    maxSelfEditsPerSession: 3,
  }),
  requireApprovalFor: text("require_approval_for")
    .array()
    .notNull()
    .default(sql`'{}'`),
  federationAccess: text("federation_access").notNull().default("none"),
  namespaces: text("namespaces")
    .array()
    .notNull()
    .default(sql`'{}'`),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/**
 * mnemo_access_policy_change — one row per policy write, written by a trigger on
 * mnemo_access_policy and polled by every replica to drop its cached policy
 * (migration 0067). RLS + FORCE per workspace.
 */
export const accessPolicyChangeTable = mnemoSchema.table("mnemo_access_policy_change", {
  seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentId: text("agent_id").notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`clock_timestamp()`),
});

/**
 * mnemo_prompt_version — versioned prompt templates.
 * Extended in migration 0040 with procedural-memory evolution columns (spec §14).
 */
export const promptVersionTable = mnemoSchema.table("mnemo_prompt_version", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  promptKey: text("prompt_key").notNull(),
  version: integer("version").notNull(),
  content: text("content").notNull(),
  performanceScore: real("performance_score"),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  // §14 Procedural memory evolution columns (migration 0040)
  agentId: text("agent_id").notNull().default(""),
  promptText: text("prompt_text"),
  diffFromPrevious: text("diff_from_previous"),
  algorithm: text("algorithm").notNull().default("manual"),
  trajectoriesUsed: integer("trajectories_used"),
  avgScoreBefore: real("avg_score_before"),
  avgScoreAfter: real("avg_score_after"),
  status: text("status").notNull().default("candidate"),
  activatedAt: timestamp("activated_at", { withTimezone: true, mode: "date" }),
});

/**
 * mnemo_plugin_state — plugin synchronization state.
 */
export const pluginStateTable = mnemoSchema.table("mnemo_plugin_state", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  pluginId: text("plugin_id").notNull(),
  cursor: text("cursor"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
  errorCount: integer("error_count").notNull().default(0),
  lastError: text("last_error"),
  state: jsonb("state").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/**
 * mnemo_composition_rule — DSL-defined composition rules.
 */
export const compositionRuleTable = mnemoSchema.table("mnemo_composition_rule", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  conditionDsl: jsonb("condition_dsl").notNull(),
  actionDsl: jsonb("action_dsl").notNull(),
  priority: integer("priority").notNull().default(100),
  isActive: boolean("is_active").notNull().default(true),
  executionCount: integer("execution_count").notNull().default(0),
  createdBy: text("created_by"),
  source: text("source").notNull().default("manual"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/**
 * mnemo_webhook_endpoint — outgoing webhook registrations.
 */
export const webhookEndpointTable = mnemoSchema.table("mnemo_webhook_endpoint", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  url: text("url").notNull(),
  events: text("events")
    .array()
    .notNull()
    .default(sql`'{}'`),
  secretHash: text("secret_hash").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  description: text("description"),
  failureCount: integer("failure_count").notNull().default(0),
  disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/**
 * mnemo_webhook_delivery — append-only delivery attempt log.
 */
export const webhookDeliveryTable = mnemoSchema.table("mnemo_webhook_delivery", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: text("status").notNull().default("pending"),
  responseStatus: integer("response_status"),
  responseBody: text("response_body"),
  attempt: integer("attempt").notNull().default(1),
  deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/**
 * mnemo_encryption_keys — encryption key registry.
 */
export const encryptionKeysTable = mnemoSchema.table("mnemo_encryption_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  keyId: text("key_id").notNull().unique(),
  algorithm: text("algorithm").notNull().default("AES-256-GCM"),
  purpose: text("purpose").notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "date" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type SelectQueryCache = typeof queryCacheTable.$inferSelect;
export type InsertQueryCache = typeof queryCacheTable.$inferInsert;
export type SelectReviewQueue = typeof reviewQueueTable.$inferSelect;
export type InsertReviewQueue = typeof reviewQueueTable.$inferInsert;
export type SelectHealth = typeof healthTable.$inferSelect;
export type InsertHealth = typeof healthTable.$inferInsert;
export type SelectApiKeys = typeof apiKeysTable.$inferSelect;
export type InsertApiKeys = typeof apiKeysTable.$inferInsert;
export type SelectAccessPolicy = typeof accessPolicyTable.$inferSelect;
export type InsertAccessPolicy = typeof accessPolicyTable.$inferInsert;
export type SelectPromptVersion = typeof promptVersionTable.$inferSelect;
export type InsertPromptVersion = typeof promptVersionTable.$inferInsert;
export type SelectPluginState = typeof pluginStateTable.$inferSelect;
export type InsertPluginState = typeof pluginStateTable.$inferInsert;
export type SelectCompositionRule = typeof compositionRuleTable.$inferSelect;
export type InsertCompositionRule = typeof compositionRuleTable.$inferInsert;
export type SelectWebhookEndpoint = typeof webhookEndpointTable.$inferSelect;
export type InsertWebhookEndpoint = typeof webhookEndpointTable.$inferInsert;
export type SelectWebhookDelivery = typeof webhookDeliveryTable.$inferSelect;
export type InsertWebhookDelivery = typeof webhookDeliveryTable.$inferInsert;
export type SelectEncryptionKeys = typeof encryptionKeysTable.$inferSelect;
export type InsertEncryptionKeys = typeof encryptionKeysTable.$inferInsert;

/**
 * mnemo_reminder — prospective memory: time- and semantic-triggered reminders.
 */
export const reminderTable = mnemoSchema.table("mnemo_reminder", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  content: text("content").notNull(),
  // REMIND-1 (migration 0018): nullable — a reminder may be time-only.
  condition: text("condition"),
  triggerAt: timestamp("trigger_at", { withTimezone: true, mode: "date" }),
  status: text("status").notNull().default("pending"),
  conditionEmbedding: halfvec("condition_embedding"),
  triggeredAt: timestamp("triggered_at", { withTimezone: true, mode: "date" }),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true, mode: "date" }),
  // LIFECYCLE-6 (migration 0043): when a recall first returned it to an agent.
  deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
  createdByAgentId: text("created_by_agent_id"),
  // p45 (migration 0026): actor_id/user_id/actor_type — reuses the standard
  // provenance triple pattern from 0023, added later here because
  // mnemo_reminder is not one of the 10 cognitive primitive tables.
  actorId: text("actor_id"),
  userId: text("user_id"),
  actorType: text("actor_type"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type SelectReminder = typeof reminderTable.$inferSelect;
export type InsertReminder = typeof reminderTable.$inferInsert;

/**
 * mnemo_actor_dek — per-actor Data Encryption Keys for GDPR crypto-erasure.
 *
 * GDPR Article 17: destroying the DEK makes all actor data unreadable without
 * deleting rows — preserving the bitemporal audit trail.
 */
export const actorDekTable = mnemoSchema.table("mnemo_actor_dek", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  actorId: text("actor_id").notNull(),
  /**
   * The platform account (mnemo_user.id) this DEK's writer was bound to, when
   * one exists. NULL for service/agent/system-authored DEKs (no person to
   * erase). Populated at provisioning time only — existing rows predating this
   * column stay NULL; they remain destroyable via the actor_id-keyed path.
   * Does NOT participate in wrap/unwrap AAD — that stays keyed on actor_id
   * only, since a key's user_id binding is fixed for its whole lifetime (see
   * FactRepository.destroyUserDeks doc comment for the full reasoning).
   */
  userId: text("user_id"),
  // Slice 1 pt.2 (flatten-legacy-dual-core, design.md D1): physical is bytea,
  // not text — FactRepository.ts's write path already `decode(..., 'base64')`s
  // into it via raw SQL, and 2 of its 3 read call sites already defensively
  // handle a Buffer-shaped value coming back (see FactRepository.ts's
  // replaceFact/updateFact wrapped-value handling). Declaring the real type
  // here surfaces that createFact's own DEK-lookup read path was the one call
  // site NOT doing that Buffer-aware unwrap — fixed in the same commit.
  encryptedKey: bytea("encrypted_key"),
  algorithm: text("algorithm").notNull().default("AES-256-GCM"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  destroyedAt: timestamp("destroyed_at", { withTimezone: true, mode: "date" }),
});

export type SelectActorDek = typeof actorDekTable.$inferSelect;
export type InsertActorDek = typeof actorDekTable.$inferInsert;

/**
 * mnemo_workspace_kek — records the active KEK version per workspace.
 *
 * When the quarterly cron rotates the KEK, it bumps kekVersion, re-wraps every
 * live DEK under the new KEK (DEK plaintext unchanged → no fact re-encryption),
 * and inserts a new row here. DEK erasure still works: nulling encrypted_key in
 * mnemo_actor_dek makes the DEK irrecoverable regardless of KEK version.
 */
export const workspaceKekTable = mnemoSchema.table("mnemo_workspace_kek", {
  // Slice 1 pt.2 (flatten-legacy-dual-core, design.md D1): physical is
  // `uuid DEFAULT gen_random_uuid()`, not a bare text PK — never used via the
  // Drizzle query builder anywhere (grep-confirmed), so zero call-site ripple.
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  workspaceId: text("workspace_id").notNull(),
  /** Monotonically increasing KEK version (starts at 1). */
  kekVersion: integer("kek_version").notNull().default(1),
  rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type SelectWorkspaceKek = typeof workspaceKekTable.$inferSelect;
export type InsertWorkspaceKek = typeof workspaceKekTable.$inferInsert;

/**
 * mnemo_workspace_mode — tracks whether a workspace is in cold-start learning
 * mode (worth gate relaxed) or production mode (full serving gate active).
 *
 * Wave T4: OutcomeSignal + cold-start learning mode.
 * RDD-5: Multi-criteria graduation (factCount/sessionCount/entityCount/daysElapsed).
 */
export const workspaceModeTable = mnemoSchema.table("mnemo_workspace_mode", {
  workspaceId: text("workspace_id").notNull().primaryKey(),
  /** "learning" = cold-start (worth gate relaxed); "production" = full gate active. */
  mode: text("mode").notNull().default("learning"),
  /** Monotonic count of completed session collapses. */
  sessionCount: integer("session_count").notNull().default(0),
  /** Collapse count threshold for auto-promoting to production (null = manual only). */
  promoteAt: integer("promote_at"),
  /** When this workspace entered learning mode (RDD-5 daysElapsed criterion). */
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  /** Cumulative fact count (RDD-5 factCount criterion). */
  factCount: integer("fact_count").notNull().default(0),
  /** Cumulative entity count (RDD-5 entityCount criterion). */
  entityCount: integer("entity_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type SelectWorkspaceMode = typeof workspaceModeTable.$inferSelect;
export type InsertWorkspaceMode = typeof workspaceModeTable.$inferInsert;
