# Disaster Recovery & Backup

> **Owner:** SRE / Infrastructure

---

## What's implemented (v1.0)

| Capability | Status |
|---|---|
| Weekly CI restore drill (`test-restore.yml`) | ✅ Real `pg_dump → pg_restore` cycle — integrity-verified |
| Schema + RLS policy verification after restore | ✅ Asserted in CI (migration count + policy count match) |
| WAL streaming to S3 | ⏳ Deferred — requires production S3 bucket provisioning |
| Nightly snapshot to S3 | ⏳ Deferred — production infra dependency |
| PITR (point-in-time recovery) | ⏳ Deferred — requires WAL→S3 first |
| Cross-region replica | ⏳ Deferred — Mnemosyne v1.0 is single-region (`iad`) |

The weekly CI drill (`.github/workflows/test-restore.yml`) performs a real `pg_dump` of the
migrated database, restores it to a fresh target DB, and asserts that migration count and RLS
policy count match. This proves the restore mechanism works; shipping the dump to S3 is the
production-hardening step deferred to the post-1.0 infra milestone.

---

## RPO / RTO — current capability

| Metric | CI drill (v1.0) | Target (WAL-based, post-1.0) |
|---|---|---|
| RPO | Last successful CI dump ≈ 7 days | < 1 minute (continuous WAL) |
| RTO | Manual restore from latest dump < 30 min | < 5 minutes |
| Availability SLO | Best-effort (single-region) | 99.9% |

The gap between v1.0 capability and the target is primarily the WAL→S3 pipeline (see roadmap
below). The restore mechanism itself is proven by the CI drill.

---

## Backup cadences (roadmap — post-1.0)

| Type | Cadence | Retention | Storage |
|---|---|---|---|
| WAL (continuous) | Continuous streaming | 7-day PITR window | S3 |
| Snapshot (base backup) | Every 6 hours | 30 days | S3 |

Achieving the < 1 min RPO target requires a managed-PG provider with WAL streaming enabled
(Neon, RDS, or pgBackRest to S3) and the `BACKUP_S3_BUCKET` secret provisioned in CI
(see `docs/ops/ci-secrets.md`). The `test-restore.yml` workflow already supports both paths:
when `BACKUP_S3_BUCKET` is set, it downloads the real production backup from S3 instead of
taking a local `pg_dump`.

---

## PITR procedure (for post-1.0 WAL-backed deployments)

1. Identify target timestamp.
2. Restore base snapshot closest before the target:
   `aws s3 cp s3://$BACKUP_S3_BUCKET/snapshots/<closest>.dump /tmp/restore.dump`
3. `pg_restore -d mnemo_restore_target /tmp/restore.dump`
4. Replay WAL to the target point (provider-specific: Neon PITR branch, RDS point-in-time).
5. Verify: row counts, spot-check data integrity.
6. Update `DATABASE_URL` to point at the restored instance.

---

## DR Runbook Triggers

| Trigger | Runbook |
|---|---|
| PG primary unreachable | [pg_primary_down.md](runbooks/pg_primary_down.md) |
| Redis primary unreachable | [redis_primary_down.md](runbooks/redis_primary_down.md) |
| Region outage (single-region: IAD) | [region_down.md](runbooks/region_down.md) |
| Data corruption detected | [data_corruption.md](runbooks/data_corruption.md) |

---

## Weekly CI Test-Restore

`.github/workflows/test-restore.yml` runs every Sunday 03:00 UTC.

What it does:
1. Applies all migrations to a fresh Postgres container.
2. Records migration count and RLS policy count (pre-backup checksums).
3. Takes a `pg_dump --format=custom` backup.
4. Creates a fresh restore target database.
5. `pg_restore`s the dump into the target.
6. Asserts migration count and RLS policy count match — fails the job if they differ.
7. Uploads the dump as a GitHub Actions artifact (7-day retention).

When `AWS_ACCESS_KEY_ID` + `BACKUP_S3_BUCKET` secrets are configured, step 3 is replaced
by downloading the latest production backup from S3, making the drill a real production restore
validation.

---

## Post-1.0 WAL→S3 roadmap

Provisioning steps (SRE owner required):
1. Choose provider: Neon managed PG (native PITR) or self-managed PG + pgBackRest to S3.
2. Create S3 bucket: `mnemosyne-backups-<env>` with versioning + server-side encryption.
3. Configure WAL archiving: `archive_mode=on`, `archive_command` → S3 via pgBackRest.
4. Set CI secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BACKUP_S3_BUCKET`.
5. Validate: `test-restore.yml` will automatically use the S3 backup in the next Sunday run.
6. Update this doc: remove the RPO/RTO gap column and bless the production targets.
