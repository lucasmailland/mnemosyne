/**
 * Slice 1 (flatten-legacy-dual-core, docs/archive/openspec/flatten-legacy-dual-core/design.md
 * decision D1) — model <-> physical catalog diff guard.
 *
 * Regenerates the physical truth IN-TEST via `introspectSchema()` against a
 * fresh testcontainer with every committed adapter-postgres migration
 * applied. This NEVER reads the committed `schema-truth.json` as authority
 * (see design.md D1 and docs/archive/remediation/2026-08-09-schema-reality-check.md's
 * "Handoff to Slice 1" — that file is a point-in-time reference for humans,
 * not the diff's source of truth). It diffs that regeneration against a
 * projection of the v3 Drizzle models via `getTableConfig()` from
 * `drizzle-orm/pg-core`.
 *
 * Scope (Slice 1 pt.2, tasks.md 2.10): forward-only, model -> physical,
 * scanning EVERY table `schema/index.ts` exports (widened from PR2's
 * facts.ts-only scope — see `getModelTables()` below, which now introspects
 * `schema` itself via `getTableConfig()` rather than hand-listing tables).
 * Every column and CHECK constraint DECLARED in the model must match its
 * physical counterpart exactly; this does NOT assert the reverse (a physical
 * column/constraint the model hasn't declared yet is not flagged) — see
 * design.md D1's "mechanical, diff-driven, forward-only" scope.
 *
 * PR2 (Phase 2 pt.1) fixed facts.ts's own 3 tables and found the wider run —
 * during development — surfaced 41 additional pre-existing model<->physical
 * mismatches across 19 tables. PR3 (Phase 2 pt.2, this file's current state)
 * fixed all 41: type/notNull/hasDefault corrections
 * (mnemo_decision.revisionCount, mnemo_recall_log.recallScore,
 * mnemo_actor_dek.encryptedKey text->bytea — see _custom-types.ts's `bytea`
 * customType fix this forced, `uuid` vs `text` id/space_id/workspace_id
 * columns on mnemo_workspace_kek/mnemo_vector_space/mnemo_fact_embeddings_N
 * (N=1024/1536/2048/4096)/mnemo_agent_profile), a missing `gen_random_uuid()` default on
 * mnemo_session.id, and 5 tables (mnemo_citation, mnemo_query_cache,
 * mnemo_review_queue, mnemo_health, mnemo_access_policy) whose Drizzle model
 * declared a column shape physical was never migrated to — all 5 confirmed
 * dead/unused via the query builder (grep across adapter-postgres/core/
 * server), so reconciled to the real physical shape with zero call-site
 * ripple. See each schema file's own Slice 1 pt.2 comments for the
 * table-by-table reasoning, and apply-progress.md's PR3 section for the full
 * accounting (incl. one flagged-not-fixed finding: FactRepository's
 * lookupQueryCache/upsertQueryCache raw SQL still references pre-migration
 * mnemo_query_cache columns that never existed — an app-logic bug, not a
 * schema-declaration one, out of this file's scope).
 *
 * Identity-generated PK columns (`.generatedAlwaysAsIdentity()` —
 * mnemo_audit_log.id, mnemo_scoped_key_usage.id, mnemo_scoped_key_escrow.id)
 * are existence-only, same as GENERATED ALWAYS AS (expr) STORED columns:
 * `information_schema.columns.column_default` is NULL for IDENTITY columns
 * (Postgres tracks identity generation via `is_identity`, not
 * `column_default`), so physical `hasDefault` is always false for them even
 * though a value IS reliably generated on insert — comparing hasDefault here
 * would be a permanent, structural false-positive, not real drift.
 *
 * CHECK-constraint comparison is done empirically against the real
 * database, never by string-diffing hand-rendered SQL from memory (D1's
 * hard rule, applied here to verification rather than repair): each
 * model-declared CHECK's predicate is added as a differently-named
 * constraint to the REAL migrated table inside a transaction that is
 * always rolled back, then both the pre-existing physical constraint and
 * the freshly-added probe constraint are read back via the same
 * `pg_get_constraintdef()` Postgres itself uses to deparse constraints.
 * Postgres canonicalizes CHECK bodies into one internal form regardless of
 * how the original expression text was written, so two semantically
 * identical constraints always deparse to byte-identical text (module the
 * constraint's own name) — this makes the comparison robust to authoring
 * differences (parens, per-element vs whole-array casts, spacing) while
 * still proving real semantic equivalence against the live catalog.
 *
 * Run (Node 22 required — testcontainers' undici dependency; see CLAUDE.md):
 *   pnpm --filter @mnemo-ai/adapter-postgres test:integration -- schema-drift
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import postgres, { type Sql as PostgresSql, type TransactionSql } from "postgres";
import {
  getTableConfig,
  IndexedColumn,
  PgDialect,
  type Index,
  type PgTable,
} from "drizzle-orm/pg-core";
import { is, SQL } from "drizzle-orm";
import { migrate } from "../migrate.js";
import * as schema from "../schema/index.js";
// Relative path mirrors introspect-schema.mjs's own documented "in-test
// regeneration" usage comment: src/__tests__ -> adapter-postgres -> packages
// -> repo root -> scripts/introspect-schema.mjs.
import { introspectSchema } from "../../../../scripts/introspect-schema.mjs";

type SchemaSnapshot = Awaited<ReturnType<typeof introspectSchema>>;

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";
const WS = "ffffffff-ffff-4fff-ffff-ffffffffffff";
const TASK_2_INDEX_NAMES = [
  "idx_session_workspace_id_unique",
  "idx_session_source_generation_unique",
  "idx_session_turn_source_message_unique",
  "idx_harness_event_workspace_id_unique",
  "idx_harness_event_id_unique",
  "idx_harness_source_sequence_unique",
  "idx_harness_tombstone_source_message_unique",
  "idx_managed_collapse_operation_workspace_id_unique",
  "idx_managed_collapse_session_generation_unique",
  "idx_managed_collapse_effect_unique",
  "idx_session_managed_activity",
  "idx_session_collapse_due",
  "idx_session_terminal_retention",
  "idx_harness_event_retryable",
  "idx_harness_loss_session",
  "idx_harness_retraction_session",
  "idx_harness_tombstone_session",
  "idx_managed_collapse_effect_pending",
  "idx_extraction_provenance_primitive",
] as const;
const TASK_2_INDEX_TABLE_NAMES = [
  "mnemo_session",
  "mnemo_session_turn",
  "mnemo_harness_workspace_control",
  "mnemo_harness_ingestion_event",
  "mnemo_harness_loss",
  "mnemo_harness_retraction",
  "mnemo_harness_message_tombstone",
  "mnemo_managed_collapse_operation",
  "mnemo_managed_collapse_effect",
  "mnemo_extraction_provenance",
] as const;
const LEGACY_UNRELATED_SESSION_INDEXES = new Set([
  "mnemo_session.idx_session_workspace",
  "mnemo_session_turn.idx_session_turn_session",
  "mnemo_session_turn.idx_session_turn_pinned",
]);

let container: StartedTestContainer;
let sql: ReturnType<typeof postgres>;
let physical: SchemaSnapshot;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  await migrate({ databaseUrl, log: () => void 0 });

  sql = postgres(databaseUrl, { onnotice: () => void 0, max: 3 });

  // Regenerated in-test — never read from the committed schema-truth.json.
  physical = await introspectSchema(sql, "mnemosyne");
}, 120_000);

afterAll(async () => {
  await sql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

// ── KNOWN_DRIFT ───────────────────────────────────────────────────────────
//
// Must be [] for this file to be considered done (tasks.md 2.10). Any entry
// here represents a confirmed, temporary model<->physical mismatch that is
// NOT yet fixed. It is intentionally empty — every table in the full catalog
// scan below matches physical exactly as of Slice 1 pt.2 (PR3).
const KNOWN_DRIFT: readonly string[] = [];

function normalizeSqlType(t: string): string {
  return t.toLowerCase().split("(")[0]!.trim();
}

/**
 * Every table `schema/index.ts` exports (Slice 1 pt.2, tasks.md 2.10 —
 * widened from PR2's facts.ts-only scope). Introspects `schema`'s own
 * exports via `getTableConfig()` rather than hand-listing table names, so
 * a new table added to `schema/index.ts` is automatically covered by this
 * scan without another edit here.
 */
