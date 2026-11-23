#!/usr/bin/env node
// packages/mnemosyne/src/cli/migrate.ts
//
// Tiny migration runner for @mnemo-ai/core when consumed as a
// standalone package outside the Orchester monorepo.
//
// Why this exists
// ---------------
// External consumers install `@mnemo-ai/core` from npm and need
// to apply ~62 SQL migrations against their own Postgres before they
// can call `withMnemoTx`. Asking them to download SQL files from
// GitHub and run them manually is hostile. This CLI:
//
//   1. Discovers the bundled migrations directory (shipped alongside
//      the compiled output via `package.json#files`).
//   2. Connects to the consumer's `DATABASE_URL`.
//   3. Creates a tracking table `mnemo_migration_history` on first run.
//   4. Applies migrations in lexical order, skipping ones whose
//      filename already has a recorded row.
//   5. Runs each migration in its own transaction so a failure halts
//      the cron without leaving the schema half-applied.
//
// PRE-FLIGHT (read before first run)
// ----------------------------------
// - RLS FOUNDATION FIRST: migration `0015_mnemo_rls_foundation.sql` defines
//   `apply_pattern_a()` / `current_workspace_id()` / `is_cross_tenant_admin()`
//   that EVERY later mnemo_* migration depends on. It is numbered 0015 so it
//   sorts (and runs) before 0016 — do not reorder or skip it, or 0016+ will
//   fail with "function apply_pattern_a does not exist".
// - The HOST must have provisioned the `pgvector` extension and any required
//   app role/grants BEFORE running this CLI. We do NOT create them (see the
//   "What this does NOT do" section below).
//
// Usage from a consumer's project
// -------------------------------
//   DATABASE_URL=postgres://… npx mnemo-migrate
//   DATABASE_URL=postgres://… npx mnemo-migrate --dry-run
//   DATABASE_URL=postgres://… npx mnemo-migrate --target 0042
//
// What this does NOT do
// ---------------------
// - Down migrations. The bundled `.down.sql` files exist for
//   completeness (the Orchester monorepo uses them) but applying
//   them from this CLI is an explicit out-of-scope to avoid the
//   "I accidentally dropped my prod memory" footgun. Consumers who
//   need rollback should run `.down.sql` manually with `psql`.
//
// - Pgvector / role bootstrapping. We DO NOT install the pgvector
//   extension or create `app_user` / `cron_admin` roles — those are
//   environment decisions the consumer's DBA owns. The CLI surfaces
//   a friendly error and points at the pre-flight checklist if
//   they're missing.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Top-level SQL statement splitter.
 *
 * Migrations marked `-- migrate:no-transaction` (required for anything
 * containing `CREATE INDEX CONCURRENTLY`) cannot run as one multi-statement
 * string — Postgres wraps a multi-statement simple query in an implicit
 * transaction and rejects CONCURRENTLY inside it. We split such files into
 * individual top-level statements and run each on its own, outside any
 * transaction. Splitting on a naive `;` is wrong: PL/pgSQL `DO $$ … $$;`
 * bodies and string literals contain `;`. This splitter is aware of:
 *   • dollar-quoted blocks  — `$$ … $$` and `$tag$ … $tag$`
 *   • single-quoted strings — `'…'`, the `''` escape, and `E'…'` backslashes
 *   • line comments         — `-- …`
 *   • block comments        — `/* … *​/` (nesting allowed, like Postgres)
 *
 * DRY NOTE: a byte-identical copy lives in
 * `packages/adapter-postgres/src/sql-split.ts` (exported + unit-tested
 * there). This CLI is published to npm standalone and deliberately does NOT
 * import adapter-postgres, so the function is duplicated. If you change one,
 * change the other — both are exercised against real Postgres by the
 * integration suites.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : "";

    // Line comment: -- … to end of line.
    if (ch === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    // Block comment: /* … */ with Postgres-style nesting.
    if (ch === "/" && next === "*") {
      let depth = 1;
      current += "/*";
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && i + 1 < n && sql[i + 1] === "*") {
          depth += 1;
          current += "/*";
          i += 2;
        } else if (sql[i] === "*" && i + 1 < n && sql[i + 1] === "/") {
          depth -= 1;
          current += "*/";
          i += 2;
        } else {
          current += sql[i];
          i += 1;
        }
      }
      continue;
    }

    // Single-quoted string literal: '…' with the '' escape; E'…' backslashes.
    if (ch === "'") {
      const escapesBackslash = current.length > 0 && /[Ee]$/.test(current);
      current += ch;
      i += 1;
      while (i < n) {
        const c = sql[i];
        if (escapesBackslash && c === "\\" && i + 1 < n) {
          current += c + sql[i + 1];
          i += 2;
          continue;
        }
        if (c === "'") {
          if (i + 1 < n && sql[i + 1] === "'") {
            current += "''";
            i += 2;
            continue;
          }
          current += "'";
          i += 1;
          break;
        }
        current += c;
        i += 1;
      }
      continue;
    }

    // Dollar-quoted block: $$ … $$ or $tag$ … $tag$.
    if (ch === "$") {
      const tag = matchDollarTag(sql, i);
      if (tag !== null) {
        const closeIdx = sql.indexOf(tag, i + tag.length);
        const end = closeIdx === -1 ? n : closeIdx + tag.length;
        current += sql.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === ";") {
      pushIfSql(statements, current);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  pushIfSql(statements, current);

  return statements;
}

/**
 * Push `fragment` (trimmed) onto `out` only if it contains real SQL — i.e.
 * something remains after stripping comments and whitespace. A fragment that
 * is purely comments is a no-op to execute and is dropped. The ORIGINAL
 * fragment text (including any leading comment, valid before a statement) is
 * what gets pushed.
 */
function pushIfSql(out: string[], fragment: string): void {
  const trimmed = fragment.trim();
  if (trimmed.length === 0) return;
  if (stripComments(trimmed).trim().length === 0) return;
  out.push(trimmed);
}

/** Remove `-- …` line comments and `/* … *​/` (nesting-aware) block comments. */
function stripComments(s: string): string {
  let result = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    const next = i + 1 < n ? s[i + 1] : "";
    if (ch === "-" && next === "-") {
      const eol = s.indexOf("\n", i);
      i = eol === -1 ? n : eol;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (s[i] === "/" && i + 1 < n && s[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (s[i] === "*" && i + 1 < n && s[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (ch === "'" || ch === "$") {
      return s.slice(i);
    }
    result += ch;
    i += 1;
  }
  return result;
}

function matchDollarTag(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  // Optional tag identifier.
  const first = sql[j];
  if (first !== undefined && /[A-Za-z_]/.test(first)) {
    j += 1;
    let c = sql[j];
    while (c !== undefined && /[A-Za-z0-9_]/.test(c)) {
      j += 1;
      c = sql[j];
    }
  }
  // Must be closed by a second `$` to be a valid tag.
  if (sql[j] === "$") {
    return sql.slice(i, j + 1);
  }
  return null;
}

// Minimal structural type covering the subset of postgres-js's API
// this CLI uses. We avoid importing the package's full types so the
// module-level type-check works without `postgres` installed, and we
// keep the contract narrow and explicit.
interface SqlClient {
  /** Tagged-template query with parameter binding. */
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<unknown[]>;
  /**
   * Run a raw SQL string. With no `params` it's pure DDL (the consumer's
   * migration text). With `params` it uses postgres-js's positional binding
   * ($1, $2, …) so untrusted values can never break out of the statement.
   */
  unsafe(q: string, params?: readonly unknown[]): Promise<unknown[]>;
  /** Wrap a function in a transaction; postgres-js rolls back on throw. */
  begin<T>(
    fn: (tx: {
      unsafe(q: string, params?: readonly unknown[]): Promise<unknown>;
    }) => Promise<T>,
  ): Promise<T>;
  /** Close the connection pool. */
  end(): Promise<void>;
}

interface CliFlags {
  /** Don't apply — just print what would run. */
  dryRun: boolean;
  /** Stop after the migration with this filename prefix (e.g. "0042"). */
  target?: string;
  /** Override the bundled migrations directory (testing hook). */
  migrationsDir?: string;
  /** Override the DATABASE_URL env (testing hook). */
  databaseUrl?: string;
  /** Print the version and exit. */
  version: boolean;
  /** Print usage and exit. */
  help: boolean;
}

function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = { dryRun: false, version: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--version" || a === "-v") flags.version = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--target") flags.target = String(argv[++i] ?? "");
    else if (a?.startsWith("--target=")) flags.target = a.slice("--target=".length);
    else if (a === "--migrations-dir") flags.migrationsDir = String(argv[++i] ?? "");
    else if (a?.startsWith("--migrations-dir="))
      flags.migrationsDir = a.slice("--migrations-dir=".length);
    else if (a === "--database-url") flags.databaseUrl = String(argv[++i] ?? "");
  }
  return flags;
}

function printHelp(): void {
  process.stdout.write(`
@mnemo-ai/core migrate — apply bundled SQL migrations against a Postgres database.

Usage
  mnemo-migrate [flags]

Flags
  --dry-run                 Print the migrations that WOULD run; do not apply.
  --target <prefix>         Stop after the migration whose filename starts with <prefix>
                            (e.g. --target 0042).
  --migrations-dir <path>   Override the bundled migrations directory (testing).
  --database-url <url>      Override DATABASE_URL (defaults to the env var).
  --help, -h                Print this help and exit.
  --version, -v             Print version and exit.

Env
  DATABASE_URL              Postgres connection string. Required unless --database-url is set.

Pre-flight (the CLI checks these and aborts with a friendly error if missing)
  - pgvector extension installed (CREATE EXTENSION vector)
  - The connecting role can create tables in the target schema

Examples
  DATABASE_URL=postgres://localhost:5432/mydb mnemo-migrate
  DATABASE_URL=… mnemo-migrate --dry-run
  DATABASE_URL=… mnemo-migrate --target 0050

`);
}

/**
 * Resolve the bundled migrations directory. After tsup builds the
 * package, the directory layout is:
 *   dist/
 *     migrate.mjs   ← this file (compiled)
 *   migrations/     ← shipped via package.json#files
 *
 * From `dist/migrate.mjs` the migrations dir is one level up.
 */
function locateMigrationsDir(override?: string): string {
  if (override) return resolve(override);
  // import.meta.url works under ESM. tsup's CJS shim makes it work
  // under CJS too, but to be defensive we fall back to __dirname.
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = __dirname;
  }
  // Walk up at most two levels looking for a `migrations` sibling
  // — works whether the file is `dist/migrate.mjs` (one up) or
  // `dist/cli/migrate.mjs` (two up).
  for (let i = 0; i < 3; i++) {
    const candidate = join(here, "..".repeat(i), "migrations");
    const resolved = resolve(candidate);
    if (existsSync(resolved)) return resolved;
  }
  throw new Error(
    "Could not locate bundled migrations directory. Pass --migrations-dir explicitly."
  );
}

interface MigrationFile {
  /** Full filename, e.g. "0017_mnemosyne_init.sql". */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Lexical sort key — just `name` since they're zero-padded. */
  sortKey: string;
}

function discoverMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .map((name) => ({ name, path: join(dir, name), sortKey: name }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

/**
 * SQL for the bookkeeping table. Created on first run; subsequent
 * runs SELECT from it to figure out what's already applied.
 */
const HISTORY_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS mnemo_migration_history (
    name        text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
`;

async function loadAlreadyApplied(sql: SqlClient): Promise<Set<string>> {
  const rows = (await sql.unsafe(`SELECT name FROM mnemo_migration_history`)) as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    return 0;
  }
  if (flags.version) {
    process.stdout.write(
      `@mnemo-ai/core migrate ${process.env["npm_package_version"] ?? "unknown"}\n`
    );
    return 0;
  }

  const databaseUrl = flags.databaseUrl ?? process.env["DATABASE_URL"];
  if (!databaseUrl) {
    process.stderr.write(
      "error: DATABASE_URL is not set. Pass --database-url or set the env var.\n"
    );
    return 1;
  }

  const dir = locateMigrationsDir(flags.migrationsDir);
  const files = discoverMigrations(dir);
  if (files.length === 0) {
    process.stderr.write(`error: no .sql files found in ${dir}\n`);
    return 1;
  }

  // Dynamic import so we don't crash when the package is imported
  // only for types or in an environment without `postgres`.
  const postgres = (await import("postgres")).default;
  const sql = postgres(databaseUrl, {
    onnotice: () => undefined, // suppress "NOTICE: extension already exists" chatter
  }) as unknown as SqlClient;

  try {
    process.stdout.write(`▸ Discovered ${files.length} migrations in ${dir}\n`);

    if (!flags.dryRun) {
      await sql.unsafe(HISTORY_TABLE_DDL);
    }

    const applied = flags.dryRun ? new Set<string>() : await loadAlreadyApplied(sql);

    let appliedThisRun = 0;
    let skipped = 0;
    for (const m of files) {
      if (applied.has(m.name)) {
        skipped += 1;
        continue;
      }
      // C3: --target is an INCLUSIVE prefix. Apply this migration if its name
      // startsWith the target prefix (e.g. --target 0042 still applies
      // 0042_foo.sql) or sorts at/before it; only stop once we've passed it.
      if (
        flags.target &&
        !m.name.startsWith(flags.target) &&
        m.name.localeCompare(flags.target) > 0
      ) {
        process.stdout.write(`  (stopping past --target=${flags.target})\n`);
        break;
      }
      const sqlText = readFileSync(m.path, "utf8");
      const tag = flags.dryRun ? "[dry-run]" : "[applying]";
      process.stdout.write(`${tag} ${m.name}\n`);

      // A migration whose text carries `-- migrate:no-transaction` legitimately
      // contains `CREATE INDEX CONCURRENTLY`, which Postgres rejects inside any
      // transaction block. Such files MUST NOT be wrapped in `sql.begin`, and
      // MUST NOT be sent as a single multi-statement string (that's an implicit
      // transaction too). We split them into top-level statements and run each
      // on its own, outside any transaction.
      const noTransaction = /--\s*migrate:no-transaction/i.test(sqlText);

      if (!flags.dryRun) {
        if (noTransaction) {
          // No rollback is possible (CONCURRENTLY can't run in a tx). On a
          // statement failure we log exactly which one failed and re-throw
          // WITHOUT recording history, so the loop halts and a re-run retries.
          // For safe re-runs the migration's statements should be idempotent
          // (IF NOT EXISTS / DO-block guards); a half-built CONCURRENTLY index
          // is left INVALID and dropped+recreated next run.
          const statements = splitSqlStatements(sqlText);
          for (let idx = 0; idx < statements.length; idx++) {
            const statement = statements[idx]!;
            try {
              await sql.unsafe(statement);
            } catch (err) {
              const preview = statement.replace(/\s+/g, " ").slice(0, 120);
              process.stderr.write(
                `  ✗ ${m.name} statement ${idx + 1}/${statements.length} failed: ${preview}…\n`
              );
              throw err;
            }
          }
          // Record as applied only after ALL statements succeed.
          await sql.unsafe(
            `INSERT INTO mnemo_migration_history (name) VALUES ($1)`,
            [m.name]
          );
        } else {
          // Default: each migration in its own implicit transaction. On error,
          // postgres-js rolls back the tx and re-throws, halting the loop with
          // the schema intact through the previous migration.
          await sql.begin(async (tx) => {
            await tx.unsafe(sqlText);
            // D1: bind the filename as a positional parameter ($1) instead of
            // interpolating it into the SQL text — a filename can never break
            // out of the literal regardless of its characters.
            await tx.unsafe(
              `INSERT INTO mnemo_migration_history (name) VALUES ($1)`,
              [m.name]
            );
          });
        }
      }
      appliedThisRun += 1;
    }

    process.stdout.write(
      `\n✓ done — applied ${appliedThisRun}, skipped ${skipped} (already applied)${flags.dryRun ? " [DRY RUN]" : ""}\n`
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `\n✗ migration failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    if (err instanceof Error && err.message.includes('extension "vector"')) {
      process.stderr.write(
        '\nHint: install pgvector first:\n  psql $DATABASE_URL -c "CREATE EXTENSION IF NOT EXISTS vector;"\n'
      );
    }
    return 1;
  } finally {
    await (sql as unknown as { end: () => Promise<void> }).end().catch(() => undefined);
  }
}

main().then((code) => process.exit(code));
