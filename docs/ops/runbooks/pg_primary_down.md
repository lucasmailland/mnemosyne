# PG Primary Down Runbook

## Symptoms
- Alert: `MNEMO_001` write latency p99 > 200ms, or `MNEMO_002` recall p99 > 500ms
- API returns 503 or connection pool exhausted errors
- `pg_stat_activity` queries time out

## Affected Systems
- All read/write API endpoints
- Consolidation background jobs
- Outbox drain workers

## Immediate Mitigation

```bash
# 1. Check PG primary reachability
psql $DATABASE_URL -c "SELECT 1;"

# 2. Check connection pool saturation
psql $DATABASE_URL -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"

# 3. Kill long-running queries (> 30s)
psql $DATABASE_URL -c "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE state != 'idle'
    AND query_start < now() - interval '30 seconds'
    AND pid != pg_backend_pid();
"

# 4. Check WAL lag (if replica is available)
psql $DATABASE_URL -c "SELECT pg_is_in_recovery(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"

# 5. If primary is dead, initiate managed-PG failover (provider-specific):
# - Neon: automatic, verify in Neon dashboard
# - RDS: `aws rds failover-db-cluster --db-cluster-identifier mnemosyne`
```

## Root Cause Analysis

Common causes:
1. **OOM kill**: Check `dmesg | grep oom` on PG host; increase shared_buffers or add replica for read load.
2. **Disk full**: `df -h` on PG volume; clear WAL archive or expand disk.
3. **Lock contention**: `SELECT * FROM pg_locks JOIN pg_stat_activity USING (pid) WHERE granted = false;`
4. **Long transaction blocking vacuum**: Check `pg_stat_activity` for idle-in-transaction sessions.

## Escalation
- SEV1 if API is fully unavailable for > 5 minutes
- Page: On-call engineer → Tech Lead
- If managed-PG provider issue: file emergency support ticket with provider

## Related
- [DR runbook](../dr-backup.md) for full restore procedure
- [incident-response.md](../incident-response.md) for SEV escalation criteria
