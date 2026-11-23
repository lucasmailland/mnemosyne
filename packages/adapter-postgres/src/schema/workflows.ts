import { mnemoSchema } from "./mnemo_schema.js";
import { text, integer, real, numeric, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { halfvec, tsvector } from "./_custom-types.js";
import { sql } from "drizzle-orm";
import { userTable } from "./tenants.js";

export const workflowTable = mnemoSchema.table("mnemo_workflow", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  actorId: text("actor_id"),
  agentId: text("agent_id"),
  userId: text("user_id").references(() => userTable.id, { onDelete: "set null" }),
  actorType: text("actor_type"),
  // "workspace:<id>" | "user:<id>" | "tenant:<id>" — who owns this workflow.
  scopeOwner: text("scope_owner"),
  // Project/entity scope reference — mirrors mnemo_fact.scope_ref (nullable, no FK).
  scopeRef: text("scope_ref"),
  name: text("name").notNull(),
  description: text("description"),
  steps: jsonb("steps").notNull().default([]),
  avgDurationMs: integer("avg_duration_ms").notNull().default(0),
  successRate: real("success_rate").notNull().default(0.0),
  // §25.2 Beta-evidence pair (procedural class, H=173d). Seeded from success_rate
  // (pseudo-count 10) in migration 0053 and relaxed toward the (1,1) prior by
  // StorageAdapter.decayKind; kept live alongside success_rate by updateWorth.
  worthAlpha: numeric("worth_alpha", { precision: 8, scale: 4 }).notNull().default("1.0"),
  worthBeta: numeric("worth_beta", { precision: 8, scale: 4 }).notNull().default("1.0"),
  // C7: Beta-Bernoulli posterior added in migration 0060.
  worth: real("worth").generatedAlwaysAs(sql`worth_alpha / NULLIF(worth_alpha + worth_beta, 0)`),
  executionCount: integer("execution_count").notNull().default(0),
  lastExecutedAt: timestamp("last_executed_at", { withTimezone: true, mode: "date" }),
  version: integer("version").notNull().default(1),
  previousVersionId: text("previous_version_id"),
  status: text("status").notNull().default("active"),
  sensitivity: text("sensitivity").notNull().default("internal"),
  // P65 / migration 0033 — workflows had NO vector columns at all: persisted
  // and structurally impossible to recall.
  embedding: halfvec("embedding"),
  embeddingModel: text("embedding_model"),
  embeddingStale: boolean("embedding_stale").notNull().default(true),
  textLemmatized: tsvector("text_lemmatized"),
  // P131 B3 — Spanish-stemmed twin (migration 0036). Queried ORed with the
  // English column above; see repositories/_fts-config.ts for why both exist.
  textLemmatizedEs: tsvector("text_lemmatized_es"),
  // P18 — bitemporal validity interval (mirrors strategy/decision/fact pattern).
  validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
});

export type SelectWorkflow = typeof workflowTable.$inferSelect;
export type InsertWorkflow = typeof workflowTable.$inferInsert;
