#!/bin/bash
# Mnemosyne — Shared helpers for Claude Code hooks
# WARNING: Do not read from stdin here — scripts source this before reading their hook input.

# Detect project name from git remote, with fallbacks.
# Priority: git remote origin repo name > git root basename > cwd basename
detect_project() {
  local dir="$1"

  # Try git remote origin URL
  # Handles both SSH (git@github.com:user/repo.git) and HTTPS (https://github.com/user/repo.git)
  local url
  url=$(git -C "$dir" remote get-url origin 2>/dev/null)
  if [ -n "$url" ]; then
    local name
    name=$(echo "$url" | sed 's/\.git$//' | sed 's|.*[/:]||')
    if [ -n "$name" ]; then
      echo "$name"
      return
    fi
  fi

  # Fallback: git root directory name (works in worktrees)
  local root
  root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$root" ]; then
    basename "$root"
    return
  fi

  # Final fallback: cwd basename
  basename "$dir"
}

# Read a key from ~/.mnemo/config.json
read_config() {
  local key="$1"
  local config_file="$HOME/.mnemo/config.json"
  [ -f "$config_file" ] || return
  jq -r ".$key // empty" "$config_file" 2>/dev/null
}

# Get workspace ID for a project from ~/.mnemo/workspaces.json
get_workspace_id() {
  local project="$1"
  local ws_file="$HOME/.mnemo/workspaces.json"
  [ -f "$ws_file" ] || return

  local wid
  wid=$(jq -r --arg p "$project" '.[$p].workspaceId // empty' "$ws_file" 2>/dev/null)
  if [ -n "$wid" ]; then
    echo "$wid"
    return
  fi

  # Single non-default entry fallback
  local count
  count=$(jq 'keys | map(select(. != "default")) | length' "$ws_file" 2>/dev/null)
  if [ "$count" = "1" ]; then
    jq -r 'to_entries | map(select(.key != "default")) | .[0].value.workspaceId // empty' \
      "$ws_file" 2>/dev/null
    return
  fi

  # Fallback to "default"
  jq -r '.default.workspaceId // empty' "$ws_file" 2>/dev/null
}

# Get MNEMO_URL: env var → config file
get_mnemo_url() {
  # An unusable workspace selection (init_workspace) sends nothing: falling back
  # to the key's default workspace would write somewhere the user did not choose.
  [ -n "${MNEMO_WS_BLOCKED:-}" ] && return
  if [ -n "$MNEMO_URL" ]; then
    echo "$MNEMO_URL"
    return
  fi
  read_config "url"
}

# Get MNEMO_KEY: env var → config file
get_mnemo_key() {
  if [ -n "$MNEMO_KEY" ]; then
    echo "$MNEMO_KEY"
    return
  fi
  read_config "apiKey"
}

# ── Presupuesto del recall automático (user-prompt-submit.sh) ───────────────
#
# El `--max-time` de ese recall estaba hardcodeado en 1.5s, elegido midiendo
# contra el stack local (el propio script anota "~0.9-1.1s, Ollama"). Contra un
# servidor remoto el supuesto no se sostiene: medido contra una instancia detrás
# de TLS con embeddings de Bedrock, el mismo recall cuesta entre 0.53s y 1.82s
# según pegue o no la caché del embedding. El corte quedaba en el medio de la
# distribución y el recall fallaba de forma intermitente — que se lee como un
# servidor inestable, no como un presupuesto corto.
#
# Subir el default para todos le cobraría esa latencia a quien corre Mnemosyne
# local, que es justo para quien 1.5s sobra. Por eso es configuración.
RECALL_TIMEOUT_DEFAULT_S=1.5
# Techo. hooks.json le pone un timeout duro al hook; pedir más que eso no compra
# nada — Claude Code lo mata igual, y encima sin el mensaje de degradación que
# el script sí emite cuando es curl quien corta.
RECALL_TIMEOUT_MAX_S=8

