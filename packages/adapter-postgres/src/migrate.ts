/**
 * Mnemosyne v3 — SQL migrations runner.
 *
 * Applies pending migrations from migrations/baseline/ in filename order.
 * Tracks applied migrations in mnemosyne.schema_migrations (created on first run).
 *
 * Usage (standalone CLI):
 *   DATABASE_URL=postgres://... node --import tsx/esm src/migrate.ts
 *   pnpm migrate  (inside @mnemo-ai/adapter-postgres)
 * The caller must supply a direct PostgreSQL or session-pooled URL. The
 * production Docker entrypoint enforces its dedicated migration URL separately.
 *
 * Usage (programmatic):
 *   import { migrate } from '@mnemo-ai/adapter-postgres/migrate';
 *   await migrate({ databaseUrl: process.env.DATABASE_URL! });
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";
import { splitSqlStatements } from "./sql-split.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve to the directory containing this file, then up to migrations/baseline/
// Works both from src/ (dev) and from dist/ (built).
const MIGRATIONS_DIR = join(__dirname, "..", "migrations", "baseline");
const MIGRATION_LOCK_CLASS_ID = 1835954031;
const MIGRATION_LOCK_OBJECT_ID = 1296649799;

const SCHEMA_MIGRATIONS_DDL = `
CREATE SCHEMA IF NOT EXISTS mnemosyne;
CREATE TABLE IF NOT EXISTS mnemosyne.schema_migrations (
  filename   TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum   TEXT        NOT NULL
);
`;

export interface MigrateOptions {
  /** Must connect directly to PostgreSQL or through a session-mode pooler. */
  databaseUrl: string;
  /** Override migrations directory (useful in tests). */
  migrationsDir?: string;
  log?: (msg: string) => void;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * List forward migration filenames bundled with this build, sorted (numeric
 * prefix sorts correctly). Excludes `*.down.sql` rollback files — same rule
 * `migrate()` applies when deciding what to run.
 *
 * Exported so callers that only need to know "what's the latest migration
 * this build expects" (e.g. a drift-detection health check) don't have to
 * duplicate the readdir/filter/sort logic or actually run a migration.
 */
export async function listMigrationFilenames(migrationsDir = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();
}

