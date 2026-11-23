#!/bin/bash
# CLIENTS-10 — the hooks ignored MNEMO_WORKSPACE_ID and .mnemo.json (the latter
# only drove the banner), so with a multi-workspace user token the hooks wrote to
# the key's default workspace while the CLI addressed the intended one. Same
# precedence as the CLI (cli/src/workspace-flag.ts): env > .mnemo.json. The chosen
# workspace is sent as X-Workspace-Id on EVERY request and is bound to the session
# mapping, so a later change of workspace never reuses another workspace's session.
#
# Run with: bash packages/plugin/scripts/__tests__/workspace-header.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS + 1)); else
    echo "FAIL: $1"; echo "  expected: $2"; echo "  actual:   $3"; FAIL=$((FAIL + 1)); fi
}

TMP_HOME=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
REPO=$(mktemp -d)
trap 'rm -rf "$TMP_HOME" "$FAKE_BIN" "$REPO"; rm -f /tmp/mnemo-claude-wh-*-loaded' EXIT
export HOME="$TMP_HOME"
export PATH="$FAKE_BIN:$PATH"
source "$SCRIPT_DIR/__tests__/legacy-runtime-fixture.sh"
install_legacy_runtime_fixture
export MNEMO_URL="http://localhost:3939" MNEMO_KEY="mns_test_fake"
unset MNEMO_WORKSPACE_ID MNEMO_HARNESS_V1_ENABLED 2>/dev/null || true
LOG="$TMP_HOME/curl.log"

mkdir -p "$REPO/.git" "$REPO/sub"
echo '{"workspaceId":"ws-file","label":"File"}' > "$REPO/.mnemo.json"
BARE=$(mktemp -d); mkdir -p "$BARE/.git"

mkdir -p "$TMP_HOME/.mnemo/harness/capture"
echo '{"version":1,"host":"claude-code","mode":"user-only","consentedAt":"x","hostVersion":"1","packageHash":"x"}' \
  > "$TMP_HOME/.mnemo/harness/capture/claude-code.json"

