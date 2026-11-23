# Incident Response Runbook

> **v1.0 operational status:** Severity definitions, escalation paths, and post-mortem templates in this document are the active v1.0 procedure. PagerDuty integration and an automated on-call rotation require a PagerDuty account and team headcount — these are post-1.0 ops milestones. Until then: follow the manual escalation path (SEV1 → page primary on-call; SEV2 → Slack #incidents). The "PENDING HUMAN OWNER" notes below mark configuration steps that require a human owner to complete before the on-call program is fully operational.

**Spec §35 lines 4474–4511**

---

## Severity Definitions

| SEV | Description | Initial Response SLA | Resolution SLA | Notification |
|---|---|---|---|---|
| **SEV1** | Customer-facing outage: API returning 5xx or completely unavailable | 5 minutes | 4 hours | Status page update within 5 min; customer email within 1h; executive notification |
| **SEV2** | Degraded performance: p99 latency > 2× SLO threshold; partial unavailability | 30 minutes | 8 hours | Status page update within 15 min; notify affected customers |
| **SEV3** | Non-customer-facing: background job failure, internal alert, elevated error rate < 1% | 2 hours | 2 business days | Internal Slack only |

---

## On-Call Rotation

- **On-call shift**: 1 week, rotating among team members
- **Escalation path**: On-call engineer → Tech Lead → CTO (SEV1 only)
- **PagerDuty policy**: Auto-escalate SEV1 after 15min no-ack; SEV2 after 30min

---

## Incident Command Structure

For SEV1/2, assign roles at the start of the incident:
- **Incident Commander (IC)**: owns status updates, timeline, escalation
- **Technical Lead (TL)**: drives investigation and fix
- **Communications Lead (CL)**: writes external status-page updates (SEV1/2)

---

## 5-Part Runbook Template

Every runbook (see `docs/ops/runbooks/`) follows this structure:

```markdown
# [Alert Name] Runbook

## Symptoms
- What the alert fires on (metric + threshold)
- What users/systems experience

## Affected Systems
- Services, databases, queues impacted

## Immediate Mitigation
```bash
# Copy-pasteable commands to reduce blast radius
```

## Root Cause Analysis
- Common causes + diagnostic queries

## Escalation
- When to escalate (SEV threshold criteria)
- Who to page (PagerDuty policy + role)
```

---

## Alert → Runbook Cross-Reference

| Alert Name | Wave V Code | Runbook |
|---|---|---|
| `MNEMO_001` — write latency p99 > 200ms | Wave V1 | [pg_primary_down.md](runbooks/pg_primary_down.md) |
| `MNEMO_002` — recall latency p99 > 500ms | Wave V1 | [pg_primary_down.md](runbooks/pg_primary_down.md) |
| `MNEMO_003` — error rate > 1% | Wave V1 | [data_corruption.md](runbooks/data_corruption.md) |
| Redis unreachable | AB5 | [redis_primary_down.md](runbooks/redis_primary_down.md) |
| Region failover | AB2 | [region_down.md](runbooks/region_down.md) |
| Security key anomaly | Wave T | [security_breach.md](runbooks/security_breach.md) |

---

## Post-Mortem Template

Published within:
- SEV1: 48 hours
- SEV2: 5 business days

```markdown
# Post-Mortem: [Title]

**Date**: YYYY-MM-DD  
**Severity**: SEV1/2  
**Duration**: X hours Y minutes  
**Incident Commander**: @name  

## Summary
One paragraph description of what happened and impact.

## Timeline (UTC)
- HH:MM — Alert fired
- HH:MM — IC declared incident
- HH:MM — Root cause identified
- HH:MM — Mitigation applied
- HH:MM — Incident resolved

## Root Cause
Technical explanation of the failure.

## Contributing Factors
What made this worse / delayed detection?

## Action Items
| Action | Owner | Due |
|---|---|---|
| Fix X | @name | YYYY-MM-DD |
| Add alert Y | @name | YYYY-MM-DD |

## Lessons Learned
What did we learn? What was done well?
```

---

## Communications

For external communications (SEV1/2), use the templates in [status-page.md](status-page.md).

**PENDING HUMAN OWNER**: On-call schedule, PagerDuty configuration, post-mortem review cadence.
