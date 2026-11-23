#!/bin/bash
# Capture honours a refused workspace selection, and a capture rollover
# publishes the successor session id to the model.
set -euo pipefail
SCRIPTS="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"; rm -f /tmp/mnemo-claude-blocked-ws-fixture-loaded /tmp/mnemo-claude-rollover-fixture-loaded' EXIT
mkdir -p "$TEST_ROOT/home/.mnemo/harness/capture" "$TEST_ROOT/bin"
cat > "$TEST_ROOT/bin/curl" <<'SH'
#!/bin/bash
for arg in "$@"; do
 case "$arg" in
 */health) printf '{"lastWriteAt":"2099-01-01T00:00:00.000Z"}'; exit 0 ;;
 */recall) printf '{"hits":[],"nothingRelevant":true}'; exit 0 ;;
 esac
done
printf '{}'
SH
cat > "$TEST_ROOT/bin/capture" <<'SH'
#!/bin/bash
cat >/dev/null
echo "${2:-}" >> "$CAPTURE_LOG"
SH
chmod +x "$TEST_ROOT/bin/"*
printf '{"version":1,"host":"claude-code","mode":"full"}' > "$TEST_ROOT/home/.mnemo/harness/capture/claude-code.json"
passed=0

# 1. A refused workspace selection captures nothing: the writer would fall back
#    to the key's default workspace.
mkdir -p "$TEST_ROOT/blocked-repo/.git"
printf '{"workspaceId":{}}' > "$TEST_ROOT/blocked-repo/.mnemo.json"
for event in UserPromptSubmit Stop PreCompact; do
 env HOME="$TEST_ROOT/home" PATH="$TEST_ROOT/bin:$PATH" MNEMO_BIN="$TEST_ROOT/bin/capture" \
  CAPTURE_LOG="$TEST_ROOT/blocked-events" BLOCKED_REPO="$TEST_ROOT/blocked-repo" EVENT="$event" \
  SCRIPT_DIR="$SCRIPTS" \
  bash -ec 'source "$SCRIPT_DIR/_helpers.sh"; init_workspace "$BLOCKED_REPO"; [ -n "$MNEMO_WS_BLOCKED" ]; legacy_capture_hook "$EVENT" "{\"session_id\":\"c\"}"'
done
[ ! -e "$TEST_ROOT/blocked-events" ]; passed=$((passed + 1))
printf '%s' '{"session_id":"blocked-ws-fixture","prompt":"hi","cwd":"'"$TEST_ROOT/blocked-repo"'"}' \
 | env HOME="$TEST_ROOT/home" PATH="$TEST_ROOT/bin:$PATH" MNEMO_BIN="$TEST_ROOT/bin/capture" MNEMO_URL=http://fixture \
  MNEMO_KEY=fixture MNEMO_HARNESS_V1_ENABLED= CAPTURE_LOG="$TEST_ROOT/blocked-events" \
  bash "$SCRIPTS/user-prompt-submit.sh" >/dev/null
[ ! -e "$TEST_ROOT/blocked-events" ]; passed=$((passed + 1))
# Control: the same launcher captures once the selection is valid.
printf '{"workspaceId":"ws-valid"}' > "$TEST_ROOT/blocked-repo/.mnemo.json"
env HOME="$TEST_ROOT/home" PATH="$TEST_ROOT/bin:$PATH" MNEMO_BIN="$TEST_ROOT/bin/capture" \
 CAPTURE_LOG="$TEST_ROOT/blocked-events" BLOCKED_REPO="$TEST_ROOT/blocked-repo" SCRIPT_DIR="$SCRIPTS" \
 bash -ec 'source "$SCRIPT_DIR/_helpers.sh"; init_workspace "$BLOCKED_REPO"; legacy_capture_hook Stop "{\"session_id\":\"c\"}"'
[ "$(cat "$TEST_ROOT/blocked-events")" = Stop ]; passed=$((passed + 1))