# One log line per curl call: its whole argv.
cat > "$FAKE_BIN/curl" <<CEOF
#!/bin/bash
echo "\$*" | tr '\\n' ' ' >> "$LOG"; echo >> "$LOG"
for a in "\$@"; do
  case "\$a" in
    */me) echo '{"workspaceId":"ws-x"}'; exit 0 ;;
    */session/start) echo '{"id":"mnemo-sess-new","status":"active"}'; exit 0 ;;
    */capture) exit 0 ;;
    */session/*) echo '{"status":"active","lastRecallAt":"2026-01-01"}'; exit 0 ;;
  esac
done
echo '{"hits":[]}'
CEOF
chmod +x "$FAKE_BIN/curl"

seed_map() { # claude_id mnemo_id [workspace-json-fragment]
  mkdir -p "$TMP_HOME/.mnemo/sessions"
  echo "{\"mnemoSessionId\":\"$2\"${3:-},\"createdAt\":\"2026-07-31T00:00:00Z\"}" > "$TMP_HOME/.mnemo/sessions/$1.json"
}
run_all() { # cwd  — every hook that talks HTTP, one session id per scenario
  local cwd="$1" sid="$2"
  rm -f "/tmp/mnemo-claude-${sid}-loaded"
  printf '{"session_id":"%s","cwd":"%s"}' "$sid" "$cwd" | bash "$SCRIPT_DIR/session-start.sh" >/dev/null 2>&1
  printf '{"session_id":"%s","cwd":"%s","prompt":"hi there"}' "$sid" "$cwd" | bash "$SCRIPT_DIR/user-prompt-submit.sh" >/dev/null 2>&1
  printf '{"session_id":"%s","cwd":"%s","prompt":"second"}' "$sid" "$cwd" | bash "$SCRIPT_DIR/user-prompt-submit.sh" >/dev/null 2>&1
  printf '{"session_id":"%s","cwd":"%s"}' "$sid" "$cwd" | bash "$SCRIPT_DIR/session-stop.sh" >/dev/null 2>&1
  printf '{"session_id":"%s","cwd":"%s","stdout":"agent output"}' "$sid" "$cwd" | bash "$SCRIPT_DIR/subagent-stop.sh" >/dev/null 2>&1
  sleep 0.4 # the turn write is detached
}
calls() { grep -c . "$LOG"; }
with_header() { grep -c -- "X-Workspace-Id: $1" "$LOG"; }

# 1. env beats .mnemo.json, on every request
: > "$LOG"; rm -rf "$TMP_HOME/.mnemo/sessions"
MNEMO_WORKSPACE_ID=ws-env run_all "$REPO/sub" wh-1
check "env: every request carries X-Workspace-Id: ws-env" "$(calls)" "$(with_header ws-env)"
check "env: .mnemo.json does not leak into any request" "0" "$(with_header ws-file)"
check "env: the hooks made requests at all (guards the check above)" "1" "$([ "$(calls)" -ge 6 ] && echo 1 || echo 0)"

# 2. .mnemo.json alone, found from a subdirectory, stopping at the repo boundary
: > "$LOG"; rm -rf "$TMP_HOME/.mnemo/sessions"
run_all "$REPO/sub" wh-2
check ".mnemo.json: every request carries X-Workspace-Id: ws-file" "$(calls)" "$(with_header ws-file)"

# 3. nothing configured: no header at all (the key's own workspace)
: > "$LOG"; rm -rf "$TMP_HOME/.mnemo/sessions"
run_all "$BARE" wh-3
check "no selection: no request carries X-Workspace-Id" "0" "$(grep -c -i 'x-workspace-id' "$LOG")"
check "no selection: requests were made" "1" "$([ "$(calls)" -ge 6 ] && echo 1 || echo 0)"

# 4. the mapping is bound to the workspace it was created under
: > "$LOG"; rm -rf "$TMP_HOME/.mnemo/sessions"
printf '{"session_id":"wh-4","cwd":"%s"}' "$REPO" | bash "$SCRIPT_DIR/session-start.sh" >/dev/null 2>&1
check "session-start records the destination in the mapping" "ws-file" \
  "$(jq -r '.workspaceId // empty' "$TMP_HOME/.mnemo/sessions/wh-4.json" 2>/dev/null)"
: > "$LOG"
rm -f /tmp/mnemo-claude-wh-4-loaded
printf '{"session_id":"wh-4","cwd":"%s","prompt":"after the workspace changed"}' "$REPO" \
  | MNEMO_WORKSPACE_ID=ws-other bash "$SCRIPT_DIR/user-prompt-submit.sh" >/dev/null 2>&1
sleep 0.4
check "mapping from workspace A is not reused under workspace B (no turn posted)" "0" "$(grep -c '/turn' "$LOG")"
check "...nor sent as the recall sessionId" "0" "$(grep -c 'mnemo-sess-new' "$LOG")"

# 5. a mapping written before this field existed keeps working
: > "$LOG"; seed_map wh-5 mnemo-sess-legacy
rm -f /tmp/mnemo-claude-wh-5-loaded
printf '{"session_id":"wh-5","cwd":"%s","prompt":"legacy mapping"}' "$BARE" | bash "$SCRIPT_DIR/user-prompt-submit.sh" >/dev/null 2>&1
sleep 0.4
check "legacy mapping (no workspaceId) still receives turns" "1" "$(grep -c 'mnemo-sess-legacy/turn' "$LOG")"

# 6. an unusable id sends nothing, rather than falling back to the default workspace
: > "$LOG"; rm -rf "$TMP_HOME/.mnemo/sessions"
rm -f /tmp/mnemo-claude-wh-6-loaded
OUT=$(printf '{"session_id":"wh-6","cwd":"%s","prompt":"x"}' "$BARE" | MNEMO_WORKSPACE_ID='ws bad;$(id)' bash "$SCRIPT_DIR/user-prompt-submit.sh" 2>/dev/null)
check "unsafe workspace id: no request at all" "0" "$(calls)"
check "unsafe workspace id: hook still emits valid JSON" "0" "$(printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; echo $?)"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
