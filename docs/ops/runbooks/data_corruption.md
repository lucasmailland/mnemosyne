# Data Corruption Runbook

## Symptoms
- Alert: `MNEMO_003` error rate > 1%
- API returns inconsistent data (fact content changes between requests)
- Merkle audit chain verification fails
- Checksum mismatch in `mnemo_fact_hash` table

## Affected Systems
- All read operations (if corruption is in facts/entities)
- Audit trail integrity
- Session compression (if episodes are corrupted)

## Immediate Mitigation

```bash
# 1. Identify affected workspaces
psql $DATABASE_URL -c "
  SELECT workspace_id, count(*) as corrupt_count
  FROM mnemo_fact
  WHERE worth < 0 OR worth > 1
  GROUP BY workspace_id;
"

# 2. Check Merkle audit chain integrity
psql $DATABASE_URL -c "
  SELECT id, event_type, created_at, chain_hash
  FROM mnemo_audit_log
  ORDER BY created_at DESC
  LIMIT 100;
"

# 3. Verify fact hashes
psql $DATABASE_URL -c "
  SELECT f.id, fh.sha256, length(f.embedding::text) as emb_len
  FROM mnemo_fact f
  LEFT JOIN mnemo_fact_hash fh ON f.id = fh.fact_id
  WHERE fh.sha256 IS NULL
  LIMIT 20;
"

# 4. If corruption is confirmed, STOP writes to affected workspace immediately:
#    (Requires DBA + Tech Lead approval)
psql $DATABASE_URL -c "
  -- REQUIRES APPROVAL
  -- Block new writes via a workspace-level maintenance flag (if implemented)
  -- Otherwise: remove API keys for the affected workspace temporarily
"

# 5. Restore from most recent backup (see dr-backup.md)
```

## Root Cause Analysis

1. **Migration went wrong**: Check `mnemosyne.schema_migrations` for recent applies.
2. **Hardware failure**: Check PG logs for I/O errors.
3. **Bug in write path**: Check recent deployments (canary → rollback if needed).
4. **Deliberate tampering**: If Merkle chain broken, treat as security breach (see security_breach.md).

## Escalation
- SEV1 immediately if customer data is provably wrong
- Page: On-call engineer → Tech Lead → CTO
- If GDPR data affected: also page DPO

## Related
- [DR backup runbook](../dr-backup.md) for point-in-time restore
- [security_breach.md](security_breach.md) if tampering suspected
