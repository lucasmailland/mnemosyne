#!/usr/bin/env bash
# Local mirror of the "load smoke (k6 · 30s · 5rps)" CI job in
# .github/workflows/ci.yml — that job is NOT continue-on-error (it "gates
# main"), so it deserves a local equivalent even though it needs live
# services. Postgres and Redis run as throwaway containers of their own (no
# volume, removed on exit), so a developer's docker/docker-compose.yml stack,
# its data and its local .env stay untouched; the server runs as a plain node
# process (no image build) — same as CI.
#
# Requires: docker, psql, a build (pnpm build) already done. k6 runs from PATH
# when installed (mise-provisioned — see .mise.toml), else from its image.
#
# Usage: bash scripts/load-smoke-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Own ports: 3000/5432/6379 are the ones other local stacks tend to hold already.
PORT="${SMOKE_PORT:-3990}"
PG_PORT="${SMOKE_PG_PORT:-55440}"
REDIS_PORT="${SMOKE_REDIS_PORT:-6390}"
DATABASE_URL="postgresql://mnemo:mnemo@localhost:$PG_PORT/mnemo"
REDIS_URL="redis://localhost:$REDIS_PORT"
TEST_API_KEY="mns_test_localsmoke2026localkey12345"
PG_NAME=mnemosyne-smoke-postgres
REDIS_NAME=mnemosyne-smoke-redis
K6_IMAGE=grafana/k6:0.54.0

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  docker rm -f "$PG_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "::: starting throwaway postgres + redis"
docker run -d --name "$PG_NAME" -p "$PG_PORT:5432" \
  -e POSTGRES_USER=mnemo -e POSTGRES_PASSWORD=mnemo -e POSTGRES_DB=mnemo \
  pgvector/pgvector:pg17 >/dev/null
docker run -d --name "$REDIS_NAME" -p "$REDIS_PORT:6379" redis:7-alpine >/dev/null
# The image's init runs a temporary server first: ready means the second "ready" line.
for i in $(seq 1 60); do
  [ "$(docker logs "$PG_NAME" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  [ "$i" -eq 60 ] && { echo "postgres did not become ready"; exit 1; }
  sleep 1
done
for i in $(seq 1 30); do
  docker exec "$REDIS_NAME" redis-cli ping 2>/dev/null | grep -q PONG && break
  [ "$i" -eq 30 ] && { echo "redis did not become ready"; exit 1; }
  sleep 1
done

echo "::: running migrations"
DATABASE_URL="$DATABASE_URL" pnpm --filter @mnemo-ai/core migrate
DATABASE_URL="$DATABASE_URL" pnpm --filter @mnemo-ai/adapter-postgres migrate

echo "::: seeding smoke test API key (idempotent)"
KEY_HASH=$(cd packages/server && node --input-type=module <<'NODESCRIPT'
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const bcrypt = require("bcrypt");
const h = await bcrypt.hash("mns_test_localsmoke2026localkey12345", 12);
process.stdout.write(h + "\n");
NODESCRIPT
)
psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -c \
  "INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, plan) VALUES ('key_local_smoke', '00000000-0000-0000-0000-000000000001', '$KEY_HASH', 'local smoke test key', 'local smoke test key', 'enterprise') ON CONFLICT (id) DO UPDATE SET key_hash = EXCLUDED.key_hash" \
  >/dev/null

echo "::: starting server on :$PORT"
DATABASE_URL="$DATABASE_URL" \
REDIS_URL="$REDIS_URL" \
MNEMO_REDIS_URL="$REDIS_URL" \
PORT="$PORT" \
MNEMO_MASTER_KEY="local-smoke-ephemeral-not-for-prod" \
NODE_ENV="test" \
MNEMO_ALLOW_UNSAFE_DB_ROLE="true" \
MNEMO_ALLOW_LEGACY_FULL_SCOPE="true" \
MNEMO_EMBED_STUB="true" \
  node packages/server/dist/index.js > /tmp/mnemosyne-load-smoke-server.log 2>&1 &
SERVER_PID=$!

for i in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { echo "server ready (attempt $i)"; break; }
  [ "$i" -eq 30 ] && { echo "server did not start"; cat /tmp/mnemosyne-load-smoke-server.log; exit 1; }
  sleep 1
done

echo "::: seeding smoke dataset (200 facts)"
MNEMO_BASE_URL="http://localhost:$PORT" MNEMO_TEST_API_KEY="$TEST_API_KEY" \
  node load/scripts/seed.mjs --count 200 --batch 20

echo "::: running k6 recall smoke (30s · 5rps)"
k6_args=(--env MNEMO_TEST_API_KEY="$TEST_API_KEY" --env MNEMO_RECALL_RPS=5 --env MNEMO_DURATION=30s)
if command -v k6 >/dev/null 2>&1; then
  k6 run --env MNEMO_BASE_URL="http://localhost:$PORT" "${k6_args[@]}" load/k6/recall.js
else
  docker run --rm -v "$PWD/load:/load:ro" "$K6_IMAGE" run \
    --env MNEMO_BASE_URL="http://host.docker.internal:$PORT" "${k6_args[@]}" /load/k6/recall.js
fi
