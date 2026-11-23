import { mnemoSchema } from "./mnemo_schema.js";
import {
  text,
  numeric,
  real,
  doublePrecision,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  smallint,
  bigint,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { halfvec, tsvector } from "./_custom-types.js";
import { entityTable } from "./entities.js";
import { episodeTable } from "./episodes.js";
import { userTable } from "./tenants.js";

export const factTable = mnemoSchema.table(
  "mnemo_fact",
  {
    // Identity
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    agentId: text("agent_id"),
    actorId: text("actor_id"),
    // Provenance: the platform account (mnemo_user.id) behind this write, when one exists.
    userId: text("user_id").references(() => userTable.id, { onDelete: "set null" }),
    actorType: text("actor_type"),
    scope: text("scope").notNull(),
    scopeRef: text("scope_ref"),
    // "workspace:<id>" | "user:<id>" | "tenant:<id>" — who owns this fact.
    scopeOwner: text("scope_owner"),

    // Content
    statement: text("statement").notNull(),
    subject: text("subject").notNull(),
    kind: text("kind").notNull(),

    // Confidence & retrieval
    // Slice 1 (flatten-legacy-dual-core D1): physical mnemosyne.mnemo_fact.confidence
    // is `real`, not `numeric` — confirmed by schema-drift.integration.test.ts's
    // in-test regenerated catalog scan, never hand-guessed. The model previously
    // declared `numeric(6,4)`, which would have made postgres.js/Drizzle's numeric
    // driver-value mapping (expects a string, to avoid float precision loss) receive
    // a native JS number instead — a latent type-correctness bug this reconciliation
    // closes without any migration (the column's stored bytes don't change).
    confidence: real("confidence").notNull().default(0.7),
    relevance: real("relevance").notNull().default(1.0),
    hitCount: integer("hit_count").notNull().default(0),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true, mode: "date" }),

    // Memory Worth (Beta-Bernoulli + TD(λ))
    worthSuccess: numeric("worth_success", { precision: 10, scale: 4 }).notNull().default("0"),
    worthFailure: numeric("worth_failure", { precision: 10, scale: 4 }).notNull().default("0"),
    worthAlpha: numeric("worth_alpha", { precision: 8, scale: 4 }).notNull().default("2.0"),
    worthBeta: numeric("worth_beta", { precision: 8, scale: 4 }).notNull().default("2.0"),
    // Beta-Bernoulli posterior mean α / (α + β). α and β start at the Beta(2,2)
    // prior (2.0 each) and are bumped by StorageAdapter.updateWorth() on every
    // success/failure. When (α+β)=0 (impossible by default), worth is NULL.
    worth: numeric("worth", { precision: 6, scale: 4 }).generatedAlwaysAs(
      sql`worth_alpha / NULLIF(worth_alpha + worth_beta, 0)`
    ),

    // Cognitive memory model
    memoryType: text("memory_type").notNull().default("semantic"),
    // Slice 1 (flatten-legacy-dual-core D1): physical mnemosyne.mnemo_fact
    // memory_strength/memory_stability are `double precision`, not `real` —
    // confirmed by schema-drift.integration.test.ts's in-test catalog scan.
    memoryStrength: doublePrecision("memory_strength").notNull().default(1.0),
    memoryStability: doublePrecision("memory_stability").notNull().default(1.0),
    lastStrengthUpdate: timestamp("last_strength_update", { withTimezone: true, mode: "date" }),

    // Attribution
    attribution: text("attribution").notNull().default("inferred"),
    attributedTo: text("attributed_to"),
    sourceMessageIds: text("source_message_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),

    // Provenance & versioning
    sessionId: text("session_id"),
    extractionSource: text("extraction_source"),
    topicKey: text("topic_key"),
    revisionCount: integer("revision_count").notNull().default(1),
    protocolVersion: text("protocol_version").notNull().default("v3.0"),

    // Foreign keys
    entityId: text("entity_id").references(() => entityTable.id, { onDelete: "set null" }),
    episodeId: text("episode_id").references(() => episodeTable.id, { onDelete: "set null" }),

    // Lifecycle
    status: text("status").notNull().default("active"),
    pinned: boolean("pinned").notNull().default(false),
    /** §11 governance: worth>0.8 ∧ confLower>0.7 → exempt from consolidation merging. */
    canonical: boolean("canonical").notNull().default(false),
    sensitivity: text("sensitivity").notNull().default("internal"),
    mergedIntoId: text("merged_into_id"),

    // Validity window
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),

    // Embedding
    embedding: halfvec("embedding"),
    embeddingModel: text("embedding_model"),
    embeddingStale: boolean("embedding_stale").notNull().default(false),
    // DB-2: real columns on this table (baseline migration), populated by the
    // legacy packages/core write path (db/schema/fact.ts, factory.ts) directly
    // against this same table — never written by the v3 CreateFactInput port,
    // but genuinely present on rows that path touches. Declared here (read-only
    // from this adapter's perspective) so archiveFact() can select and copy the
    // real value instead of silently dropping it.
    embeddingVersion: text("embedding_version"),
    linkedMemoryIds: text("linked_memory_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),

    // Full-text search
    textLemmatized: tsvector("text_lemmatized"),
    // P131 B3 — Spanish-stemmed twin (migration 0036). Queried ORed with the
    // English column above; see repositories/_fts-config.ts for why both exist.
    textLemmatizedEs: tsvector("text_lemmatized_es"),

    // Audit
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    index("idx_fact_active").on(t.workspaceId, t.updatedAt),
    index("idx_fact_worth_high").on(t.workspaceId, t.worth),
    uniqueIndex("idx_fact_topic_active_unique")
      .on(t.workspaceId, t.topicKey)
      .where(sql`${t.topicKey} IS NOT NULL AND ${t.status} = 'active'`),
    index("idx_fact_session").on(t.sessionId),
    // Slice 1 (flatten-legacy-dual-core, design.md D1): these two CHECK
    // constraints already exist physically on mnemosyne.mnemo_fact — defined
    // by this package's own 0001_v3_complete_baseline.sql, confirmed via
    // schema-truth.json (Slice 0) and re-verified structurally by
    // schema-drift.integration.test.ts, which adds each constraint's
    // rendered predicate to a rolled-back transaction against the real
    // migrated table and compares Postgres's own pg_get_constraintdef()
    // deparse of both sides — never hand-compared from memory. Declaring
    // them here closes the model↔physical gap: previously the Drizzle model
    // was silently unaware the database already enforces `kind`/`scope`, so
    // a migration that accidentally dropped either CHECK would have gone
    // undetected by getTableConfig(). `kind` matches `@mnemo-ai/types`'
    // documented `Fact.kind` (13 values since migration 0048, verify Q-3).
    // `scope` matches `@mnemo-ai/types`'
    // `Fact.scope` (2 values) as of migration 0028 (Slice 1 pt.2, tasks.md
    // 2.9), which narrowed the physical CHECK from its original 4 values —
    // 'employee'/'team' were dead, unreferenced anywhere in application code.
    check(
      "mnemo_fact_kind_check",
      sql`kind = ANY (ARRAY['preference', 'trait', 'event', 'relationship', 'skill', 'concern', 'architecture', 'bugfix', 'config', 'discovery', 'policy', 'process', 'other']::text[])`
    ),
    check("mnemo_fact_scope_check", sql`scope = ANY (ARRAY['global', 'conversation']::text[])`),
  ]
);

