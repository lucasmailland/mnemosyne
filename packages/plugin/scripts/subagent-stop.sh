#!/bin/bash
# Mnemosyne — SubagentStop hook (async, fire-and-forget)
#
# When a Claude Code subagent finishes, its visible final text (the native
# SubagentStop field `last_assistant_message`, SS01 contract in
# packages/harness/fixtures/claude-code-subagent-stop.json) is sent to Mnemosyne's
# passive capture endpoint (POST /capture) for automatic fact extraction. The
# transcript file is never opened. Sending it requires consent AND mode "full".
# Runs async so it never delays Claude Code's workflow.
#
# Timeout budget: hooks.json gives this hook a 10s ceiling (async — a
# timeout doesn't block the user, but a hung process still lingers and
# leaks). Unlike every other hook script here, this curl call had no
# --max-time at all: without one, curl falls back to OS-level TCP
# timeouts on a stalled (not actively-refused) connection, which can run
# well past 10s. Capped at 8s — consistent with the other scripts'
# explicit budgeting, with ~2s slack under the harness kill-timeout.
#
# autonomous-memory Requirement 3, roll-up decision (tasks.md 3.3): subagent
# sessions do NOT get their own Mnemosyne episode. POST /capture extracts
# facts directly from the provided content — it has never created a session/
# episode record, so there is no separate subagent episode to fragment
# against the parent's in the first place; the "roll up, don't fragment"
# recommendation is already satisfied by this endpoint's existing design.
# SS07 binding: the parent session is resolved with read_session_mapping under
# the active workspace and sent as parentSessionId, with the canonical project
# (scopeRef), native agent id, a source message id and an explicit evaluation
# origin (MNEMO_TRAFFIC_ORIGIN, only when set). A missing mapping, or one opened
# under another workspace, posts nothing and opens no session: the hook logs a
# reason code only and exits 0.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_helpers.sh
source "${SCRIPT_DIR}/_helpers.sh"

INPUT=$(cat)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
init_workspace "${CWD:-$PWD}"

# CLIENTS-1 + mode: this sends assistant text. Without consent AND mode "full"
# it is a no-op, and the payload's text is not read at all
# (assistant_capture_allowed in _helpers.sh).
assistant_capture_allowed || exit 0

# Diagnostics carry a reason code only, never payload content.
diag() { echo "subagent-stop: payload not captured (reason: $1)" >&2; }
[ -n "$(printf '%s' "$INPUT" | tr -d '[:space:]')" ] || { diag empty; exit 0; }
CODE=$(printf '%s' "$INPUT" | jq -r '
  if type != "object" then "unknown_payload"
  elif .hook_event_name != "SubagentStop" then "wrong_event"
  elif ((.session_id | type) != "string" or .session_id == "" or (.agent_id | type) != "string" or .agent_id == "") then "unknown_payload"
  elif ((.last_assistant_message | type) != "string") or (.last_assistant_message | test("\\S") | not) then "no_visible_text"
  else "ok" end' 2>/dev/null)
[ -n "$CODE" ] || CODE=invalid_json
[ "$CODE" = ok ] || { diag "$CODE"; exit 0; }
OUTPUT=$(printf '%s' "$INPUT" | jq -r '.last_assistant_message')
[ "${#OUTPUT}" -le 65536 ] || { diag oversize; exit 0; }
# Nothing credential-shaped leaves the machine: the same shared redactor the
# assistant-turn capture path uses (redact_secrets in _helpers.sh). The server's
# PII redaction does not know these credential shapes.
OUTPUT=$(printf '%s' "$OUTPUT" | redact_secrets)
[ -n "$OUTPUT" ] || { diag redaction_failed; exit 0; }

MNEMO_URL=$(get_mnemo_url)
MNEMO_KEY=$(get_mnemo_key)

# Skip silently if Mnemosyne is not configured
[ -z "$MNEMO_URL" ] || [ -z "$MNEMO_KEY" ] && exit 0

# SS07: bind to the parent session. A mapping file that exists but is not readable
# under the active workspace is a binding mismatch; no file at all is a missing
# mapping. Neither case opens or rewrites a session.
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id')
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id')
PARENT_ID=$(read_session_mapping "$SESSION_ID")
if [ -z "$PARENT_ID" ]; then
  if [ -f "$MNEMO_SESSIONS_DIR/${SESSION_ID}.json" ]; then diag binding_mismatch; else diag no_session_mapping; fi
  exit 0
fi
PROJECT=$(detect_project "${CWD:-$PWD}")
ORIGIN="${MNEMO_TRAFFIC_ORIGIN:-}"

curl "${WS_CURL_ARGS[@]}" -sf --max-time 8 \
  -H "Authorization: Bearer $MNEMO_KEY" \
  -H "Content-Type: application/json" \
  -X POST \
  "${MNEMO_URL}/capture" \
  -d "$(jq -n --arg content "$OUTPUT" --arg source "subagent-stop" \
    --arg parent "$PARENT_ID" --arg scope "$PROJECT" --arg agent "$AGENT_ID" \
    --arg src "${SESSION_ID}:${AGENT_ID}" --arg origin "$ORIGIN" \
    '{content: $content, source: $source, parentSessionId: $parent, agentId: $agent, sourceMessageId: $src}
     + (if $scope == "" then {} else {scopeRef: $scope} end)
     + (if $origin == "" then {} else {trafficOrigin: $origin} end)')" \
  > /dev/null 2>&1

exit 0
