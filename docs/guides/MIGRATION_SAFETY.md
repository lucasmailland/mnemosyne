# Migration Safety Guide

**English** · [Español](MIGRATION_SAFETY.es.md)

This guide explains how to write safe database migrations for Mnemosyne and how to use the migration safety linter.

## Overview

Mnemosyne enforces zero-downtime schema migrations through automated safety checks. Every migration must pass the migration-safety linter before merging. The linter detects unsafe DDL patterns that can cause production downtime.

## Quick Start

### Running the Linter

```bash
# Lint all committed baseline migrations
pnpm lint:migrations

# Lint specific migration files
node scripts/lint-migrations.mjs path/to/migration.sql

# Lint in per-file mode (for committed sets, skips cross-file blast-radius check)
node scripts/lint-migrations.mjs --per-file packages/adapter-postgres/migrations/baseline/*.sql
```

### CI Enforcement

The linter runs automatically in CI on every PR that touches migrations:

- **Per-file checks** on ALL committed migrations (5 safety rules)
- **Full checks** on newly added migrations (5 safety rules + blast-radius limit)

See `.github/workflows/schema-safety.yml` for the CI configuration.

### Unit Test

The committed migration set is also tested via `migration-safety-real.test.ts`:

```bash
pnpm --filter @mnemo-ai/adapter-postgres test migration-safety-real
```

## Safety Rules

The linter enforces 5 core safety rules plus 1 derived rule:

### 1. `no_table_locks_over_5s`

**Violation:** `ADD COLUMN NOT NULL` without `DEFAULT`, or `ADD CONSTRAINT` (FK/CHECK) without `NOT VALID`.

**Why it's unsafe:** Both operations scan the entire table and hold an `AccessExclusiveLock`, blocking all reads and writes.

**Safe pattern:**

```sql
-- ✅ Correct: ADD COLUMN with DEFAULT
ALTER TABLE mnemo_fact
  ADD COLUMN new_col TEXT NOT NULL DEFAULT 'placeholder';

-- ✅ Correct: ADD CONSTRAINT with NOT VALID, then VALIDATE later
ALTER TABLE mnemo_fact
  ADD CONSTRAINT fk_workspace FOREIGN KEY (workspace_id)
    REFERENCES mnemo_workspace(id) NOT VALID;

-- In a subsequent migration (after backfill if needed):
ALTER TABLE mnemo_fact VALIDATE CONSTRAINT fk_workspace;
```

**Exception:** Fresh tables created in the same migration can use `ADD CONSTRAINT` without `NOT VALID` (tables are empty, validation is instantaneous). Use the `-- migrate:allow-table-locks reason=<text>` marker for baseline files.

### 2. `no_column_drops_without_flag`

**Violation:** `DROP COLUMN` without an explicit acknowledgment marker.

**Why it's unsafe:** Column drops are irreversible and can break running application code that still references the column.

**Safe pattern:**

```sql
-- migrate:allow-drop reason=column no longer used after deploy X

ALTER TABLE mnemo_fact
  DROP COLUMN deprecated_field;
```

**Best practice:** Use a 3-phase drop:

1. Migration 1: Make column nullable (if not already), remove NOT NULL constraint
2. Deploy: Remove all application references to the column
3. Migration 2: Add `allow-drop` marker and drop the column

### 3. `no_type_changes_in_place`

**Violation:** `ALTER COLUMN ... TYPE`

**Why it's unsafe:** Type changes rewrite the entire table, holding an `AccessExclusiveLock` for the duration.

**Safe pattern (5-phase additive):**

```sql
-- Phase 1: Add new column (nullable, no NOT NULL)
ALTER TABLE mnemo_fact ADD COLUMN status_new TEXT;

-- Phase 2: Backfill via batched UPDATE (done outside the migration, or via a background job)

-- Phase 3: Make the new column NOT NULL with DEFAULT (in a new migration, after backfill)
ALTER TABLE mnemo_fact ALTER COLUMN status_new SET DEFAULT 'active';
ALTER TABLE mnemo_fact ALTER COLUMN status_new SET NOT NULL;

-- Phase 4: Deploy application code to use status_new

-- Phase 5: Drop old column (in a new migration, with allow-drop marker)
-- migrate:allow-drop reason=status_new fully adopted
ALTER TABLE mnemo_fact DROP COLUMN status;
```

**Exception marker:** Use `-- migrate:allow-type-change reason=<text>` for cases where the 5-phase pattern isn't practical — e.g., dropping a fixed-dimension constraint from a `vector`/`halfvec` column so it accepts multiple embedding dimensions (see `0009_unconstrained_halfvec.sql`). Use only when the in-place `ALTER COLUMN ... TYPE` is verified safe (e.g., a widening/unconstraining change with no data rewrite risk).

### 4. `index_creation_concurrent`

**Violation:** `CREATE INDEX` without `CONCURRENTLY` on a pre-existing table.

