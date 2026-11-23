# SOC 2 Evidence Collection Guide

> Spec §35 — AB8 compliance automation

> ⚠️ **ALPHA TEMPLATE — produces stubs in the current alpha environment.** The `collect-soc2-evidence.sh` script is a template. When `DATABASE_URL` is not set (the default in alpha), it writes a stub for `access-logs.csv` instead of real data. When `PROMETHEUS_URL` is not set (also the alpha default), `uptime-metrics.txt` contains only the SLO targets text plus manual instructions, not actual uptime data. No formal SOC 2 audit scope has been defined, no auditor has been engaged, and the incident history and PagerDuty exports referenced in this guide do not yet exist. Do not submit the output of this script to an auditor without first confirming every artifact contains real data, not stubs.

## Overview

The `collect-soc2-evidence.sh` script automates evidence gathering for SOC 2 Type II audits.
Run it at the start of each audit window (quarterly recommended) and retain the output bundle.

## Running the Script

```bash
# From the repo root
bash scripts/collect-soc2-evidence.sh
```

Output: `soc2-evidence-YYYYMMDD/` directory containing 5 artifacts.

### Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | For Artifact 1 | Postgres connection string. If absent, a stub is written. |
| `PROMETHEUS_URL` | For Artifact 5 | Prometheus base URL. If absent, manual instructions are included. |

### Running with Production Access

```bash
# Set DB and Prometheus access, then run
DATABASE_URL="postgres://user:pass@host/db?sslmode=require" \
PROMETHEUS_URL="https://prom.internal" \
bash scripts/collect-soc2-evidence.sh
```

## Artifacts Produced

### 1. `access-logs.csv`

**SOC 2 Control Family:** Access Controls (CC6.x)

Exports the last 90 days of `mnemo_audit_log` rows:
`actor_id, actor_type, event_type, workspace_id, created_at, ip_address`

For the live export to succeed, `DATABASE_URL` must be set and the `psql` client must be installed.

**Auditor use:** Demonstrates that all access to customer data is logged and attributable.

### 2. `deploy-history.txt`

**SOC 2 Control Family:** Change Management (CC8.x)

Git log for the last 90 days plus CI run export instructions.

For full CI history, also export from GitHub Actions:

```bash
gh run list --limit 200 --json databaseId,createdAt,status,headBranch,workflowName \
  > soc2-evidence-$(date +%Y%m%d)/ci-runs.json
```

**Auditor use:** Demonstrates that all changes go through version-controlled, reviewed deployments.

### 3. `encryption-proof.txt`

**SOC 2 Control Family:** Data Classification (PI1.x) + Additional Criteria

Snapshot of encryption configuration:
- At-rest: managed provider AES-256
- In-transit: TLS 1.2+ + Postgres SSL
- API key hashing: argon2id
- DEK crypto-erasure: GDPR right-to-forget

**Auditor use:** Demonstrates that data is encrypted at rest and in transit per SOC 2 CC6.7.

### 4. `incident-history.txt`

**SOC 2 Control Family:** Monitoring (CC7.x) + Availability Criteria

Index of `docs/ops/postmortems/` plus PagerDuty export instructions.

For full incident history:
```bash
# Export PagerDuty incidents (requires pd CLI)
pd incidents:list --since 90days --output json \
  > soc2-evidence-$(date +%Y%m%d)/pagerduty-incidents.json
```

**Auditor use:** Demonstrates that security incidents are detected, responded to, and documented.

### 5. `uptime-metrics.txt`

**SOC 2 Control Family:** Availability Criteria (A1.x)

SLO targets plus instructions for exporting from Grafana/Prometheus. For full metrics:

```promql
# API availability over 30 days
sum(rate(http_requests_total{job="mnemosyne-api", status_code!~"5.."}[30d]))
/
sum(rate(http_requests_total{job="mnemosyne-api"}[30d]))
```

Export the Grafana SLO burn-rate dashboard as PDF and add to the bundle:
`soc2-evidence-YYYYMMDD/slo-dashboard.pdf`

**Auditor use:** Demonstrates that the system meets its 99.9% availability commitment.

## Storing Evidence Bundles

1. Run the script before each quarterly audit window
2. Upload the `soc2-evidence-YYYYMMDD/` directory to your designated evidence vault
   (e.g., Vanta, Drata, Secureframe, or a locked S3 bucket)
3. Retain bundles for a minimum of 12 months (SOC 2 Type II covers a 12-month period)
4. Never delete bundles while an audit is open

## Checklist Before Sharing with Auditors

- [ ] `access-logs.csv` contains real data (not a stub)
- [ ] `deploy-history.txt` includes CI run export (`ci-runs.json`)
- [ ] `encryption-proof.txt` reviewed and accurate
- [ ] `incident-history.txt` supplemented with PagerDuty export
- [ ] `uptime-metrics.txt` supplemented with Grafana PDF export (`slo-dashboard.pdf`)
- [ ] Bundle uploaded to evidence vault
- [ ] Bundle retention confirmed (minimum 12 months)

## Relevant Source Files

| Artifact | Primary Source |
|---|---|
| Access logs | `packages/adapter-postgres/migrations/v3/0030_audit_log.sql` |
| Encryption config | `packages/server/src/auth/ScopedApiKeyAdapter.ts` |
| DEK rotation | `packages/adapter-postgres/migrations/v3/` (mnemo_actor_dek table) |
| SLO metrics | `packages/server/src/metrics/index.ts` (Wave V Prometheus) |
| Incident runbooks | `docs/ops/runbooks/` |
| Vendor registry | `docs/compliance/vendor-management.md` |

## Related Documents

- `docs/compliance/soc2-controls.md` — Full controls matrix
- `docs/compliance/vendor-management.md` — Sub-processor registry
- `docs/ops/incident-response.md` — SEV1/2/3 definitions and runbooks
- `docs/ops/status-page.md` — Public availability page
