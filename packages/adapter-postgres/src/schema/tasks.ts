import { mnemoSchema } from "./mnemo_schema.js";
import { text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { userTable } from "./tenants.js";

export const taskTable = mnemoSchema.table("mnemo_task", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  actorId: text("actor_id"),
  agentId: text("agent_id"),
  userId: text("user_id").references(() => userTable.id, { onDelete: "set null" }),
  actorType: text("actor_type"),
  // "workspace:<id>" | "user:<id>" | "tenant:<id>" — who owns this task.
  scopeOwner: text("scope_owner"),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("pending"),
  priority: text("priority").notNull().default("medium"),
  assignedTo: text("assigned_to").notNull(),
  delegatedBy: text("delegated_by"),
  delegatedAt: timestamp("delegated_at", { withTimezone: true, mode: "date" }),
  blockedBy: text("blocked_by")
    .array()
    .notNull()
    .default(sql`'{}'`),
  subtaskIds: text("subtask_ids")
    .array()
    .notNull()
    .default(sql`'{}'`),
  parentTaskId: text("parent_task_id"),
  relatedFacts: text("related_facts")
    .array()
    .notNull()
    .default(sql`'{}'`),
  relatedEntities: text("related_entities")
    .array()
    .notNull()
    .default(sql`'{}'`),
  sessionId: text("session_id"),
  outcome: text("outcome"),
  lessonsLearned: text("lessons_learned"),
  sensitivity: text("sensitivity").notNull().default("internal"),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }),
  // P18 — bitemporal validity interval (mirrors strategy/decision/fact pattern).
  validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
});

export type SelectTask = typeof taskTable.$inferSelect;
export type InsertTask = typeof taskTable.$inferInsert;