# Presupuesto en SEGUNDOS listo para `curl --max-time`, desde
# `recallTimeoutMs` de ~/.mnemo/config.json.
#
# Todo lo que no sea un entero positivo cae al default: `--max-time abc` hace
# fallar a curl entero, y `--max-time 0` significa "sin límite" para curl, que
# es lo contrario de lo que espera quien escribe 0 — dejaría el hook colgado
# hasta que lo mate el runtime.
get_recall_timeout() {
  local ms
  ms=$(read_config "recallTimeoutMs")
  awk -v ms="$ms" -v def="$RECALL_TIMEOUT_DEFAULT_S" -v max="$RECALL_TIMEOUT_MAX_S" 'BEGIN{
    if (ms !~ /^[0-9]+$/ || ms + 0 <= 0) { print def; exit }
    s = ms / 1000
    if (s > max) s = max
    if (s == int(s)) printf "%d\n", s; else printf "%g\n", s
  }'
}

# The first prompt is sent to /recall as the query without capture consent, so
# it is redacted (redact_secrets) and cut to this many characters (APP-033).
RECALL_QUERY_MAX_CHARS=500

# Whole-hook budget for UserPromptSubmit: hooks.json kills it at 10s, and one
# second is kept for jq and the JSON answer, so the degradation message always
# gets out.
PROMPT_HOOK_BUDGET_MS=9000
# Below this, a recall cannot answer in time and is not attempted.
RECALL_MIN_REMAINING_MS=250

# Monotonic-enough wall clock in milliseconds. bash 5 has EPOCHREALTIME; the
# macOS bash 3.2 fallback is whole seconds, rounded UP when measuring elapsed.
now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local s="${EPOCHREALTIME%[.,]*}" f="${EPOCHREALTIME#*[.,]}000"
    printf '%s\n' "$(( s * 1000 + 10#${f:0:3} ))"
  else
    local ns
    ns=$(date +%s%N 2>/dev/null)
    case "$ns" in
      *[!0-9]* | "") printf '%s\n' "$(( $(date +%s) * 1000 + 999 ))" ;;
      *) printf '%s\n' "$(( ns / 1000000 ))" ;;
    esac
  fi
}

# The recall's `curl --max-time` once $1 (a now_ms reading at hook start) has
# been spent: the configured timeout, cut to what is left of the hook budget.
# Prints nothing when too little is left for a recall to be worth starting.
remaining_recall_timeout() {
  local started="$1" configured elapsed
  configured=$(get_recall_timeout)
  elapsed=$(( $(now_ms) - started ))
  awk -v c="$configured" -v left="$(( PROMPT_HOOK_BUDGET_MS - elapsed ))" \
    -v min="$RECALL_MIN_REMAINING_MS" 'BEGIN{
    if (left < min) exit
    s = left / 1000
    if (s > c) s = c
    if (s == int(s)) printf "%d\n", s; else printf "%.3g\n", s
  }'
}

# Get personal workspace ID from ~/.mnemo/workspaces.json (P10)
# Returns empty string if not set or jq is unavailable.
get_personal_workspace_id() {
  local ws_file="$HOME/.mnemo/workspaces.json"
  [ -f "$ws_file" ] || return
  jq -r '.personalWorkspaceId // empty' "$ws_file" 2>/dev/null
}

# Find per-repo .mnemo.json project config (P29/P31)
# Walks up from $dir, stopping at .git boundary or filesystem root.
# Prints raw JSON string of .mnemo.json if found and valid.
find_project_config() {
  local curr="${1:-$PWD}"
  while [ -n "$curr" ] && [ "$curr" != "/" ]; do
    if [ -f "$curr/.mnemo.json" ]; then
      local content
      content=$(cat "$curr/.mnemo.json" 2>/dev/null)
      if echo "$content" | jq -e '.workspaceId' >/dev/null 2>&1; then
        echo "$content"
        return 0
      fi
    fi
    # Stop at .git boundary (directory or worktree file)
    if [ -e "$curr/.git" ]; then
      return 1
    fi
    curr="$(dirname "$curr")"
  done
  return 1
}

