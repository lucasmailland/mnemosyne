import { mnemoSchema } from "./mnemo_schema.js";
import { text, timestamp, jsonb, uuid, primaryKey } from "drizzle-orm/pg-core";

/**
 * mnemo_agent_profile — per-agent self-model (Wave M2, spec §13).
 * One row per (workspace_id, agent_id).
 * Populated and rewritten by the reflection cycle.
 */
export const agentProfileTable = mnemoSchema.table(
  "mnemo_agent_profile",
  {
    // Slice 1 pt.2 (flatten-legacy-dual-core, design.md D1): physical is uuid,
    // not text — same JS string type either way, zero call-site ripple.
    workspaceId: uuid("workspace_id").notNull(),
    agentId: text("agent_id").notNull(),
    summary: text("summary").notNull().default(""),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.agentId], name: "mnemo_agent_profile_pkey" })]
);

export type SelectAgentProfile = typeof agentProfileTable.$inferSelect;
export type InsertAgentProfile = typeof agentProfileTable.$inferInsert;
