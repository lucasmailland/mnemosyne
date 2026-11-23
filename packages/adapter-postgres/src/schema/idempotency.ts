import { mnemoSchema } from "./mnemo_schema.js";
import { text, timestamp, integer, primaryKey } from "drizzle-orm/pg-core";

export const idempotencyKeysTable = mnemoSchema.table(
  "mnemo_idempotency_keys",
  {
    workspaceId: text("workspace_id").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    recoveryPoint: text("recovery_point").notNull().default("started"),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    responseCode: integer("response_code"),
    responseBody: text("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.workspaceId, t.key] }) })
);

export type SelectIdempotencyKey = typeof idempotencyKeysTable.$inferSelect;
export type InsertIdempotencyKey = typeof idempotencyKeysTable.$inferInsert;
