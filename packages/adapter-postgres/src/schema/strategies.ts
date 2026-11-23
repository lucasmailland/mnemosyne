import { mnemoSchema } from "./mnemo_schema.js";
import { text, integer, real, numeric, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { halfvec, tsvector } from "./_custom-types.js";
import { userTable } from "./tenants.js";

export const strategyTable = mnemoSchema.table("mnemo_strategy", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentId: text("agent_id"),
  actorId: text("actor_id"),
  userId: text("user_id").references(() => userTable.id, { onDelete: "set null" }),
  actorType: text("actor_type"),
  // "workspace:<id>" | "user:<id>" | "tenant:<id>" — who owns this strategy.
  scopeOwner: text("scope_owner"),
  // Project/entity scope reference — mirrors mnemo_fact.scope_ref (nullable, no FK).
  scopeRef: text("scope_ref"),
  trigger: text("trigger").notNull(),
  action: text("action").notNull(),
  context: text("context"),
  relatedFacts: text("related_facts")
    .array()
    .notNull()
    .default(sql`'{}'`),
  attribution: text("attribution").notNull().default("inferred"),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  // C7: Beta-Bernoulli posterior (migration 0060) replaces the raw ratio.
  worth: real("worth").generatedAlwaysAs(sql`worth_alpha / NULLIF(worth_alpha + worth_beta, 0)`),
  // §25.2 Beta-evidence pair (procedural class, H=173d). Seeded from the
  // success/failure counters in migration 0053 and relaxed toward the (1,1)
  // prior by StorageAdapter.decayKind; kept live alongside the legacy counters
  // by StorageAdapter.updateWorth.
  worthAlpha: numeric("worth_alpha", { precision: 8, scale: 4 }).notNull().default("1.0"),
  worthBeta: numeric("worth_beta", { precision: 8, scale: 4 }).notNull().default("1.0"),
  supersedesId: text("supersedes_id"),
  status: text("status").notNull().default("active"),
  sensitivity: text("sensitivity").notNull().default("internal"),
  embedding: halfvec("embedding"),
  embeddingModel: text("embedding_model"),
  embeddingStale: boolean("embedding_stale").notNull().default(false),
  // P65 / migration 0033 — lexical arm of the non-fact recall path.
  textLemmatized: tsvector("text_lemmatized"),
  // P131 B3 — Spanish-stemmed twin (migration 0036). Queried ORed with the
  // English column above; see repositories/_fts-config.ts for why both exist.
  textLemmatizedEs: tsvector("text_lemmatized_es"),
  validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
});

export type SelectStrategy = typeof strategyTable.$inferSelect;
export type InsertStrategy = typeof strategyTable.$inferInsert;
