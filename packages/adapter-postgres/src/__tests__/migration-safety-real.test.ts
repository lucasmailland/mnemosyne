import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintMigration } from "../migration-safety.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations", "baseline");

/**
 * Lint all committed baseline migrations with the per-file safety rules.
 *
 * We use `lintMigration` (not `lintMigrationSet`) so the cross-file
 * `max_10_tables_per_deploy` blast-radius check does not false-positive
 * against the squash baseline (which legitimately creates 50+ tables).
 *
 * The squash baseline is a fresh-install file (pg_dump + manual cleanup):
 * - `ADD CONSTRAINT PRIMARY KEY/UNIQUE` on freshly-created tables is safe
 *   (tables are brand-new; lock is instantaneous).
 * - `CREATE INDEX ON ONLY` (for partitioned table parents) is safe: all
 *   tables including the partitioned parent are created in this same file.
 * - These two patterns are false positives of the per-row linter checks
 *   designed for incremental migrations, not comprehensive baselines.
 *
 * Checks that DO apply to the squash file and are tested here:
 *   1. no_column_drops_without_flag  (DROP COLUMN without allow-drop marker)
 *   2. no_type_changes_in_place      (ALTER COLUMN ... TYPE)
 *   3. concurrently_requires_no_transaction
 *                                    (CONCURRENTLY without no-transaction marker)
 *
 * If this test fails, fix the offending migration — do NOT weaken the linter.
 */
describe("real v3 migrations pass the per-file safety linter", () => {
  it("lintMigration reports no violations across migrations/baseline/*.sql", () => {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({
        filename: f,
        sql: readFileSync(join(migrationsDir, f), "utf8"),
      }));

    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap(({ filename, sql }) => lintMigration(sql, { filename }));

    // For the squash baseline these checks produce false positives:
    //   - index_creation_concurrent: the linter doesn't handle `ON ONLY <table>` (partitioned
    //     parent syntax) so it misidentifies the target as "only" and can't confirm the table
    //     was created in this file. All tables are created here, so these are safe.
    //   - no_table_locks_over_5s: ADD CONSTRAINT PRIMARY KEY/UNIQUE in pg_dump output has no
    //     NOT VALID clause, but the tables are freshly created in the same file — lock is
    //     instantaneous. This rule targets ADD CONSTRAINT on pre-existing large tables.
    //   - grant_completeness / rls_policy_completeness (SAFE-1): `lintMigration` is
    //     necessarily per-file (no cross-migration state) — SAFE-1 found 11 real GRANT
    //     gaps across 0001/0008, but the fix landed in a LATER file (0014, per this repo's
    //     "never edit a shipped migration" convention), which is invisible when scanning
    //     0001/0008 in isolation. Real-DB coverage for the actual fix lives in
    //     app-role-grants.integration.test.ts (has_table_privilege against a migrated
    //     container), not here. The remaining 3 tables these checks flag
    //     (mnemo_scoped_api_keys, mnemo_scoped_key_escrow, mnemo_scoped_key_usage) are a
    //     deliberate architectural exception, same as mnemo_api_keys (see
    //     DrizzleApiKeyStore.ts and migration 0014's own comment) — intentionally never
    //     granted, since auth lookups against them run pre-workspace-GUC over the bootstrap
    //     connection, not as mnemo_app_role.
    //
    // All other checks (DROP COLUMN, TYPE changes, CONCURRENTLY marker) must be clean.
    const relevantViolations = violations.filter(
      (v) =>
        v.check !== "index_creation_concurrent" &&
        v.check !== "no_table_locks_over_5s" &&
        v.check !== "grant_completeness" &&
        v.check !== "rls_policy_completeness" &&
        // APP-048: the duplicate-check rule binds migrations written after it
        // (0076+); the history before it is applied and checksummed.
        !(v.check === "unique_index_duplicate_check" && Number(v.file?.slice(0, 4)) < 76)
    );

    expect(relevantViolations, JSON.stringify(relevantViolations, null, 2)).toEqual([]);
  });
});
