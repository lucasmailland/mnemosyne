import { mnemoSchema } from "./mnemo_schema.js";
import { text, integer, boolean, timestamp, jsonb, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { halfvec } from "./_custom-types.js";
import { userTable } from "./tenants.js";

export const episodeTable = mnemoSchema.table("mnemo_episode", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentId: text("agent_id"),
  actorId: text("actor_id"),
  userId: text("user_id").references(() => userTable.id, { onDelete: "set null" }),
  actorType: text("actor_type"),
  // "workspace:<id>" | "user:<id>" | "tenant:<id>" — who owns this episode.
  scopeOwner: text("scope_owner"),
  title: text("title").notNull(),
  narrative: text("narrative").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
  durationMinutes: integer("duration_minutes"),
  participants: text("participants")
    .array()
    .notNull()
    .default(sql`'{}'`),
  topics: text("topics")
    .array()
    .notNull()
    .default(sql`'{}'`),
  linkedFactIds: text("linked_fact_ids")
    .array()
    .notNull()
    .default(sql`'{}'`),
  parentEpisodeId: text("parent_episode_id").references((): AnyPgColumn => episodeTable.id),
  deltaContent: text("delta_content"),
  isRoot: boolean("is_root").notNull().default(false),
  depth: integer("depth").notNull().default(0),
  isSynthetic: boolean("is_synthetic").notNull().default(false),
  sourceConversationId: text("source_conversation_id"),
  sensitivity: text("sensitivity").notNull().default("internal"),
  // DELTAMEM §16 — embedding triple (mirrors mnemo_fact). Populated by the
  // OutboxWorker from the createEpisode vector_upsert outbox entry.
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

export type SelectEpisode = typeof episodeTable.$inferSelect;
export type InsertEpisode = typeof episodeTable.$inferInsert;
