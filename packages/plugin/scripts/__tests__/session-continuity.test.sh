#!/bin/bash
# Launcher contract. Delivery, replay and transcript fidelity are exercised by
# harness/src/__tests__/legacy-capture.test.ts using the real durable writer.
set -euo pipefail
SCRIPTS="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/home/.mnemo/harness/capture" "$TEST_ROOT/bin"
cat > "$TEST_ROOT/bin/mnemo" <<'SH'
#!/bin/bash
payload=$(cat)
jq -nc --arg event "${2:-}" --argjson payload "$payload" '{event:$event,payload:$payload}' >> "$CAPTURE_LOG"
if [ "${2:-}" = SessionStart ]; then
 mkdir -p "$HOME/.mnemo/sessions"
 printf '{"mnemoSessionId":"existing-segment","workspaceId":""}' > "$HOME/.mnemo/sessions/continuity-fixture.json"
fi
SH
cat > "$TEST_ROOT/bin/curl" <<'SH'
#!/bin/bash
for arg in "$@"; do
 case "$arg" in
 */me) printf '{"workspaceId":"fixture"}'; exit 0 ;;
 */health) printf '{"lastWriteAt":"2099-01-01T00:00:00.000Z"}'; exit 0 ;;
 */recall) printf '{"hits":[],"nothingRelevant":true}'; exit 0 ;;
 esac
done
printf '{}'
SH
chmod +x "$TEST_ROOT/bin/"*
printf '{"version":1,"host":"claude-code","mode":"full"}' > "$TEST_ROOT/home/.mnemo/harness/capture/claude-code.json"
run_hook() {
 local script="$1" event="${2:-}"
 printf '%s' '{"session_id":"continuity-fixture","source":"resume","prompt":"<task-notification>done</task-notification>","cwd":"/tmp"}' \
 | env HOME="$TEST_ROOT/home" PATH="$TEST_ROOT/bin:$PATH" MNEMO_BIN="$TEST_ROOT/bin/mnemo" MNEMO_URL=http://fixture MNEMO_KEY=fixture MNEMO_HARNESS_V1_ENABLED= CAPTURE_LOG="$TEST_ROOT/events" bash "$SCRIPTS/$script" "$event" > "$TEST_ROOT/output"
 case "$script" in session-stop.sh|user-prompt-submit.sh|legacy-lifecycle.sh) jq -e . "$TEST_ROOT/output" >/dev/null ;; esac
}
run_hook session-start.sh
run_hook user-prompt-submit.sh
run_hook session-stop.sh
run_hook post-compaction.sh
run_hook legacy-lifecycle.sh PreCompact
run_hook legacy-lifecycle.sh SessionEnd
jq -es 'map(.event) == ["SessionStart","UserPromptSubmit","Stop","PostCompact","PreCompact","SessionEnd"]' "$TEST_ROOT/events" >/dev/null
jq -es '.[1].payload.prompt == "<task-notification>done</task-notification>"' "$TEST_ROOT/events" >/dev/null
jq -e '.mnemoSessionId == "existing-segment"' "$TEST_ROOT/home/.mnemo/sessions/continuity-fixture.json" >/dev/null
jq -e '.hooks.SessionStart[0].matcher | contains("resume")' "$SCRIPTS/../hooks/hooks.json" >/dev/null
before=$(wc -l < "$TEST_ROOT/events")
rm "$TEST_ROOT/home/.mnemo/harness/capture/claude-code.json"
run_hook session-stop.sh
[ "$(wc -l < "$TEST_ROOT/events")" -eq "$before" ]

# An npx install records its own runtime even when an older global CLI is on PATH.
mkdir -p "$TEST_ROOT/installed/scripts"
cp "$SCRIPTS/_helpers.sh" "$TEST_ROOT/installed/scripts/_helpers.sh"
cp "$TEST_ROOT/bin/mnemo" "$TEST_ROOT/installed/cli.sh"
cat > "$TEST_ROOT/bin/mnemo" <<'SH'
#!/bin/bash
echo old-path-runtime >> "$CAPTURE_LOG"
exit 1
SH
jq -nc --arg node "$(command -v bash)" --arg cli "$TEST_ROOT/installed/cli.sh" \
 '{node:$node,cli:$cli}' > "$TEST_ROOT/installed/.mnemo-runtime.json"
printf '{"version":1,"host":"claude-code","mode":"user-only"}' > "$TEST_ROOT/home/.mnemo/harness/capture/claude-code.json"
run_launcher() {
 env HOME="$TEST_ROOT/home" PATH="$TEST_ROOT/bin:$PATH" MNEMO_BIN="$1" \
  SCRIPT_DIR="$TEST_ROOT/installed/scripts" CAPTURE_LOG="$TEST_ROOT/runtime-events" \
  bash -ec 'source "$SCRIPT_DIR/_helpers.sh"; legacy_capture_hook Stop '\''{"session_id":"c"}'\'''
}
run_launcher ""
jq -es 'length == 1 and .[0].event == "Stop" and .[0].payload.session_id == "c"' "$TEST_ROOT/runtime-events" >/dev/null

# An explicit override still takes precedence over the recorded runtime.
printf '{malformed' > "$TEST_ROOT/installed/.mnemo-runtime.json"
cat > "$TEST_ROOT/override" <<'SH'
#!/bin/bash
cat >/dev/null
echo explicit-override >> "$CAPTURE_LOG"
SH
chmod +x "$TEST_ROOT/override"
rm "$TEST_ROOT/runtime-events"
run_launcher "$TEST_ROOT/override"
[ "$(cat "$TEST_ROOT/runtime-events")" = explicit-override ]
printf 'Session continuity launcher: 12 assertions passed\n'
