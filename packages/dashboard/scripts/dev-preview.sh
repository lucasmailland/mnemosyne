#!/usr/bin/env bash
# Dev-preview launcher for the dashboard: points the rewrites at the
# locally-built Hono server (port 3940) used for e2e verification.
set -euo pipefail
export MNEMO_SERVER_URL="${MNEMO_SERVER_URL:-http://localhost:3940}"
exec pnpm --dir "$(cd "$(dirname "$0")/.." && pwd)" dev
