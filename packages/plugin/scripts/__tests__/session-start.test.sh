#!/bin/bash
# P10 — unit tests for get_personal_workspace_id() helper and
# MNEMO_PERSONAL_WORKSPACE_ID injection in session-start.sh
#
# harden-hooks-and-measure-precision Requirement 2 (session-start.sh
# headroom): Tests 9-10 below exercise the FULL script end to end (not just
# helpers) with a fake curl (via a fake binary earlier in PATH), covering
# the two scenarios from spec.md Requirement 2: every upstream call slow but
# reachable, and every upstream call failing. Both must still emit SKILL.md
# and exit 0 (fail-open, unchanged).
#
# Run with: bash packages/plugin/scripts/__tests__/session-start.test.sh
# Returns exit 0 on pass, exit 1 on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="${SCRIPT_DIR}/session-start.sh"
PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_empty() {
  local label="$1" actual="$2"
  if [ -z "$actual" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected empty, got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected to find: $needle)"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "FAIL: $label (unexpectedly found: $needle)"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: $label"
    PASS=$((PASS + 1))
  fi
}

assert_lt() {
  local label="$1" actual="$2" ceiling="$3"
  if [ "$actual" -lt "$ceiling" ]; then
    echo "PASS: $label ($actual < $ceiling)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected < $ceiling, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

# ── Setup temporary HOME ──────────────────────────────────────────────────────

TMP_HOME=$(mktemp -d)
trap 'rm -rf "$TMP_HOME"' EXIT

export HOME="$TMP_HOME"

# ── Source helpers ────────────────────────────────────────────────────────────

# shellcheck source=../_helpers.sh
source "${SCRIPT_DIR}/_helpers.sh"

# ── Test 1: get_personal_workspace_id returns empty when file missing ─────────

assert_empty "get_personal_workspace_id returns empty when workspaces.json absent" \
  "$(get_personal_workspace_id)"

# ── Test 2: get_personal_workspace_id returns empty when key not set ─────────

mkdir -p "$TMP_HOME/.mnemo"
echo '{"other-project":{"workspaceId":"ws-proj-001","url":"http://localhost"}}' \
  > "$TMP_HOME/.mnemo/workspaces.json"

assert_empty "get_personal_workspace_id returns empty when personalWorkspaceId key absent" \
  "$(get_personal_workspace_id)"

# ── Test 3: get_personal_workspace_id returns value when key is set ──────────

echo '{"personalWorkspaceId":"ws-personal-test-001","other-project":{"workspaceId":"ws-proj-001"}}' \
  > "$TMP_HOME/.mnemo/workspaces.json"

RESULT=$(get_personal_workspace_id)
assert_eq "get_personal_workspace_id returns personalWorkspaceId value" \
  "ws-personal-test-001" "$RESULT"

# ── Test 4: MNEMO_PERSONAL_WORKSPACE_ID is exported when field present ────────

unset MNEMO_PERSONAL_WORKSPACE_ID 2>/dev/null || true

# Simulate the session-start.sh export block
PERSONAL_WS_ID=$(get_personal_workspace_id)
if [ -n "$PERSONAL_WS_ID" ]; then
  export MNEMO_PERSONAL_WORKSPACE_ID="$PERSONAL_WS_ID"
fi

assert_eq "MNEMO_PERSONAL_WORKSPACE_ID exported when personalWorkspaceId present" \
  "ws-personal-test-001" "${MNEMO_PERSONAL_WORKSPACE_ID:-}"

# ── Test 5: MNEMO_PERSONAL_WORKSPACE_ID not set when field absent ─────────────

unset MNEMO_PERSONAL_WORKSPACE_ID 2>/dev/null || true
echo '{"other-project":{"workspaceId":"ws-proj-001"}}' \
  > "$TMP_HOME/.mnemo/workspaces.json"

PERSONAL_WS_ID=$(get_personal_workspace_id)
if [ -n "$PERSONAL_WS_ID" ]; then
  export MNEMO_PERSONAL_WORKSPACE_ID="$PERSONAL_WS_ID"
fi

assert_empty "MNEMO_PERSONAL_WORKSPACE_ID not set when personalWorkspaceId absent" \
  "${MNEMO_PERSONAL_WORKSPACE_ID:-}"

# ── Test 6: find_project_config finds .mnemo.json in current directory ────────
TMP_REPO=$(mktemp -d)
trap 'rm -rf "$TMP_HOME" "$TMP_REPO"' EXIT

mkdir -p "$TMP_REPO/.git"
echo '{"workspaceId":"ws-link-test-123","label":"my-app"}' > "$TMP_REPO/.mnemo.json"

FOUND_CFG=$(find_project_config "$TMP_REPO")
FOUND_WS=$(echo "$FOUND_CFG" | jq -r '.workspaceId')
assert_eq "find_project_config reads workspaceId from cwd" "ws-link-test-123" "$FOUND_WS"

# ── Test 7: find_project_config walks up to find .mnemo.json ──────────────────
mkdir -p "$TMP_REPO/src/sub/deep"
FOUND_SUB_CFG=$(find_project_config "$TMP_REPO/src/sub/deep")
FOUND_SUB_WS=$(echo "$FOUND_SUB_CFG" | jq -r '.workspaceId')
assert_eq "find_project_config walks up from nested dir to find .mnemo.json" "ws-link-test-123" "$FOUND_SUB_WS"

# ── Test 8: find_project_config stops at .git boundary ───────────────────────
PARENT_REPO=$(mktemp -d)
trap 'rm -rf "$TMP_HOME" "$TMP_REPO" "$PARENT_REPO"' EXIT
echo '{"workspaceId":"ws-parent-should-not-reach"}' > "$PARENT_REPO/.mnemo.json"

CHILD_REPO="$PARENT_REPO/child"
mkdir -p "$CHILD_REPO/.git"

FOUND_CHILD=$(find_project_config "$CHILD_REPO" || true)
assert_empty "find_project_config stops at .git boundary and ignores parent .mnemo.json" "$FOUND_CHILD"

# ── Test 9: every upstream call is slow but reachable — parallel, not sequential ──
# harden-hooks-and-measure-precision Requirement 2, scenario "every upstream
# call is slow but reachable": each of /me, /session/start, /admin/stats
# sleeps for its full --max-time 2 budget. Sequentially that would be ~6s;
# in parallel it must be close to 2s. Asserts wall time stays well under the
# old sequential worst case (6s) as proof the fix actually parallelises,
# plus that SKILL.md and the workspace-context section both still emit.

FAKE_BIN=$(mktemp -d)
trap 'rm -rf "$TMP_HOME" "$TMP_REPO" "$PARENT_REPO" "$FAKE_BIN"' EXIT

cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/bash
URL=""
# session-start.sh pide los vitals a /health (no /admin/stats: ese exigía
# memory:admin por el prefijo del path, para los mismos datos), con `-o` para el
# cuerpo y `-w '%{http_code}'` para el status — con `-f` un 403 llegaba vacío e
# indistinguible de una red caída. Estos dobles tienen que hablar el mismo
# protocolo o dejan de probar lo que dicen probar.
OUT_FILE=""
WANT_CODE=false
prev=""
for a in "$@"; do
  case "$prev" in
    -o) OUT_FILE="$a" ;;
    -w) case "$a" in *http_code*) WANT_CODE=true ;; esac ;;
  esac
  prev="$a"
