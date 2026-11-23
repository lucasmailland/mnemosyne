import { mnemoSchema } from "./mnemo_schema.js";
import {
  index,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uuid,
  numeric,
} from "drizzle-orm/pg-core";
import { factTable } from "./facts.js";
import { sessionTable } from "./sessions.js";

/**
 * mnemo_spatial_index — geographic retrieval anchors.
 */
export const spatialIndexTable = mnemoSchema.table(
  "mnemo_spatial_index",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    factId: text("fact_id")
      .notNull()
      .references(() => factTable.id, { onDelete: "cascade" }),
    locationName: text("location_name"),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    radiusKm: numeric("radius_km", { precision: 8, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("idx_spatial_fact").on(t.workspaceId, t.factId)]
);

/**
 * mnemo_temporal_anchor — time-scoped associations for temporal reasoning.
 */
export const temporalAnchorTable = mnemoSchema.table(
  "mnemo_temporal_anchor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    factId: text("fact_id")
      .notNull()
      .references(() => factTable.id, { onDelete: "cascade" }),
    anchorLabel: text("anchor_label").notNull(),
    anchorStart: timestamp("anchor_start", { withTimezone: true, mode: "date" }),
    anchorEnd: timestamp("anchor_end", { withTimezone: true, mode: "date" }),
    isRecurring: boolean("is_recurring").notNull().default(false),
    recurrence: jsonb("recurrence"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("idx_temporal_fact").on(t.workspaceId, t.factId)]
);

/**
 * mnemo_causal_chain — directed causal links between any two primitives.
 */
export const causalChainTable = mnemoSchema.table("mnemo_causal_chain", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  causeId: uuid("cause_id").notNull(),
  causeType: text("cause_type").notNull(),
  effectId: uuid("effect_id").notNull(),
  effectType: text("effect_type").notNull(),
  confidence: numeric("confidence", { precision: 6, scale: 4 }).notNull().default("0.5"),
  lagSeconds: integer("lag_seconds"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/**
 * mnemo_analogy_map — structural similarity mappings for analogical reasoning.
 */
export const analogyMapTable = mnemoSchema.table("mnemo_analogy_map", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  sourceType: text("source_type").notNull(),
  targetId: uuid("target_id").notNull(),
  targetType: text("target_type").notNull(),
  similarity: numeric("similarity", { precision: 6, scale: 4 }).notNull(),
  mappingType: text("mapping_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/**
 * mnemo_salience_map — per-workspace topic salience for anticipatory prefetch.
 */
export const salienceMapTable = mnemoSchema.table(
  "mnemo_salience_map",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    topic: text("topic").notNull(),
    salience: numeric("salience", { precision: 6, scale: 4 }).notNull().default("0.5"),
    decayRate: numeric("decay_rate", { precision: 8, scale: 6 }).notNull().default("0.1"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("idx_salience_topic").on(t.workspaceId, t.topic)]
);

/**
 * mnemo_prime_ctx — pre-fetched context injected at session start.
 */
export const primeCtxTable = mnemoSchema.table(
  "mnemo_prime_ctx",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionTable.id, { onDelete: "cascade" }),
    factId: text("fact_id")
      .notNull()
      .references(() => factTable.id, { onDelete: "cascade" }),
    triggerType: text("trigger_type").notNull(),
    confidence: numeric("confidence", { precision: 6, scale: 4 }).notNull(),
    injectedAt: timestamp("injected_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_prime_session").on(t.workspaceId, t.sessionId)]
);

/**
 * mnemo_contradiction_queue — facts flagged contradictory pending resolution.
 */
export const contradictionQueueTable = mnemoSchema.table(
  "mnemo_contradiction_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    factAId: text("fact_a_id")
      .notNull()
      .references(() => factTable.id, { onDelete: "cascade" }),
    factBId: text("fact_b_id")
      .notNull()
      .references(() => factTable.id, { onDelete: "cascade" }),
    detectedAt: timestamp("detected_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    contradictionType: text("contradiction_type").notNull(),
    confidence: numeric("confidence", { precision: 6, scale: 4 }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    resolution: text("resolution"),
    resolvedBy: text("resolved_by"),
  },
  (t) => [index("idx_contradiction_pending").on(t.workspaceId, t.resolvedAt)]
);

export type SelectSpatialIndex = typeof spatialIndexTable.$inferSelect;
export type InsertSpatialIndex = typeof spatialIndexTable.$inferInsert;
export type SelectTemporalAnchor = typeof temporalAnchorTable.$inferSelect;
export type InsertTemporalAnchor = typeof temporalAnchorTable.$inferInsert;
export type SelectCausalChain = typeof causalChainTable.$inferSelect;
export type InsertCausalChain = typeof causalChainTable.$inferInsert;
export type SelectAnalogyMap = typeof analogyMapTable.$inferSelect;
export type InsertAnalogyMap = typeof analogyMapTable.$inferInsert;
export type SelectSalienceMap = typeof salienceMapTable.$inferSelect;
export type InsertSalienceMap = typeof salienceMapTable.$inferInsert;
export type SelectPrimeCtx = typeof primeCtxTable.$inferSelect;
export type InsertPrimeCtx = typeof primeCtxTable.$inferInsert;
export type SelectContradictionQueue = typeof contradictionQueueTable.$inferSelect;
export type InsertContradictionQueue = typeof contradictionQueueTable.$inferInsert;

/**
 * mnemo_review_item — review queue for codebase-drift and other anomalous primitives.
 * Wave Y §25.1
 */
export const reviewItemTable = mnemoSchema.table(
  "mnemo_review_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    primitiveId: text("primitive_id").notNull(),
    primitiveKind: text("primitive_kind").notNull().default("fact"),
    reason: text("reason").notNull(),
    detail: jsonb("detail").notNull().default({}),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("idx_review_item_ws_status").on(t.workspaceId, t.status)]
);

export type SelectReviewItem = typeof reviewItemTable.$inferSelect;
export type InsertReviewItem = typeof reviewItemTable.$inferInsert;
