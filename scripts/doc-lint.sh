#!/usr/bin/env bash
# doc-lint.sh — CI documentation consistency guard
# Fails if critical doc invariants are violated.
# Add to .github/workflows/ci.yml as a separate step.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAIL=0

fail() { echo "FAIL: $1" >&2; FAIL=1; }
pass() { echo "ok:   $1"; }

# ── 1. Critical files exist ────────────────────────────────────────────────────
for f in CLAUDE.md AGENTS.md CONTRIBUTING.md docs/STATUS.md docs/INDEX.md docs/RELEASING.md \
          docs/architecture/ARCHITECTURE.md docs/guides/CLI.md; do
  if [[ -f "$REPO_ROOT/$f" ]]; then
    pass "$f exists"
  else
    fail "$f is missing"
  fi
done

# ── 2. All 19 packages have README.md ─────────────────────────────────────────
PACKAGES=(types core adapter-postgres adapter-redis adapter-vector adapter-llm
          llm-providers server mcp cli client-ts consolidation cup federation plugins
          mock-server sdk-go sdk-python dashboard)
for pkg in "${PACKAGES[@]}"; do
  if [[ -f "$REPO_ROOT/packages/$pkg/README.md" ]]; then
    pass "packages/$pkg/README.md exists"
  else
    fail "packages/$pkg/README.md is missing"
  fi
done

# ── 3. CLAUDE.md mentions all 10 cognitive primitives ─────────────────────────
PRIMITIVES=(fact decision episode entity strategy workflow skill task event reasoning)
for prim in "${PRIMITIVES[@]}"; do
  if grep -q "$prim" "$REPO_ROOT/CLAUDE.md"; then
    pass "CLAUDE.md mentions primitive: $prim"
  else
    fail "CLAUDE.md does not mention primitive: $prim"
  fi
done

# ── 4. CLAUDE.md mentions all 9 RelationVerbs ─────────────────────────────────
VERBS=(related compatible scoped conflicts_with supersedes not_conflict derived_from part_of member_of)
for verb in "${VERBS[@]}"; do
  if grep -q "$verb" "$REPO_ROOT/CLAUDE.md"; then
    pass "CLAUDE.md mentions RelationVerb: $verb"
  else
    fail "CLAUDE.md does not mention RelationVerb: $verb"
  fi
done

# ── 5. RelationVerb in source has exactly 9 values ────────────────────────────
VERB_COUNT=$(grep -c '"related"\|"compatible"\|"scoped"\|"conflicts_with"\|"supersedes"\|"not_conflict"\|"derived_from"\|"part_of"\|"member_of"' \
  "$REPO_ROOT/packages/types/src/relations.ts" 2>/dev/null || echo 0)
if [[ "$VERB_COUNT" -ge 9 ]]; then
  pass "relations.ts has 9 RelationVerb values"
else
  fail "relations.ts has fewer than 9 RelationVerb values (found $VERB_COUNT lines)"
fi

# ── 6. Hexagonal domain (v3) has no infrastructure imports ────────────────────
# Scoped to the pure cognitive/session/security/resilience layers that must
# never import drizzle-orm, pg, redis, or @neondatabase directly.
# (packages/core/src/{db,factory,entity,...} is v2 legacy; purity is not
# enforced there by this guard.)
INFRA_IMPORTS=$(grep -rn "from ['\"]drizzle-orm\|from ['\"]pg\b\|from ['\"]redis\|from ['\"]@neondatabase" \
  "$REPO_ROOT/packages/core/src/cognitive/" \
  "$REPO_ROOT/packages/core/src/session/" \
  "$REPO_ROOT/packages/core/src/security/" \
  "$REPO_ROOT/packages/core/src/resilience/" \
  2>/dev/null | grep -v "\.test\.\|__tests__" || true)
if [[ -z "$INFRA_IMPORTS" ]]; then
  pass "packages/core v3 hex layer (cognitive/session/security/resilience) has no infrastructure imports"
else
  fail "packages/core v3 hex layer contains infrastructure imports:
$INFRA_IMPORTS"
fi

# ── 7. docs/STATUS.md mentions key stubs ──────────────────────────────────────
for stub in "memory_consolidate" "memory_remind_when" "stage 4"; do
  if grep -qi "$stub" "$REPO_ROOT/docs/STATUS.md"; then
    pass "STATUS.md mentions: $stub"
  else
    fail "STATUS.md does not mention: $stub"
  fi
done

# ── 8. MCP README has accurate tool count header ──────────────────────────────
# Derived from registry.ts (TOOL_REGISTRARS / MCP_TOOL_COUNT) rather than a
# hardcoded number — a hardcoded "N live" string is exactly what let the
# README drift to "26" while the registry had grown to 33 (see #121).
MCP_REGISTRY="$REPO_ROOT/packages/mcp/src/registry.ts"
TOOL_COUNT="$(awk '/const TOOL_REGISTRARS = \[/,/\] as const/' "$MCP_REGISTRY" | grep -cE '^\s*register[A-Za-z]+,?\s*$')"
if [[ "$TOOL_COUNT" -lt 15 ]]; then
  fail "could not parse TOOL_REGISTRARS from $MCP_REGISTRY (got count=$TOOL_COUNT — check the awk/grep pattern still matches)"
elif grep -q "$TOOL_COUNT live" "$REPO_ROOT/packages/mcp/README.md"; then
  pass "packages/mcp/README.md reflects $TOOL_COUNT live tools (matches registry.ts)"
else
  fail "packages/mcp/README.md does not mention '$TOOL_COUNT live' — registry.ts has $TOOL_COUNT registered tools, README is stale"
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "All doc-lint checks passed."
else
  echo "One or more doc-lint checks FAILED. See output above." >&2
  exit 1
fi
