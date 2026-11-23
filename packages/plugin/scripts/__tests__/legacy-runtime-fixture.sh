# Hook tests mock the CLI boundary. Durable delivery itself is tested in harness.
install_legacy_runtime_fixture() {
  export MNEMO_TEST_HELPERS="$SCRIPT_DIR/_helpers.sh"
  export MNEMO_BIN="$FAKE_BIN/mnemo-test"
  cat > "$MNEMO_BIN" <<'SH'
#!/bin/bash
source "$MNEMO_TEST_HELPERS"
payload=$(cat)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')
sid=$(printf '%s' "$payload" | jq -r '.session_id // empty')
init_workspace "${cwd:-$PWD}"
url=$(get_mnemo_url); key=$(get_mnemo_key)
[ -n "$url" ] && [ -n "$key" ] || exit 0
case "${2:-}" in
 SessionStart)
   response=$(curl "${WS_CURL_ARGS[@]}" -sf --max-time 2 -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -X POST "$url/session/start" -d '{}')
   code=$?
   id=$(printf '%s' "$response" | jq -r '.id // empty' 2>/dev/null)
   [ -z "$id" ] || write_session_mapping "$sid" "$id"
   jq -nc --argjson reached "$([ "$code" -eq 0 ] && echo true || echo false)" '{serverReached:$reached}'
   ;;
 UserPromptSubmit)
   msid=$(read_session_mapping "$sid")
   [ -n "$msid" ] || exit 0
   body=$(printf '%s' "$payload" | jq -c '{role:"user",content:.prompt}')
   curl "${WS_CURL_ARGS[@]}" -sf --max-time 2 -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -X POST "$url/session/$msid/turn" -d "$body" >/dev/null
   ;;
esac
SH
  chmod +x "$MNEMO_BIN"
  if [ "${1:-}" = consent ]; then
    mkdir -p "$HOME/.mnemo/harness/capture"
    printf '{"version":1,"host":"claude-code","mode":"user-only"}' > "$HOME/.mnemo/harness/capture/claude-code.json"
  fi
}
