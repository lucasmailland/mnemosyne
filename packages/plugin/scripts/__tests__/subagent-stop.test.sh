#!/bin/bash
# CLIENTS-1 — subagent-stop.sh posts a subagent's visible output to POST /capture. That
# is capture, so it needs the same consent marker as every other capture path
# (docs/guides/HARNESS.md). Default-deny.
#
# SS03 — the payload is the native SubagentStop shape observed on claude-code
# 2.1.325 (packages/harness/fixtures/claude-code-subagent-stop.json): the visible
# text is `last_assistant_message`, not `.stdout`. Sending assistant text also
# needs mode "full" (user-only and mcp-only never send it).
#
# Run with: bash packages/plugin/scripts/__tests__/subagent-stop.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="${SCRIPT_DIR}/subagent-stop.sh"
PASS=0
FAIL=0

check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS + 1)); else
    echo "FAIL: $1"; echo "  expected: $2"; echo "  actual:   $3"; FAIL=$((FAIL + 1)); fi
}

TMP_HOME=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
trap 'rm -rf "$TMP_HOME" "$FAKE_BIN"' EXIT
export HOME="$TMP_HOME"
export PATH="$FAKE_BIN:$PATH"
export MNEMO_URL="http://localhost:3939" MNEMO_KEY="mns_test_fake"
unset MNEMO_HARNESS_V1_ENABLED 2>/dev/null || true

cat > "$FAKE_BIN/curl" <<PROBE
#!/bin/bash
for arg in "\$@"; do
  case "\$arg" in
    */capture) echo "\$*" > "$TMP_HOME/capture-called" ;;
  esac
done
exit 0
PROBE
chmod +x "$FAKE_BIN/curl"

marker() { mkdir -p "$TMP_HOME/.mnemo/harness/capture"; printf '%s' "$2" > "$TMP_HOME/.mnemo/harness/capture/$1.json"; }
GOOD='{"version":1,"host":"claude-code","mode":"user-only","consentedAt":"x","hostVersion":"1","packageHash":"x"}'
FULL='{"version":1,"host":"claude-code","mode":"full","consentedAt":"x","hostVersion":"1","packageHash":"x"}'

# Parent session mapping for the consent fixture (provenance threading comes later).
mkdir -p "$TMP_HOME/.mnemo/sessions"
printf '%s' '{"mnemoSessionId":"sess_parent_s1","workspaceId":"","createdAt":"2026-07-31T00:00:00Z"}' > "$TMP_HOME/.mnemo/sessions/s1.json"

# Native canary payload (SS01 contract fields), visible text in last_assistant_message.
NATIVE="{\"session_id\":\"s1\",\"transcript_path\":\"$TMP_HOME/session.jsonl\",\"cwd\":\"$TMP_HOME\",\"hook_event_name\":\"SubagentStop\",\"stop_hook_active\":false,\"agent_id\":\"a1\",\"agent_type\":\"general-purpose\",\"agent_transcript_path\":\"$TMP_HOME/subagents/agent-a1.jsonl\",\"last_assistant_message\":\"SS03_CANARY visible subagent text\"}"

# feed <payload> — runs the hook, prints its exit code, keeps stderr in $TMP_HOME/stderr.
feed() {
  rm -f "$TMP_HOME/capture-called"
  printf '%s' "$1" | bash "$HOOK" >/dev/null 2>"$TMP_HOME/stderr"
  echo $?
}
posted() { [ -f "$TMP_HOME/capture-called" ] && echo yes || echo no; }

check "no consent: exits 0" "0" "$(feed "$NATIVE")"
check "no consent: nothing posted to /capture" "no" "$(posted)"

marker codex "$FULL"
feed "$NATIVE" >/dev/null
check "another host's marker does not authorise claude-code" "no" "$(posted)"

marker claude-code 'garbage{'
feed "$NATIVE" >/dev/null
check "unreadable marker reads as OFF" "no" "$(posted)"