done
# $1 = cuerpo, $2 = código HTTP
out() {
  if [ -n "$OUT_FILE" ]; then printf '%s' "$1" > "$OUT_FILE"; else printf '%s\n' "$1"; fi
  if [ "$WANT_CODE" = true ]; then printf '%s' "$2"; fi
}
for arg in "$@"; do
  case "$arg" in
    *"/me") URL="me" ;;
    *"/session/start") URL="session" ;;
    *"/admin/stats") URL="stats" ;;
    *"/health") URL="health" ;;
  esac
done
case "$URL" in
  me) sleep 2; echo '{"workspaceId":"ws-slow","workspaceName":"Slow WS","workspaceRole":"write"}' ;;
  session) sleep 2; echo '{"id":"sess-slow"}' ;;
  health) sleep 2; out '{"workspaceId":"ws-slow","factsLive":1,"factsClosed":0,"lastWriteAt":"2026-08-01T00:00:00Z"}' 200 ;;
esac
EOF
chmod +x "$FAKE_BIN/curl"

export PATH="$FAKE_BIN:$PATH"
source "$SCRIPT_DIR/__tests__/legacy-runtime-fixture.sh"
install_legacy_runtime_fixture consent
export MNEMO_URL="http://localhost:3939"
export MNEMO_KEY="mns_test_slow"

