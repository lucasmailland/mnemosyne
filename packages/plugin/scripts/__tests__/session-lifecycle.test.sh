#!/bin/bash
# autonomous-memory Requirement 3 (auto-episode-lifecycle) — unit tests for
# session-start.sh (writes the Requirement 1 mapping instead of the old
# ad hoc /tmp file) and session-stop.sh (reads the mapping, fires the async
# collapse, deletes the mapping afterward). Mocks curl so no real network
# call happens.
#
# Run with: bash packages/plugin/scripts/__tests__/session-lifecycle.test.sh
# Returns exit 0 on pass, exit 1 on any failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
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

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label ($path does not exist)"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_absent() {
  local label="$1" path="$2"
  if [ ! -f "$path" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label ($path unexpectedly exists)"
    FAIL=$((FAIL + 1))
  fi
}

TMP_HOME=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
trap 'rm -rf "$TMP_HOME" "$FAKE_BIN"' EXIT
export HOME="$TMP_HOME"
export PATH="$FAKE_BIN:$PATH"
source "$SCRIPT_DIR/__tests__/legacy-runtime-fixture.sh"
install_legacy_runtime_fixture consent

# ── session-start.sh: writes the mapping when the server responds ───────────

cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/bash
# Fake curl: /me -> workspace, /session/start -> id, /admin/stats -> stats
for a in "$@"; do
  case "$a" in
    */me) echo '{"workspaceId":"ws-test-001"}'; exit 0 ;;
    */session/start) echo '{"id":"mnemo-sess-startup-1","status":"active"}'; exit 0 ;;
    */admin/stats) echo '{"facts":{"live":1,"closed":0},"lastWriteAt":null}'; exit 0 ;;
  esac
done
echo '{}'
EOF
chmod +x "$FAKE_BIN/curl"

export MNEMO_URL="http://localhost:3939"
export MNEMO_KEY="mns_test_fake"

OUT=$(printf '%s' '{"session_id":"claude-sess-A","cwd":"/tmp"}' | bash "${SCRIPT_DIR}/session-start.sh")
assert_file_exists "session-start.sh writes the session mapping" \
  "$TMP_HOME/.mnemo/sessions/claude-sess-A.json"
MAPPED_ID=$(jq -r '.mnemoSessionId' "$TMP_HOME/.mnemo/sessions/claude-sess-A.json" 2>/dev/null)
assert_eq "mapping contains the real Mnemosyne session id" "mnemo-sess-startup-1" "$MAPPED_ID"

if printf '%s' "$OUT" | grep -qi "Mnemosyne Memory Protocol"; then
  echo "PASS: session-start.sh still injects SKILL.md content on stdout"
  PASS=$((PASS + 1))
else
  echo "FAIL: session-start.sh did not inject SKILL.md content"
  FAIL=$((FAIL + 1))
fi

# ── session-start.sh: workspaceName/workspaceRole injection (D5, multi-tenancy
# closure plan) — piggybacks on the existing /me call, no new network call ──

cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/bash
for a in "$@"; do
  case "$a" in
    */me) echo '{"workspaceId":"ws-test-002","workspaceName":"Prod memory","workspaceRole":"read"}'; exit 0 ;;
    */session/start) echo '{"id":"mnemo-sess-startup-2","status":"active"}'; exit 0 ;;
    */admin/stats) echo '{"facts":{"live":1,"closed":0},"lastWriteAt":null}'; exit 0 ;;
  esac
done
echo '{}'
EOF
chmod +x "$FAKE_BIN/curl"

OUT_ROLE=$(printf '%s' '{"session_id":"claude-sess-role","cwd":"/tmp"}' | bash "${SCRIPT_DIR}/session-start.sh")

if printf '%s' "$OUT_ROLE" | grep -q "Prod memory"; then
  echo "PASS: session-start.sh injects workspaceName from /me"
  PASS=$((PASS + 1))
else
  echo "FAIL: session-start.sh did not inject workspaceName"
  FAIL=$((FAIL + 1))
fi

if printf '%s' "$OUT_ROLE" | grep -q "Your role: read"; then
  echo "PASS: session-start.sh injects workspaceRole from /me"
  PASS=$((PASS + 1))
else
  echo "FAIL: session-start.sh did not inject workspaceRole"
  FAIL=$((FAIL + 1))
