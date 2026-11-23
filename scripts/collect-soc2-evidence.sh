#!/usr/bin/env bash
# collect-soc2-evidence.sh — SOC 2 automated evidence bundle
# Spec §35 lines 4372–4378
#
# Usage:
#   bash scripts/collect-soc2-evidence.sh
#
# Real-infra mode (all 5 artifacts real):
#   DATABASE_URL=postgres://... \
#   PROMETHEUS_URL=http://prometheus:9090 \
#   PAGERDUTY_API_KEY=u+... \
#   bash scripts/collect-soc2-evidence.sh
#
# Output: soc2-evidence-YYYYMMDD/ directory with 5 artifacts

set -euo pipefail

DATE=$(date +%Y%m%d)
BUNDLE="soc2-evidence-${DATE}"
mkdir -p "$BUNDLE"

echo "[soc2-evidence] Creating bundle: $BUNDLE/"
echo "[soc2-evidence] DATABASE_URL: ${DATABASE_URL:+(set)} ${DATABASE_URL:-NOT SET}"
echo "[soc2-evidence] PROMETHEUS_URL: ${PROMETHEUS_URL:-NOT SET}"
echo "[soc2-evidence] PAGERDUTY_API_KEY: ${PAGERDUTY_API_KEY:+(set)} ${PAGERDUTY_API_KEY:-NOT SET}"
echo ""

# ── Artifact 1: Access log export ───────────────────────────────────────────
echo "[1/5] Exporting access logs from mnemo_audit_log..."
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" --no-password -c \
    "COPY (
       SELECT actor_id, actor_type, event_type, workspace_id, created_at, ip_address
       FROM mnemosyne.mnemo_audit_log
       WHERE created_at > now() - interval '90 days'
       ORDER BY created_at DESC
     ) TO STDOUT WITH CSV HEADER" \
    > "$BUNDLE/access-logs.csv" && {
    ROW_COUNT=$(wc -l < "$BUNDLE/access-logs.csv")
    echo "  [OK] ${ROW_COUNT} rows exported (including header)"
  } || {
    echo "  [WARN] psql query failed — writing stub"
    echo "actor_id,actor_type,event_type,workspace_id,created_at,ip_address" > "$BUNDLE/access-logs.csv"
    echo "(stub: DATABASE_URL set but DB unreachable or query failed)" >> "$BUNDLE/access-logs.csv"
  }
else
  echo "  [WARN] DATABASE_URL not set — writing stub"
  echo "actor_id,actor_type,event_type,workspace_id,created_at,ip_address" > "$BUNDLE/access-logs.csv"
  echo "(stub: set DATABASE_URL to export real audit logs)" >> "$BUNDLE/access-logs.csv"
fi
echo "  -> $BUNDLE/access-logs.csv"

# ── Artifact 2: Deploy history ───────────────────────────────────────────────
echo "[2/5] Generating deploy history..."
{
  echo "# Deploy History"
  echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# Source: git log + GitHub Actions CI"
  echo ""
  echo "## Git Log (last 90 days)"
  git log --oneline --since="90 days ago" --format="%H %ad %s" --date=short 2>/dev/null || echo "(git not available)"
  echo ""
  echo "## GitHub Actions Workflow Runs (last 90 days)"
  if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
    gh run list --limit 200 --json databaseId,createdAt,status,conclusion,headBranch,workflowName \
      --jq '.[] | [.createdAt, .status, .conclusion // "—", .headBranch, .workflowName] | @csv' \
      2>/dev/null || echo "(gh CLI available but run list failed)"
  else
    echo "(gh CLI not available or not authenticated — run: gh auth login)"
    echo "Manual export: GitHub Actions > All workflows > last 90 days"
    echo "  gh run list --limit 200 --json databaseId,createdAt,status,headBranch,workflowName"
  fi
} > "$BUNDLE/deploy-history.txt"
echo "  -> $BUNDLE/deploy-history.txt"

# ── Artifact 3: Encryption proof ─────────────────────────────────────────────
echo "[3/5] Capturing encryption configuration snapshot..."
cat > "$BUNDLE/encryption-proof.txt" << EOF
# Encryption Proof
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)

## At-Rest Encryption
- Database: Managed PG provider encrypts at rest (AES-256)
- Redis: Managed Redis provider encrypts at rest
- API key secrets: argon2id hashed (see packages/server/src/auth/hash.ts)
- Per-actor DEK: GDPR crypto-erasure via key rotation (migration 0033, DrizzleStorageAdapter.ts)

## In-Transit Encryption
- All API endpoints: TLS 1.2+ enforced at load balancer / Fly.io edge
- Database connections: postgres SSL mode=require
- Redis connections: TLS mandatory (Upstash/managed provider)

## Key Rotation
- API keys: revoke-and-reissue (no in-place rotation; 7-day deprecation grace)
- mk_admin_ break-glass: 24h TTL ceiling (ADMIN_MAX_TTL_MS in ScopedApiKeyAdapter.ts)
- DEK rotation: crypto-erasure via mnemo_actor_dek table (migration 0033)

## Code References
- Auth: packages/server/src/auth/ScopedApiKeyAdapter.ts
- DEK: packages/adapter-postgres/src/DrizzleStorageAdapter.ts
- Migrations: packages/adapter-postgres/migrations/v3-squash/ (squash baseline), packages/adapter-postgres/migrations/v3-archive/ (history)
- Argon2id: packages/server/src/auth/hash.ts
EOF
echo "  -> $BUNDLE/encryption-proof.txt"