START_NS=$(date +%s%N)
OUT9=$(printf '%s' '{"session_id":"slow-session","cwd":"/tmp"}' | bash "$HOOK")
EXIT9=$?
END_NS=$(date +%s%N)
ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))

assert_eq "slow upstreams: hook exits 0" "0" "$EXIT9"
assert_lt "slow upstreams: wall time stays near the 2s parallel max, not the 6s sequential sum" \
  "$ELAPSED_MS" "4000"
assert_contains "slow upstreams: SKILL.md protocol heading is emitted" "$OUT9" \
  "# Mnemosyne Memory Protocol"
assert_contains "slow upstreams: workspace-context section is emitted" "$OUT9" \
  "## Mnemosyne Workspace Context"
assert_contains "slow upstreams: workspace identity from /me is present" "$OUT9" \
  "Slow WS"
assert_contains "slow upstreams: vitals from /health are present" "$OUT9" \
  "Facts: 1 live, 0 closed"

# ── Test 10: every upstream call fails — SKILL.md still emitted, still fail-open ──
# harden-hooks-and-measure-precision Requirement 2, scenario "an upstream
# call fails": all three curls fail outright (simulated network-unreachable
# exit code). SKILL.md and the workspace-context section must still be
# emitted, and the hook must still exit 0 — unchanged fail-open contract.

cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/bash
exit 7
EOF
chmod +x "$FAKE_BIN/curl"

OUT10=$(printf '%s' '{"session_id":"failed-session","cwd":"/tmp"}' | bash "$HOOK")
EXIT10=$?

assert_eq "all upstreams fail: hook exits 0" "0" "$EXIT10"
assert_contains "all upstreams fail: SKILL.md protocol heading is emitted" "$OUT10" \
  "# Mnemosyne Memory Protocol"
assert_contains "all upstreams fail: workspace-context section is emitted" "$OUT10" \
  "## Mnemosyne Workspace Context"
assert_contains "all upstreams fail: identity section states unreachable, not silence" "$OUT10" \
  "Active workspace: unavailable — Mnemosyne could not be reached"
assert_contains "all upstreams fail: stats section states unreachable, not silence" "$OUT10" \
  "Stats: unavailable — Mnemosyne could not be reached"
assert_not_contains "all upstreams fail: does NOT claim it responded with nothing (unreachable != empty)" \
  "$OUT10" "responded but returned no"

# ── Test 11: upstreams are reachable but return unusable/empty bodies ────────
# harden-hooks-and-measure-precision Requirement 4, "the server is reachable
# and genuinely has nothing" scenario: /me responds with a valid-but-empty
# JSON object (no workspaceId), and /health responds with a reachable
# but non-JSON body (a malformed/garbage response, e.g. a proxy error page
# with a 200 status). Both must be distinguishable from Test 10's
# "could not be reached" wording — same section, different cause, must never
# read the same to the model.

cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/bash
URL=""
# session-start.sh pide los vitals a /health (no /admin/stats: ese exigía
# memory:admin por el prefijo del path, para los mismos datos), con `-o` para el
# cuerpo y `-w '%{http_code}'` para el status — con `-f` un 403 llegaba vacío e
# indistinguible de una red caída. Estos dobles tienen que hablar el mismo
# protocolo o dejan de probar lo que dicen probar.
OUT_FILE=""
WANT_CODE=false
prev=""
for a in "$@"; do
  case "$prev" in
    -o) OUT_FILE="$a" ;;
    -w) case "$a" in *http_code*) WANT_CODE=true ;; esac ;;
  esac
  prev="$a"
done
# $1 = cuerpo, $2 = código HTTP
out() {
  if [ -n "$OUT_FILE" ]; then printf '%s' "$1" > "$OUT_FILE"; else printf '%s\n' "$1"; fi
  if [ "$WANT_CODE" = true ]; then printf '%s' "$2"; fi
}
for arg in "$@"; do
  case "$arg" in
    *"/me") URL="me" ;;
    *"/session/start") URL="session" ;;
    *"/admin/stats") URL="stats" ;;
    *"/health") URL="health" ;;
  esac
done
case "$URL" in
  me) echo '{}' ;;
  session) echo '{"id":"sess-empty"}' ;;
  health) out 'not json at all' 200 ;;
esac
EOF
chmod +x "$FAKE_BIN/curl"

OUT11=$(printf '%s' '{"session_id":"empty-session","cwd":"/tmp"}' | bash "$HOOK")
EXIT11=$?

assert_eq "reachable-but-empty upstreams: hook exits 0" "0" "$EXIT11"
assert_contains "reachable-but-empty upstreams: identity section is distinct from unreachable" "$OUT11" \
  "Active workspace: unavailable — Mnemosyne responded but returned no workspace identity"
assert_contains "reachable-but-empty upstreams: stats section is distinct from unreachable" "$OUT11" \
  "Stats: unavailable — Mnemosyne responded but returned no usable stats"
assert_not_contains "reachable-but-empty upstreams: does NOT claim unreachable (reachable != unreachable)" \
  "$OUT11" "could not be reached"

unset MNEMO_URL MNEMO_KEY 2>/dev/null || true

# ── Test 12: the EPISODE line, in all four states (P69/C1) ──────────────────
# /me and the vitals call each got a reachability signal in Requirement 4;
# /session/start did not, and it is the one whose silent failure actually
# costs something. No episode means recall goes uncorrelated (no lastRecallAt,
# no recordRecall, no TD(λ)) and session-stop.sh finds no mapping, so the
# guaranteed collapse never runs and NOTHING from the session is extracted.
# Before this, that outcome printed nothing at all — indistinguishable from a
# session that legitimately has no episode.

cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/bash
URL=""
# session-start.sh pide los vitals a /health (no /admin/stats: ese exigía
# memory:admin por el prefijo del path, para los mismos datos), con `-o` para el
# cuerpo y `-w '%{http_code}'` para el status — con `-f` un 403 llegaba vacío e
# indistinguible de una red caída. Estos dobles tienen que hablar el mismo
# protocolo o dejan de probar lo que dicen probar.
OUT_FILE=""
WANT_CODE=false
prev=""
for a in "$@"; do
  case "$prev" in
    -o) OUT_FILE="$a" ;;
    -w) case "$a" in *http_code*) WANT_CODE=true ;; esac ;;
  esac
  prev="$a"
done
# $1 = cuerpo, $2 = código HTTP
out() {
  if [ -n "$OUT_FILE" ]; then printf '%s' "$1" > "$OUT_FILE"; else printf '%s\n' "$1"; fi
  if [ "$WANT_CODE" = true ]; then printf '%s' "$2"; fi
}
for arg in "$@"; do
  case "$arg" in
    *"/me") URL="me" ;;
    *"/session/start") URL="session" ;;
    *"/admin/stats") URL="stats" ;;
    *"/health") URL="health" ;;
  esac