export async function migrate(opts: MigrateOptions): Promise<MigrationResult> {
  const log = opts.log ?? ((msg: string) => process.stdout.write(msg + "\n"));
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;

  const sql = postgres(opts.databaseUrl, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 10,
  });
  let connection: Awaited<ReturnType<typeof sql.reserve>> | undefined;
  let lockAcquired = false;

  try {
    connection = await sql.reserve();
    await connection`SELECT pg_advisory_lock(${MIGRATION_LOCK_CLASS_ID}, ${MIGRATION_LOCK_OBJECT_ID})`;
    lockAcquired = true;

    // Ensure the tracking table exists (idempotent).
    await connection.unsafe(SCHEMA_MIGRATIONS_DDL);

    // Load already-applied filenames.
    const rows = await connection<{ filename: string; checksum: string }[]>`
      SELECT filename, checksum FROM mnemosyne.schema_migrations ORDER BY filename
    `;
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

    // Discover FORWARD migration files sorted by name (numeric prefix sorts correctly).
    // CRITICAL: exclude `*.down.sql` rollback files. Without this, a down sorts before
    // its up ('.down.sql' < '.sql') and gets applied + tracked as a forward migration —
    // harmless for idempotent additive downs (DROP COLUMN IF EXISTS on a not-yet-created
    // column) but a DATA-LOSS risk for any down that drops something an earlier migration
    // created (e.g. 0020.down dropping a table 0010 made). Downs are applied only by the
    // rollback path, never by the forward runner.
    const files = await listMigrationFilenames(migrationsDir);

    const result: MigrationResult = { applied: [], skipped: [] };

    for (const filename of files) {
      const content = await readFile(join(migrationsDir, filename), "utf8");
      const checksum = createHash("sha256").update(content).digest("hex");

      if (applied.has(filename)) {
        const storedChecksum = applied.get(filename)!;
        if (storedChecksum !== checksum) {
          // Squash-successor detection: a regenerated baseline absorbs previously-applied
          // migrations. The squash header lists all absorbed files between "squash-of:" and
          // the closing "=====" fence. If every listed file was applied on this DB, the
          // checksum mismatch is safe to auto-heal: update the stored checksum and remove
          // the now-absorbed rows so the tracking table stays tidy.
          const squashSection = content.match(/--\s*squash-of:([\s\S]*?)--\s*={4,}/);
          if (squashSection) {
            const squashedFiles = squashSection[1]!.match(/\b[\w-]+\.sql\b/g) ?? [];
            if (squashedFiles.length > 0 && squashedFiles.every((f) => applied.has(f))) {
              await connection.unsafe("BEGIN");
              try {
                await connection`UPDATE mnemosyne.schema_migrations SET checksum = ${checksum} WHERE filename = ${filename}`;
                for (const squashedFile of squashedFiles) {
                  await connection`DELETE FROM mnemosyne.schema_migrations WHERE filename = ${squashedFile}`;
                }
                await connection.unsafe("COMMIT");
              } catch (err) {
                await connection.unsafe("ROLLBACK").catch(() => undefined);
                throw err;
              }
              log(
                `  heal  ${filename} (squash accepted, removed ${squashedFiles.length} absorbed migrations)`
              );
              result.skipped.push(filename);
              continue;
            }
          }
          throw new Error(
            `Migration ${filename} was modified after being applied. ` +
              `Stored checksum: ${storedChecksum.slice(0, 12)}…, ` +
              `Current: ${checksum.slice(0, 12)}…. ` +
              `Never edit applied migrations — create a new one instead.`
          );
        }
        log(`  skip  ${filename} (already applied)`);
        result.skipped.push(filename);
        continue;
      }

      // Reset session state leaked by a PREVIOUS migration before applying this
      // one. Every migration runs on the SAME connection (`max: 1` above), so a
      // non-local `SET` in one file silently changes the environment every later
      // file executes in.
      //
      // This is not hypothetical. 0001_v3_complete_baseline.sql is pg_dump
      // output, and pg_dump emits
      //   SELECT pg_catalog.set_config('search_path', '', false);
      // near the top. The `false` means NOT local: it persists for the rest of
      // the session, so on a FRESH database every migration after 0001 runs with
      // an empty search_path, while on an already-migrated database 0001 is
      // skipped and the same files run with the default `"$user", public`.
      // Two different environments for the same SQL, decided by whether the
      // database happened to be new — which is exactly the "only works on
      // already-patched databases" failure fresh-install-migrate.integration.test.ts
      // was written to catch.
      //
      // 0010 documents the trap and works around it by schema-qualifying every
      // name (`public.halfvec`, `public.vector_dims`). 0035 did not: it does
      // `CREATE EXTENSION unaccent SCHEMA public` and then references the
      // dictionary as bare `unaccent`, which resolves only if `public` is on the
      // path. Fresh install → `ERROR: text search dictionary "unaccent" does not
      // exist`; re-run against the same database → passes. Qualifying 0035 would
      // fix that one file, but the leak would keep re-arming for the next author
      // who writes an unqualified name, and editing an applied migration trips
      // the checksum guard above. Resetting here fixes the class of bug instead
      // of the instance, and changes no migration's checksum.
      //
      // Only `search_path` is reset, not `RESET ALL`: 0001 also leaks
      // `row_security = off` and `check_function_bodies = false`, and some later
      // migration may (correctly or not) depend on those still being in effect.
      // Widening this is a separate change with its own verification.
      await connection.unsafe("RESET search_path");

      log(`  apply ${filename} …`);
      // Check for the no-transaction marker (required for CONCURRENTLY — spec §35 line 4031).
      // A file whose first non-empty line is `-- migrate:no-transaction` is applied outside
      // a transaction so that CREATE INDEX CONCURRENTLY etc. can run successfully.
      const noTransaction = /--\s*migrate:no-transaction/i.test(content);
      if (noTransaction) {
        // No-transaction migrations legitimately contain `CREATE INDEX
        // CONCURRENTLY`, which Postgres rejects inside any transaction block.
        // Running the whole file as ONE `sql.unsafe(content)` would send it as a
        // single multi-statement simple query — an implicit transaction — and
        // CONCURRENTLY would fail. So split into top-level statements and run
        // each on its own, OUTSIDE any transaction. Each CONCURRENTLY index
        // then executes as a standalone simple query.
        //
        // There is no rollback here (CONCURRENTLY can't run in a tx, so the
        // file is inherently non-atomic). If a statement fails we log exactly
        // which one and re-throw WITHOUT recording the migration as applied, so
        // a re-run retries it. For this to be safely re-runnable the migration's
        // statements should be idempotent (the v3 no-transaction files use
        // IF NOT EXISTS / DO-block guards); a partially-applied CONCURRENTLY
        // index is left INVALID and is dropped+recreated on the next run.
        const statements = splitSqlStatements(content);
        for (let idx = 0; idx < statements.length; idx++) {
          const statement = statements[idx]!;
          try {
            await connection.unsafe(statement);
          } catch (err) {
            const preview = statement.replace(/\s+/g, " ").slice(0, 120);
            log(`  FAIL  ${filename} statement ${idx + 1}/${statements.length}: ${preview}…`);
            throw err;
          }
        }
        // Record as applied only after ALL statements succeed.
        await connection`
          INSERT INTO mnemosyne.schema_migrations (filename, checksum)
          VALUES (${filename}, ${checksum})
        `;
      } else {
        // Default: each migration runs in a single transaction.
        await connection.unsafe("BEGIN");
        try {
          await connection.unsafe(content);
          await connection`
            INSERT INTO mnemosyne.schema_migrations (filename, checksum)
            VALUES (${filename}, ${checksum})
          `;
          await connection.unsafe("COMMIT");
        } catch (err) {
          await connection.unsafe("ROLLBACK").catch(() => undefined);
          throw err;
        }
      }
      log(`  done  ${filename}`);
      result.applied.push(filename);
    }

    return result;
  } finally {
    try {
      if (connection) {
        if (lockAcquired) {
          await connection`SELECT pg_advisory_unlock(${MIGRATION_LOCK_CLASS_ID}, ${MIGRATION_LOCK_OBJECT_ID})`.catch(
            () => undefined
          );
        }
        connection.release();
      }
    } finally {
      await sql.end();
    }
  }
}

// CLI entry point — runs when executed directly, whether as the built JS
// (`node dist/migrate.js`, used by the Docker migrate image and the package's
function isMigrateMain(): boolean {
  if (!process.argv[1]) return false;
  const currentFilePath = fileURLToPath(import.meta.url);
  try {
    const realArgv = realpathSync(process.argv[1]);
    const realCurrent = realpathSync(currentFilePath);
    return realArgv === realCurrent;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMigrateMain()) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write("[migrate] DATABASE_URL environment variable is required\n");
    process.exit(1);
  }

  console.log("[migrate] Running Mnemosyne v3 migrations…");
  migrate({ databaseUrl })
    .then(({ applied, skipped }) => {
      console.log(`[migrate] Done. Applied: ${applied.length}, Skipped: ${skipped.length}`);
    })
    .catch((err) => {
      process.stderr.write(
        `[migrate] Error: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    });
}
