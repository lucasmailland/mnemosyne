import { mnemoSchema } from "./mnemo_schema.js";
import { text, integer, real, numeric, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { halfvec } from "./_custom-types.js";
import { userTable } from "./tenants.js";

export const skillTable = mnemoSchema.table("mnemo_skill", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  actorId: text("actor_id"),
  agentId: text("agent_id"),
  userId: text("user_id").references(() => userTable.id, { onDelete: "set null" }),
  actorType: text("actor_type"),
  // "workspace:<id>" | "user:<id>" | "tenant:<id>" — who owns this skill.
  scopeOwner: text("scope_owner"),
  name: text("name").notNull(),
  promptTemplate: text("prompt_template").notNull(),
  variables: text("variables")
    .array()
    .notNull()
    .default(sql`'{}'`),
  requiredContext: text("required_context")
    .array()
    .notNull()
    .default(sql`'{}'`),
  qualityScore: real("quality_score").notNull().default(0.5),
  // §25.2 Beta-evidence pair (procedural class, H=173d). Seeded from quality_score
  // (pseudo-count 10) in migration 0053 and relaxed toward the (1,1) prior by
  // StorageAdapter.decayKind; kept live alongside quality_score by updateWorth.
  worthAlpha: numeric("worth_alpha", { precision: 8, scale: 4 }).notNull().default("1.0"),
  worthBeta: numeric("worth_beta", { precision: 8, scale: 4 }).notNull().default("1.0"),
  // C7: Beta-Bernoulli posterior added in migration 0060.
  worth: real("worth").generatedAlwaysAs(sql`worth_alpha / NULLIF(worth_alpha + worth_beta, 0)`),
  usageCount: integer("usage_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  sensitivity: text("sensitivity").notNull().default("internal"),
  embedding: halfvec("embedding"),
  embeddingModel: text("embedding_model"),
  embeddingStale: boolean("embedding_stale").notNull().default(false),
  // P18 — bitemporal validity interval (mirrors strategy/decision/fact pattern).
  validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
});

export type SelectSkill = typeof skillTable.$inferSelect;
export type InsertSkill = typeof skillTable.$inferInsert;