fi

if printf '%s' "$OUT_ROLE" | grep -qi "read-only access"; then
  echo "PASS: session-start.sh surfaces a visible warning for role='read'"
  PASS=$((PASS + 1))
else
  echo "FAIL: session-start.sh did not surface the read-only warning"
  FAIL=$((FAIL + 1))
fi

# ── session-start.sh: no server configured — no mapping written, still exits cleanly ──

unset MNEMO_URL MNEMO_KEY 2>/dev/null || true
bash "${SCRIPT_DIR}/session-start.sh" < <(printf '%s' '{"session_id":"claude-sess-B","cwd":"/tmp"}') >/dev/null
assert_file_absent "no server configured: no mapping written" \
  "$TMP_HOME/.mnemo/sessions/claude-sess-B.json"

# ── session-stop.sh: helper to seed a mapping file ───────────────────────────

seed_mapping() {
  local claude_id="$1" mnemo_id="$2"
  mkdir -p "$TMP_HOME/.mnemo/sessions"
  echo "{\"mnemoSessionId\":\"${mnemo_id}\",\"createdAt\":\"2026-07-31T00:00:00Z\"}" \
    > "$TMP_HOME/.mnemo/sessions/${claude_id}.json"
}

export MNEMO_URL="http://localhost:3939"
export MNEMO_KEY="mns_test_fake"

# Fake curl distinguishing GET /session/:id (status snapshot) from
# POST .../collapse, driven by env vars the test sets before each run.
cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/bash
# FAKE_STATUS / FAKE_LAST_RECALL_AT drive the GET /session/:id response.
# FAKE_COLLAPSE_HTTP drives the POST .../collapse response code.
# FAKE_UNREACHABLE=1 makes every call behave like a connection failure.
IS_POST=0
for a in "$@"; do
  [ "$a" = "POST" ] && IS_POST=1
done

if [ "${FAKE_UNREACHABLE:-0}" = "1" ]; then
  # Real curl on a connection failure with -o /dev/null -w '%{http_code}'
  # prints "000"; with a plain GET (no -w), it prints nothing and exits nonzero.
  if [ "$IS_POST" = "1" ]; then
    echo -n "000"
  fi
  exit 7
fi

if [ "$IS_POST" = "1" ]; then
  touch "$TMP_HOME/collapse-called" 2>/dev/null || true
  echo -n "${FAKE_COLLAPSE_HTTP:-202}"
  exit 0
fi

# GET /session/:id
jq -n --arg status "${FAKE_STATUS:-active}" --arg lra "${FAKE_LAST_RECALL_AT:-}" \
  '{status: $status} + (if $lra != "" then {lastRecallAt: $lra} else {lastRecallAt: null} end)'
EOF
chmod +x "$FAKE_BIN/curl"
export TMP_HOME # so the fake curl script (subshell) can see it

# Scenario 1: healthy session — recall happened, model already collapsed it.
seed_mapping "claude-sess-C1" "mnemo-sess-1"
export FAKE_STATUS="collapsed" FAKE_LAST_RECALL_AT="2026-07-31T01:00:00.000Z"
rm -f "$TMP_HOME/collapse-called"
OUT=$(printf '%s' '{"session_id":"claude-sess-C1"}' | bash "${SCRIPT_DIR}/session-stop.sh")
assert_eq "healthy session: no systemMessage (no gap)" "" "$(echo "$OUT" | jq -r '.systemMessage // empty')"
assert_file_absent "healthy session: already collapsed by model — no extra collapse call fired" \
  "$TMP_HOME/collapse-called"
# P70 — the mapping must SURVIVE. `Stop` fires once per turn, so deleting it
# here severed both turn-writing and recall correlation from turn 2 onward.
assert_file_exists "session-stop.sh keeps the mapping (Stop is per-turn, not per-session)" \
  "$TMP_HOME/.mnemo/sessions/claude-sess-C1.json"

