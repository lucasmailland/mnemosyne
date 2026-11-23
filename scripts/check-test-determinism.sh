#!/usr/bin/env bash
# Fails if a *.test.ts uses a nondeterministic primitive without an explicit allow marker.
# To allow a specific line, append:  // determinism-ok: <reason>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hits=$(grep -rnE 'Math\.random\(|Date\.now\(|new Date\(\)' "$ROOT/packages" \
  --include='*.test.ts' | grep -v 'determinism-ok' || true)
if [[ -n "$hits" ]]; then
  echo "FAIL: nondeterministic primitives in tests — seed them or add '// determinism-ok: <reason>':" >&2
  echo "$hits" >&2
  exit 1
fi
echo "ok: no unguarded nondeterminism in tests"