# ── autonomous-memory Requirement 1 — session correlation ───────────────────
#
# Maps Claude Code's own session_id (from hook stdin) to the Mnemosyne
# session/episode id session-start.sh opens for it, so later hooks in the
# SAME Claude Code session (user-prompt-submit.sh, session-stop.sh,
# subagent-stop.sh) can find it without re-deriving or re-creating it.
# Replaces the earlier ad hoc /tmp/mnemo-session-<id> file with a durable,
# documented location + a real cleanup policy (that file had neither).

MNEMO_SESSIONS_DIR="$HOME/.mnemo/sessions"

# ── Workspace selection (CLIENTS-10) ────────────────────────────────────────
#
# Same precedence as the CLI (cli/src/workspace-flag.ts), minus its flag, which
# hooks do not have: MNEMO_WORKSPACE_ID > the repo's .mnemo.json. Without either,
# nothing is sent and the key's own workspace applies. Hooks used to ignore both,
# so a multi-workspace user token wrote them to its default workspace while the
# CLI addressed the intended one.
#
# init_workspace <dir> sets MNEMO_WS_ID and WS_CURL_ARGS, which every curl call
# in the hooks expands. An id with characters outside [A-Za-z0-9._:-] (or over 128
# of them) is refused (MNEMO_WS_BLOCKED): it would become an HTTP header, and
# silently dropping it would redirect the write to the default workspace.
MNEMO_WS_ID=""
MNEMO_WS_BLOCKED=""
WS_CURL_ARGS=()
init_workspace() {
  local dir="${1:-$PWD}" ws pj
  MNEMO_WS_ID=""; MNEMO_WS_BLOCKED=""; WS_CURL_ARGS=()
  ws=$(printf '%s' "${MNEMO_WORKSPACE_ID:-}" | tr -d '[:space:]')
  if [ -z "$ws" ]; then
    pj=$(find_project_config "$dir" 2>/dev/null) && ws=$(printf '%s' "$pj" | jq -r '.workspaceId // empty' 2>/dev/null)
  fi
  [ -n "$ws" ] || return 0
  case "$ws" in
    *[!A-Za-z0-9._:-]*) MNEMO_WS_BLOCKED=1; return 0 ;;
  esac
  [ "${#ws}" -le 128 ] || { MNEMO_WS_BLOCKED=1; return 0; }
  MNEMO_WS_ID="$ws"
  WS_CURL_ARGS=(-H "X-Workspace-Id: $ws")
}

# Format written by write_session_mapping:
#   { "mnemoSessionId": "sess_abc123", "workspaceId": "ws-1", "createdAt": "2026-07-31T12:00:00Z" }
#
# workspaceId is the destination the session was opened under ("" = the key's
# own). A mapping is only returned to a caller addressing the SAME destination,
# so a later change of .mnemo.json or MNEMO_WORKSPACE_ID never feeds turns or
# recall into a session that belongs to another workspace. Mappings written
# before the field existed carry no workspaceId and keep working.

# Persist the mapping for a Claude Code session_id. Best-effort — a failure
# to write (disk full, permissions) must never block the calling hook.
write_session_mapping() {
  local claude_session_id="$1"
  local mnemo_session_id="$2"
  [ -n "$claude_session_id" ] && [ -n "$mnemo_session_id" ] || return
  mkdir -p "$MNEMO_SESSIONS_DIR" 2>/dev/null
  chmod 700 "$MNEMO_SESSIONS_DIR" 2>/dev/null
  local file="$MNEMO_SESSIONS_DIR/${claude_session_id}.json"
  jq -n --arg id "$mnemo_session_id" --arg ws "${MNEMO_WS_ID:-}" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{mnemoSessionId: $id, workspaceId: $ws, createdAt: $ts}' > "${file}.$$.tmp" 2>/dev/null
  mv -f "${file}.$$.tmp" "$file" 2>/dev/null
  chmod 600 "$file" 2>/dev/null
  cleanup_old_session_mappings
}

