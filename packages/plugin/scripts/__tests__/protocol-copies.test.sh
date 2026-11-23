#!/bin/bash
# AGENTSIM-13 — one canonical plugin protocol. SKILL.md is the source;
# GEMINI.md must carry it verbatim (plus its Gemini-only tail) and AGENTS.md's
# quick reference must not contradict it. These were three hand-edited copies
# that drifted (sessionId vs conversationId, subject vs scope, "end the episode
# on compaction", a 120-character limit the schema never enforced).
#
# Run with: bash packages/plugin/scripts/__tests__/protocol-copies.test.sh

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SKILL="$ROOT/skills/memory/SKILL.md"
PASS=0
FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

BODY=$(awk 'BEGIN{n=0} /^---$/ && n<2 {n++; next} n>=2 {print}' "$SKILL")
if [ -n "$BODY" ] && python3 - "$ROOT/GEMINI.md" "$BODY" <<'PYEOF'
import sys
gem=open(sys.argv[1]).read()
body=sys.argv[2].strip("\n")
sys.exit(0 if body in gem else 1)
PYEOF
then ok "GEMINI.md carries the SKILL.md protocol verbatim"; else bad "GEMINI.md has drifted from SKILL.md (regenerate it: SKILL.md body + Gemini tail)"; fi

for f in SKILL.md:"$SKILL" AGENTS.md:"$ROOT/AGENTS.md" GEMINI.md:"$ROOT/GEMINI.md"; do
  name="${f%%:*}"; path="${f#*:}"
  if grep -qiE "maximum 120|120 characters" "$path"; then bad "$name still states a 120-character limit"; else ok "$name has no 120-character limit"; fi
  # memory_decide has no sessionId parameter: its real schema field is
  # `conversationId` (packages/mcp/src/tools/decide.ts), and the PO04 protocol
  # tells agents to pass the open sessionId there. The drift this guards
  # against is conversationId on memory_remember, so memory_decide lines are
  # exempt — every other line is still checked.
  if grep -viE "memory_decide" "$path" | grep -qiE "pass conversationId|conversationId:"; then bad "$name tells the agent to pass conversationId"; else ok "$name never asks for conversationId"; fi
  if grep -qiE "(call|1\.) *\`?memory_episode_end\`? with the compacted" "$path"; then bad "$name orders memory_episode_end on compaction"; else ok "$name does not end the session on compaction"; fi
  if grep -q "sessionId" "$path"; then ok "$name names sessionId"; else bad "$name does not mention sessionId"; fi
  # APP-056: examples use an invented name, never a contributor's real one.
  if grep -q "Pablo" "$path"; then bad "$name uses a real first name as an example"; else ok "$name uses an invented example name"; fi
done
grep -q 'action: "turn"' "$SKILL" && ok "SKILL.md teaches pure-MCP agents to send turns" || bad "SKILL.md never teaches turns"
grep -q "429" "$SKILL" && ok "SKILL.md covers 429" || bad "SKILL.md says nothing about 429"
grep -q "1000" "$SKILL" && ok "SKILL.md states the real MCP limit" || bad "SKILL.md omits the 1000-character MCP limit"
grep -q "action: \"supersede\" and no" "$SKILL" && bad "SKILL.md keeps the stale 'server already archived' claim" || ok "SKILL.md dropped the stale supersede claim"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
