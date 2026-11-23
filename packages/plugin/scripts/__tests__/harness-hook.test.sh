#!/usr/bin/env bash
# Contract tests for harness-hook.sh: the launcher that stands between Claude
# Code's hook channel and the harness.
set -uo pipefail
# A developer machine may export the server's flag; the cases below set it explicitly.
unset MNEMO_HARNESS_V1_ENABLED

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${HERE}/../harness-hook.sh"
PASS=0
FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: ${name}"
    echo "  expected: ${expected}"
    echo "  actual:   ${actual}"
  fi
}

# A hook that exits non-zero can interrupt the user's turn. Nothing here is
# worth that, so every path must exit 0.
echo '{}' | bash "$HOOK" UserPromptSubmit >/dev/null 2>&1
check "exits 0 without consent" "0" "$?"

OUT=$(echo '{}' | bash "$HOOK" UserPromptSubmit 2>/dev/null)
check "emits valid JSON without consent" "0" "$(printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; echo $?)"

OUT=$(echo '{}' | bash "$HOOK" 2>/dev/null)
check "emits valid JSON with no event name" "0" "$(printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; echo $?)"
echo '{}' | bash "$HOOK" >/dev/null 2>&1
check "exits 0 with no event name" "0" "$?"

# A consented scratch home: the developer's real consent never decides a case.
CONSENTED_HOME="$(mktemp -d)"
mkdir -p "${CONSENTED_HOME}/.mnemo/harness/capture"
printf '{}' > "${CONSENTED_HOME}/.mnemo/harness/capture/claude-code.json"

# The binary does not exist: the most ordinary failure there is.
OUT=$(echo '{}' | HOME="$CONSENTED_HOME" MNEMO_BIN=/nonexistent/mnemo bash "$HOOK" Stop 2>/dev/null)
check "emits valid JSON when the CLI is missing" "0" "$(printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; echo $?)"
echo '{}' | HOME="$CONSENTED_HOME" MNEMO_BIN=/nonexistent/mnemo bash "$HOOK" Stop >/dev/null 2>&1
check "exits 0 when the CLI is missing" "0" "$?"

# A chatty child must not corrupt the host's JSON channel.
NOISY="$(mktemp)"
cat > "$NOISY" <<'INNER'
#!/usr/bin/env bash
echo "this is a diagnostic that must not reach stdout"
exit 1
INNER
chmod +x "$NOISY"
OUT=$(echo '{}' | HOME="$CONSENTED_HOME" MNEMO_BIN="$NOISY" bash "$HOOK" Stop 2>/dev/null)
check "child stdout never reaches the hook channel" "0" "$(printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; echo $?)"
check "hook stdout is exactly one object" "1" "$(printf '%s' "$OUT" | jq -s 'length' 2>/dev/null)"
rm -f "$NOISY"

# ── Consent: the on-disk marker, not just the environment variable ──────────
#
# The variable alone could never work as the only gate: an installer cannot set
# it in a host process that starts tomorrow. Every one of these runs with HOME
# pointed at a scratch directory so the developer's real consent is never what
# makes a test pass.
SCRATCH_HOME="$(mktemp -d)"
NOOP="$(mktemp)"
cat > "$NOOP" <<'INNER'
#!/usr/bin/env bash
cat >/dev/null
# On STDOUT: the launcher redirects the child's stdout to its own stderr, and
# sends the child's stderr to /dev/null, so this is the channel that survives.
echo "child ran"
INNER
chmod +x "$NOOP"

ran() {
  # The launcher reports on stderr whether it reached the child at all.
  local home="$1" host="${2:-}"
  local err
  if [ -n "$host" ]; then
    err=$(echo '{}' | HOME="$home" MNEMO_BIN="$NOOP" bash "$HOOK" --host "$host" SessionEnd 2>&1 >/dev/null)
  else
    err=$(echo '{}' | HOME="$home" MNEMO_BIN="$NOOP" bash "$HOOK" SessionEnd 2>&1 >/dev/null)
  fi
  case "$err" in *"child ran"*) echo "yes" ;; *) echo "no" ;; esac
}

check "no-ops with neither marker nor env var" "no" "$(ran "$SCRATCH_HOME")"