export const factArchiveTable = mnemoSchema.table("mnemo_fact_archive", {
  // All columns from mnemo_fact (LIKE mnemo_fact INCLUDING ALL)
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  agentId: text("agent_id"),
  actorId: text("actor_id"),
  // Plain columns, no FK — see migration 0023_provenance_identity.sql: the
  // archive must remain findable by user_id for GDPR erasure even after a
  // user row is gone, so it can't reference mnemo_user.
  userId: text("user_id"),
  actorType: text("actor_type"),
  scope: text("scope").notNull(),
  scopeRef: text("scope_ref"),
  scopeOwner: text("scope_owner"),
  statement: text("statement").notNull(),
  subject: text("subject").notNull(),
  kind: text("kind").notNull(),
  // Slice 1 (flatten-legacy-dual-core D1): physical mnemosyne.mnemo_fact_archive
  // confidence/relevance are `numeric` with NO column default (the archive row
  // always copies an explicit value from the live fact, see
  // FactRepository.archiveFact()) — asymmetric with mnemo_fact itself (`real`,
  // WITH a default), confirmed by schema-drift.integration.test.ts's in-test
  // catalog scan, not assumed from mnemo_fact's shape.
  confidence: numeric("confidence").notNull(),
  relevance: numeric("relevance").notNull(),
  hitCount: integer("hit_count").notNull().default(0),
  lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true, mode: "date" }),
  worthSuccess: numeric("worth_success", { precision: 10, scale: 4 }).notNull().default("0"),
  worthFailure: numeric("worth_failure", { precision: 10, scale: 4 }).notNull().default("0"),
  worthAlpha: numeric("worth_alpha", { precision: 8, scale: 4 }).notNull().default("2.0"),
  worthBeta: numeric("worth_beta", { precision: 8, scale: 4 }).notNull().default("2.0"),
  // Beta-Bernoulli posterior mean α / (α + β). α and β start at the Beta(2,2)
  // prior (2.0 each) and are bumped by StorageAdapter.updateWorth() on every
  // success/failure. When (α+β)=0 (impossible by default), worth is NULL.
  worth: numeric("worth", { precision: 6, scale: 4 }).generatedAlwaysAs(
    sql`worth_alpha / NULLIF(worth_alpha + worth_beta, 0)`
  ),
  memoryType: text("memory_type").notNull().default("semantic"),
  // Slice 1 (flatten-legacy-dual-core D1): matches mnemo_fact's own
  // real->doublePrecision reconciliation above (same physical drift).
  memoryStrength: doublePrecision("memory_strength").notNull().default(1.0),
  memoryStability: doublePrecision("memory_stability").notNull().default(1.0),
  lastStrengthUpdate: timestamp("last_strength_update", { withTimezone: true, mode: "date" }),
  attribution: text("attribution").notNull().default("inferred"),
  attributedTo: text("attributed_to"),
  sourceMessageIds: text("source_message_ids")
    .array()
    .notNull()
    .default(sql`'{}'`),
  sessionId: text("session_id"),
  extractionSource: text("extraction_source"),
  topicKey: text("topic_key"),
  revisionCount: integer("revision_count").notNull().default(1),
  protocolVersion: text("protocol_version").notNull().default("v3.0"),
  entityId: text("entity_id"),
  episodeId: text("episode_id"),
  status: text("status").notNull().default("active"),
  pinned: boolean("pinned").notNull().default(false),
  sensitivity: text("sensitivity").notNull().default("internal"),
  mergedIntoId: text("merged_into_id"),
  validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true, mode: "date" }),
  embedding: halfvec("embedding"),
  embeddingModel: text("embedding_model"),
  embeddingStale: boolean("embedding_stale").notNull().default(false),
  // DB-2: mirrors mnemo_fact.embedding_version / linked_memory_ids (migration 0013).
  embeddingVersion: text("embedding_version"),
  linkedMemoryIds: text("linked_memory_ids")
    .array()
    .notNull()
    .default(sql`'{}'`),
  textLemmatized: tsvector("text_lemmatized"),
  // P131 B3 — Spanish-stemmed twin (migration 0036). Queried ORed with the
  // English column above; see repositories/_fts-config.ts for why both exist.
  textLemmatizedEs: tsvector("text_lemmatized_es"),
  // Slice 1 (flatten-legacy-dual-core D1): physical mnemosyne.mnemo_fact_archive
  // created_at/updated_at have NO column default — archiveFact() always copies
  // the live row's exact createdAt and sets updatedAt = archive time explicitly.
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  // Extra columns added by archive
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  archiveReason: text("archive_reason").notNull(),
});

export type SelectFact = typeof factTable.$inferSelect;
export type InsertFact = typeof factTable.$inferInsert;
export type SelectFactArchive = typeof factArchiveTable.$inferSelect;
export type InsertFactArchive = typeof factArchiveTable.$inferInsert;

// ── Wave P Tier 2: LSH band signatures ───────────────────────────────────────

export const factLshTable = mnemoSchema.table(
  "mnemo_fact_lsh",
  {
    workspaceId: text("workspace_id").notNull(),
    factId: text("fact_id").notNull(),
    bandIdx: smallint("band_idx").notNull(),
    bandHash: bigint("band_hash", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.factId, t.bandIdx] }),
    index("idx_fact_lsh_lookup").on(t.workspaceId, t.bandIdx, t.bandHash),
  ]
);

export type SelectFactLsh = typeof factLshTable.$inferSelect;
export type InsertFactLsh = typeof factLshTable.$inferInsert;