marker claude-code "$GOOD"
check "user-only mode: exits 0" "0" "$(feed "$NATIVE")"
check "user-only mode: assistant text is never sent" "no" "$(posted)"

marker claude-code "$FULL"
check "full mode: exits 0" "0" "$(feed "$NATIVE")"
check "full mode: visible text is captured" "yes" "$(posted)"
check "full mode: posted body carries last_assistant_message" "yes" \
  "$(grep -q 'SS03_CANARY visible subagent text' "$TMP_HOME/capture-called" && echo yes || echo no)"
check "full mode: source is subagent-stop" "yes" \
  "$(grep -q 'subagent-stop' "$TMP_HOME/capture-called" && echo yes || echo no)"
check "full mode: curl budget is 8 seconds" "yes" \
  "$(grep -q -- '--max-time 8' "$TMP_HOME/capture-called" && echo yes || echo no)"

SECRET_PAYLOAD=$(printf '%s' "$NATIVE" | sed 's/SS03_CANARY visible subagent text/SS03_SECRET DB_PASSWORD=hunter2supersecret key mns_live_abcdefghijklmnop1234 done/')
feed "$SECRET_PAYLOAD" >/dev/null
check "full mode: secret payload is still captured" "yes" "$(posted)"
check "full mode: secret-named assignment value is redacted before posting" "no" \
  "$(grep -q 'hunter2supersecret' "$TMP_HOME/capture-called" && echo yes || echo no)"
check "full mode: mns_live key is redacted before posting" "no" \
  "$(grep -q 'mns_live_abcdefghijklmnop1234' "$TMP_HOME/capture-called" && echo yes || echo no)"
check "full mode: non-secret text survives redaction" "yes" \
  "$(grep -q 'SS03_SECRET' "$TMP_HOME/capture-called" && grep -q 'REDACTED' "$TMP_HOME/capture-called" && echo yes || echo no)"

marker claude-code "$FULL"
check "stdout-only payload (not the native shape) is not captured" "no" \
  "$(feed '{"session_id":"s1","stdout":"private stdout"}' >/dev/null; posted)"
check "stdout-only payload exits 0" "0" "$(feed '{"session_id":"s1","stdout":"private stdout"}')"
check "stdout-only payload: diagnostic is a reason code, no content" "yes" \
  "$(grep -q 'wrong_event' "$TMP_HOME/stderr" && ! grep -q 'private' "$TMP_HOME/stderr" && echo yes || echo no)"

check "empty payload exits 0" "0" "$(feed '')"
check "empty payload: diagnostic says empty" "yes" \
  "$(grep -q 'reason: empty' "$TMP_HOME/stderr" && echo yes || echo no)"
check "empty payload: nothing posted" "no" "$(posted)"

check "invalid JSON exits 0" "0" "$(feed 'garbage{ SS03_CANARY')"
check "invalid JSON: diagnostic says invalid_json, no content" "yes" \
  "$(grep -q 'reason: invalid_json' "$TMP_HOME/stderr" && ! grep -q 'SS03_CANARY' "$TMP_HOME/stderr" && echo yes || echo no)"

NO_TEXT=$(printf '%s' "$NATIVE" | sed 's/"last_assistant_message":"[^"]*"/"last_assistant_message":"   "/')
check "blank last_assistant_message: exits 0, nothing posted" "no" "$(feed "$NO_TEXT" >/dev/null; posted)"
check "blank last_assistant_message: diagnostic says no_visible_text" "yes" \
  "$(feed "$NO_TEXT" >/dev/null; grep -q 'reason: no_visible_text' "$TMP_HOME/stderr" && echo yes || echo no)"

marker claude-code "$GOOD"
rm -f "$TMP_HOME/capture-called"
printf '%s' "$NATIVE" | MNEMO_HARNESS_V1_ENABLED=true bash "$HOOK" >/dev/null 2>&1
check "env override does not unlock assistant text without mode full" "no" "$(posted)"

rm -rf "$TMP_HOME/.mnemo/harness"
feed "$NATIVE" >/dev/null
check "marker removed: capture stops" "no" "$(posted)"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
