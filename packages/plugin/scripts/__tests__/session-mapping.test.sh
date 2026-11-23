#!/bin/bash
# autonomous-memory Requirement 1 — unit tests for write_session_mapping() /
# read_session_mapping() / delete_session_mapping() / cleanup_old_session_mappings()
#
# Run with: bash packages/plugin/scripts/__tests__/session-mapping.test.sh
# Returns exit 0 on pass, exit 1 on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_empty() {
  local label="$1" actual="$2"
  if [ -z "$actual" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected empty, got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label ($path does not exist)"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_absent() {
  local label="$1" path="$2"
  if [ ! -f "$path" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label ($path unexpectedly exists)"
    FAIL=$((FAIL + 1))
  fi
}

TMP_HOME=$(mktemp -d)
trap 'rm -rf "$TMP_HOME"' EXIT
export HOME="$TMP_HOME"

# shellcheck source=../_helpers.sh
source "${SCRIPT_DIR}/_helpers.sh"

# ── Test 1: read returns empty when no mapping exists yet ────────────────────

assert_empty "read_session_mapping returns empty when no mapping exists" \
  "$(read_session_mapping "claude-sess-unknown")"

# ── Test 2: write then read round-trips the mnemo session id ─────────────────

write_session_mapping "claude-sess-1" "mnemo-sess-abc123"
RESULT=$(read_session_mapping "claude-sess-1")
assert_eq "write_session_mapping then read_session_mapping round-trips" \
  "mnemo-sess-abc123" "$RESULT"

# ── Test 3: mapping file is written with 0600 perms and dir with 0700 ────────

MAPPING_FILE="$TMP_HOME/.mnemo/sessions/claude-sess-1.json"
assert_file_exists "mapping file was created" "$MAPPING_FILE"
PERMS=$(stat -c '%a' "$MAPPING_FILE" 2>/dev/null || stat -f '%Lp' "$MAPPING_FILE" 2>/dev/null)
assert_eq "mapping file has 0600 perms" "600" "$PERMS"

# ── Test 4: write_session_mapping with empty args is a safe no-op ───────────

write_session_mapping "" "mnemo-sess-should-not-write" || true
write_session_mapping "claude-sess-2" "" || true
assert_empty "write_session_mapping no-ops on empty claude_session_id" \
  "$(read_session_mapping "")"
assert_empty "write_session_mapping no-ops on empty mnemo_session_id" \
  "$(read_session_mapping "claude-sess-2")"

# ── Test 5: a second write for a different claude session_id doesn't clobber the first ──

write_session_mapping "claude-sess-3" "mnemo-sess-xyz789"
assert_eq "first mapping still intact after a second, different write" \
  "mnemo-sess-abc123" "$(read_session_mapping "claude-sess-1")"
assert_eq "second mapping independently readable" \
  "mnemo-sess-xyz789" "$(read_session_mapping "claude-sess-3")"

# ── Test 6: delete_session_mapping removes the file ──────────────────────────

delete_session_mapping "claude-sess-1"
assert_file_absent "delete_session_mapping removes the mapping file" "$MAPPING_FILE"
assert_empty "read_session_mapping returns empty after delete" \
  "$(read_session_mapping "claude-sess-1")"

# ── Test 7: delete_session_mapping on a nonexistent mapping is a safe no-op ──

delete_session_mapping "claude-sess-never-existed"
echo "PASS: delete_session_mapping on nonexistent mapping did not error"
PASS=$((PASS + 1))

# ── Test 8: cleanup_old_session_mappings deletes files older than 7 days ────

OLD_FILE="$TMP_HOME/.mnemo/sessions/claude-sess-old.json"
echo '{"mnemoSessionId":"mnemo-sess-old","createdAt":"2020-01-01T00:00:00Z"}' > "$OLD_FILE"
# Backdate mtime by 10 days so the +7 mtime filter catches it.
TOUCH_DATE=$(date -u -d '10 days ago' +%Y%m%d%H%M 2>/dev/null || date -u -v-10d +%Y%m%d%H%M 2>/dev/null)
touch -t "$TOUCH_DATE" "$OLD_FILE" 2>/dev/null || true

cleanup_old_session_mappings
assert_file_absent "cleanup_old_session_mappings deletes a 10-day-old mapping" "$OLD_FILE"
assert_file_exists "cleanup_old_session_mappings leaves recent mappings alone" \
  "$TMP_HOME/.mnemo/sessions/claude-sess-3.json"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
