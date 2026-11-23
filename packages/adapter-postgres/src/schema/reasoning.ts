import { mnemoSchema } from "./mnemo_schema.js";
import { text, integer, real, numeric, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { halfvec } from "./_custom-types.js";
import { userTable } from "./tenants.js";

export const reasoningTable = mnemoSchema.table("mnemo_reasoning", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentId: text("agent_id"),
  // actorId did not exist before migration 0023_provenance_identity.sql.
  actorId: text("actor_id"),
  userId: text("user_id").references(() => userTable.id, { onDelete: "set null" }),
  actorType: text("actor_type"),
  // "workspace:<id>" | "user:<id>" | "tenant:<id>" — who owns this reasoning.
  scopeOwner: text("scope_owner"),
  question: text("question").notNull(),
  chain: jsonb("chain").notNull().default([]),
  conclusion: text("conclusion").notNull(),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  // C7: Beta-Bernoulli posterior (migration 0060) replaces the raw ratio.
  worth: real("worth").generatedAlwaysAs(sql`worth_alpha / NULLIF(worth_alpha + worth_beta, 0)`),
  // §25.2 Beta-evidence pair (reasoning class, H=90d). Seeded from the
  // success/failure counters in migration 0053 and relaxed toward the (1,1)
  // prior by StorageAdapter.decayKind; kept live alongside the legacy counters
  // by StorageAdapter.updateWorth.
  worthAlpha: numeric("worth_alpha", { precision: 8, scale: 4 }).notNull().default("1.0"),
  worthBeta: numeric("worth_beta", { precision: 8, scale: 4 }).notNull().default("1.0"),
  topicKey: text("topic_key"),
  embedding: halfvec("embedding"),
  embeddingModel: text("embedding_model"),
  embeddingStale: boolean("embedding_stale").notNull().default(false),
  status: text("status").notNull().default("active"),
  sensitivity: text("sensitivity").notNull().default("internal"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  usageCount: integer("usage_count").notNull().default(0),
  // P64 — bitemporal validity interval (mirrors strategy/decision/fact/skill pattern).
  validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
});

export type SelectReasoning = typeof reasoningTable.$inferSelect;
export type InsertReasoning = typeof reasoningTable.$inferInsert;
