#!/bin/bash
# Shared by SessionStart, post-compaction and their output contract tests.
# Prints only what changes per session: session id and episode state, the
# workspace details read on stdin, and one pointer to the skill. The protocol
# itself reaches the model once, as the MCP server's instructions
# (packages/mcp/src/instructions.ts); repeating it here cost ~4.5 KB a session.
HOOK_OUTPUT_BUDGET_BYTES=1500

# Only auxiliary workspace details may be omitted. Keep complete UTF-8 lines,
# including later short diagnostics when an earlier metadata line is oversized.
fit_hook_details() {
  LC_ALL=C awk -v max="$1" '
    BEGIN { notice = "[Workspace details truncated]"; max -= length(notice) + 1 }
    { if (n + length($0) + 1 <= max) { print; n += length($0) + 1 } else cut = 1 }
    END { if (cut) print notice }
  '
}

# emit_hook_output <startup|compact> <session-id> <episode-state>
# Reads auxiliary details on stdin. Only those are ever truncated.
emit_hook_output() {
  local mode="$1" id="$2" state="${3:-}" critical heading footer details fixed remaining
  # Server IDs are UUIDs. Do not let malformed/unbounded upstream values crowd
  # provenance or the protocol out of the host's preview; never print a partial ID.
  case "$id" in *[!A-Za-z0-9._:-]*) id="" ;; esac
  [ "${#id}" -le 128 ] || id=""
  critical=$(
    if [ "$mode" = "compact" ]; then
      printf '## CRITICAL — POST-COMPACTION RECOVERY\n'
      printf 'Context was reset. The Mnemosyne session CONTINUES — do not end it or start a new one.\n'
    fi
    if [ -n "$id" ]; then
      printf 'Keep passing sessionId: "%s" to EVERY memory_remember.\n' "$id"
    else
      printf 'sessionId: unavailable; never invent one. Use memory_remember explicitly for facts worth keeping.\n'
    fi
    if [ "$mode" = "compact" ]; then
      printf 'Call memory_status, then memory_recall with current task keywords, even if status errors; only then continue.\n'
    elif [ -n "$id" ]; then
      printf 'Episode: open (%s) — plugin hooks record the turns; do not start or end it.\n' "$id"
    elif [ "$state" = "no-host" ]; then
      printf 'Episode: not started — this host supplied no session id\n'
    elif [ "$state" = "no-id" ]; then
      printf '⚠️ Episode: NOT started — Mnemosyne responded without a session id. No automatic extraction; use memory_remember explicitly.\n'
    else
      printf '⚠️ Episode: NOT started — Mnemosyne could not be reached. No automatic extraction; use memory_remember explicitly.\n'
    fi
  )
  heading='# Mnemosyne Memory Protocol: in the MCP server instructions.'
  footer='Examples and details: skill mnemosyne:memory (skills/memory/SKILL.md).'
  fixed=$(printf '%s\n\n%s\n\n%s\n' "$critical" "$heading" "$footer" | LC_ALL=C wc -c)
  # One extra newline separates optional details from the final skill pointer.
  remaining=$((HOOK_OUTPUT_BUDGET_BYTES - fixed - 1))
  details=$(fit_hook_details "$remaining")
  printf '%s\n\n%s\n\n' "$critical" "$heading"
  [ -z "$details" ] || printf '%s\n' "$details"
  printf '%s\n' "$footer"
}
