import { mnemoSchema } from "./mnemo_schema.js";
import { index, uniqueIndex, text, boolean, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { halfvec } from "./_custom-types.js";
import { userTable } from "./tenants.js";

export const entityTable = mnemoSchema.table(
  "mnemo_entity",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    actorId: text("actor_id"),
    agentId: text("agent_id"),
    // Provenance: who WROTE this row, when a platform account exists.
    userId: text("user_id").references(() => userTable.id, { onDelete: "set null" }),
    actorType: text("actor_type"),
    // Subject: who this row is ABOUT (deliberately distinct from userId above).
    // Only ever set via POST /entities/:id/link-user — never on create/update.
    linkedUserId: text("linked_user_id").references(() => userTable.id, { onDelete: "set null" }),
    // "workspace:<id>" | "user:<id>" | "tenant:<id>" — who owns this entity.
    scopeOwner: text("scope_owner"),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'`),
    canonicalId: text("canonical_id"),
    description: text("description"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    mentionCount: integer("mention_count").notNull().default(1),
    sensitivity: text("sensitivity").notNull().default("internal"),
    // P16 — entity embedding triple (mirrors mnemo_episode). Populated by the
    // OutboxWorker from the createEntity / updateEntity vector_upsert outbox entry.
    embedding: halfvec("embedding"),
    embeddingModel: text("embedding_model"),
    embeddingStale: boolean("embedding_stale").notNull().default(false),
    // P18 — bitemporal validity interval (mirrors strategy/decision/fact pattern).
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    index("idx_entity_workspace").on(t.workspaceId, t.kind, t.lastSeenAt),
    index("idx_entity_canonical").on(t.workspaceId, t.canonicalId),
    // 0045 / PRIM-2: unique among LIVE rows only (a closed entity frees its name).
    uniqueIndex("uq_mnemo_entity_live_name_kind")
      .on(t.workspaceId, t.name, t.kind)
      .where(sql`${t.validTo} IS NULL`),
  ]
);

export type SelectEntity = typeof entityTable.$inferSelect;
export type InsertEntity = typeof entityTable.$inferInsert;
