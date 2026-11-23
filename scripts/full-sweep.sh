#!/usr/bin/env bash
# Full post-remediation verification sweep. Mirrors every CI job in
# .github/workflows/ci.yml.
# Usage: bash scripts/full-sweep.sh           # fast lane (no Docker)
#        FULL=1 bash scripts/full-sweep.sh     # + integration suites + bench +
#                                                 load-smoke (Docker: postgres+redis+k6)
#
# NOT covered even with FULL=1:
#   - schema-safety.yml's shadow-apply job  — applies migrations to a real Postgres,
#     redundant in spirit with "migration lint" below; run manually if you want
#     the exact CI check: see .github/workflows/schema-safety.yml
set -euo pipefail
cd "$(dirname "$0")/.."

declare -a RESULTS
step() { # step "name" cmd...
  local name="$1"; shift
  echo "::: $name"
  if "$@"; then RESULTS+=("PASS  $name"); else RESULTS+=("FAIL  $name"); FAILED=1; fi
}
FAILED=0

export COVERAGE="${COVERAGE:-1}"

step "doc-lint"           bash scripts/doc-lint.sh
step "test-determinism"   bash scripts/check-test-determinism.sh
step "validate dashboards" bash docker/scripts/dashboards/validate.sh
step "build"              pnpm turbo run build
step "lint"                pnpm turbo run lint
step "typecheck"           pnpm turbo run typecheck
# Each package's vitest already spreads across every core, so turbo's default of
# 10 packages at once puts ~10x the workers on the CPU and real-timing tests
# (repo-scanning guards, spawned hook scripts, otel) blow their timeouts on a
# different package every run. Three at a time was green on a 15-core machine.
step "unit tests"          pnpm turbo run test --concurrency=3
step "mcp contract tests"    pnpm --filter @mnemo-ai/mcp test:contracts
step "server contract tests" pnpm --filter @mnemo-ai/server test:contracts
step "migration lint"      node scripts/lint-migrations.mjs
step "script tests"        pnpm test:scripts
step "hook tests"          pnpm test:hooks
step "doc translations"    pnpm docs:check-translations

if command -v go >/dev/null 2>&1; then
  step "sdk-go vet+fmt+test" bash -c 'cd packages/sdk-go && go vet ./... && test -z "$(gofmt -l mnemo/)" && go test ./mnemo/ -count=1'
else
  echo "(skipping sdk-go — 'go' not on PATH; see .mise.toml)"
fi

# testcontainers finds a runtime through DOCKER_HOST or /var/run/docker.sock. OrbStack
# does not create the latter by default, and every integration file then failed with
# "Could not find a working container runtime strategy".
docker_runtime() {
  if [[ -z "${DOCKER_HOST:-}" && ! -S /var/run/docker.sock && -S "$HOME/.orbstack/run/docker.sock" ]]; then
    export DOCKER_HOST="unix://$HOME/.orbstack/run/docker.sock"
    # Ryuk mounts the socket by its path inside the VM, not the host path.
    export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE="${TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE:-/var/run/docker.sock}"
    echo "(DOCKER_HOST unset: using OrbStack's socket, $DOCKER_HOST)"
  fi
  if docker info >/dev/null 2>&1; then return 0; fi
  cat >&2 <<MSG
No container runtime is reachable (DOCKER_HOST=${DOCKER_HOST:-<unset>}). Start one, point
DOCKER_HOST at its socket and run again:
  OrbStack: export DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
  Colima:   export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
  Rootless: export DOCKER_HOST=unix://${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock
MSG
  return 1
}
integration() { docker_runtime && pnpm turbo run test:integration; }

if [[ "${FULL:-0}" == "1" ]]; then
  step "integration (all pkgs)" integration
  step "bench + regression gate" bash -c 'pnpm --filter @mnemo-ai/core build && BENCH_OUT=bench-results.json pnpm --filter @mnemo-ai/core exec tsx src/benchmark/bench.ts && pnpm --filter @mnemo-ai/core exec tsx src/benchmark/check-regression.ts'
  step "load smoke (k6)" bash scripts/load-smoke-local.sh
else
  echo "(skipping integration + bench + load-smoke — set FULL=1 to include; requires Docker)"
fi

echo; echo "==== SWEEP SUMMARY ===="
printf '%s\n' "${RESULTS[@]}"
exit "${FAILED}"
