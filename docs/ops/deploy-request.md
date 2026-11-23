# Schema Deploy-Request Process

> **Owner:** Release / Infra — PENDING HUMAN OWNER (sign-off required that this process matches real prod deploy gates)

Mnemosyne uses a PlanetScale-style schema deploy-request review: **schema migrations are decoupled from application deploys** and reviewed as a separate gate before the application rolls out.

---

## The 5 Migration Safety Checks (spec §35 lines 4027–4033)

Every new migration file is linted by `packages/adapter-postgres/src/migration-safety.ts` in CI (`schema-safety.yml`). Any violation fails the PR.

| Check                          | What is rejected                                                                  | Why                                             |
| ------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `no_table_locks_over_5s`       | `ADD COLUMN ... NOT NULL` without `DEFAULT`; `ADD CONSTRAINT` without `NOT VALID` | Long AccessExclusiveLock on large tables        |
| `no_column_drops_without_flag` | `DROP COLUMN` without `-- migrate:allow-drop reason=<text>` marker                | Phase-5 cleanup must be explicitly acknowledged |
| `no_type_changes_in_place`     | `ALTER COLUMN ... TYPE`                                                           | Full table rewrite + lock                       |
| `index_creation_concurrent`    | `CREATE INDEX` without `CONCURRENTLY`                                             | ShareLock during creation                       |
| `max_10_tables_per_deploy`     | >10 distinct tables touched across all new migration files in the PR              | Blast-radius limit                              |

---

## The `-- migrate:no-transaction` Marker

Files containing `CONCURRENTLY` (for index creation) **must** include this marker as the first non-empty line comment:

```sql
-- migrate:no-transaction
CREATE INDEX CONCURRENTLY idx_fact_workspace ON mnemosyne.mnemo_fact (workspace_id);
```

The runner (`migrate.ts`) detects this marker and applies the file **outside** a transaction, then records the migration row in a separate statement.

Without the marker, the runner wraps the file in `sql.begin()`, and PostgreSQL will immediately error: `CREATE INDEX CONCURRENTLY cannot run inside a transaction block`.

---

## The `-- migrate:allow-drop` Marker

`DROP COLUMN` is blocked unless the file contains an explicit reason:

```sql
-- migrate:allow-drop reason=phase5-cleanup-legacy_col-after-backfill
ALTER TABLE mnemosyne.mnemo_fact DROP COLUMN legacy_col;
```

The reason must be non-empty and describe the context. This forces a reviewable, auditable acknowledgement.

---

## 5-Phase Additive Column-Change Playbook (spec §35 lines 4038–4045)

Never alter a column type in place. Instead, use this 5-phase pattern:

| Phase | Migration                 | Description                                                                                          |
| ----- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1     | `0NNN_add_new_col.sql`    | `ADD COLUMN new_col <type>` (nullable)                                                               |
| 2     | `0NNN+1_backfill.sql`     | Batch backfill: `UPDATE ... SET new_col = old_col WHERE new_col IS NULL LIMIT 1000` (repeat offline) |
| 3     | App deploy                | Read from both columns; writes go to both                                                            |
| 4     | App deploy                | Reads from new column only; writes to new column only                                                |
| 5     | `0NNN+2_drop_old_col.sql` | `-- migrate:allow-drop reason=phase5-cleanup\nDROP COLUMN old_col;`                                  |

Never skip phases. Each phase must deploy and be stable before the next.

---

## Throttle / Auto-Rollback Policy

During the migration deployment window, the `SloRollbackMonitor` (AB4) watches the error-ratio series from Wave V's Prometheus metrics.

- If the error rate delta rises above 1% relative to baseline during migration → **halt deploy + auto-rollback** the migration.
- The canary deployment stages (one machine → half the machines → all, `scripts/canary-rollout.mjs`) are each gated by `evaluateCanary` (`packages/core/src/cognitive/canary.ts`); see `docs/deploy/SERVICES.md` section 8.

---

## Rollout Order

1. **Schema deploy request** — open a PR with only migration file(s). Lint + shadow-apply CI must pass.
2. **Schema review** — a second eng reviews the migration against this playbook.
3. **Schema apply** — the migration is applied to prod (during low-traffic window). Monitor error rates.
4. **Application deploy** — the app deploys after the schema migration is stable.

This separation prevents the app from starting before its schema is ready and prevents rollback of the app from being blocked by the schema.