# Scenario 2: episode NOT yet collapsed mid-session — P70: this hook must NOT
# collapse. `Stop` runs per turn; collapsing here ended the episode after the
# first exchange. The server's 5-minute stale-session sweep owns collapse now,
# and it survives a kill -9, which no hook does.
seed_mapping "claude-sess-C2" "mnemo-sess-2"
export FAKE_STATUS="active" FAKE_LAST_RECALL_AT="2026-07-31T01:00:00.000Z" FAKE_COLLAPSE_HTTP="202"
rm -f "$TMP_HOME/collapse-called"
OUT=$(printf '%s' '{"session_id":"claude-sess-C2"}' | bash "${SCRIPT_DIR}/session-stop.sh")
assert_file_absent "session-stop.sh no longer collapses per turn" "$TMP_HOME/collapse-called"
assert_eq "an uncollapsed session mid-conversation is not a gap" "" "$(echo "$OUT" | jq -r '.systemMessage // empty')"

# Scenario 3: recall never correlated (lastRecallAt null) — genuine gap reported.
seed_mapping "claude-sess-C3" "mnemo-sess-3"
export FAKE_STATUS="active" FAKE_LAST_RECALL_AT="" FAKE_COLLAPSE_HTTP="202"
OUT=$(printf '%s' '{"session_id":"claude-sess-C3"}' | bash "${SCRIPT_DIR}/session-stop.sh")
MSG=$(echo "$OUT" | jq -r '.systemMessage // empty')
if printf '%s' "$MSG" | grep -qi "memory_recall was never correlated"; then
  echo "PASS: missing lastRecallAt is reported as a genuine gap"
  PASS=$((PASS + 1))
else
  echo "FAIL: missing lastRecallAt should be reported as a gap, got: $MSG"
  FAIL=$((FAIL + 1))
fi

# Scenario 3b: Stop runs once per TURN. The same gap is reported once per
# session, not repeated after every reply.
OUT=$(printf '%s' '{"session_id":"claude-sess-C3"}' | bash "${SCRIPT_DIR}/session-stop.sh")
assert_eq "the recall gap is reported once per session, not on every Stop" "" \
  "$(echo "$OUT" | jq -r '.systemMessage // empty')"
assert_eq "a repeated Stop still answers with valid JSON" "0" "$(echo "$OUT" | jq -e . >/dev/null 2>&1; echo $?)"

# Scenario 4: server unreachable for the whole session — both gaps reported.
seed_mapping "claude-sess-C4" "mnemo-sess-4"
unset FAKE_STATUS FAKE_LAST_RECALL_AT FAKE_COLLAPSE_HTTP
export FAKE_UNREACHABLE="1"
OUT=$(printf '%s' '{"session_id":"claude-sess-C4"}' | bash "${SCRIPT_DIR}/session-stop.sh")
MSG=$(echo "$OUT" | jq -r '.systemMessage // empty')
# P70 — only the recall gap remains reportable here. "Collapse failed" was
# dropped: with collapse moved to the server sweep, an uncollapsed session is the
# normal mid-conversation state, and reporting it every turn would train the
# reader to ignore the compliance check entirely.
if printf '%s' "$MSG" | grep -qi "memory_recall was never correlated" && ! printf '%s' "$MSG" | grep -qi "collapse failed"; then
  echo "PASS: unreachable server reports the recall gap, and no longer a false collapse gap"
  PASS=$((PASS + 1))
else
  echo "FAIL: expected the recall gap without a collapse gap, got: $MSG"
  FAIL=$((FAIL + 1))
fi
unset FAKE_UNREACHABLE

# ── session-stop.sh: no mapping for this session — no collapse call, no error ──

rm -f "$TMP_HOME/collapse-called"
export FAKE_STATUS="active" FAKE_LAST_RECALL_AT="2026-07-31T01:00:00.000Z" FAKE_COLLAPSE_HTTP="202"
OUT=$(printf '%s' '{"session_id":"claude-sess-never-started"}' | bash "${SCRIPT_DIR}/session-stop.sh")
assert_file_absent "session-stop.sh: no mapping means no collapse call" "$TMP_HOME/collapse-called"
assert_eq "session-stop.sh: no mapping means no gap report either" "" "$(echo "$OUT" | jq -r '.systemMessage // empty')"

# ── CLIENTS-2: compaction keeps the session open ─────────────────────────────
#
# post-compaction.sh and SKILL.md told the agent to call memory_episode_end on
# recovery. That archives the episode (a skipped collapse is terminal), so every
# later turn hit a 409 the hook discarded: the rest of the conversation was lost.
# The session is preserved across compaction: same mapping, no close instruction,
# later turns still posted.