function getModelTables(): PgTable[] {
  const out: PgTable[] = [];
  for (const value of Object.values(schema)) {
    if (value === null || typeof value !== "object") continue;
    try {
      getTableConfig(value as PgTable);
      out.push(value as PgTable);
    } catch {
      // Not a PgTable (e.g. mnemoSchema itself, or a non-table export) — skip.
    }
  }
  return out;
}

const dialect = new PgDialect();

/** Render a model CHECK's predicate SQL as literal text (no bound params expected). */
function renderCheckSql(value: SQL): string {
  const { sql: text, params } = dialect.sqlToQuery(value);
  if (params.length > 0) {
    throw new Error(
      "schema-drift probe only supports CHECK predicates written as static literal SQL " +
        "(no ${}-interpolated bind values) — found bound params for: " +
        text
    );
  }
  return text;
}

/** Thrown to force `sql.begin()` to roll back while still carrying the probe result out. */
class DriftProbeAbort extends Error {
  constructor(public readonly def: string | undefined) {
    super("schema-drift probe rollback (expected — not a real failure)");
  }
}

/**
 * Adds `rendered` as a new, uniquely-named CHECK constraint to the real
 * migrated `mnemosyne.<tableName>` table inside a transaction, reads back
 * Postgres's own canonical deparse of it, then always rolls back — the
 * table is left byte-identical to how it started.
 */
