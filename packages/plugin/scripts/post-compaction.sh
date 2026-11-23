#!/bin/bash
# Mnemosyne — Post-compaction hook for Claude Code
#
# Injects bounded recovery instructions and the session's state when context is
# reset; the protocol itself stays in the MCP server's instructions (APP-021).
# Stdout goes to Claude as additionalContext.

# Load shared helpers
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_helpers.sh
source "${SCRIPT_DIR}/_helpers.sh"
# shellcheck source=./_hook-output.sh
source "${SCRIPT_DIR}/_hook-output.sh"

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
# The mapping is bound to the workspace it was opened under: resolve it first.
init_workspace "${CWD:-$PWD}"
legacy_capture_hook PostCompact "$INPUT"
MNEMO_SESSION_ID=""
[ -n "$SESSION_ID" ] && MNEMO_SESSION_ID=$(read_session_mapping "$SESSION_ID")

# CLIENTS-2: compaction does not end the session. This used to order
# memory_episode_end here; a skipped collapse archives the episode, so every
# later turn of the conversation was rejected (409) and lost. The mapping is
# left alone and the same session keeps receiving turns.
emit_hook_output compact "$MNEMO_SESSION_ID" </dev/null

exit 0
