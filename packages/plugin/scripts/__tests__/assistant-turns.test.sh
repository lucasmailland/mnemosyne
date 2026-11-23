#!/bin/bash
# The durable writer owns transcript security, redaction, pagination and replay;
# its repeatable specs live in harness/src/__tests__/legacy-capture.test.ts.
# This shell boundary must forward Stop and suppress all child output/failures.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/home/.mnemo/harness/capture"
printf '{"version":1,"host":"claude-code","mode":"full"}' > "$TEST_ROOT/home/.mnemo/harness/capture/claude-code.json"
cat > "$TEST_ROOT/mnemo" <<'SH'
#!/bin/bash
jq -nc --arg event "$2" --argjson input "$(cat)" '{event:$event,input:$input}' >> "$TEST_LOG"
printf 'child output must not reach the host\n'
exit 1
SH
chmod +x "$TEST_ROOT/mnemo"
payload='{"session_id":"assistant-fixture","transcript_path":"/controlled/transcript.jsonl"}'
output=$(printf '%s' "$payload" | env HOME="$TEST_ROOT/home" MNEMO_BIN="$TEST_ROOT/mnemo" MNEMO_HARNESS_V1_ENABLED= TEST_LOG="$TEST_ROOT/log" bash "$SCRIPT_DIR/session-stop.sh")
[ "$output" = '{}' ]
jq -e '.event == "Stop" and .input.transcript_path == "/controlled/transcript.jsonl"' "$TEST_ROOT/log" >/dev/null
printf 'Assistant capture launcher: 2 assertions passed\n'