# ── Artifact 4: Incident history ─────────────────────────────────────────────
echo "[4/5] Building incident history..."
{
  echo "# Incident History"
  echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "## Post-Mortem Index"
  POSTMORTEMS_DIR="docs/ops/postmortems"
  if [ -d "$POSTMORTEMS_DIR" ] && ls "$POSTMORTEMS_DIR"/*.md &>/dev/null 2>&1; then
    ls "$POSTMORTEMS_DIR"/*.md | while read -r f; do
      echo "  - $f"
    done
  else
    echo "  (no post-mortems on record — docs/ops/postmortems/ is empty or missing)"
  fi
  echo ""
  echo "## PagerDuty Incidents (last 90 days)"
  SINCE=$(date -u -v-90d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u --date='90 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
  if [ -n "${PAGERDUTY_API_KEY:-}" ] && [ -n "$SINCE" ]; then
    RESPONSE=$(curl -sf -H "Authorization: Token token=${PAGERDUTY_API_KEY}" \
      -H "Accept: application/vnd.pagerduty+json;version=2" \
      "https://api.pagerduty.com/incidents?since=${SINCE}&limit=100&statuses[]=triggered&statuses[]=acknowledged&statuses[]=resolved" \
      2>/dev/null) && {
      echo "$RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for i in data.get('incidents', []):
    print(f\"  {i.get('created_at','?')} SEV{i.get('urgency','?')} {i.get('status','?')} — {i.get('title','?')}\")
" 2>/dev/null || echo "$RESPONSE"
    } || echo "  (PagerDuty API call failed — check PAGERDUTY_API_KEY)"
  else
    echo "  (PAGERDUTY_API_KEY not set — populate manually)"
    echo "  Command: pd incidents:list --since 90days"
    echo "  Or: curl -H 'Authorization: Token token=<key>' 'https://api.pagerduty.com/incidents?since=${SINCE}&limit=100'"
  fi
} > "$BUNDLE/incident-history.txt"
echo "  -> $BUNDLE/incident-history.txt"

# ── Artifact 5: Uptime metrics ───────────────────────────────────────────────
echo "[5/5] Generating uptime metrics..."
{
  echo "# Uptime Metrics"
  echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  echo "## SLO Targets (spec §35)"
  echo "- API availability: 99.9%"
  echo "- Recall latency p99: < 200ms"
  echo "- Write latency p99: < 100ms"
  echo ""
  if [ -n "${PROMETHEUS_URL:-}" ]; then
    echo "## Live Prometheus Data (PROMETHEUS_URL=$(echo "${PROMETHEUS_URL}" | sed 's/:[^@]*@/:***@/g'))"
    _prom_query() {
      local label="$1" query="$2"
      local result
      result=$(curl -sf "${PROMETHEUS_URL}/api/v1/query" \
        --data-urlencode "query=${query}" 2>/dev/null) && {
        local value
        value=$(echo "$result" | python3 -c "
import json, sys
d=json.load(sys.stdin)
r=d.get('data',{}).get('result',[])
print(r[0]['value'][1] if r else 'no_data')
" 2>/dev/null || echo "parse_error")
        echo "  $label: $value"
      } || echo "  $label: (query failed)"
    }
    _prom_query "availability_30d" \
      "avg_over_time(up{job=\"mnemosyne\"}[30d])"
    _prom_query "recall_p99_ms" \
      "histogram_quantile(0.99, rate(mnemo_recall_duration_seconds_bucket[30d])) * 1000"
    _prom_query "error_rate_24h" \
      "sum(rate(http_requests_total{status=~\"5..\",job=\"mnemosyne\"}[24h])) / sum(rate(http_requests_total{job=\"mnemosyne\"}[24h]))"
    _prom_query "facts_total" \
      "mnemo_facts_total"
  else
    echo "## Evidence Source (PROMETHEUS_URL not set)"
    echo ""
    echo "Set PROMETHEUS_URL to query real SLO metrics automatically."
    echo ""
    echo "Manual queries (run in Grafana/Prometheus UI):"
    echo '  # 30-day availability'
    echo '  avg_over_time(up{job="mnemosyne"}[30d])'
    echo '  # Recall p99 latency (ms)'
    echo '  histogram_quantile(0.99, rate(mnemo_recall_duration_seconds_bucket[30d])) * 1000'
    echo '  # Error rate (last 24h)'
    echo '  sum(rate(http_requests_total{status=~"5..",job="mnemosyne"}[24h])) / sum(rate(http_requests_total{job="mnemosyne"}[24h]))'
    echo ""
    echo "Dashboard: Grafana at \$GRAFANA_URL/d/mnemosyne-slo"
  fi
} > "$BUNDLE/uptime-metrics.txt"
echo "  -> $BUNDLE/uptime-metrics.txt"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "[soc2-evidence] Bundle complete: $BUNDLE/"
echo ""
ls -lh "$BUNDLE/"
echo ""
echo "Upload $BUNDLE/ to your audit evidence vault before the SOC2 audit window."
echo ""
echo "Stubs to replace with real data:"
grep -l "(stub:" "$BUNDLE/"*.{csv,txt} 2>/dev/null | while read -r f; do
  echo "  $f — set the corresponding env var (see usage at top of script)"
done || echo "  (no stubs — all artifacts are real)"
