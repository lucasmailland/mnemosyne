#!/bin/bash
# Mnemosyne — sessionStart hook for CURSOR.
#
# P73. Cursor is not a degraded host and has not been for a while: it emits
# ~20 hook events, `sessionStart` accepts an `additional_context` field, and
# `~/.cursor/hooks.json` is user-global. That is push, close signal and global
# config — the three things that made Claude Code our only real host.
#
# This is a thin adapter, ON PURPOSE. The logic that decides what memory to
# inject lives in `session-start.sh` and must not be duplicated: two copies of
# an injection policy drift, and the drift is invisible because both hosts keep
# working. The only difference between hosts is the SHAPE of the answer.
#
#   Claude Code: plain stdout is taken as additionalContext.
#   Cursor:      stdout must be JSON with an `additional_context` field.
#
# So: run the real script, capture what it would have said, wrap it.
#
# Cursor's stdin carries `session_id`, the same field name `session-start.sh`
# already reads, so the input passes through untouched.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT=$(cat)

# Never let a hook failure block the user's session. A memory layer that stops
# someone from starting work is worse than a memory layer that missed a turn.
CONTEXT=$(printf '%s' "$INPUT" | bash "${SCRIPT_DIR}/session-start.sh" 2>/dev/null) || CONTEXT=""

if [ -z "$CONTEXT" ]; then
  # `{}` and not an empty body: Cursor should see a well-formed no-op, not a
  # parse error it might report as a broken hook.
  echo '{}'
  exit 0
fi

jq -n --arg ctx "$CONTEXT" '{additional_context: $ctx}'
