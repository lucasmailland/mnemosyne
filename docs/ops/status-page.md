# Status Page

> ⚠️ **NOT YET LIVE — setup template only.** No external status page has been created. No status page URL exists yet. PagerDuty webhook, auto-monitor hooks, and public-facing components are not configured. This document is a setup checklist and communication template for when the status page is provisioned. The "PENDING HUMAN OWNER" checklist at the bottom reflects every item that must be completed before this becomes operational.

**Spec §35 lines 4264–4269**

**PENDING HUMAN OWNER**: The external status-page account must be created and owned by the on-call team lead. This document defines the configuration — execution requires human sign-off.

---

## Provider Recommendation

Use **Instatus** (self-serve, webhooks, 99.9% SLA), **statuspage.io** (Atlassian, enterprise), or self-host with **Upptime** (GitHub-backed, zero cost for public pages).

For a commercial product: **statuspage.io** (integrates with PagerDuty + Datadog) or **Instatus** (API-first, lower cost, Slack/PagerDuty webhooks).

---

## Components to Track

| Component           | What it measures                                |
| ------------------- | ----------------------------------------------- |
| **API**             | `/health/ready` — HTTP 200 within 500ms         |
| **Recall**          | `mnemo_recall_latency_p99` < 200ms (Wave V SLO) |
| **Write**           | `mnemo_write_latency_p99` < 100ms               |
| **WebSocket**       | WS connection + first-event latency             |
| **Federation**      | Cross-region sync last-seen age < 5min          |
| **Background Jobs** | Consolidation + outbox drain lag < 30min        |

---

## Incident Communication Template

### SEV1 (customer-facing outage)

```
[INVESTIGATING] API disruption — <date>

We are investigating elevated error rates affecting the Mnemosyne API.
Recall and write operations may return 5xx errors.

Impact: All customers in [region].
Started: <time UTC>
Next update: in 30 minutes.
```

### SEV2 (degraded performance)

```
[MONITORING] Elevated latency — <date>

We are monitoring elevated recall latency above SLO thresholds.
Requests are completing but slower than normal.

Impact: Recall p99 > 200ms in [region].
Started: <time UTC>
Next update: in 1 hour.
```

### Resolved

```
[RESOLVED] <title> — <date>

The issue has been resolved. All systems are operating normally.
Duration: <N> minutes.
Root cause: [brief description]
Post-mortem: <link> (published within 5 business days for SEV1/2)
```

---

## SLO Burn-Rate Alert → Incident Post Integration

Wave V Prometheus alerts (`MNEMO_002` recall-latency, etc.) fire to PagerDuty.

When PagerDuty escalates (SEV1/2), the on-call engineer MUST:

1. Acknowledge the alert in PagerDuty (within SLA window — see [incident response](incident-response.md))
2. Create an incident post on the status page within 5 minutes
3. Use the templates above
4. Update every 30 minutes until resolved
5. Post-mortem within 5 business days for SEV1/2

---

## Monitoring Hooks

Configure the status page to auto-monitor:

- `https://<api-domain>/health/ready` — HTTP 200, timeout 5s, interval 60s
- `wss://<api-domain>/v1/ws` — WebSocket connect, interval 120s

Automatic incidents open when 3 consecutive checks fail.

---

## Human Owner Sign-Off Required

- [ ] Status page account created (provider: TBD)
- [ ] Public URL: not chosen yet (the project's domain is `getmnemosyne.ai`)
- [ ] Components configured as above
- [ ] PagerDuty webhook registered
- [ ] Auto-monitor hooks enabled
- [ ] SEV definitions linked to `docs/ops/incident-response.md`

**PENDING HUMAN OWNER**: _(on-call team lead who owns the external status-page account and public comms)_