async function probeCheckDef(
  tableName: string,
  constraintName: string,
  rendered: string
): Promise<string | undefined> {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(
        `ALTER TABLE mnemosyne.${tableName} ADD CONSTRAINT ${constraintName} CHECK (${rendered})`
      );
      const rows = await tx<Array<{ def: string }>>`
        SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conname = ${constraintName}
      `;
      throw new DriftProbeAbort(rows[0]?.def);
    });
  } catch (err) {
    if (err instanceof DriftProbeAbort) return err.def;
    throw err;
  }
  return undefined;
}

interface IndexAttributeSignature {
  position: number;
  role: "key" | "include";
  term: string;
  opclass: string | null;
  collation: string | null;
  descending: boolean | null;
  nullsFirst: boolean | null;
}

interface IndexSignature {
  schema: string;
  table: string;
  name: string;
  unique: boolean;
  method: string;
  attributes: IndexAttributeSignature[];
  expressionTree: string | null;
  predicateTree: string | null;
  predicateSql: string | null;
  nullsNotDistinct: boolean;
  valid: boolean;
  ready: boolean;
  live: boolean;
}

type CatalogIndexRow = Omit<IndexSignature, "attributes"> & {
  attributes: Array<{
    position: number;
    role: "key" | "include";
    term: string;
    opclass: string | null;
    collation: string | null;
    descending: boolean | null;
    nulls_first: boolean | null;
  }>;
};

function indexIdentity(table: string, name: string): string {
  return `${table}.${name}`;
}

function isLegacyUnrelatedSessionIndex(table: string, name: string): boolean {
  return LEGACY_UNRELATED_SESSION_INDEXES.has(indexIdentity(table, name));
}

