#!/bin/bash
# harden-hooks-and-measure-precision Requirement 3 (hook-event-contract) —
# asserts every event key in packages/plugin/hooks/hooks.json belongs to a
# maintained allowlist of real Claude Code hook events, and that every
# script path the manifest references exists on disk and is executable.
#
# This exists to make one specific failure impossible: a renamed or invented
# event name produces no error, no log, and no capture — it simply never
# fires (the claude-mem #2435 lesson, docs/research/MEMORY_SYSTEMS_LANDSCAPE.md
# §2 lesson L6). A test that cannot fail is the failure mode this file
# exists to prevent, so Tests 1-2 below prove the checker functions
# genuinely detect a broken fixture before Tests 3-4 assert the real
# manifest is clean.
#
# Allowlist sourced from (no bundled Claude Code hook schema is installed
# locally to import programmatically, so this is corroborated from multiple
# independent local artifacts rather than one source):
#   - ~/.claude/cache/changelog.md — explicit prose mentions of
#     PreToolUse, PostToolUse, Notification, PreCompact, SessionEnd,
#     SessionStart, UserPromptSubmit, Stop, SubagentStop as real hook types
#     Claude Code fires/consumes.
#   - The `engram` plugin's own hooks.json (a comparable persistent-memory
#     plugin, installed locally) declares the exact same 4 events as this
#     plugin: SessionStart, UserPromptSubmit, SubagentStop, Stop.
#   - The `vercel` official plugin's hooks-json-structural.test.ts asserts
#     against `hooksJson.hooks.SubagentStart` and `.SubagentStop` as valid
#     (if often-empty) keys, confirming SubagentStart is real and paired
#     with SubagentStop.
#   - The `hookify` official plugin's hooks.json additionally exercises
#     PreToolUse and PostToolUse.
#
# Run with: bash packages/plugin/scripts/__tests__/hook-event-contract.test.sh
# Returns exit 0 on pass, exit 1 on any failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOOKS_JSON="${PLUGIN_ROOT}/hooks/hooks.json"
PASS=0
FAIL=0

assert_empty() {
  local label="$1" actual="$2"
  if [ -z "$actual" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected empty, got: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected to find: $needle)"
    echo "  actual: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

# ── The maintained allowlist ──────────────────────────────────────────────────
# See the header comment for the corroboration sources. Adding a genuinely
# new Claude Code hook event requires updating this list deliberately, not
# silently — that is the entire point of this file.
ALLOWLIST="PreToolUse PostToolUse Notification UserPromptSubmit Stop SubagentStart SubagentStop PreCompact SessionStart SessionEnd"

# ── Checker 1: every declared event key must be in the allowlist ─────────────
# Prints each offending (non-allowlisted) key, one per line. Empty output
# means every key passed.
check_hook_events() {
  local hooks_file="$1"
  local key
  while IFS= read -r key; do
    [ -z "$key" ] && continue
    if ! printf '%s\n' $ALLOWLIST | grep -qxF "$key"; then
      echo "$key"
    fi
  done < <(jq -r '.hooks | keys[]' "$hooks_file" 2>/dev/null)
}

# ── Checker 2: every referenced script must exist and be executable ──────────
# Commands take the shape: bash "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.sh" —
# extracts the script path, resolves it against the real plugin root, and
# prints each missing/non-executable resolved path, one per line.
check_hook_scripts() {
  local hooks_file="$1" plugin_root="$2"
  local cmd script_rel resolved
  while IFS= read -r cmd; do
    [ -z "$cmd" ] && continue
    script_rel=$(printf '%s' "$cmd" | sed -n 's/.*CLAUDE_PLUGIN_ROOT}\(\/scripts\/[a-zA-Z0-9_.-]*\.sh\).*/\1/p')
    if [ -z "$script_rel" ]; then
      echo "UNPARSEABLE_COMMAND:$cmd"
      continue
    fi
    resolved="${plugin_root}${script_rel}"
    if [ ! -x "$resolved" ]; then
      echo "$resolved"
    fi
  done < <(jq -r '.hooks[][].hooks[].command' "$hooks_file" 2>/dev/null)
}

# ── Test 1: the event-allowlist checker genuinely fails on a bad fixture ─────
# Proves the checker is not a tautology before trusting it against the real
# file. Renames SessionStart -> a value absent from the allowlist in a
# throwaway fixture copy (the real hooks.json is never touched) and asserts
# the checker both flags it AND names the exact offending key.

FIXTURE_EVENTS=$(mktemp)
trap 'rm -f "$FIXTURE_EVENTS" "${FIXTURE_SCRIPTS:-}"' EXIT

jq '.hooks.NotARealClaudeCodeEvent = .hooks.SessionStart | del(.hooks.SessionStart)' \
  "$HOOKS_JSON" > "$FIXTURE_EVENTS"

FIXTURE_EVENT_RESULT=$(check_hook_events "$FIXTURE_EVENTS")
assert_contains "RED proof: renamed event key is detected and named" \
  "$FIXTURE_EVENT_RESULT" "NotARealClaudeCodeEvent"

# ── Test 2: the script-existence checker genuinely fails on a bad fixture ────
# Points a hook command at a script that does not exist, in a throwaway
# fixture copy, and asserts the checker flags the missing resolved path.

FIXTURE_SCRIPTS=$(mktemp)
jq '(.hooks.SessionStart[0].hooks[0].command) =
  "bash \"${CLAUDE_PLUGIN_ROOT}/scripts/does-not-exist.sh\""' \
  "$HOOKS_JSON" > "$FIXTURE_SCRIPTS"

FIXTURE_SCRIPT_RESULT=$(check_hook_scripts "$FIXTURE_SCRIPTS" "$PLUGIN_ROOT")
assert_contains "RED proof: missing script path is detected and named" \
  "$FIXTURE_SCRIPT_RESULT" "does-not-exist.sh"

# ── Test 3: the real hooks.json — every declared event is allowlisted ────────

REAL_EVENT_RESULT=$(check_hook_events "$HOOKS_JSON")
assert_empty "hooks.json: every declared event key is in the allowlist" "$REAL_EVENT_RESULT"

# ── Test 4: the real hooks.json — every referenced script exists + is executable ──

REAL_SCRIPT_RESULT=$(check_hook_scripts "$HOOKS_JSON" "$PLUGIN_ROOT")
assert_empty "hooks.json: every referenced script exists and is executable" "$REAL_SCRIPT_RESULT"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