done
case "$URL" in
  me) echo '{"workspaceId":"ws-1","workspaceName":"WS","workspaceRole":"write"}' ;;
  session) echo '{"id":"sess-open-1"}' ;;
  health) out '{"workspaceId":"ws-1","factsLive":1,"factsClosed":0}' 200 ;;
esac
EOF
chmod +x "$FAKE_BIN/curl"
export MNEMO_URL="http://localhost:3939"
export MNEMO_KEY="mns_test_episode"

OUT12=$(printf '%s' '{"session_id":"ep-ok","cwd":"/tmp"}' | bash "$HOOK")
assert_contains "episode open: reports the id" "$OUT12" "Episode: open (sess-open-1)"
assert_not_contains "episode open: no warning" "$OUT12" "Episode: NOT started"

# Unreachable: the collapse will not happen and the agent must know NOW, while
# it can still write explicitly, not after the session is gone.
cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/bash
exit 7
EOF
chmod +x "$FAKE_BIN/curl"

OUT13=$(printf '%s' '{"session_id":"ep-down","cwd":"/tmp"}' | bash "$HOOK")
assert_contains "episode unreachable: says NOT started" "$OUT13"   "Episode: NOT started — Mnemosyne could not be reached"
assert_contains "episode unreachable: tells the agent what to do instead" "$OUT13"   "Use memory_remember explicitly"

# Reachable but no id: a different failure with the same consequence, and it
# must not be reported as unreachable.
cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/bash
URL=""
# session-start.sh pide los vitals a /health (no /admin/stats: ese exigía
# memory:admin por el prefijo del path, para los mismos datos), con `-o` para el
# cuerpo y `-w '%{http_code}'` para el status — con `-f` un 403 llegaba vacío e
# indistinguible de una red caída. Estos dobles tienen que hablar el mismo
# protocolo o dejan de probar lo que dicen probar.
OUT_FILE=""
WANT_CODE=false
prev=""
for a in "$@"; do
  case "$prev" in
    -o) OUT_FILE="$a" ;;
    -w) case "$a" in *http_code*) WANT_CODE=true ;; esac ;;
  esac
  prev="$a"
done
# $1 = cuerpo, $2 = código HTTP
out() {
  if [ -n "$OUT_FILE" ]; then printf '%s' "$1" > "$OUT_FILE"; else printf '%s\n' "$1"; fi
  if [ "$WANT_CODE" = true ]; then printf '%s' "$2"; fi
}
for arg in "$@"; do
  case "$arg" in
    *"/me") URL="me" ;;
    *"/session/start") URL="session" ;;
    *"/admin/stats") URL="stats" ;;
    *"/health") URL="health" ;;
  esac
done
case "$URL" in
  me) echo '{"workspaceId":"ws-1"}' ;;
  session) echo '{}' ;;
  health) out '{"workspaceId":"ws-1","factsLive":1,"factsClosed":0}' 200 ;;
esac
EOF
chmod +x "$FAKE_BIN/curl"

OUT14=$(printf '%s' '{"session_id":"ep-empty","cwd":"/tmp"}' | bash "$HOOK")
assert_contains "episode reachable-but-empty: says NOT started, responded without an id" "$OUT14"   "Episode: NOT started — Mnemosyne responded without a session id"
assert_not_contains "episode reachable-but-empty: does NOT claim unreachable" "$OUT14"   "Episode: NOT started — Mnemosyne could not be reached"

# No session id from the host: NOT a failure, and must not be shouted about.
# Cursor's cloud agents and any host without a session id land here.
OUT15=$(printf '%s' '{"cwd":"/tmp"}' | bash "$HOOK")
assert_contains "no host session id: states the reason plainly" "$OUT15"   "Episode: not started — this host supplied no session id"
assert_not_contains "no host session id: not flagged as a warning" "$OUT15"   "⚠️ Episode"

unset MNEMO_URL MNEMO_KEY 2>/dev/null || true

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