async function readCatalogIndexSignatures(
  client: PostgresSql | TransactionSql,
  filter: { names: readonly string[] } | { tables: readonly string[] }
): Promise<IndexSignature[]> {
  const scope =
    "names" in filter
      ? client`index_class.relname IN ${client(filter.names)}`
      : client`table_class.relname IN ${client(filter.tables)}`;
  const rows = await client<CatalogIndexRow[]>`
    SELECT
      table_namespace.nspname AS "schema",
      table_class.relname AS "table",
      index_class.relname AS name,
      index_catalog.indisunique AS "unique",
      access_method.amname AS method,
      COALESCE(attributes.value, '[]'::jsonb) AS attributes,
      index_catalog.indexprs::text AS "expressionTree",
      index_catalog.indpred::text AS "predicateTree",
      pg_get_expr(index_catalog.indpred, index_catalog.indrelid, false) AS "predicateSql",
      index_catalog.indnullsnotdistinct AS "nullsNotDistinct",
      index_catalog.indisvalid AS valid,
      index_catalog.indisready AS ready,
      index_catalog.indislive AS live
    FROM pg_index index_catalog
    JOIN pg_class index_class ON index_class.oid = index_catalog.indexrelid
    JOIN pg_class table_class ON table_class.oid = index_catalog.indrelid
    JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
    JOIN pg_am access_method ON access_method.oid = index_class.relam
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'position', ordinal.value,
          'role', CASE WHEN ordinal.value <= index_catalog.indnkeyatts THEN 'key' ELSE 'include' END,
          'term', pg_get_indexdef(index_catalog.indexrelid, ordinal.value, true),
          'opclass', CASE WHEN operator_class.oid IS NULL THEN NULL
            ELSE format('%I.%I', operator_namespace.nspname, operator_class.opcname) END,
          'collation', CASE WHEN collation_entry.oid IS NULL THEN NULL
            ELSE format('%I.%I', collation_namespace.nspname, collation_entry.collname) END,
          'descending', CASE WHEN ordinal.value > index_catalog.indnkeyatts THEN NULL
            ELSE ((index_catalog.indoption)[ordinal.value - 1] & 1) <> 0 END,
          'nulls_first', CASE WHEN ordinal.value > index_catalog.indnkeyatts THEN NULL
            ELSE ((index_catalog.indoption)[ordinal.value - 1] & 2) <> 0 END
        ) ORDER BY ordinal.value
      ) AS value
      FROM generate_series(1, index_catalog.indnatts) AS ordinal(value)
      LEFT JOIN pg_opclass operator_class
        ON ordinal.value <= index_catalog.indnkeyatts
       AND operator_class.oid = (index_catalog.indclass)[ordinal.value - 1]
      LEFT JOIN pg_namespace operator_namespace ON operator_namespace.oid = operator_class.opcnamespace
      LEFT JOIN pg_collation collation_entry
        ON ordinal.value <= index_catalog.indnkeyatts
       AND collation_entry.oid = (index_catalog.indcollation)[ordinal.value - 1]
       AND (index_catalog.indcollation)[ordinal.value - 1] <> 0
      LEFT JOIN pg_namespace collation_namespace
        ON collation_namespace.oid = collation_entry.collnamespace
    ) attributes
    WHERE table_namespace.nspname = 'mnemosyne'
      AND ${scope}
      AND NOT index_catalog.indisprimary
    ORDER BY table_class.relname, index_class.relname
  `;
  return rows.map((row) => ({
    ...row,
    attributes: row.attributes.map(({ nulls_first, ...attribute }) => ({
      ...attribute,
      nullsFirst: nulls_first,
    })),
  }));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function renderStaticSql(value: SQL): string {
  const query = dialect.sqlToQuery(value, "indexes");
  if (query.params.length > 0) {
    throw new Error(`index drift probe cannot render bound parameters: ${query.sql}`);
  }
  return query.sql;
}

function renderIndexProbe(table: PgTable, index: Index, probeName: string): string {
  const config = index.config;
  const columns = config.columns.map((column) => {
    if (is(column, SQL)) return `(${renderStaticSql(column)})`;
    if (!(column instanceof IndexedColumn) || !column.name) {
      throw new Error(`${config.name}: unsupported Drizzle index column metadata`);
    }
    const { order, nulls, opClass } = column.indexConfig;
    return [
      quoteIdentifier(column.name),
      opClass,
      order?.toUpperCase(),
      nulls ? `NULLS ${nulls.toUpperCase()}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  });
  const tableConfig = getTableConfig(table);
  const target = `${quoteIdentifier(tableConfig.schema ?? "public")}.${quoteIdentifier(tableConfig.name)}`;
  const where = config.where ? ` WHERE ${renderStaticSql(config.where)}` : "";
  return `CREATE ${config.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(probeName)} ON ${
    config.only ? "ONLY " : ""
  }${target} USING ${quoteIdentifier(config.method ?? "btree")} (${columns.join(", ")})${where}`;
}

class IndexProbeAbort extends Error {
  constructor(public readonly signature: IndexSignature) {
    super("index drift probe rollback");
  }
}

async function deriveModelIndexSignature(table: PgTable, index: Index): Promise<IndexSignature> {
  const probeName = `__drift_${index.config.name}`.slice(0, 63);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(renderIndexProbe(table, index, probeName));
      const signatures = await readCatalogIndexSignatures(tx, { names: [probeName] });
      if (signatures.length !== 1) throw new Error(`${index.config.name}: probe index missing`);
      throw new IndexProbeAbort({ ...signatures[0]!, name: index.config.name! });
    });
  } catch (error) {
    if (error instanceof IndexProbeAbort) return error.signature;
    throw error;
  }
  throw new Error(`${index.config.name}: index probe unexpectedly committed`);
}

async function task2IndexMismatches(
  alterModelForProbe?: (index: Index) => void
): Promise<string[]> {
  const ownedTables = new Set<string>(TASK_2_INDEX_TABLE_NAMES);
  const modelDeclarations = getModelTables().flatMap((table) => {
    const tableConfig = getTableConfig(table);
    if (!ownedTables.has(tableConfig.name)) return [];
    return tableConfig.indexes
      .filter(
        (index) =>
          index.config.name && !isLegacyUnrelatedSessionIndex(tableConfig.name, index.config.name)
      )
      .map((index) => ({ table, index }));
  });
  for (const { index } of modelDeclarations) alterModelForProbe?.(index);
  const physical = (
    await readCatalogIndexSignatures(sql, { tables: TASK_2_INDEX_TABLE_NAMES })
  ).filter((index) => !isLegacyUnrelatedSessionIndex(index.table, index.name));
  const model = await Promise.all(
    modelDeclarations.map(({ table, index }) => deriveModelIndexSignature(table, index))
  );
  const physicalByIdentity = new Map(
    physical.map((signature) => [indexIdentity(signature.table, signature.name), signature])
  );
  const modelByIdentity = new Map(
    model.map((signature) => [indexIdentity(signature.table, signature.name), signature])
  );
  const mismatches: string[] = [];

  const discoveredIdentities = new Set([...modelByIdentity.keys(), ...physicalByIdentity.keys()]);
  for (const identity of [...discoveredIdentities].sort()) {
    const modelSignature = modelByIdentity.get(identity);
    const physicalSignature = physicalByIdentity.get(identity);
    const name = modelSignature?.name ?? physicalSignature!.name;
    if (!modelSignature) {
      mismatches.push(`${name}: missing from Drizzle model`);
    } else if (!physicalSignature) {
      mismatches.push(`${name}: missing from physical catalog`);
    } else if (JSON.stringify(modelSignature) !== JSON.stringify(physicalSignature)) {
      mismatches.push(`${name}: model and physical signatures differ`);
    }
  }
  const discoveredNames = new Set([...model, ...physical].map((signature) => signature.name));
  for (const name of TASK_2_INDEX_NAMES) {
    if (!discoveredNames.has(name)) mismatches.push(`${name}: missing from both index catalogs`);
  }
  if (model.length !== modelByIdentity.size)
    mismatches.push("duplicate Task 2 index name in Drizzle model");
  if (physical.length !== physicalByIdentity.size)
    mismatches.push("duplicate Task 2 index name in physical catalog");
  return mismatches;
}

describe("schema-drift: v3 Drizzle model vs physical mnemosyne catalog (forward-only)", () => {
  it("Task 2 checks exist and indexes match semantically in both directions", async () => {
    const task2Checks = [
      "mnemo_harness_workspace_control_fence_epoch_check",
      "mnemo_harness_ingestion_event_enqueue_sequence_check",
      "mnemo_harness_ingestion_event_source_generation_check",
      "mnemo_harness_ingestion_event_ledger_state_check",
      "mnemo_harness_loss_source_generation_check",
      "mnemo_harness_loss_enqueue_sequence_check",
      "mnemo_harness_message_tombstone_source_generation_check",
      "mnemo_managed_collapse_operation_source_generation_check",
      "mnemo_managed_collapse_operation_status_check",
      "mnemo_managed_collapse_effect_attempts_check",
      "mnemo_managed_collapse_effect_status_check",
      "mnemo_session_managed_archive_reason_check",
    ];
    const tables = getModelTables().map((table) => getTableConfig(table));
    const modelChecks = new Set(tables.flatMap((table) => table.checks.map((value) => value.name)));
    const physicalConstraints = new Set(physical.checks.map((value) => value.name));

    for (const name of task2Checks) {
      expect(modelChecks, `Drizzle CHECK ${name}`).toContain(name);
      expect(physicalConstraints, `physical CHECK ${name}`).toContain(name);
    }
    expect(await task2IndexMismatches()).toEqual([]);
  });

  it("detects semantic Task 2 index drift from the live Drizzle metadata", async () => {
    let target: Index | undefined;
    let originalUnique: boolean | undefined;
    try {
      const mismatches = await task2IndexMismatches((index) => {
        if (index.config.name === "idx_session_workspace_id_unique") {
          target = index;
          originalUnique = index.config.unique;
          index.config.unique = !originalUnique;
        }
      });
      expect(mismatches).toContain(
        "idx_session_workspace_id_unique: model and physical signatures differ"
      );
    } finally {
      if (target && originalUnique !== undefined) target.config.unique = originalUnique;
    }
  });

  it("detects a model-only extra index on a Task 2-owned table", async () => {
    let target: Index | undefined;
    let originalName: string | undefined;
    const extraName = "idx_task2_model_only_probe";
    try {
      const mismatches = await task2IndexMismatches((index) => {
        if (index.config.name === "idx_harness_loss_session") {
          target = index;
          originalName = index.config.name;
          index.config.name = extraName;
        }
      });
      expect(mismatches).toContain(`${extraName}: missing from physical catalog`);
    } finally {
      if (target) target.config.name = originalName;
    }
  });

  it("detects a physical-only extra index on a Task 2-owned table", async () => {
    const extraName = "idx_task2_physical_only_probe";
    await sql.unsafe(
      `CREATE INDEX ${extraName} ON mnemosyne.mnemo_harness_loss (workspace_id, reason)`
    );
    try {
      expect(await task2IndexMismatches()).toContain(`${extraName}: missing from Drizzle model`);
    } finally {
      await sql.unsafe(`DROP INDEX IF EXISTS mnemosyne.${extraName}`);
    }
  });

  it("Task 2 foreign keys match canonical columns and delete actions bidirectionally", async () => {
    type ForeignKeySignature = {
      table_name: string;
      constraint_name: string;
      columns: string[];
      referenced_table: string;
      referenced_columns: string[];
      on_delete: string;
      delete_set_columns: string[];
      validated: boolean;
    };
    const expected: Record<string, Omit<ForeignKeySignature, "constraint_name" | "validated">> = {
      mnemo_harness_workspace_control_workspace_fkey: {
        table_name: "mnemo_harness_workspace_control",
        columns: ["workspace_id"],
        referenced_table: "mnemo_workspace",
        referenced_columns: ["id"],
        on_delete: "cascade",
        delete_set_columns: [],
      },
      mnemo_session_predecessor_workspace_fkey: {
        table_name: "mnemo_session",
        columns: ["workspace_id", "predecessor_session_id"],
        referenced_table: "mnemo_session",
        referenced_columns: ["workspace_id", "id"],
        on_delete: "set null",
        delete_set_columns: ["predecessor_session_id"],
      },
      mnemo_session_turn_session_workspace_fkey: {
        table_name: "mnemo_session_turn",
        columns: ["ingestion_event_workspace_id", "session_id"],
        referenced_table: "mnemo_session",
        referenced_columns: ["workspace_id", "id"],
        on_delete: "cascade",
        delete_set_columns: [],
      },
      mnemo_session_turn_ingestion_event_workspace_fkey: {
        table_name: "mnemo_session_turn",
        columns: ["ingestion_event_workspace_id", "ingestion_event_id"],
        referenced_table: "mnemo_harness_ingestion_event",
        referenced_columns: ["workspace_id", "id"],
        on_delete: "set null",
        delete_set_columns: ["ingestion_event_id"],
      },
      mnemo_harness_ingestion_event_session_workspace_fkey: {
        table_name: "mnemo_harness_ingestion_event",
        columns: ["workspace_id", "session_id"],
        referenced_table: "mnemo_session",
        referenced_columns: ["workspace_id", "id"],
        on_delete: "no action",
        delete_set_columns: [],
      },
      mnemo_harness_loss_session_workspace_fkey: {
        table_name: "mnemo_harness_loss",
        columns: ["workspace_id", "session_id"],
        referenced_table: "mnemo_session",
        referenced_columns: ["workspace_id", "id"],
        on_delete: "cascade",
        delete_set_columns: [],
      },
      mnemo_harness_loss_event_workspace_fkey: {
        table_name: "mnemo_harness_loss",
        columns: ["workspace_id", "ingestion_event_id"],
        referenced_table: "mnemo_harness_ingestion_event",
        referenced_columns: ["workspace_id", "id"],
        on_delete: "restrict",
        delete_set_columns: [],
      },
      mnemo_harness_retraction_session_workspace_fkey: {
        table_name: "mnemo_harness_retraction",
        columns: ["workspace_id", "session_id"],
        referenced_table: "mnemo_session",
        referenced_columns: ["workspace_id", "id"],
        on_delete: "cascade",
        delete_set_columns: [],
      },
      mnemo_harness_retraction_event_workspace_fkey: {
        table_name: "mnemo_harness_retraction",
        columns: ["workspace_id", "ingestion_event_id"],
        referenced_table: "mnemo_harness_ingestion_event",
        referenced_columns: ["workspace_id", "id"],
        on_delete: "restrict",
        delete_set_columns: [],
      },
      mnemo_harness_retraction_predecessor_workspace_fkey: {
        table_name: "mnemo_harness_retraction",
        columns: ["workspace_id", "predecessor_session_id"],
        referenced_table: "mnemo_session",
        referenced_columns: ["workspace_id", "id"],
        on_delete: "set null",
        delete_set_columns: ["predecessor_session_id"],
      },
      mnemo_harness_tombstone_session_workspace_fkey: {
        table_name: "mnemo_harness_message_tombstone",
        columns: ["workspace_id", "session_id"],
        referenced_table: "mnemo_session",
        referenced_columns: ["workspace_id", "id"],
        on_delete: "no action",
        delete_set_columns: [],
      },
      mnemo_managed_collapse_operation_session_workspace_fkey: {
        table_name: "mnemo_managed_collapse_operation",
        columns: ["workspace_id", "session_id"],
        referenced_table: "mnemo_session",
        referenced_columns: ["workspace_id", "id"],
        on_delete: "restrict",
        delete_set_columns: [],
      },
      mnemo_managed_collapse_effect_operation_workspace_fkey: {
        table_name: "mnemo_managed_collapse_effect",
        columns: ["workspace_id", "collapse_operation_id"],
        referenced_table: "mnemo_managed_collapse_operation",
        referenced_columns: ["workspace_id", "operation_id"],
        on_delete: "cascade",
        delete_set_columns: [],
      },
      mnemo_extraction_provenance_operation_workspace_fkey: {
        table_name: "mnemo_extraction_provenance",
        columns: ["workspace_id", "collapse_operation_id"],
        referenced_table: "mnemo_managed_collapse_operation",
        referenced_columns: ["workspace_id", "operation_id"],
        on_delete: "cascade",
        delete_set_columns: [],
      },
      mnemo_extraction_provenance_session_workspace_fkey: {
        table_name: "mnemo_extraction_provenance",
        columns: ["workspace_id", "session_id"],
        referenced_table: "mnemo_session",
        referenced_columns: ["workspace_id", "id"],
        on_delete: "restrict",
        delete_set_columns: [],
      },
    };
    const rawSqlOwned = new Set([
      "mnemo_session_predecessor_workspace_fkey",
      "mnemo_session_turn_ingestion_event_workspace_fkey",
      "mnemo_harness_retraction_predecessor_workspace_fkey",
    ]);
    expect(
      new Set(
        ((schema as Record<string, unknown>).HOST_HARNESS_RAW_SQL_OWNED_FOREIGN_KEYS as
          readonly string[] | undefined) ?? []
      )
    ).toEqual(rawSqlOwned);

    const physicalForeignKeys = await sql<ForeignKeySignature[]>`
      SELECT child.relname AS table_name,
        con.conname AS constraint_name,
        ARRAY(
          SELECT att.attname
          FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = key.attnum
          ORDER BY key.position
        ) AS columns,
        parent.relname AS referenced_table,
        ARRAY(
          SELECT att.attname
          FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = key.attnum
          ORDER BY key.position
        ) AS referenced_columns,
        CASE con.confdeltype
          WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict' WHEN 'c' THEN 'cascade'
          WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default'
        END AS on_delete,
        COALESCE(ARRAY(
          SELECT att.attname
          FROM unnest(con.confdelsetcols) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = key.attnum
          ORDER BY key.position
        ), ARRAY[]::name[])::text[] AS delete_set_columns,
        con.convalidated AS validated
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_class parent ON parent.oid = con.confrelid
      WHERE con.contype = 'f' AND con.conname IN ${sql(Object.keys(expected))}
      ORDER BY con.conname
    `;
    expect(physicalForeignKeys).toHaveLength(Object.keys(expected).length);
    for (const foreignKey of physicalForeignKeys) {
      expect(foreignKey.validated, foreignKey.constraint_name).toBe(true);
      expect(
        {
          table_name: foreignKey.table_name,
          columns: foreignKey.columns,
          referenced_table: foreignKey.referenced_table,
          referenced_columns: foreignKey.referenced_columns,
          on_delete: foreignKey.on_delete,
          delete_set_columns: foreignKey.delete_set_columns,
        },
        foreignKey.constraint_name
      ).toEqual(expected[foreignKey.constraint_name]);
    }

    const modelForeignKeys = new Map(
      getModelTables().flatMap((table) =>
        getTableConfig(table).foreignKeys.map((foreignKey) => {
          const reference = foreignKey.reference();
          return [
            foreignKey.getName(),
            {
              table_name: getTableConfig(table).name,
              columns: reference.columns.map((column) => column.name),
              referenced_table: getTableConfig(reference.foreignTable).name,
              referenced_columns: reference.foreignColumns.map((column) => column.name),
              on_delete: foreignKey.onDelete ?? "no action",
              delete_set_columns: [],
            },
          ] as const;
        })
      )
    );
    for (const name of rawSqlOwned) expect(modelForeignKeys.has(name), name).toBe(false);
    for (const [name, signature] of Object.entries(expected)) {
      if (rawSqlOwned.has(name)) continue;
      expect(modelForeignKeys.get(name), name).toEqual(signature);
    }
  });

  it("every modeled column's type/notNull/hasDefault matches physical (GENERATED columns: existence only)", () => {
    const physicalByKey = new Map(physical.columns.map((c) => [`${c.table}.${c.column}`, c]));

    const mismatches: string[] = [];

    for (const table of getModelTables()) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const key = `${config.name}.${column.name}`;
        const phys = physicalByKey.get(key);
        if (!phys) {
          mismatches.push(`${key}: modeled but missing from physical catalog`);
          continue;
        }
        if (column.generated || column.generatedIdentity) {
          // GENERATED ALWAYS AS (expr) STORED columns, AND
          // .generatedAlwaysAsIdentity()/.generatedByDefaultAsIdentity()
          // columns: information_schema.columns reports column_default =
          // NULL for both (Postgres tracks identity generation via
          // is_identity, not column_default; introspect-schema.mjs
          // deliberately doesn't project the separate identity catalog
          // columns per design.md's committed SchemaSnapshot shape), so
          // hasDefault comparison is not meaningful for either — a false
          // positive, not real drift. Only existence is asserted.
          continue;
        }

        const modelType = normalizeSqlType(column.getSQLType());
        const physType = normalizeSqlType(phys.sqlType);
        if (modelType !== physType) {
          mismatches.push(`${key}: type model=${modelType} physical=${physType}`);
        }
        if (column.notNull !== phys.notNull) {
          mismatches.push(`${key}: notNull model=${column.notNull} physical=${phys.notNull}`);
        }
        if (column.hasDefault !== phys.hasDefault) {
          mismatches.push(
            `${key}: hasDefault model=${column.hasDefault} physical=${phys.hasDefault}`
          );
        }
      }
    }

    const unexpected = mismatches.filter((m) => !KNOWN_DRIFT.includes(m));
    expect(unexpected).toEqual([]);
  });

  it("every modeled CHECK constraint's predicate matches physical (Postgres-canonicalized, verified against the real DB)", async () => {
    const physicalChecksByKey = new Map(
      physical.checks
        .filter((c) => c.expr.startsWith("CHECK"))
        .map((c) => [`${c.table}.${c.name}`, c.expr])
    );

    const mismatches: string[] = [];

    for (const table of getModelTables()) {
      const config = getTableConfig(table);
      for (const modelCheck of config.checks) {
        const key = `${config.name}.${modelCheck.name}`;
        const physExpr = physicalChecksByKey.get(key);
        if (!physExpr) {
          mismatches.push(`${key}: modeled CHECK missing from physical catalog`);
          continue;
        }

        const rendered = renderCheckSql(modelCheck.value);
        const probeName = `__drift_probe_${modelCheck.name}`.slice(0, 63); // Postgres identifier limit
        const probeExpr = await probeCheckDef(config.name, probeName, rendered);

        if (probeExpr === undefined) {
          mismatches.push(`${key}: model CHECK predicate rejected by Postgres (invalid SQL)`);
          continue;
        }
        if (probeExpr !== physExpr) {
          mismatches.push(`${key}: predicate model="${probeExpr}" physical="${physExpr}"`);
        }
      }
    }

    const unexpected = mismatches.filter((m) => !KNOWN_DRIFT.includes(m));
    expect(unexpected).toEqual([]);
  });

  it("keeps every modeled harness enqueue watermark strictly positive in the physical catalog", async () => {
    const expected = [
      ["mnemo_session", "mnemo_session_terminal_sequence_safe_check"],
      ["mnemo_harness_ingestion_event", "mnemo_harness_ingestion_event_enqueue_sequence_check"],
      [
        "mnemo_harness_ingestion_event",
        "mnemo_harness_ingestion_event_enqueue_sequence_safe_check",
      ],
      ["mnemo_harness_loss", "mnemo_harness_loss_enqueue_sequence_check"],
      ["mnemo_harness_loss", "mnemo_harness_loss_enqueue_sequence_safe_check"],
    ] as const;

    for (const [table, name] of expected) {
      const expression = physical.checks.find(
        (candidate) => candidate.table === table && candidate.name === name
      )?.expr;
      expect(expression, `${table}.${name}`).toMatch(/>=\s*1/);
      expect(expression, `${table}.${name}`).not.toMatch(/>=\s*0/);
    }
  });

  // ── tasks.md 2.6 ──────────────────────────────────────────────────────
  //
  // The model↔physical parity proven above is only meaningful if the
  // physical CHECK actually rejects out-of-set values at the database
  // layer — not just silently accepted. This proves the DB enforces it,
  // independent of any application-level validation.
  it("a v3 fact insert with a kind outside the CHECK-enforced set is rejected by the database", async () => {
    await expect(
      sql`
        INSERT INTO mnemosyne.mnemo_fact
          (id, workspace_id, scope, kind, subject, statement)
        VALUES
          ('fact-bad-kind-drift-test', ${WS}, 'global', 'not_a_real_kind', 'probe-subject', 'probe-statement')
      `
    ).rejects.toThrow(/mnemo_fact_kind_check/);
  });

  it("a v3 fact insert with a scope outside the CHECK-enforced set is rejected by the database", async () => {
    await expect(
      sql`
        INSERT INTO mnemosyne.mnemo_fact
          (id, workspace_id, scope, kind, subject, statement)
        VALUES
          ('fact-bad-scope-drift-test', ${WS}, 'not_a_real_scope', 'preference', 'probe-subject', 'probe-statement')
      `
    ).rejects.toThrow(/mnemo_fact_scope_check/);
  });
});
