#!/bin/bash
# Mnemosyne — sessionEnd hook for CURSOR.
#
# P73, and it fixes P70's problem on this host rather than reproducing it.
#
# On Claude Code the collapse hangs off `Stop`, which fires ONCE PER TURN. That
# is why the episode used to die after the first exchange — the hook cannot
# tell "the assistant finished talking" from "the session is over", because
# Claude Code has no SessionEnd. Cursor DOES: `sessionEnd` fires once, with a
# `reason` (`completed|aborted|error|window_close|user_close`) and a
# `duration_ms`. A real close signal, so the collapse belongs exactly here and
# nowhere else on this host.
#
# `session-stop.sh` already does the work — resolve the episode, collapse it if
# the model never did, and surface a gap only when one is genuine. It reads
# `session_id` from stdin, which Cursor also supplies. Its `systemMessage`
# output shape is Claude Code's, and Cursor has no equivalent for a
# fire-and-forget close hook, so the body is discarded here: the collapse is
# the point, the message was only ever the nicety.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT=$(cat)

printf '%s' "$INPUT" | bash "${SCRIPT_DIR}/session-stop.sh" >/dev/null 2>&1

# Cursor treats sessionEnd as fire-and-forget. Always succeed: a non-zero exit
# here would be reported to the user at the exact moment they are closing the
# window, about work whose failure they can do nothing with.
exit 0
