#!/usr/bin/env node
/**
 * Canonical physical-schema snapshot for the `mnemosyne` Postgres schema.
 *
 * Slice 0 of `flatten-legacy-dual-core` (docs/archive/openspec/flatten-legacy-dual-core/design.md,
 * decision D1). Projects `information_schema.columns` + `pg_constraint`
 * (CHECK/PK/FK) + `pg_indexes` + `information_schema.role_table_grants` —
 * filtered to `schema='mnemosyne'` — into one canonical, key-sorted JSON
 * shape (`SchemaSnapshot`, matching design.md's "Interfaces / Contracts").
 *
 * This is HALF of Slice 1's model<->catalog diff guard. The other half is
 * the Drizzle model's own `getTableConfig()` projection into the same shape
 * (schema-drift.integration.test.ts, a later slice). Both sides are
 * generated — nothing here is hand-authored SQL reasoning, which is the
 * exact mistake the 2026-06-27 incident (docs/archive/remediation/2026-06-27-
 * squash-baseline-regeneration.md) punished.
 *
 * `checks` deliberately holds every `pg_constraint` row for the schema, not
 * only CHECK constraints — `pg_get_constraintdef()` renders PRIMARY KEY and
 * FOREIGN KEY definitions in the same readable form, and design.md's
 * committed interface has one array for all of them (see D1: "pg_constraint
 * (CHECK/FK/PK)"). The field keeps the name `checks` to match that
 * committed shape exactly; do not read it as "CHECK constraints only".
 *
 * Usage (CLI — introspect an already-migrated database):
 *   node scripts/introspect-schema.mjs --database-url <url> [--schema mnemosyne] [--out <file>]
 *   DATABASE_URL=postgres://... node scripts/introspect-schema.mjs
 *
 *   With no --out, the canonical JSON is printed to stdout.
 *
 * Usage (import — e.g. from an in-test regeneration):
 *   import { introspectSchema } from "../../../../scripts/introspect-schema.mjs";
 *   const snapshot = await introspectSchema(sql, "mnemosyne");
 *
 * This script does NOT run migrations and does NOT manage a database's
 * lifecycle — it only reads an already-migrated database's catalog. Slice
 * 0's one-off generation of the committed `schema-truth.json` runs this
 * against a fresh testcontainer with every committed migration applied
 * first (mirrors `fresh-install-migrate.integration.test.ts` /
 * `schema-safety.yml`'s shadow-apply pattern) — see
 * `docs/archive/remediation/2026-08-09-schema-reality-check.md` for exactly how
 * that one-off run was done.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

// `postgres` is a devDependency of @mnemo-ai/adapter-postgres (also a peerDep
// of the package itself), not a root dependency — resolve it from there so
// this script runs from the repo root without adding a root-level dep.
// Mirrors scripts/backfill-fact-embeddings.mjs's `createRequire` pattern.
const require = createRequire(
  new URL("../packages/adapter-postgres/package.json", import.meta.url)
);

/**
 * @typedef {{ table: string; column: string; sqlType: string; notNull: boolean; hasDefault: boolean }} SchemaColumn
 * @typedef {{ table: string; name: string; expr: string }} SchemaCheck
 * @typedef {{ table: string; name: string; definition: string }} SchemaIndex
 * @typedef {{ table: string; grantee: string; privilege: string }} SchemaGrant
 * @typedef {{ columns: SchemaColumn[]; checks: SchemaCheck[]; indexes: SchemaIndex[]; grants: SchemaGrant[] }} SchemaSnapshot
 */

/**
 * Query the live catalog for `schema` and project it into the canonical
 * `SchemaSnapshot` shape. Every array is sorted deterministically so the
 * JSON is byte-stable across repeated runs against the same schema.
 *
 * @param {import("postgres").Sql<Record<string, unknown>>} sql an open `postgres` client
 * @param {string} [schema]
 * @returns {Promise<SchemaSnapshot>}
 */
export async function introspectSchema(sql, schema = "mnemosyne") {
  const columnRows = await sql`
    SELECT
      c.table_name AS table_name,
      c.column_name AS column_name,
      CASE
        WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name
        WHEN c.data_type = 'ARRAY' THEN trim(leading '_' from c.udt_name) || '[]'
        ELSE c.data_type
      END AS sql_type,
      (c.is_nullable = 'NO') AS not_null,
      (c.column_default IS NOT NULL) AS has_default
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = ${schema}
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.column_name
  `;

  const checkRows = await sql`
    SELECT
      cl.relname AS table_name,
      con.conname AS constraint_name,
      pg_get_constraintdef(con.oid) AS constraint_def
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE ns.nspname = ${schema}
    ORDER BY cl.relname, con.conname
  `;

  const indexRows = await sql`
    SELECT
      tablename AS table_name,
      indexname AS index_name,
      indexdef AS index_def
    FROM pg_indexes
    WHERE schemaname = ${schema}
    ORDER BY tablename, indexname
  `;

  const grantRows = await sql`
    SELECT
      table_name,
      grantee,
      privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = ${schema}
    ORDER BY table_name, grantee, privilege_type
  `;

  /** @type {SchemaSnapshot} */
  const snapshot = {
    columns: columnRows.map((r) => ({
      table: r.table_name,
      column: r.column_name,
      sqlType: r.sql_type,
      notNull: r.not_null,
      hasDefault: r.has_default,
    })),
    checks: checkRows.map((r) => ({
      table: r.table_name,
      name: r.constraint_name,
      expr: r.constraint_def,
    })),
    indexes: indexRows.map((r) => ({
      table: r.table_name,
      name: r.index_name,
      definition: r.index_def,
    })),
    grants: grantRows.map((r) => ({
      table: r.table_name,
      grantee: r.grantee,
      privilege: r.privilege_type,
    })),
  };

  return snapshot;
}

/**
 * Serialize a SchemaSnapshot to canonical, diff-stable JSON: every array is
 * already query-sorted (see introspectSchema); this additionally sorts
 * object keys alphabetically so two independently generated snapshots of
 * an identical schema always produce byte-identical text.
 *
 * @param {import("./introspect-schema.mjs").SchemaSnapshot} snapshot
 * @returns {string}
 */
export function toCanonicalJson(snapshot) {
  const sortKeysReplacer = (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      );
    }
    return value;
  };
  return `${JSON.stringify(snapshot, sortKeysReplacer, 2)}\n`;
}

function parseArgs(argv) {
  const args = { schema: "mnemosyne" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--database-url") args.databaseUrl = argv[++i];
    else if (a === "--schema") args.schema = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      "Usage: node scripts/introspect-schema.mjs --database-url <url> [--schema mnemosyne] [--out <file>]"
    );
    process.exit(0);
  }

  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("error: DATABASE_URL is not set. Pass --database-url or set the env var.");
    process.exit(1);
  }

  const postgres = require("postgres");
  const sql = postgres(databaseUrl, { onnotice: () => void 0, max: 1 });

  try {
    const snapshot = await introspectSchema(sql, args.schema);
    const json = toCanonicalJson(snapshot);

    if (args.out) {
      writeFileSync(args.out, json, "utf8");
      console.error(
        `Wrote schema snapshot for '${args.schema}' (${snapshot.columns.length} columns, ` +
          `${snapshot.checks.length} constraints, ${snapshot.indexes.length} indexes, ` +
          `${snapshot.grants.length} grants) to ${args.out}`
      );
    } else {
      process.stdout.write(json);
    }
  } finally {
    await sql.end();
  }
}

// Only run the CLI when this file is executed directly, not when imported
// (e.g. by a future in-test regeneration).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
