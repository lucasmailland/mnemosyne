#!/usr/bin/env node
/**
 * CI script: lint migration files for safety violations.
 *
 * Usage:
 *   node scripts/lint-migrations.mjs [--per-file] [file1.sql file2.sql ...]
 *
 * Modes:
 *   (default)    lintMigrationSet: runs all per-file checks + the
 *                max_10_tables_per_deploy blast-radius check across the set.
 *                Use for PR-added files (enforces per-deploy blast-radius).
 *
 *   --per-file   lintMigration per file: runs only the per-file checks
 *                (no cross-file blast-radius). Use for linting the full
 *                committed set — the repo legitimately spans many tables.
 *                In this mode, PER_FILE_MODE_EXEMPT_CHECKS below are excluded
 *                — they're structurally per-file-blind (can't see a fix that
 *                landed in a later migration, or that a partitioned/freshly-
 *                created table's lock is instantaneous) and produce known
 *                false positives against the sanctioned squash baseline. This
 *                mirrors packages/adapter-postgres/src/__tests__/
 *                migration-safety-real.test.ts, which documents the exact
 *                same exemptions (and why) for the same reason.
 *
 * If no files provided, falls back to git diff to find added migration files.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dynamically import the linter (compiled or source via tsx)
async function getLinter() {
  // Try compiled dist first, fall back to tsx source
  const distPath = join(
    __dirname,
    "..",
    "packages",
    "adapter-postgres",
    "dist",
    "migration-safety.js"
  );
  const srcPath = join(
    __dirname,
    "..",
    "packages",
    "adapter-postgres",
    "src",
    "migration-safety.ts"
  );
  try {
    return await import(distPath);
  } catch {
    // In CI, source is available via tsx/ts-node
    try {
      return await import(srcPath);
    } catch {
      throw new Error(
        "Cannot find migration-safety module. Run: pnpm --filter @mnemo-ai/adapter-postgres build"
      );
    }
  }
}

async function getAddedMigrationFiles(rawArgs) {
  // CLI args first (excluding flags)
  const args = rawArgs.filter((f) => f.endsWith(".sql"));
  if (args.length > 0) return args;

  // Then git diff against the base branch. Re-audit 2026-11-22 (defect 12):
  // a git error used to mean "no new migrations" and the step passed with
  // nothing linted. Now every base is tried and none answering is a failure.
  const bases = process.env.MNEMO_MIGRATION_BASE
    ? [process.env.MNEMO_MIGRATION_BASE]
    : ["origin/main", "main"];
  let stdout = null;
  for (const base of bases) {
    try {
      ({ stdout } = await execFileAsync("git", [
        "diff",
        "--name-only",
        "--diff-filter=A",
        `${base}...HEAD`,
      ]));
      break;
    } catch {
      // try the next base
    }
  }
  if (stdout === null) {
    throw new Error(
      `cannot find the base branch (${bases.join(", ")}) to list new migrations; fetch it or set MNEMO_MIGRATION_BASE`
    );
  }
  {
    return stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(
        (f) =>
          f.endsWith(".sql") &&
          // APP-048: migrations live in baseline/ since the squash; filtering on
          // the old directories alone made this mode lint nothing and pass.
          (f.includes("migrations/baseline/") ||
            f.includes("migrations/v3-squash/") ||
            f.includes("migrations/v3-archive/"))
      )
      .map((f) => resolve(f));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const perFile = argv.includes("--per-file");
  const rawArgs = argv.filter((a) => a !== "--per-file");

  const { lintMigration, lintMigrationSet } = await getLinter();
  const files = await getAddedMigrationFiles(rawArgs);

  if (files.length === 0) {
    process.stdout.write("[lint-migrations] No new migration files to lint.\n");
    process.exit(0);
  }

  process.stdout.write(
    `[lint-migrations] Linting ${files.length} file(s)${perFile ? " (per-file mode)" : ""}...\n`
  );

  const fileData = files.map((f) => ({
    filename: f,
    sql: readFileSync(f, "utf8"),
  }));

  // See the module doc comment above and migration-safety-real.test.ts for
  // why these 4 checks are excluded specifically in --per-file mode: each is
  // structurally per-file-blind and produces known false positives against
  // the sanctioned squash baseline (0001) and 0008 specifically — real gaps
  // they found were fixed by 0011 (RLS policy) and 0014 (11 missing GRANTs),
  // both later files this per-file scan can't see when linting 0001/0008 in
  // isolation. New migrations added going forward are NOT exempt — this
  // list only softens the "lint everything we've already shipped" mode.
  const PER_FILE_MODE_EXEMPT_CHECKS = new Set([
    "index_creation_concurrent",
    "no_table_locks_over_5s",
    "grant_completeness",
    "rls_policy_completeness",
    // APP-048 rule, for new migrations; the applied history predates it.
    "unique_index_duplicate_check",
  ]);

  const rawViolations = perFile
    ? fileData.flatMap(({ filename, sql }) => lintMigration(sql, { filename }))
    : lintMigrationSet(fileData);
  const violations = perFile
    ? rawViolations.filter((v) => !PER_FILE_MODE_EXEMPT_CHECKS.has(v.check))
    : rawViolations;

  if (violations.length === 0) {
    process.stdout.write("[lint-migrations] All checks passed.\n");
    process.exit(0);
  }

  for (const v of violations) {
    const loc = v.file ? `${v.file}${v.line ? `:${v.line}` : ""}` : "(set-level)";
    process.stderr.write(`${loc}:${v.check}:${v.message}\n`);
  }
  process.stderr.write(
    `[lint-migrations] ${violations.length} violation(s) found. Fix them before merging.\n`
  );
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`[lint-migrations] Error: ${err.message}\n`);
  process.exit(1);
});
