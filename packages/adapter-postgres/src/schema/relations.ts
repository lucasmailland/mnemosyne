import { mnemoSchema } from "./mnemo_schema.js";
import { text, integer, real, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { halfvec } from "./_custom-types.js";
import { userTable } from "./tenants.js";

export const relationTable = mnemoSchema.table("mnemo_relation", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceId: text("source_id").notNull(),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  relation: text("relation").notNull(),
  // Hebbian learning
  hebbianWeight: real("hebbian_weight").notNull().default(1.0),
  coRecallCount: integer("co_recall_count").notNull().default(0),
  directionality: real("directionality").notNull().default(0.0),
  lastCoRecallAt: timestamp("last_co_recall_at", { withTimezone: true, mode: "date" }),
  // Judgment
  judgmentStatus: text("judgment_status").notNull().default("pending"),
  reason: text("reason"),
  evidence: jsonb("evidence"),
  confidence: real("confidence"),
  markedByUserId: text("marked_by_user_id"),
  markedByKind: text("marked_by_kind").notNull().default("system"),
  markedByModel: text("marked_by_model"),
  markedByPromptVersion: text("marked_by_prompt_version"),
  // Provenance
  provenance: text("provenance"),
  conversationId: text("conversation_id"),
  supersededByRelationId: text("superseded_by_relation_id"),
  actorId: text("actor_id"),
  userId: text("user_id").references(() => userTable.id, { onDelete: "set null" }),
  actorType: text("actor_type"),
  // Validity
  validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const hyperedgeTable = mnemoSchema.table("mnemo_hyperedge", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  memberIds: text("member_ids").array().notNull(),
  label: text("label"),
  description: text("description"),
  contextQuery: text("context_query"),
  contextEmbedding: halfvec("context_embedding"),
  activationCount: integer("activation_count").notNull().default(0),
  worth: real("worth").notNull().default(0.5),
  actorId: text("actor_id"),
  userId: text("user_id").references(() => userTable.id, { onDelete: "set null" }),
  actorType: text("actor_type"),
  validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

// Slice 1 pt.2 (flatten-legacy-dual-core, design.md D1) partially reconciled
// this table to the physical shape (sourceKind/sourceId/createdAt). PR9e
// (design.md D6.5) finishes the reconciliation: `CitationRepository` now
// reads through this model, so every remaining physical column
// (memory_kind/memory_id/extractor_*/judge_*/evidence_excerpt) is declared
// here too — see docs/archive/remediation/2026-08-09-schema-reality-check.md and
// schema-truth.json for the full physical shape this mirrors exactly.
export const citationTable = mnemoSchema.table("mnemo_citation", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  memoryKind: text("memory_kind").notNull(),
  memoryId: text("memory_id").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceId: text("source_id"),
  extractorModel: text("extractor_model"),
  extractorPromptVersion: text("extractor_prompt_version"),
  judgeModel: text("judge_model"),
  judgeRelationId: text("judge_relation_id"),
  evidenceExcerpt: text("evidence_excerpt"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type SelectRelation = typeof relationTable.$inferSelect;
export type InsertRelation = typeof relationTable.$inferInsert;
export type SelectHyperedge = typeof hyperedgeTable.$inferSelect;
export type InsertHyperedge = typeof hyperedgeTable.$inferInsert;
export type SelectCitation = typeof citationTable.$inferSelect;
export type InsertCitation = typeof citationTable.$inferInsert;
