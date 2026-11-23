# CI/CD Secrets

This document lists all secrets required by CI workflows, their purpose, and the team
responsible for provisioning them in GitHub Actions (Settings → Secrets → Actions).

## Secrets by Workflow

### `.github/workflows/test-restore.yml` — Backup Restore Verification

| Secret | Description | Owner |
|--------|-------------|-------|
| `AWS_ACCESS_KEY_ID` | AWS credentials for reading from backup S3 bucket | Platform / Infra |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials secret | Platform / Infra |
| `BACKUP_S3_BUCKET` | S3 bucket name containing Mnemosyne backups | Platform / Infra |

This workflow tests that backups can be restored. Requires read access to the S3 bucket
where Mnemosyne's PostgreSQL backups are stored. The `scripts/test-restore.sh` script
also uses `BACKUP_S3_BUCKET` and the AWS credentials for production restore runs.

### `.github/workflows/chaos.yml` — Chaos Engineering

| Secret | Description | Owner |
|--------|-------------|-------|
| `STAGING_DATABASE_URL` | PostgreSQL connection URL for staging environment | Platform / Infra |
| `STAGING_REDIS_URL` | Redis connection URL for staging environment | Platform / Infra |

This workflow runs weekly chaos experiments against staging. Additionally requires the
staging GitHub Actions environment to have `MNEMO_CHAOS_ENABLED=true` set as a variable
(not a secret — add directly to the environment's Variables section in GitHub).

### `.github/workflows/deploy-canary.yml` — Canary Deployment

| Secret | Description | Owner |
|--------|-------------|-------|
| `FLY_API_TOKEN` | Fly.io API token for deploying the canary instance (scope: mnemosyne app) | Platform / Infra |
| `PROMETHEUS_URL` | Base URL of the Prometheus endpoint for SLO evaluation (e.g. `https://prometheus.internal/api/v1`) | Observability |

## Provisioning Steps

1. Go to GitHub repository → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add each secret listed above with the appropriate value
4. For `MNEMO_CHAOS_ENABLED`, go to Settings → Environments → staging → Variables instead
5. Notify the owner team when provisioned

## Status

| Secret | Status |
|--------|--------|
| `AWS_ACCESS_KEY_ID` | Pending provisioning |
| `AWS_SECRET_ACCESS_KEY` | Pending provisioning |
| `BACKUP_S3_BUCKET` | Pending provisioning |
| `STAGING_DATABASE_URL` | Pending provisioning |
| `STAGING_REDIS_URL` | Pending provisioning |
| `FLY_API_TOKEN` | Pending provisioning |
| `PROMETHEUS_URL` | Pending provisioning |
