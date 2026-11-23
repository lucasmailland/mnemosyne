# SOC 2 Type II Controls Matrix

**Spec §35 lines 4319–4380**

**PENDING HUMAN OWNER(S)**: This controls matrix requires operational execution by:
- Org/compliance owner — access review schedule, quarterly review execution
- Legal/DPO — vendor DPA execution, SCCs, transfer impact assessments
- Security lead — break-glass approvals, security incident handling
- Auditor — SOC 2 engagement (3–12 month audit window per spec line 4323)

---

## Control Family 1: Access Management

| Control | Requirement | Automated? | Evidence Source |
|---|---|---|---|
| CC6.1 | Quarterly access reviews for all humans with DB/infra access | Manual | Spreadsheet + calendar invite per `docs/ops/incident-response.md` |
| CC6.2 | Same-day offboarding: API key revocation + DB role removal | Automated (partial) | `POST /v1/admin/keys/:id/revoke` → `mnemo_audit_log` |
| CC6.3 | Break-glass (`mk_admin_`) requires TOTP MFA + 24h TTL + two-person approval (a privileged op needs a grant approved by a second, distinct admin) | Automated | `ScopedApiKeyAdapter.ts` (`verifyTotp` + `ADMIN_MAX_TTL_MS`); `rbac-policy.ts` break-glass gate; `mnemo_break_glass_request` table |
| CC6.4 | Least privilege: scoped API keys, `getScopeForRequest` guards | Automated | `packages/server/src/auth.ts` — 15-scope guard |
| CC6.5 | IP allowlist enforcement for sensitive keys | Automated | `ScopedApiKeyAdapter.ts` — `ipInCidr` check |

---

## Control Family 2: Change Management

| Control | Requirement | Automated? | Evidence Source |
|---|---|---|---|
| CC7.1 | All schema changes via migration files (no direct DDL) | Automated | `migrate.ts` + `schema-safety.yml` CI workflow |
| CC7.2 | Migration safety lint: 5 checks + no-transaction marker | Automated | `migration-safety.ts` + `lintMigrationSet` |
| CC7.3 | Shadow-apply on staging before production | Manual + CI | `.github/workflows/schema-safety.yml` — PENDING staging wiring |
| CC7.4 | Deploy review required for production (deploy-request.md) | Manual | `docs/ops/deploy-request.md` — PENDING HUMAN OWNER |
| CC7.5 | Canary deploy with automated rollback on SLO breach | Automated | `SloRollbackMonitor.ts` + `deploy-canary.yml` |
| CC7.6 | DR restore tested weekly | Automated | `.github/workflows/test-restore.yml` |

---

## Control Family 3: Data Classification + Retention

Maps to the existing `Sensitivity` enum in `packages/types/src/common.ts:3` (line 3).

| Class | Sensitivity Value | Examples | Retention | Deletion |
|---|---|---|---|---|
| Public | `"public"` | Documentation, marketing | Indefinite | N/A |
| Internal | `"internal"` | Internal notes, non-PII memory | 2 years | Soft delete + purge at 24 months |
| Confidential | `"confidential"` | PII-adjacent memory, session transcripts | 1 year | Crypto-erasure via DEK rotation (Wave P1.2) |
| Restricted | `"restricted"` | PII facts, GDPR-sensitive data | 90 days | Immediate crypto-erasure on GDPR request |

**Enforcement**: Retention windows are enforced in code by the `mnemo.retention.purge`
daily cron (02:30 UTC). The cron iterates all workspaces and soft-closes facts that
exceed their tier window. For `confidential` and `restricted` tiers, actor DEKs are
crypto-erased via `destroyActorDek` once all encrypted facts for that actor have expired.

Configurable via env vars (defaults shown):
- `MNEMO_RETENTION_INTERNAL_DAYS=730`
- `MNEMO_RETENTION_CONFIDENTIAL_DAYS=365`
- `MNEMO_RETENTION_RESTRICTED_DAYS=90`
- `MNEMO_RETENTION_DRY_RUN=false` (set to `true` to audit without mutations)

Each workspace purge run appends one summary row to `mnemo_deletion_log` with
`deletion_type='retention_purge'` for audit evidence.

---

## Control Family 4: Monitoring + Logging

| Control | Requirement | Automated? | Evidence Source |
|---|---|---|---|
| CC4.1 | Tamper-evident audit log (Merkle chain) | Automated | `MerkleAuditChain.ts` (Wave P0.4) |
| CC4.2 | SLO burn-rate alerts wired to PagerDuty | Manual (wiring) | Wave V Prometheus rules — PENDING HUMAN OWNER (PD account) |
| CC4.3 | Structured logs (pino) with request IDs | Automated | `packages/server/src/index.ts` — pino middleware |
| CC4.4 | Slow-query threshold logging | Automated | `perf/slow-query.ts` — `withSlowQueryLog` |
| CC4.5 | Metrics endpoint `/metrics` (Prometheus) | Automated | `packages/server/src/metrics/index.ts` (Wave V1) |

---

## Control Family 5: Vendor Management

See `docs/compliance/vendor-management.md` for full sub-processor list.

| Vendor | Category | DPA Status | Annual Review |
|---|---|---|---|
| Neon / AWS RDS | Database hosting | PENDING | Q4 annually |
| Upstash / Redis Cloud | Cache hosting | PENDING | Q4 annually |
| OpenAI / Cohere | LLM/embedding | PENDING | Q4 annually |
| Fly.io / Railway | Container hosting | PENDING | Q4 annually |
| GitHub | Source control + CI | PENDING | Q4 annually |
| Datadog / Grafana Cloud | Observability | PENDING | Q4 annually |

**PENDING HUMAN OWNER**: Legal/DPO must execute vendor DPAs.

---

## Quarterly Checklist

- [ ] Access review: audit all humans with DB/infra access; remove stale permissions
- [ ] API key audit: run `SELECT keyId, lastUsedAt, status FROM mnemo_api_keys` — revoke unused
- [ ] Vendor review: confirm DPA currency for all sub-processors
- [ ] Incident review: walk through all SEV1/2 post-mortems for pattern analysis
- [ ] Evidence collection: run `bash scripts/collect-soc2-evidence.sh`

*Spec §35 lines 4327–4333*