mkdir -p "${SCRATCH_HOME}/.mnemo/harness/capture"
printf '{}' > "${SCRATCH_HOME}/.mnemo/harness/capture/claude-code.json"
check "runs with the marker alone" "yes" "$(ran "$SCRATCH_HOME")"

# Consent is per host: Claude Code's marker must not enable Codex.
check "one host's marker does not enable another" "no" "$(ran "$SCRATCH_HOME" codex)"
printf '{}' > "${SCRATCH_HOME}/.mnemo/harness/capture/codex.json"
check "runs for codex with its own marker" "yes" "$(ran "$SCRATCH_HOME" codex)"

# APP-034c: MNEMO_HARNESS_V1_ENABLED is the server's feature flag. Client-side it
# is only a kill switch: `true` grants nothing, `false` stops a consented host.
ENVONLY_HOME="$(mktemp -d)"
ERR=$(echo '{}' | HOME="$ENVONLY_HOME" MNEMO_HARNESS_V1_ENABLED=true MNEMO_BIN="$NOOP" bash "$HOOK" SessionEnd 2>&1 >/dev/null)
case "$ERR" in *"child ran"*) ENVONLY="yes" ;; *) ENVONLY="no" ;; esac
check "the env var alone is not consent" "no" "$ENVONLY"
ERR=$(echo '{}' | HOME="$SCRATCH_HOME" MNEMO_HARNESS_V1_ENABLED=false MNEMO_BIN="$NOOP" bash "$HOOK" SessionEnd 2>&1 >/dev/null)
case "$ERR" in *"child ran"*) KILLED="no" ;; *) KILLED="yes" ;; esac
check "MNEMO_HARNESS_V1_ENABLED=false is a kill switch over the marker" "yes" "$KILLED"

# APP-035a: Codex's SessionStart rejects a bare {"continue": true}; every Codex
# event gets hookSpecificOutput with an (empty) additionalContext, consented or not.
for home in "$SCRATCH_HOME" "$ENVONLY_HOME"; do
  for event in SessionStart UserPromptSubmit SessionEnd; do
    OUT=$(echo '{}' | HOME="$home" MNEMO_BIN="$NOOP" bash "$HOOK" --host codex "$event" 2>/dev/null)
    check "codex ${event}: exactly one object" "1" "$(printf '%s' "$OUT" | jq -s 'length' 2>/dev/null)"
    check "codex ${event}: hookSpecificOutput names the event" "$event" \
      "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)"
    check "codex ${event}: additionalContext is an empty string" '""' \
      "$(printf '%s' "$OUT" | jq -c '.hookSpecificOutput.additionalContext' 2>/dev/null)"
  done
done
OUT=$(echo '{}' | HOME="$SCRATCH_HOME" MNEMO_BIN="$NOOP" bash "$HOOK" SessionEnd 2>/dev/null)
check "claude-code keeps the {continue:true} shape" "true" "$(printf '%s' "$OUT" | jq -r '.continue' 2>/dev/null)"

# The host reaches a path component, so an unknown one is refused, not interpolated.
OUT=$(echo '{}' | HOME="$SCRATCH_HOME" bash "$HOOK" --host ../../etc SessionEnd 2>/dev/null)
check "refuses an unknown host" "0" "$(printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; echo $?)"
check "refusing an unknown host still exits 0" "0" "$(echo '{}' | HOME="$SCRATCH_HOME" bash "$HOOK" --host ../../etc SessionEnd >/dev/null 2>&1; echo $?)"

# The contract that must survive all of the above.
OUT=$(echo '{}' | HOME="$SCRATCH_HOME" MNEMO_BIN="$NOOP" bash "$HOOK" SessionEnd 2>/dev/null)
check "consented run still emits exactly one object" "1" "$(printf '%s' "$OUT" | jq -s 'length' 2>/dev/null)"

