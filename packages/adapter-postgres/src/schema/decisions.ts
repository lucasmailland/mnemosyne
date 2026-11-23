import { mnemoSchema } from "./mnemo_schema.js";
import { index, text, real, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { halfvec, tsvector } from "./_custom-types.js";
import { userTable } from "./tenants.js";

export const decisionTable = mnemoSchema.table(
  "mnemo_decision",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    agentId: text("agent_id"),
    actorId: text("actor_id"),
    userId: text("user_id").references(() => userTable.id, { onDelete: "set null" }),
    actorType: text("actor_type"),
    conversationId: text("conversation_id"),
    // "workspace:<id>" | "user:<id>" | "tenant:<id>" — who owns this decision.
    scopeOwner: text("scope_owner"),
    // Project/entity scope reference — mirrors mnemo_fact.scope_ref (nullable, no FK).
    scopeRef: text("scope_ref"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    topicKey: text("topic_key"),
    // Slice 1 pt.2 (flatten-legacy-dual-core, design.md D1): physical is
    // `integer`, matching mnemo_fact.revisionCount's own (already-correct)
    // declaration in facts.ts — same semantic counter, incremented by 1 on
    // every self-edit. `real` here was a copy-paste type error, never
    // fractional at any call site (FactRepository/DecisionRepository/
    // primitives/decision.ts all do plain `+ 1` integer arithmetic).
    revisionCount: integer("revision_count").notNull().default(1),
    normalizedHash: text("normalized_hash").notNull(),
    status: text("status").notNull().default("active"),
    supersededById: text("superseded_by_id"),
    decidedByUserId: text("decided_by_user_id"),
    confidence: real("confidence"),
    sensitivity: text("sensitivity").notNull().default("internal"),
    embedding: halfvec("embedding"),
    embeddingModel: text("embedding_model"),
    embeddingStale: boolean("embedding_stale").notNull().default(false),
    textLemmatized: tsvector("text_lemmatized"),
    // P131 B3 — Spanish-stemmed twin (migration 0036). Queried ORed with the
    // English column above; see repositories/_fts-config.ts for why both exist.
    textLemmatizedEs: tsvector("text_lemmatized_es"),
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    index("idx_decision_active").on(t.workspaceId, t.status, t.updatedAt),
    index("idx_decision_topic").on(t.workspaceId, t.topicKey),
    index("idx_decision_hash").on(t.workspaceId, t.normalizedHash),
  ]
);

export type SelectDecision = typeof decisionTable.$inferSelect;
export type InsertDecision = typeof decisionTable.$inferInsert;
