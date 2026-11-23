#!/usr/bin/env bash
# Dashboard end-to-end run: fresh stack → Playwright specs → teardown.
#
#   pnpm test:e2e:dashboard                 # build from this checkout, run, remove
#   pnpm test:e2e:dashboard -- --keep       # leave the stack up afterwards
#   pnpm test:e2e:dashboard -- --grep AUTH-03   # extra args go to `playwright test`
#
# Needs Docker (compose v2) and the Playwright Chromium build
# (`pnpm --filter @mnemo-ai/dashboard exec playwright install chromium`).
# The stack is docker/docker-compose.e2e.yml on 127.0.0.1:${MNEMO_E2E_PORT:-3300};
# it is always created fresh, because the specs consume rate-limit budget and
# lock an account on purpose. Reports: packages/dashboard/playwright-report/.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker/docker-compose.e2e.yml)
KEEP=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --) ;;
    *) ARGS+=("$arg") ;;
  esac
done

teardown() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "e2e: failed (exit $status); server log tail:" >&2
    "${COMPOSE[@]}" logs --tail 40 server >&2 || true
  fi
  if [ "$KEEP" -eq 1 ]; then
    echo "e2e: stack left up (--keep). Remove it with: ${COMPOSE[*]} down -v"
  else
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap teardown EXIT

echo "e2e: starting a fresh stack"
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build --wait

export MNEMO_E2E_BASE_URL="http://localhost:${MNEMO_E2E_PORT:-3300}"
pnpm --filter @mnemo-ai/dashboard exec playwright test ${ARGS[@]+"${ARGS[@]}"}
