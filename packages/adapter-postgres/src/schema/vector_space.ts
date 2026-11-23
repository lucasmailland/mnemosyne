import { text, integer, boolean, timestamp, uuid, primaryKey } from "drizzle-orm/pg-core";
import { mnemoSchema } from "./mnemo_schema.js";
import { workspaceTable } from "./tenants.js";
import { factTable } from "./facts.js";
import { vectorCustomType } from "./_custom-types.js";

export const mnemoVectorSpace = mnemoSchema.table("mnemo_vector_space", {
  // Slice 1 pt.2 (flatten-legacy-dual-core, design.md D1): physical is uuid,
  // not text. `crypto.randomUUID()` already produces a valid uuid literal, so
  // this is a pure SQL-type fix — zero call-site ripple (JS type stays string).
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  workspaceId: text("workspace_id").notNull(),
  spaceKey: text("space_key").notNull(),
  provider: text("provider").notNull(),
  modelName: text("model_name").notNull(),
  modelRevision: text("model_revision").default("v1"),
  dimensions: integer("dimensions").notNull(),
  distanceMetric: text("distance_metric").notNull().default("cosine"),
  isActive: boolean("is_active").notNull().default(true),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const mnemoFactEmbeddings1024 = mnemoSchema.table(
  "mnemo_fact_embeddings_1024",
  {
    factId: text("fact_id")
      .notNull()
      .references(() => factTable.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => mnemoVectorSpace.id, { onDelete: "cascade" }),
    embedding: vectorCustomType(1024).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.spaceId, t.factId] }),
  })
);

export const mnemoFactEmbeddings1536 = mnemoSchema.table(
  "mnemo_fact_embeddings_1536",
  {
    factId: text("fact_id")
      .notNull()
      .references(() => factTable.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => mnemoVectorSpace.id, { onDelete: "cascade" }),
    embedding: vectorCustomType(1536).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.spaceId, t.factId] }),
  })
);

export const mnemoFactEmbeddings2048 = mnemoSchema.table(
  "mnemo_fact_embeddings_2048",
  {
    factId: text("fact_id")
      .notNull()
      .references(() => factTable.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => mnemoVectorSpace.id, { onDelete: "cascade" }),
    embedding: vectorCustomType(2048).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.spaceId, t.factId] }),
  })
);

export const mnemoFactEmbeddings4096 = mnemoSchema.table(
  "mnemo_fact_embeddings_4096",
  {
    factId: text("fact_id")
      .notNull()
      .references(() => factTable.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => mnemoVectorSpace.id, { onDelete: "cascade" }),
    embedding: vectorCustomType(4096).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.spaceId, t.factId] }),
  })
);
