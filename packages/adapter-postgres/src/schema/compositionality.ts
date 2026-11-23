import { mnemoSchema } from "./mnemo_schema.js";
import { text, integer, timestamp, numeric, primaryKey } from "drizzle-orm/pg-core";

export const inferenceLogTable = mnemoSchema.table("mnemo_inference_log", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  ruleId: text("rule_id").notNull(),
  inputFactIds: text("input_fact_ids").array().notNull(),
  derivedKind: text("derived_kind"),
  derivedId: text("derived_id"),
  confidence: numeric("confidence", { precision: 6, scale: 4 }).notNull(),
  rationale: text("rationale"),
  triggeredByQuery: text("triggered_by_query"),
  conversationId: text("conversation_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const factHashTable = mnemoSchema.table(
  "mnemo_fact_hash",
  {
    workspaceId: text("workspace_id").notNull(),
    statementHash: text("statement_hash").notNull(),
    factId: text("fact_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    seenCount: integer("seen_count").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.statementHash], name: "mnemo_fact_hash_pkey" })]
);

export type SelectInferenceLog = typeof inferenceLogTable.$inferSelect;
export type InsertInferenceLog = typeof inferenceLogTable.$inferInsert;
export type SelectFactHash = typeof factHashTable.$inferSelect;
export type InsertFactHash = typeof factHashTable.$inferInsert;