**Why it's unsafe:** Plain `CREATE INDEX` takes a `ShareLock` on the table, blocking all writes.

**Safe pattern:**

```sql
-- migrate:no-transaction

SET search_path TO mnemosyne;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fact_workspace_valid
  ON mnemo_fact (workspace_id, valid_from)
  WHERE valid_to IS NULL;
```

**Exception:** Indexes on tables created in the same migration (brand-new, empty tables) can use plain `CREATE INDEX` without `CONCURRENTLY`. The linter automatically allows this pattern.

**Exception marker:** Use `-- migrate:allow-non-concurrent-index reason=<text>` for cases where you need a plain index on a new table but want to make the exception explicit.

### 5. `max_10_tables_per_deploy`

**Violation:** A migration set (all files in a single deploy) touches more than 10 distinct tables.

**Why it's unsafe:** Blast radius control — limiting the number of tables per deploy reduces the scope of potential rollback complexity.

**Safe pattern:** Split large migrations into multiple PRs/deploys, each touching ≤10 tables.

**Note:** This check only runs in default mode (`lintMigrationSet`), not in `--per-file` mode. The full committed baseline legitimately spans 50+ tables.

### 6. `concurrently_requires_no_transaction` (derived)

**Violation:** Using `CONCURRENTLY` without the `-- migrate:no-transaction` marker.

**Why it's unsafe:** `CONCURRENTLY` operations cannot run inside a transaction block. The migration runner wraps each migration in a transaction by default.

**Safe pattern:**

```sql
-- migrate:no-transaction

CREATE INDEX CONCURRENTLY ...
```

## Safety Markers

Markers are special comments at the top of a migration file that opt into specific behaviors:

### `-- migrate:no-transaction`

Runs the migration outside a transaction. **Required** for `CONCURRENTLY` operations.

```sql
-- migrate:no-transaction

CREATE INDEX CONCURRENTLY ...
```

### `-- migrate:allow-drop reason=<text>`

Explicitly acknowledges a `DROP COLUMN` operation. The `reason=<text>` part is mandatory and should explain why the drop is safe.

```sql
-- migrate:allow-drop reason=column removed in deploy 2024-06-15, no app references

ALTER TABLE mnemo_fact DROP COLUMN deprecated_field;
```

### `-- migrate:allow-non-concurrent-index reason=<text>`

Allows a plain (non-CONCURRENT) `CREATE INDEX` on a pre-existing table. Use only when necessary (e.g., the table is known to be empty, or the migration must be transactional).

```sql
-- migrate:allow-non-concurrent-index reason=table is empty in production

CREATE INDEX idx_new ON mnemo_new_table (col);
```

### `-- migrate:allow-table-locks reason=<text>`

Allows `ADD COLUMN NOT NULL` without `DEFAULT` or `ADD CONSTRAINT` without `NOT VALID`. Use only for baseline/squash files where all tables are freshly created in the same file.

```sql
-- migrate:allow-table-locks reason=baseline file, all tables created here

CREATE TABLE mnemo_fact (...);
ALTER TABLE mnemo_fact ADD CONSTRAINT pk_fact PRIMARY KEY (id);
```

### `-- migrate:allow-type-change reason=<text>`

Explicitly acknowledges an `ALTER COLUMN ... TYPE` operation instead of the 5-phase additive pattern. The `reason=<text>` part is mandatory and should explain why the in-place type change is safe.

```sql
-- migrate:allow-type-change reason=unconstrain_halfvec_columns_for_multi_dimension_support

ALTER TABLE mnemo_fact ALTER COLUMN embedding TYPE halfvec;
```

## Common Patterns

### Adding a NOT NULL Column

```sql
-- Phase 1: Add nullable column with DEFAULT
ALTER TABLE mnemo_fact
  ADD COLUMN new_col TEXT DEFAULT 'placeholder';

-- Phase 2: Backfill NULLs (if any) via batched UPDATE outside the migration

-- Phase 3: Make NOT NULL (in a new migration, after backfill)
ALTER TABLE mnemo_fact ALTER COLUMN new_col SET NOT NULL;
```

### Adding a Foreign Key

```sql
-- Phase 1: Add the column (nullable)
ALTER TABLE mnemo_fact
  ADD COLUMN workspace_id UUID;

-- Phase 2: Backfill the column via batched UPDATE

-- Phase 3: Add constraint with NOT VALID (in a new migration)
ALTER TABLE mnemo_fact
  ADD CONSTRAINT fk_workspace FOREIGN KEY (workspace_id)
    REFERENCES mnemo_workspace(id) NOT VALID;

-- Phase 4: VALIDATE later (in a new migration or after confirming backfill)
ALTER TABLE mnemo_fact VALIDATE CONSTRAINT fk_workspace;

-- Phase 5: Make NOT NULL (in a new migration)
ALTER TABLE mnemo_fact ALTER COLUMN workspace_id SET NOT NULL;
```