# 2. Capture that rolls a terminal segment over rewrites the mapping; the next
#    prompt must announce the successor id, and only when it changed.
cat > "$TEST_ROOT/bin/rollover" <<'SH'
#!/bin/bash
cat >/dev/null
mkdir -p "$HOME/.mnemo/sessions"
printf '{"mnemoSessionId":"%s","workspaceId":""}' "$(cat "$NEXT_SEGMENT")" > "$HOME/.mnemo/sessions/rollover-fixture.json"
SH
chmod +x "$TEST_ROOT/bin/rollover"
prompt_with_segment() {
 printf '%s' "$1" > "$TEST_ROOT/next-segment"
 printf '%s' '{"session_id":"rollover-fixture","prompt":"continue","cwd":"'"$TEST_ROOT"'"}' \
 | env HOME="$TEST_ROOT/home" PATH="$TEST_ROOT/bin:$PATH" MNEMO_BIN="$TEST_ROOT/bin/rollover" MNEMO_URL=http://fixture \
  MNEMO_KEY=fixture MNEMO_HARNESS_V1_ENABLED= NEXT_SEGMENT="$TEST_ROOT/next-segment" \
  bash "$SCRIPTS/user-prompt-submit.sh" > "$TEST_ROOT/output"
 jq -e . "$TEST_ROOT/output" >/dev/null
}
rm -f /tmp/mnemo-claude-rollover-fixture-loaded
prompt_with_segment first-segment
jq -e '.systemMessage | contains("sessionId: \"first-segment\"")' "$TEST_ROOT/output" >/dev/null; passed=$((passed + 1))
prompt_with_segment first-segment
jq -e '(.systemMessage // "") | contains("first-segment") | not' "$TEST_ROOT/output" >/dev/null; passed=$((passed + 1))
prompt_with_segment successor-segment
jq -e '.systemMessage | contains("sessionId: \"successor-segment\"")' "$TEST_ROOT/output" >/dev/null; passed=$((passed + 1))
prompt_with_segment successor-segment
jq -e '(.systemMessage // "") | contains("successor-segment") | not' "$TEST_ROOT/output" >/dev/null; passed=$((passed + 1))

# 3. APP-036b: the recorded runtime is used only when its node is executable;
#    otherwise the launcher falls through to a mnemo on PATH, as harness-hook.sh does.
INSTALLED="$TEST_ROOT/installed"
mkdir -p "$INSTALLED/plugin/scripts" "$INSTALLED/cli" "$INSTALLED/path-bin"
cp "$SCRIPTS/_helpers.sh" "$INSTALLED/plugin/scripts/_helpers.sh"
printf '// cli entry stub\n' > "$INSTALLED/cli/index.js"
cat > "$INSTALLED/path-bin/mnemo" <<'SH'
#!/bin/bash
cat >/dev/null
echo "path-mnemo $*" >> "$CAPTURE_LOG"
SH
cat > "$INSTALLED/node" <<'SH'
#!/bin/bash
cat >/dev/null
echo "recorded-node $*" >> "$CAPTURE_LOG"
SH
chmod +x "$INSTALLED/path-bin/mnemo"
run_locator() {
 rm -f "$TEST_ROOT/locator-events"
 env -u MNEMO_BIN HOME="$TEST_ROOT/home" PATH="$INSTALLED/path-bin:$PATH" CAPTURE_LOG="$TEST_ROOT/locator-events" \
  SCRIPT_DIR="$INSTALLED/plugin/scripts" \
  bash -ec 'source "$SCRIPT_DIR/_helpers.sh"; legacy_capture_hook Stop "{\"session_id\":\"c\"}"'
 cat "$TEST_ROOT/locator-events" 2>/dev/null || true
}
jq -n --arg node "$INSTALLED/node" --arg cli "$INSTALLED/cli/index.js" '{node: $node, cli: $cli}' \
 > "$INSTALLED/plugin/.mnemo-runtime.json"
chmod 644 "$INSTALLED/node"
[ "$(run_locator)" = "path-mnemo legacy-hook Stop" ]; passed=$((passed + 1))
chmod 755 "$INSTALLED/node"
[ "$(run_locator)" = "recorded-node $INSTALLED/cli/index.js legacy-hook Stop" ]; passed=$((passed + 1))

printf 'Capture destination: %d assertions passed\n' "$passed"