# Read back the Mnemosyne session id for a Claude Code session_id. Prints
# empty string (not an error) when no mapping exists yet — callers should
# treat that as "no correlation available this turn," not a hard failure.
read_session_mapping() {
  local claude_session_id="$1"
  [ -n "$claude_session_id" ] || return
  local file="$MNEMO_SESSIONS_DIR/${claude_session_id}.json"
  [ -f "$file" ] || return
  local destination
  destination=$(get_mnemo_url)
  jq -r --arg ws "${MNEMO_WS_ID:-}" --arg url "${destination%/}" \
    'if (has("workspaceId") and .workspaceId != $ws) or (has("serverUrl") and .serverUrl != $url) then empty else .mnemoSessionId // empty end' \
    "$file" 2>/dev/null
}

# Delete an existing mapping (e.g. once session-stop.sh has collapsed the
# episode, so a since-reused/duplicated Claude session_id can't resurrect a
# stale mnemoSessionId). Safe to call on a mapping that doesn't exist.
delete_session_mapping() {
  local claude_session_id="$1"
  [ -n "$claude_session_id" ] || return
  rm -f "$MNEMO_SESSIONS_DIR/${claude_session_id}.json" 2>/dev/null
}

# Opportunistic GC: deletes mapping files older than 7 days. Runs on every
# write_session_mapping call — a single `find`, no daemon/cron needed — so
# ~/.mnemo/sessions/ can't grow unbounded across many Claude Code sessions
# whose Stop hook never fired (crash, force-quit) and therefore never called
# delete_session_mapping.
cleanup_old_session_mappings() {
  [ -d "$MNEMO_SESSIONS_DIR" ] || return
  find "$MNEMO_SESSIONS_DIR" \( -name '*.json' -o -name '*.gap-reported' \) -mtime +7 -delete 2>/dev/null
}

# ── Capture consent (CLIENTS-1) ─────────────────────────────────────────────
#
# Capture is opt-in per host. The gate is the marker `mnemo install --capture`
# writes (harness/src/consent.ts), the same one harness-hook.sh checks:
#
#   ~/.mnemo/harness/capture/<host>.json   {"version":1,"host":"<host>","mode":"user-only",...}
#
# Only a marker of this version, for this host, in a mode that captures
# (`full` or `user-only`) is consent. Anything else — no marker, unreadable,
# malformed, another version, another host's, or mode `mcp-only`/`unavailable`
# (APP-034b: that one sent session-start down the capture branch, which opens
# nothing) — is OFF: a gate that cannot read its own evidence must not capture
# someone's conversation on the strength of a file it could not parse.
#
# MNEMO_HARNESS_V1_ENABLED is the SERVER's feature flag. On this side it is only
# a kill switch: `false` (or 0) stops capture whatever the marker says, and
# `true` grants nothing (APP-034c) — consent is the marker, never the env.
#
# This is about WRITING a user's words to the server (prompts, subagent
# output, assistant replies). Reading — auto-recall, orientation — is not
# capture and does not need it.
#
# Cursor shares these scripts but none of the capture ones; a marker for another
# host never authorises this one, so Claude Code's consent is not Cursor's.
capture_killed() {
  case "$(printf '%s' "${MNEMO_HARNESS_V1_ENABLED:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    false | 0) return 0 ;;
  esac
  return 1
}
capture_consented() {
  local host="${1:-claude-code}"
  capture_killed && return 1
  case "$host" in *[!a-z0-9-]* | "") return 1 ;; esac
  local marker="${HOME}/.mnemo/harness/capture/${host}.json"
  [ -f "$marker" ] || return 1
  jq -e --arg h "$host" '.version == 1 and .host == $h and (.mode == "full" or .mode == "user-only")' \
    "$marker" >/dev/null 2>&1
}