mkdir -p "$TMP_HOME/.mnemo/harness/capture"
echo '{"version":1,"host":"claude-code","mode":"user-only","consentedAt":"x","hostVersion":"1","packageHash":"x"}' \
  > "$TMP_HOME/.mnemo/harness/capture/claude-code.json"
seed_mapping "claude-sess-K" "mnemo-sess-K"
cat > "$FAKE_BIN/curl" <<'KEOF'
#!/bin/bash
for a in "$@"; do
  case "$a" in
    */session/*/turn) echo "$*" >> "$TMP_HOME/turns-posted" ;;
  esac
done
echo '{"hits":[]}'
KEOF
chmod +x "$FAKE_BIN/curl"
rm -f "$TMP_HOME/turns-posted" /tmp/mnemo-claude-claude-sess-K-loaded

printf '%s' '{"session_id":"claude-sess-K","cwd":"/tmp","prompt":"before compaction"}' | bash "${SCRIPT_DIR}/user-prompt-submit.sh" >/dev/null
COMPACT_OUT=$(printf '%s' '{"session_id":"claude-sess-K","cwd":"/tmp"}' | bash "${SCRIPT_DIR}/post-compaction.sh")
printf '%s' '{"session_id":"claude-sess-K","cwd":"/tmp","prompt":"after compaction"}' | bash "${SCRIPT_DIR}/user-prompt-submit.sh" >/dev/null
sleep 0.5
rm -f /tmp/mnemo-claude-claude-sess-K-loaded

assert_eq "post-compaction keeps the session mapping" "mnemo-sess-K" \
  "$(jq -r '.mnemoSessionId' "$TMP_HOME/.mnemo/sessions/claude-sess-K.json" 2>/dev/null)"
if printf '%s' "$COMPACT_OUT" | grep -q "memory_episode_end"; then
  # the protocol may MENTION the tool, but must not order it as a recovery step
  if printf '%s' "$COMPACT_OUT" | grep -qiE "(call|1\.) *.?memory_episode_end.? with the compacted"; then
    echo "FAIL: post-compaction still orders memory_episode_end"; FAIL=$((FAIL + 1))
  else
    echo "PASS: post-compaction does not order memory_episode_end"; PASS=$((PASS + 1))
  fi
else
  echo "PASS: post-compaction does not order memory_episode_end"; PASS=$((PASS + 1))
fi
assert_eq "post-compaction tells the agent the session continues" "1" \
  "$(printf '%s' "$COMPACT_OUT" | grep -c 'mnemo-sess-K')"
assert_eq "a turn written after compaction reaches the same session" "1" \
  "$(grep -c 'after compaction' "$TMP_HOME/turns-posted" 2>/dev/null)"
rm -rf "$TMP_HOME/.mnemo/harness"

# Review round: with a workspace selected, the mapping session-start writes
# carries workspaceId, so post-compaction must resolve the same workspace before
# reading it (it read the mapping first and lost the session).
cat > "$FAKE_BIN/curl" <<'WEOF'
#!/bin/bash
for a in "$@"; do
  case "$a" in
    */session/start) echo '{"id":"mnemo-sess-WS"}'; exit 0 ;;
    */me) echo '{"workspaceId":"ws-L"}'; exit 0 ;;
  esac
done
echo '{}'
WEOF
chmod +x "$FAKE_BIN/curl"
printf '%s' '{"session_id":"claude-sess-W","cwd":"/tmp"}' | MNEMO_WORKSPACE_ID=ws-L bash "${SCRIPT_DIR}/session-start.sh" >/dev/null
assert_eq "session-start binds the mapping to the selected workspace" "ws-L" \
  "$(jq -r '.workspaceId' "$TMP_HOME/.mnemo/sessions/claude-sess-W.json" 2>/dev/null)"
WS_COMPACT=$(printf '%s' '{"session_id":"claude-sess-W","cwd":"/tmp"}' | MNEMO_WORKSPACE_ID=ws-L bash "${SCRIPT_DIR}/post-compaction.sh")
assert_eq "post-compaction restores the session when a workspace is selected" "1" \
  "$(printf '%s' "$WS_COMPACT" | grep -c 'sessionId: "mnemo-sess-WS"')"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
