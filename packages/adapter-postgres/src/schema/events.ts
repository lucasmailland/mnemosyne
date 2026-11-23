import { mnemoSchema } from "./mnemo_schema.js";
import { text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { userTable } from "./tenants.js";

export const eventTable = mnemoSchema.table("mnemo_event", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentId: text("agent_id"),
  // actorId did not exist before migration 0023_provenance_identity.sql.
  actorId: text("actor_id"),
  userId: text("user_id").references(() => userTable.id, { onDelete: "set null" }),
  actorType: text("actor_type"),
  // "workspace:<id>" | "user:<id>" | "tenant:<id>" — who owns this event.
  scopeOwner: text("scope_owner"),
  type: text("type").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
  durationS: integer("duration_s"),
  source: text("source").notNull(),
  relatedEntities: text("related_entities")
    .array()
    .notNull()
    .default(sql`'{}'`),
  annotations: jsonb("annotations").notNull().default([]),
  sensitivity: text("sensitivity").notNull().default("internal"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
});

export type SelectEvent = typeof eventTable.$inferSelect;
export type InsertEvent = typeof eventTable.$inferInsert;
