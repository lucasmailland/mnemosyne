# Region Outage Runbook (single-region: IAD)

> **v1.0 is intentionally single-region.** Mnemosyne v1.0 deploys to Fly.io `iad`
> (`primary_region = "iad"` in `fly.toml`). Multi-region routing, cross-region federation
> sync, and automatic cross-region failover are deferred to a post-1.0 milestone. The
> `region` column in the schema and `MNEMO_REGION` env var are reserved for that milestone.
>
> **Decision record (W8, 2026-06-22):** The team formally evaluated multi-region Fly.io
> (primary + read replicas across `iad`, `lhr`, `nrt`) and determined that the implementation
> cost (routing logic, cross-region federation sync, data-residency failover approval flow,
> DPO coordination) is out of scope for v1.0. Single-region with daily CI restore drills is
> the supported topology. Multi-region is the first post-1.0 ops milestone.

---

## Symptoms

- All API requests return 5xx or time out from clients in IAD / east-US.
- Fly.io dashboard shows region `iad` machines in `stopped` or `failed` state.
- `GET /healthz` on the Mnemosyne service does not respond.
- PagerDuty alert: `MNEMO_001` write latency p99 > 200ms sustained for > 5 min.

## Immediate assessment

```bash
# 1. Check Fly.io machine status
fly status --app mnemosyne

# 2. Check if the region itself is down (provider issue)
#    → https://status.fly.io/
curl -s https://status.fly.io/api/v2/status.json | jq '.status.description'

# 3. Check PG connectivity
psql "$DATABASE_URL" -c "SELECT 1;"

# 4. Check Redis connectivity
redis-cli -u "$REDIS_URL" ping
```

## Mitigation: provider issue (Fly.io IAD outage)

If the outage is a Fly.io IAD infrastructure issue:

```bash
# Monitor Fly.io status page for ETA
# https://status.fly.io/

# Open incident in PagerDuty / Slack #incidents with SEV1 if > 5 min outage
# RTO starts from first confirmed customer impact

# When IAD recovers: Fly auto-restarts machines (auto_start_machines = true in fly.toml)
fly status --app mnemosyne   # watch for machines going back to 'started'
```

**There is no cross-region failover in v1.0.** The RTO during a full-region outage is
bounded by the provider recovery time. For SLA customers, communicate the incident via
the status page (see `docs/ops/status-page.md`).

## Mitigation: application-level issue (not a provider outage)

If Fly.io infrastructure is healthy but the Mnemosyne app is down:

```bash
# Restart machines
fly machine restart --app mnemosyne

# Roll back to the previous release if a bad deploy is suspected
fly releases --app mnemosyne
fly deploy --image registry.fly.io/mnemosyne:<previous-version>

# Scale up if memory pressure caused OOM kills
fly scale vm performance-2x --app mnemosyne
```

## Mitigation: database issue

See [pg_primary_down.md](pg_primary_down.md) for PG-specific procedures.

## Post-incident

1. Fill in [incident-response.md](../incident-response.md) template.
2. Capture RTO: time from first alert to service restoration.
3. If RTO exceeded 30 min: schedule post-mortem within 48 h.
4. Update this runbook with lessons learned.

## Escalation

- SEV2 if service is degraded (> 10% error rate) for > 5 min.
- SEV1 if service is fully unavailable for > 5 min.
- Page: On-call engineer → Tech Lead.
- If provider issue: file emergency support ticket with Fly.io.

## Related

- [dr-backup.md](../dr-backup.md) — backup and restore procedures
- [pg_primary_down.md](pg_primary_down.md)
- [incident-response.md](../incident-response.md)
- [status-page.md](../status-page.md)