### Creating an Index

For incremental migrations (not baseline):

```sql
-- migrate:no-transaction

SET search_path TO mnemosyne;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fact_workspace
  ON mnemo_fact (workspace_id);
```

For new tables created in the same migration:

```sql
CREATE TABLE mnemo_new_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  -- ...
);

-- Plain index is safe: table is brand-new and empty
CREATE INDEX idx_new_table_workspace ON mnemo_new_table (workspace_id);
```

## Baseline Migrations vs Incremental Migrations

### Baseline Migrations

Baseline migrations (e.g., `0001_v3_complete_baseline.sql`) are full-schema snapshots for fresh installs. They:

- Create all tables from scratch (pg_dump output + manual cleanup)
- Can use plain `CREATE INDEX` and `ADD CONSTRAINT` without `NOT VALID` (all tables are brand-new and empty)
- Must still avoid `DROP COLUMN` and `ALTER COLUMN TYPE`

The linter's test suite filters out `index_creation_concurrent` and `no_table_locks_over_5s` violations for baseline files because these patterns are safe when all tables are created in the same file.

### Incremental Migrations

Incremental migrations (e.g., `0008_session_active_prompt_version_index.sql`) modify existing production tables. They:

- **Must** use `CONCURRENTLY` for index creation
- **Must** use `NOT VALID` for constraint addition
- **Must** use the 5-phase additive pattern for type changes
- **Must** add markers for `DROP COLUMN`

## CI and Local Development

### Pre-commit Hook

You can add a pre-commit hook to lint migrations before committing:

```bash
#!/bin/bash
# .git/hooks/pre-commit

# Lint staged migration files
STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep 'migrations/.*\.sql$' || true)

if [ -n "$STAGED" ]; then
  echo "Linting staged migrations..."
  echo "$STAGED" | xargs node scripts/lint-migrations.mjs
  if [ $? -ne 0 ]; then
    echo "Migration safety check failed. Fix violations before committing."
    exit 1
  fi
fi
```

### Local Testing

Before pushing:

1. Run the linter locally:

   ```bash
   pnpm lint:migrations
   ```

2. Run the unit test:

   ```bash
   pnpm --filter @mnemo-ai/adapter-postgres test migration-safety-real
   ```

3. Test the migration against a shadow database:
   ```bash
   # Start a test Postgres instance
   pnpm docker:up

   # Apply migrations
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mnemo_test \
     node packages/adapter-postgres/dist/migrate.js
   ```

## Troubleshooting

### "CREATE INDEX without CONCURRENTLY" on a new table

If you're creating an index on a table that was created in the same migration, the linter should auto-detect this and skip the warning. If it doesn't:

1. Verify the table name matches exactly (case-insensitive, without schema prefix)
2. Ensure the `CREATE TABLE` statement is in the same file
3. If the linter still complains, add `-- migrate:allow-non-concurrent-index reason=new table created in this file`

### "ADD CONSTRAINT without NOT VALID" on a baseline file

Baseline files legitimately create constraints on brand-new tables. Add the marker:

```sql
-- migrate:allow-table-locks reason=baseline file, all tables fresh
```

### "max_10_tables_per_deploy" false positive

This check only runs in default mode, not `--per-file` mode. The CI uses `--per-file` for the committed baseline set, so this should not trigger. If you're adding many new migrations in a single PR:

- Split the PR into multiple deploys, each touching ≤10 tables
- Or, if legitimately needed (e.g., a coordinated schema change), discuss with the team

## References

- **Spec**: `docs/research/MEMORY_MODEL.md` §35 "Zero-Downtime Schema Migrations" (lines 4027–4033)
- **Implementation**: `packages/adapter-postgres/src/migration-safety.ts`
- **CI Workflow**: `.github/workflows/schema-safety.yml`
- **Test Suite**: `packages/adapter-postgres/src/__tests__/migration-safety-real.test.ts`
- **Script**: `scripts/lint-migrations.mjs`

## Examples from the Codebase

### Fixed: Migration 0008 (Session Active Prompt Version Index)

**Before (unsafe):**

```sql
CREATE INDEX IF NOT EXISTS idx_mnemo_session_active_prompt_version
  ON mnemo_session (workspace_id, active_prompt_version_id)
  WHERE active_prompt_version_id IS NOT NULL;
```

**After (safe):**

```sql
-- migrate:no-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mnemo_session_active_prompt_version
  ON mnemo_session (workspace_id, active_prompt_version_id)
  WHERE active_prompt_version_id IS NOT NULL;
```

**Why:** The `mnemo_session` table already exists in production. Creating a plain index would take a `ShareLock` and block all writes. `CONCURRENTLY` allows concurrent writes, and `no-transaction` is required for `CONCURRENTLY` to work.
