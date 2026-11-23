#!/usr/bin/env bash
# Mnemosyne harness hook launcher for Claude Code.
#
# Claude parses this hook's STDOUT as JSON. Anything else printed there — a
# warning, a stack trace, a progress line from a tool we shelled out to — makes
# the hook look malformed and can break the turn. So stdout carries exactly one
# JSON object and nothing else; every diagnostic goes to stderr, which Claude
# ignores.
#
# It also always exits 0. A non-zero hook can interrupt the user's session, and a
# memory system is never worth that. Failure is recorded locally by the harness
# and surfaced through `mnemo harness doctor`, not by breaking the editor.
set -uo pipefail

# Both hook manifests route through this one launcher, so the host has to be a
# parameter. It used to be hardcoded to claude-code, which meant every Codex
# event was recorded against the wrong host — and, once consent became per-host,
# would have checked the wrong marker too.
#
# The flag is optional and defaults to claude-code so that manifests already
# installed on disk, which call this as `harness-hook.sh <event>`, keep working.
HOST="claude-code"
if [ "${1:-}" = "--host" ]; then
  HOST="${2:-}"
  shift 2 2>/dev/null || shift $#
fi

EVENT="${1:-}"
PAYLOAD="$(cat 2>/dev/null || true)"

# The one hook response, printed once on the way out, whatever happened below.
#
# Codex's SessionStart validator rejects a bare {"continue": true}: it needs a
# well-formed hookSpecificOutput with at least an empty additionalContext
# (harness/fixtures/codex-events.json, quirks; adapters/codex.ts hookResponse is
# the reference). That shape is sent for every Codex event. The event name only
# ever comes from our own manifests; anything outside [A-Za-z] is dropped so it
# cannot break the JSON.
emit_ok() {
  if [ "$HOST" = "codex" ]; then
    printf '{"hookSpecificOutput": {"hookEventName": "%s", "additionalContext": ""}}\n' \
      "$(printf '%s' "$EVENT" | tr -cd 'A-Za-z')"
  else
    printf '{"continue": true}\n'
  fi
}

if [ -z "$EVENT" ]; then
  echo "harness-hook: missing event name" >&2
  emit_ok
  exit 0
fi

# The host name becomes a path component below, so it is checked against the
# known set rather than interpolated on trust.
case "$HOST" in
  opencode | claude-code | codex) ;;
  *)
    echo "harness-hook: unknown host: ${HOST}" >&2
    emit_ok
    exit 0
    ;;
esac

# Capture is opt-in. Without explicit consent this is a no-op, so installing the
# plugin never starts recording conversations on its own.
#
# Consent is an on-disk marker, written per host by `mnemo install --capture`.
# It used to be the environment variable alone, which no installer can set: the
# host process that reads it starts tomorrow, in a shell we do not control. So
# the manifest installed, reported success, and captured nothing.
#
# MNEMO_HARNESS_V1_ENABLED is the server's feature flag. Here it is only a kill
# switch: `false` (or 0) stops capture, `true` grants nothing (APP-034c). The
# managed runtime re-checks the marker's mode and the qualification behind it.
CONSENT_MARKER="${HOME}/.mnemo/harness/capture/${HOST}.json"
case "$(printf '%s' "${MNEMO_HARNESS_V1_ENABLED:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
  false | 0) emit_ok; exit 0 ;;
esac
if [ ! -f "$CONSENT_MARKER" ]; then
  emit_ok
  exit 0
fi

run_mnemo_hook() {
  if [ -n "${MNEMO_BIN:-}" ]; then
    "$MNEMO_BIN" harness hook "$HOST" "$EVENT"
    return $?
  fi
  local script_dir cli_entry="" node_bin="" locator
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # Hooks often run with a PATH that has no npm bin directory (launchd on a Mac,
  # a systemd user session on Linux). The installer records the node binary and
  # CLI entry it installed from next to the plugin payload; that is the path the
  # managed writer must use, not whatever happens to be on PATH.
  locator="${script_dir}/../.mnemo-runtime.json"
  if [ -f "$locator" ] && command -v jq >/dev/null 2>&1; then
    node_bin="$(jq -r '.node // empty' "$locator" 2>/dev/null)"
    cli_entry="$(jq -r '.cli // empty' "$locator" 2>/dev/null)"
    if [ -n "$node_bin" ] && [ -x "$node_bin" ] && [ -n "$cli_entry" ] && [ -f "$cli_entry" ]; then
      "$node_bin" "$cli_entry" harness hook "$HOST" "$EVENT"
      return $?
    fi
    node_bin=""
    cli_entry=""
  fi
  # A mnemo on PATH comes only after the recorded runtime: an older global CLI
  # must not take over the hooks of the version the installer set up.
  if command -v mnemo >/dev/null 2>&1; then
    mnemo harness hook "$HOST" "$EVENT"
    return $?
  fi
  for candidate in \
    "${script_dir}/../../cli/dist/index.js" \
    "${script_dir}/../../dist/index.js"; do
    if [ -f "$candidate" ]; then
      cli_entry="$candidate"
      break
    fi
  done
  if [ -n "$cli_entry" ]; then
    for nb in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
      if [ -n "$nb" ] && [ -x "$nb" ]; then
        node_bin="$nb"
        break
      fi
    done
    if [ -n "$node_bin" ]; then
      "$node_bin" "$cli_entry" harness hook "$HOST" "$EVENT"
      return $?
    fi
  fi
  return 1
}

# stdout is redirected to stderr for the child: the harness may print progress or
# warnings, and none of that may reach the host's JSON channel.
if ! printf '%s' "$PAYLOAD" | run_mnemo_hook 1>&2 2>/dev/null; then
  echo "harness-hook: capture failed for ${EVENT}" >&2
fi

emit_ok
exit 0
