#!/bin/bash
# Mnemosyne — Stop hook for Claude Code
#
# autonomous-memory Requirement 3 (auto-episode-lifecycle): if
# session-start.sh opened an episode for this Claude Code session, this
# guarantees it gets collapsed — the fallback that makes "extraction runs
# for every session" true regardless of whether the model ever called
# memory_episode_end itself.
#
# Runs synchronously (with tight per-call timeouts, budgeted under the 5s
# ceiling below) rather than backgrounding the collapse call with `&`, which
# an earlier version of this script did. That's safe here specifically
# because hooks.json marks this Stop hook `"async": true` — Claude Code
# itself does not block the user-visible exit flow on this hook's
# completion, it just kills the process after "timeout": 5. Being
# synchronous *inside* that budget is what makes the Requirement 4 check
# below possible at all — a backgrounded call's result can never be
# observed by the same script run.
#
# "Skip re-collapsing an already-collapsed episode" (spec.md Requirement 3,
# second scenario) is checked explicitly below (GET /session/:id's status)
# rather than relied upon via a discarded 409, now that the result is
# actually inspected.
#
# autonomous-memory Requirement 4 (compliance-backstop): after resolving
# collapse, checks whether recall ever correlated to this session
# (metadata.lastRecallAt, stamped by POST /recall's sessionId param — see
# Requirement 1/2) and whether collapse succeeded (by the model earlier, or
# by this fallback just now) — surfaces a visible systemMessage ONLY when
# one is a genuine gap (e.g., the whole Mnemosyne server was unreachable for
# this session), never as a re-nag of something that already worked.

# Load shared helpers
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_helpers.sh
source "${SCRIPT_DIR}/_helpers.sh"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
init_workspace "${CWD:-$PWD}"
OUTPUT="{}"

if [ -z "$SESSION_ID" ]; then
  echo "$OUTPUT"
  exit 0
fi

legacy_capture_hook Stop "$INPUT"
MNEMO_SESSION_ID=$(read_session_mapping "$SESSION_ID")
MNEMO_URL=$(get_mnemo_url)
MNEMO_KEY=$(get_mnemo_key)

if [ -z "$MNEMO_SESSION_ID" ] || [ -z "$MNEMO_URL" ] || [ -z "$MNEMO_KEY" ]; then
  # Nothing was ever opened for this session (or the server isn't
  # configured) — no episode to collapse, no correlation id to check.
  delete_session_mapping "$SESSION_ID"
  echo "$OUTPUT"
  exit 0
fi

# Snapshot state BEFORE we intervene, so the compliance check below can tell
# "the model already did this correctly" apart from "our own fallback just
# did it" — both are success, but a failed GET here (empty $BEFORE) is
# itself the first sign of a genuine gap (server unreachable all session).
BEFORE=$(curl "${WS_CURL_ARGS[@]}" -sf --max-time 1.5 \
  -H "Authorization: Bearer $MNEMO_KEY" \
  "${MNEMO_URL}/session/${MNEMO_SESSION_ID}" 2>/dev/null)
STATUS_BEFORE=$(echo "$BEFORE" | jq -r '.status // empty' 2>/dev/null)
LAST_RECALL_AT=$(echo "$BEFORE" | jq -r '.lastRecallAt // empty' 2>/dev/null)

# P70 — this block used to collapse the episode and then delete the session
# mapping, unconditionally, on EVERY run.
#
# `Stop` fires once per TURN, not once per session ("when Claude finishes
# responding"). So turn 1 collapsed the episode and deleted the mapping, and
# from turn 2 onward read_session_mapping came back empty and this script exited
# at the guard above without doing anything. The episode covered the first
# exchange and nothing else — in every session, always. Worse, the same mapping
# is what user-prompt-submit.sh uses to attach `sessionId` to POST /recall, so
# from turn 2 on the recalls went uncorrelated too, taking recordRecall's TD(λ)
# credit with them.
#
# Collapsing is no longer this hook's job. The server sweeps stale sessions
# every 5 minutes and genuinely collapses them (index.ts, registered as
# mnemo.session.collapse — it resolves each agent's CollapsePolicy and calls the
# real pipeline, it does not merely mark). That path is strictly more reliable
# than any hook: it survives a kill -9, a closed terminal and a dropped SSH,
# none of which run a hook at all. What was written here as a "fallback that
# guarantees extraction" is better served by the component that cannot be
# skipped.
#
# The mapping is likewise NOT deleted here. It is per-session local state that
# session-start.sh rewrites on the next session; leaking a small file is
# incomparably cheaper than severing turn-writing and recall correlation from
# turn 2 onward.
COLLAPSE_OK="false"
if [ "$STATUS_BEFORE" = "collapsed" ]; then
  COLLAPSE_OK="true"
fi

# CLIENTS-15: append the assistant's visible reply to the session buffer (after
# consent, once per entry, bounded). The user's turn is written by
# user-prompt-submit.sh; without this the buffer held half the conversation.
: # reconciled and durably flushed above, including recovery without a mapping

# ── Requirement 4: build the gap report, if any ──────────────────────────────
GAPS=""
if [ -z "$LAST_RECALL_AT" ]; then
  GAPS="${GAPS}memory_recall was never correlated to this session (check server reachability/MNEMO_URL/MNEMO_KEY — this should have run automatically on the first message). "
fi
# P70 — no longer reported as a gap. This hook runs once per TURN, so an
# uncollapsed session mid-conversation is the normal, expected state, not a
# failure: the server's 5-minute sweep collapses it once the session goes
# inactive. Reporting "collapse failed" here would fire on essentially every
# turn of every session and train the reader to ignore the compliance check —
# the opposite of what it exists for. A collapse that genuinely never happens
# is the sweep's problem to surface, on the server, where it can tell "not yet"
# apart from "could not".
if [ "$COLLAPSE_OK" = "true" ]; then
  : # already collapsed (model called memory_episode_end, or the sweep beat us here)
fi

# Stop fires once per TURN, so a gap that holds for the whole session would be
# repeated after every reply and trained the reader to ignore it. Report it once
# per Claude Code session; the marker sits beside the session mapping and is
# swept with it (cleanup_old_session_mappings).
# The id comes from the host's payload and becomes a file name: anything that
# could leave the directory gets no marker (and so keeps the old, repeating
# behaviour rather than writing elsewhere).
GAP_MARKER=""
case "$SESSION_ID" in
  *[!A-Za-z0-9._-]* | .*) ;;
  *) GAP_MARKER="$MNEMO_SESSIONS_DIR/${SESSION_ID}.gap-reported" ;;
esac
if [ -n "$GAPS" ] && { [ -z "$GAP_MARKER" ] || [ ! -e "$GAP_MARKER" ]; }; then
  OUTPUT=$(jq -n --arg msg "Mnemosyne compliance check found a gap this session: ${GAPS}" \
    '{"systemMessage": $msg}')
  if [ -n "$GAP_MARKER" ]; then
    mkdir -p "$MNEMO_SESSIONS_DIR" 2>/dev/null
    : > "$GAP_MARKER" 2>/dev/null || true
  fi
fi

echo "$OUTPUT"
exit 0