# ── CLI resolution without `mnemo` on PATH ──────────────────────────────────
#
# Hooks run under launchd (Mac) or a systemd user session (Linux) whose PATH has
# no npm bin directory. The launcher must then use the node binary and CLI entry
# the installer recorded next to the plugin, and hand it the payload on stdin.
INSTALLED="$(mktemp -d)"
mkdir -p "${INSTALLED}/plugin/scripts" "${INSTALLED}/cli" "${INSTALLED}/bin"
cp "$HOOK" "${INSTALLED}/plugin/scripts/harness-hook.sh"
FAKE_NODE="${INSTALLED}/bin/fake-node"
cat > "$FAKE_NODE" <<'INNER'
#!/usr/bin/env bash
# argv: <cli entry> harness hook <host> <event>; stdin: the hook payload.
printf '%s\n' "$*" > "${FAKE_NODE_LOG}"
cat >> "${FAKE_NODE_LOG}"
INNER
chmod +x "$FAKE_NODE"
printf '// cli entry stub\n' > "${INSTALLED}/cli/index.js"
jq -n --arg node "$FAKE_NODE" --arg cli "${INSTALLED}/cli/index.js" '{node: $node, cli: $cli}' \
  > "${INSTALLED}/plugin/.mnemo-runtime.json"
LOCATOR_LOG="${INSTALLED}/node.log"
# A PATH with bash and jq but no mnemo: the system directories only.
BARE_PATH="/usr/bin:/bin"
for cand in /usr/bin/mnemo /bin/mnemo; do
  [ -e "$cand" ] && BARE_PATH="" # an installed system-wide mnemo would mask this case
done
if [ -n "$BARE_PATH" ]; then
  OUT=$(printf '{"session_id":"s-path"}' | env -u MNEMO_BIN PATH="$BARE_PATH" HOME="$SCRATCH_HOME" \
    FAKE_NODE_LOG="$LOCATOR_LOG" bash "${INSTALLED}/plugin/scripts/harness-hook.sh" Stop 2>/dev/null)
  check "resolves the CLI from the installed locator without mnemo on PATH" \
    "${INSTALLED}/cli/index.js harness hook claude-code Stop" "$(head -1 "$LOCATOR_LOG" 2>/dev/null)"
  check "forwards the hook payload on stdin" '{"session_id":"s-path"}' "$(sed -n 2p "$LOCATOR_LOG" 2>/dev/null)"
  check "locator run still emits exactly one object" "1" "$(printf '%s' "$OUT" | jq -s 'length' 2>/dev/null)"

  # An older global mnemo on PATH must not take over from the recorded runtime.
  mkdir -p "${INSTALLED}/global-bin"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "%s"\n' "${INSTALLED}/global-mnemo.log" \
    > "${INSTALLED}/global-bin/mnemo"
  chmod +x "${INSTALLED}/global-bin/mnemo"
  rm -f "$LOCATOR_LOG"
  printf '{"session_id":"s-both"}' | env -u MNEMO_BIN PATH="${INSTALLED}/global-bin:$BARE_PATH" \
    HOME="$SCRATCH_HOME" FAKE_NODE_LOG="$LOCATOR_LOG" \
    bash "${INSTALLED}/plugin/scripts/harness-hook.sh" Stop >/dev/null 2>&1
  check "prefers the installed locator over a mnemo on PATH" \
    "${INSTALLED}/cli/index.js harness hook claude-code Stop" "$(head -1 "$LOCATOR_LOG" 2>/dev/null)"
  check "does not run the mnemo on PATH when the locator resolves" "no" \
    "$([ -f "${INSTALLED}/global-mnemo.log" ] && echo yes || echo no)"

  # A stale locator (the CLI was moved) degrades to a failed capture, never a broken hook.
  rm -f "$LOCATOR_LOG" "${INSTALLED}/cli/index.js"
  OUT=$(printf '{}' | env -u MNEMO_BIN PATH="$BARE_PATH" HOME="$SCRATCH_HOME" \
    FAKE_NODE_LOG="$LOCATOR_LOG" bash "${INSTALLED}/plugin/scripts/harness-hook.sh" Stop 2>/dev/null)
  check "stale locator does not run node" "no" "$([ -f "$LOCATOR_LOG" ] && echo yes || echo no)"
  check "stale locator still emits valid JSON" "0" "$(printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; echo $?)"
fi
rm -rf "$INSTALLED"

rm -f "$NOOP"
rm -rf "$SCRATCH_HOME" "$ENVONLY_HOME" "$CONSENTED_HOME"

echo "harness-hook.test.sh: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
