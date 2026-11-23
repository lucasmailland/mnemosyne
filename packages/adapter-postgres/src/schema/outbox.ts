import { mnemoSchema } from "./mnemo_schema.js";
import { text, integer, timestamp, jsonb, uuid, index } from "drizzle-orm/pg-core";

/**
 * mnemo_outbox — NO RLS; outbox worker needs cross-workspace access.
 */
export const outboxTable = mnemoSchema.table(
  "mnemo_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("idx_outbox_pending").on(t.createdAt),
    index("idx_outbox_workspace").on(t.workspaceId, t.createdAt),
  ]
);

/**
 * mnemo_deletion_log — NO RLS; resurrection guard must work cross-workspace.
 * INSERT-only for app role (enforced via REVOKE in SQL migration).
 */
export const deletionLogTable = mnemoSchema.table("mnemo_deletion_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  deletedItemId: uuid("deleted_item_id").notNull(),
  deletedItemType: text("deleted_item_type").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  deletionType: text("deletion_type").notNull(),
  actorId: text("actor_id").notNull(),
  reason: text("reason"),
  /** 0068 — when the deleted fact was created; federation tombstones need it. */
  itemCreatedAt: timestamp("item_created_at", { withTimezone: true, mode: "date" }),
});

export type SelectOutbox = typeof outboxTable.$inferSelect;
export type InsertOutbox = typeof outboxTable.$inferInsert;
export type SelectDeletionLog = typeof deletionLogTable.$inferSelect;
export type InsertDeletionLog = typeof deletionLogTable.$inferInsert;