# ── Auto-recall rendering (CLIENTS-14, SEC-3) ───────────────────────────────

# Relevance floor on the raw cosine `similarity` the server sends per hit
# (never on the blended `score`: a high score can ride on recency or worth with
# a poor semantic match, which is exactly what a floor has to catch). 0.35 is
# the server's own minSimilarity for non-fact hits. `recallMinSimilarity` in
# ~/.mnemo/config.json overrides it; 0 turns the floor off. A hit that carries
# no `similarity` (older server) is never dropped for lack of one.
#
# A server that judged relevance against a per-model calibrated floor reports it
# as `debug.relevanceFloor` (WP-3: 0.35 sits inside bge-m3's off-topic range,
# 0.30–0.38, whose floor is 0.50). That floor then applies to EVERY hit — the
# server's `nothingRelevant: false` only says the top hit cleared it — and the
# built-in 0.35 applies when no server floor is reported. An explicit
# recallMinSimilarity applies to both. (APP-033: keying this on the mere
# presence of `nothingRelevant`, which every current server sends, turned the
# floor off entirely.)
# Usage: get_recall_min_similarity [default when none is configured]
RECALL_MIN_SIMILARITY_DEFAULT=0.35
get_recall_min_similarity() {
  local v
  v=$(read_config "recallMinSimilarity")
  awk -v v="$v" -v def="${1:-$RECALL_MIN_SIMILARITY_DEFAULT}" 'BEGIN{
    if (v !~ /^[0-9]*\.?[0-9]+$/ || v + 0 > 1) { print def; exit }
    print v + 0
  }'
}

