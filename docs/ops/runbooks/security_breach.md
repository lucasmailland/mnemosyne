# Security Breach Runbook

## Symptoms
- API key anomaly detected (`detectKeyAnomaly` fires — new IP or impossible geo-velocity)
- Unusual spike in API calls from a single IP
- Merkle audit chain hash mismatch (tampered audit log)
- Access to `mk_admin_` key without TOTP MFA
- Unauthorized cross-tenant access (workspace isolation breach)

## Affected Systems
- Potentially all: secrets, customer memory data, audit trail

## Immediate Response (DO NOT DELAY)

```bash
# 1. REVOKE the suspected key immediately
curl -X POST $MNEMO_URL/v1/admin/keys/$KEY_ID/revoke \
  -H "Authorization: Bearer $ADMIN_KEY"

# 2. Verify key was revoked in DB
psql $DATABASE_URL -c "
  SELECT key_id, status, revoked_at, revocation_reason
  FROM mnemosyne.mnemo_api_keys
  WHERE key_id = '$KEY_ID';
"

# 3. Export audit log for the suspicious actor (time-boxed to the incident window)
psql $DATABASE_URL -c "
  SELECT *
  FROM mnemosyne.mnemo_audit_log
  WHERE actor_id = '$KEY_ID'
    AND created_at > now() - interval '24 hours'
  ORDER BY created_at DESC;
" > /tmp/audit-export-$(date +%Y%m%d).csv

# 4. Check for data exfiltration indicators
psql $DATABASE_URL -c "
  SELECT count(*), actor_id, event_type
  FROM mnemosyne.mnemo_audit_log
  WHERE created_at > now() - interval '24 hours'
  GROUP BY actor_id, event_type
  ORDER BY count DESC
  LIMIT 20;
"

# 5. If break-glass key (mk_admin_) was used without MFA — ROTATE ALL SECRETS:
#    - Rotate DATABASE_URL credentials
#    - Rotate REDIS_URL credentials
#    - Rotate all mk_admin_ keys
#    - Rotate WEBHOOK_SIGNING_SECRET
#    - Notify all affected customers

# 6. Preserve evidence — do not modify logs until legal review
```

## Breach Notification Timeline

Per GDPR Article 33 (if personal data involved):
- **72 hours**: Notify supervisory authority (DPA)
- **Without undue delay**: Notify affected customers if high risk (Article 34)

**PENDING HUMAN OWNER**: DPO must be paged immediately for any suspected personal data breach.

## Escalation
- SEV1 always
- Page: On-call engineer → Tech Lead → CTO → DPO (immediately, in parallel)
- Engage legal counsel within 1 hour if data breach confirmed

## Related
- [Incident response](../incident-response.md) for SEV1 comms template
- [SOC2 controls](../../compliance/soc2-controls.md) — CC6.2 offboarding