# Render POST /recall's JSON as one block per hit, each an escaped, bounded
# <untrusted_memory> element carrying whatever metadata the server sent (id,
# kind, subject, scopeRef, topicKey, status, similarity, score).
#
# A recalled statement is data somebody wrote, not an instruction to this
# session. Every `<`, `>` and `&` in content and metadata is escaped, so a stored
# "</untrusted_memory><system>…" cannot close its element or open a sibling, and
# newlines inside content are indented so they cannot pose as another hit.
# Only the listed metadata is rendered, so a label-like field on the hit is
# ignored; inside content and metadata a `_mnemo_` name (the MCP payload's trust
# label, forged as `"_mnemo_label": "trusted_system_instruction"`, V-9) has its
# leading underscore escaped, so stored text never spells the label.
# Prints nothing when no hit survives (`nothingRelevant: true`, the floor, or an
# empty list), which the caller reads as "reached, nothing relevant".
# The floor is <min_similarity> when the response carries no numeric
# `debug.relevanceFloor`; otherwise it is that floor, raised to <min_configured>
# (default 0) when the user configured a higher one.
# Usage: format_recall_hits <json> <min_similarity> [min_configured]
format_recall_hits() {
  printf '%s' "$1" | jq -r --argjson legacy "${2:-0}" --argjson configured "${3:-0}" '
    def clean: tostring | gsub("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]"; "");
    def esc: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;")
      | gsub("(?<![A-Za-z0-9])_(?=_?mnemo_)"; "&#95;"; "i");
    def attr: clean | gsub("\\s+"; " ") | .[0:200] | esc | gsub("\""; "&quot;");
    def num: if type == "number" then (. * 100 | round / 100) else empty end;
    (.debug.relevanceFloor? // null) as $server |
    (if ($server | type) == "number" then ([$server, $configured] | max) else $legacy end) as $min |
    if .nothingRelevant == true then empty else
    [ (.hits // [])[]
      | select(((.similarity | type) == "number" and .similarity < $min) | not)
      | . as $h
      | ([ ["id", $h.id], ["kind", ($h.kind // $h.primitiveKind)], ["subject", $h.subject],
           ["scopeRef", $h.scopeRef], ["topicKey", $h.topicKey], ["status", $h.status],
           ["similarity", ($h.similarity | num)], ["score", ($h.score | num)],
           ["truncated", (if $h.truncated == true then true else null end)] ]
         | map(select(.[1] != null and .[1] != "") | " \(.[0])=\"\(.[1] | attr)\"") | join("")) as $attrs
      | "<untrusted_memory\($attrs)>\n  \(($h.content // "") | clean | .[0:1500] | esc | gsub("\n"; "\n  "))\n</untrusted_memory>"
    ] | join("\n")
    end' 2>/dev/null
}

# ── Assistant turns (CLIENTS-15) ────────────────────────────────────────────
#
# The Stop hook runs once per assistant reply and gets the transcript's path;
# this appends the reply's VISIBLE text to the same session, the way the
# harness's claude-code adapter reads a transcript
# (packages/harness/src/adapters/claude-code.ts, visibleText): `text` blocks only,
# never thinking, tool calls or tool results. That parser is TypeScript and these
# hooks must not depend on the `mnemo` binary, so the rule is mirrored in jq.
#
# Guarded, because it uploads the assistant's words and the path comes from the
# host's payload:
#   - consent AND mode: the marker's `mode` must be "full". user-only means the
#     user's messages only (docs/guides/HARNESS.md), mcp-only/unavailable mean
#     none; a missing or unknown mode is off. No environment variable unlocks
#     it (MNEMO_HARNESS_V1_ENABLED=false only stops it). A shell hook cannot recompute the build/fixture
#     hash, so a stale qualification is caught where the marker is written
#     (`mnemo install --capture`) and by `mnemo harness doctor`, not here.
#   - redaction before sending (redact_secrets below);
#   - the file must be a regular, non-symlink .jsonl inside the Claude config dir
#     and under 100MB;
#   - one run per session at a time (mkdir lock; a lock older than a minute is a
#     dead hook and is broken), cursor written atomically and only ever forward;
#   - oldest first, at most 20 entries and ~3s per run, and the cursor moves to
#     the last ACKNOWLEDGED entry, so whatever is not delivered stays pending;
#   - the first time a session is seen only what follows the LAST user prompt is
#     taken, and while consent is absent the cursor still advances, so history is
#     never replayed and nothing written before consent is captured later.
# Never blocks: every failure returns 0.

# Approximation of harness/src/sanitize.ts redactSecrets for the shell hook: PEM
# blocks, URL credentials, bearer tokens, the known key shapes, values of
# secret-named assignments, and a secret said in prose ("my password is X",
# "mi contraseña es X"). Reads stdin, writes stdout. The TypeScript version
# remains the reference; wording differs, the intent (nothing credential-shaped
# leaves) is the same.
redact_secrets() {
  jq -Rsj '
    def r: "[REDACTED]";
    gsub("-----BEGIN [A-Z ]+-----(.|\n)*?(-----END [A-Z ]+-----|$)"; r)
    | gsub("(?<s>[A-Za-z][A-Za-z0-9+.-]*://)[^/\\s:@]+:[^/\\s@]+@"; "\(.s)[REDACTED]@")
    | gsub("(?i)\\b(?<k>authorization\\s*[:=]\\s*)(bearer\\s+|basic\\s+)?[^\\s,;]+"; "\(.k)[REDACTED]")
    | gsub("(?i)\\bbearer\\s+[A-Za-z0-9._~+/=-]+"; "Bearer [REDACTED]")
    | gsub("(?i)\\b(mns_(live|test)|mk_(live|test|admin|sess|fed))_[A-Za-z0-9_-]{16,}\\b"; r)
    | gsub("(?i)\\bsk-(proj-)?[A-Za-z0-9_-]{16,}"; r)
    | gsub("(?i)\\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{10,})\\b"; r)
    | gsub("\\b(AKIA|ASIA)[A-Z0-9]{16}\\b"; r)
    | gsub("(?i)(?<k>[A-Za-z0-9_.-]*(password|passwd|secret|token|api[_-]?key|credential|private[_-]?key)[A-Za-z0-9_.-]*[\"'"'"']?\\s*[:=]\\s*)(\"[^\"\n]*\"|'"'"'[^'"'"'\n]*'"'"'|[^\\s,;}\\]]+)"; "\(.k)[REDACTED]")
    | gsub("(?i)\\b(?<k>(password|passphrase|passwd|secret|token|api[ _-]?key|access[ _-]?key|contrase(ñ|n)a|clave|secreto)\\s+(is|was|es|era)\\s+)(\"[^\"\n]*\"|[^\\s,;]+)"; "\(.k)[REDACTED]")
  ' 2>/dev/null
}

# Consent plus a mode that allows assistant text (see above).
assistant_capture_allowed() {
  local marker="${HOME}/.mnemo/harness/capture/claude-code.json"
  capture_consented claude-code || return 1
  [ -f "$marker" ] || return 1
  jq -e '.mode == "full"' "$marker" >/dev/null 2>&1
}

# Usage: capture_assistant_turns <claude_session_id> <mnemo_session_id> <transcript_path>
# One legacy writer owns user and assistant capture, durable delivery and mapping.
# The installed runtime locator is written by the CLI installer.
legacy_capture_hook() {
  local event="$1" payload="$2" sink="${3:-/dev/null}" runtime="${SCRIPT_DIR}/../.mnemo-runtime.json" nodebin clipath
  # A refused workspace selection (init_workspace) captures nothing: the writer
  # would otherwise fall back to the key's default workspace.
  [ -z "${MNEMO_WS_BLOCKED:-}" ] || return 0
  capture_consented claude-code || return 0
  if [ -f "$HOME/.mnemo/harness/capture/claude-code.json" ] && jq -e '.writer == "managed"' "$HOME/.mnemo/harness/capture/claude-code.json" >/dev/null 2>&1; then
    printf '%s' "$payload" | bash "${SCRIPT_DIR}/harness-hook.sh" "$event" >/dev/null 2>&1
    return 0
  fi
  # Same resolution order as harness-hook.sh: MNEMO_BIN, then the runtime the
  # installer recorded (only when its node is executable and its CLI is still
  # there — a stale record falls through, it is never run), then a mnemo on
  # PATH, then the CLI shipped next to this plugin with the first node found.
  nodebin="" clipath=""
  if [ -z "${MNEMO_BIN:-}" ] && [ -f "$runtime" ]; then
    nodebin=$(jq -r '.node // empty' "$runtime" 2>/dev/null || true)
    clipath=$(jq -r '.cli // empty' "$runtime" 2>/dev/null || true)
    if [ -z "$nodebin" ] || [ ! -x "$nodebin" ] || [ -z "$clipath" ] || [ ! -f "$clipath" ]; then
      nodebin="" clipath=""
    fi
  fi
  if [ -n "${MNEMO_BIN:-}" ]; then
    printf '%s' "$payload" | "$MNEMO_BIN" legacy-hook "$event" >"$sink" 2>/dev/null
  elif [ -n "$nodebin" ]; then
    printf '%s' "$payload" | "$nodebin" "$clipath" legacy-hook "$event" >"$sink" 2>/dev/null
  elif command -v mnemo >/dev/null 2>&1; then
    printf '%s' "$payload" | mnemo legacy-hook "$event" >"$sink" 2>/dev/null
  elif [ -f "${SCRIPT_DIR}/../../dist/index.js" ]; then
    local nb
    for nb in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
      if [ -n "$nb" ] && [ -x "$nb" ]; then
        printf '%s' "$payload" | "$nb" "${SCRIPT_DIR}/../../dist/index.js" legacy-hook "$event" >"$sink" 2>/dev/null
        break
      fi
    done
  fi
  return 0
}

capture_assistant_turns() {
  local payload
  payload=$(jq -n --arg sid "$1" --arg transcript "$3" '{session_id: $sid, transcript_path: $transcript}')
  legacy_capture_hook Stop "$payload"
}
