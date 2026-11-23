#!/bin/bash
# Mnemosyne — SessionStart hook for Claude Code
#
# 1. Detects current project + repo-local .mnemo.json workspace binding (P29/P31)
# 2. Checks active workspace identity & stats from Mnemosyne server
# 3. Detects workspace mismatch between .mnemo.json and active key
# 4. Injects per-session state (sessionId, episode) + workspace context + warnings as
#    additionalContext. The protocol itself arrives once, as the MCP server's
#    instructions; this hook only points at it (_hook-output.sh, APP-021).
#
# Timeout budget: hooks.json gives this hook a 10s ceiling. The 3 curl calls
# below (/me, /session/start, /health) run in PARALLEL via
# `curl ... & ... & wait` (harden-hooks-and-measure-precision M3/C1 fix) —
# none of the three depends on another's response: /me only needs
# MNEMO_URL/MNEMO_KEY, /session/start only needs the Claude-supplied
# SESSION_ID (not anything derived from /me's response), and /health
# only needs MNEMO_URL/MNEMO_KEY. Each call is still capped at --max-time 2,
# but since they run concurrently, worst case is their MAX (~2s), not their
# SUM. That leaves ~8s of the 10s ceiling (80% slack) for jq parsing, bash
# startup, and the bounded protocol rendering that happens AFTER all three —
# roughly double the ~4s (40%) margin the old sequential version left. A
# genuinely slow (not just unreachable) server can no longer eat the whole
# budget for a single injection.
#
# Prior sequential worst case (for reference): 3 x 2s = 6s against the 10s
# ceiling, leaving ~4s. If a future call is added whose request body/URL
# genuinely depends on an earlier call's response (e.g. a hypothetical
# `/canon` fetch keyed off /me's workspace id), that call must stay outside
# this parallel block and run after `wait` — do not parallelise it blindly.

# Load shared helpers
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_helpers.sh
source "${SCRIPT_DIR}/_helpers.sh"
# shellcheck source=./_hook-output.sh
source "${SCRIPT_DIR}/_hook-output.sh"

# Read hook input from stdin
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
SEARCH_DIR="${CWD:-$PWD}"

# CLIENTS-10: MNEMO_WORKSPACE_ID > .mnemo.json, sent on every request below and
# recorded in the session mapping.
init_workspace "$SEARCH_DIR"

PROJECT=$(detect_project "$SEARCH_DIR")

MNEMO_URL=$(get_mnemo_url)
MNEMO_KEY=$(get_mnemo_key)

# Read per-repo .mnemo.json config (P29)
PROJECT_JSON=$(find_project_config "$SEARCH_DIR" 2>/dev/null || true)
EXPECTED_WS_ID=""
EXPECTED_LABEL=""
if [ -n "$PROJECT_JSON" ]; then
  EXPECTED_WS_ID=$(echo "$PROJECT_JSON" | jq -r '.workspaceId // empty' 2>/dev/null)
  EXPECTED_LABEL=$(echo "$PROJECT_JSON" | jq -r '.label // empty' 2>/dev/null)
fi

# Read personal workspace ID from workspaces.json (P10)
PERSONAL_WS_ID=$(get_personal_workspace_id)
if [ -n "$PERSONAL_WS_ID" ]; then
  export MNEMO_PERSONAL_WORKSPACE_ID="$PERSONAL_WS_ID"
fi

# Parallel fetch: /me (workspace identity), /session/start (episode
# lifecycle), /health (workspace vitals). Each writes raw output to its
# own temp file so results survive past `wait`; parsed below once all three
# have returned (or hit --max-time 2). Independent inputs only — see the
# header comment for why these three don't need to serialise.
TMP_DIR=$(mktemp -d 2>/dev/null || true)
if [ -n "$TMP_DIR" ]; then
  trap 'rm -rf "$TMP_DIR"' EXIT
fi

if [ -n "$TMP_DIR" ]; then
  if [ -n "$MNEMO_URL" ] && [ -n "$MNEMO_KEY" ]; then
    curl "${WS_CURL_ARGS[@]}" -sf \
      -H "Authorization: Bearer $MNEMO_KEY" \
      "${MNEMO_URL}/me" \
      --max-time 2 >"${TMP_DIR}/me.out" 2>/dev/null &
  fi

  if [ -n "$SESSION_ID" ] && [ -n "$MNEMO_URL" ] && [ -n "$MNEMO_KEY" ]; then
    if [ -z "${MNEMO_WS_BLOCKED:-}" ] && ! capture_consented claude-code; then
      # Without capture consent the writer records nothing, but the episode is
      # not capture: it is what gives memory_remember its origin and what
      # session-stop.sh collapses. Open it as before the capture writer existed.
      curl "${WS_CURL_ARGS[@]}" -sf \
        -H "Authorization: Bearer $MNEMO_KEY" \
        -H "Content-Type: application/json" \
        -X POST \
        "${MNEMO_URL}/session/start" \
        -d "{\"label\":\"claude-session-${SESSION_ID}\"}" \
        --max-time 2 >"${TMP_DIR}/episode.out" 2>/dev/null &
    else
      legacy_capture_hook SessionStart "$INPUT" "${TMP_DIR}/session.out" &
    fi
  fi

  # /health, NO /admin/stats.
  #
  # Los dos handlers llaman a la MISMA función del storage
  # (`getWorkspaceVitals(workspaceId)`) y este banner sólo usa tres de sus
  # campos. Lo único que los separa es app-scope.ts:72, que resuelve el scope
  # por el PREFIJO del path: todo `/admin/*` exige `memory:admin`, aunque el
  # handler sea estrictamente workspace-scoped y no cruce nada — que es el caso
  # de /admin/stats. O sea que el hook pedía permisos de administrador para
  # mostrar tres números del propio workspace de la key.
  #
  # El resultado en una instalación normal era un 403 en cada arranque de
  # sesión. /health devuelve los mismos vitals con `memory:read`, que cualquier
  # key tiene.
  #
  # Deliberadamente SIN -f, a diferencia de las dos llamadas de arriba.
  #
  # `-f` hace que curl descarte el cuerpo y salga con error ante cualquier
  # HTTP >= 400. Con eso, un 403 INSUFFICIENT_SCOPE — que trae escrito qué
  # permiso falta — llegaba acá como un archivo vacío, idéntico a una red
  # caída, y el banner terminaba diciendo "could not be reached" de un
  # servidor perfectamente vivo. El costo es de diagnóstico: manda a revisar
  # DNS, VPN y contenedores cuando la respuesta era "a la key le falta un
  # scope", y el servidor la venía diciendo en cada llamada.
  #
  # El código HTTP va a su propio archivo (-w) para poder distinguir los tres
  # casos abajo. /me y /session/start conservan -f a propósito: ahí el cuerpo
  # de un error se parsearía como si fuera la respuesta buena.
  if [ -n "$MNEMO_URL" ] && [ -n "$MNEMO_KEY" ]; then
    curl "${WS_CURL_ARGS[@]}" -s \
      -H "Authorization: Bearer $MNEMO_KEY" \
      -o "${TMP_DIR}/stats.out" \
      -w '%{http_code}' \
      "${MNEMO_URL}/health" \
      --max-time 2 >"${TMP_DIR}/stats.code" 2>/dev/null &
  fi

  # Blocks for at most ~2s (the shared --max-time), not the 6s sum of all
  # three sequential budgets — whichever calls actually launched above.
  wait
fi

# Fetch active workspace identity from /me. workspaceName/workspaceRole
# (multi-tenancy closure plan D5) piggyback on this SAME call — no separate
# network round-trip.
#
# ME_REACHED (harden-hooks-and-measure-precision Requirement 4) records
# whether /me actually responded, independent of whether the response
# carried a workspaceId — the workspace-context section below uses it to
# tell "Mnemosyne could not be reached" apart from "Mnemosyne responded but
# had no workspace identity to report", instead of silently printing
# nothing in both cases.
ACTIVE_WS_ID=""
ACTIVE_WS_NAME=""
ACTIVE_WS_ROLE=""
ME_JSON=""
ME_REACHED=false
if [ -n "$TMP_DIR" ] && [ -s "${TMP_DIR}/me.out" ]; then
  ME_REACHED=true
  ME_JSON=$(cat "${TMP_DIR}/me.out" 2>/dev/null)
fi
if [ -n "$ME_JSON" ]; then
  ACTIVE_WS_ID=$(echo "$ME_JSON" | jq -r '.workspaceId // empty' 2>/dev/null)
  ACTIVE_WS_NAME=$(echo "$ME_JSON" | jq -r '.workspaceName // empty' 2>/dev/null)
  ACTIVE_WS_ROLE=$(echo "$ME_JSON" | jq -r '.workspaceRole // empty' 2>/dev/null)
fi

# autonomous-memory Requirement 3 (auto-episode-lifecycle): start a
# Mnemosyne episode automatically — the model never has to call
# memory_episode_start itself for extraction to run. Store the returned
# Mnemosyne session id via the Requirement 1 mapping helper
# (~/.mnemo/sessions/<claude_session_id>.json), keyed by Claude's own
# SESSION_ID, so user-prompt-submit.sh (recall correlation) and
# session-stop.sh (guaranteed collapse) can both find it without
# re-deriving or re-creating it.
#
# SESSION_REACHED (P69/C1) mirrors ME_REACHED and STATS_REACHED, and it is the
# one of the three that actually costs something when it fails silently. A
# missing /me line degrades the orientation blurb. A missing episode degrades
# the whole session: recall goes without a sessionId (so `lastRecallAt`,
# `recordRecall` and the TD(λ) propagation never fire — P70's failure, from a
# different direction), and session-stop.sh finds no mapping, so the guaranteed
# collapse never runs and NOTHING from the session is extracted.
#
# It was the only one of the three left without a signal: on failure this block
# just wrote no mapping and printed nothing, which is indistinguishable from a
# session that legitimately has no episode.
MNEMO_SESSION_ID=""
SESSION_REACHED=false
MNEMO_SESSION_ID=$(read_session_mapping "$SESSION_ID")
[ -n "$MNEMO_SESSION_ID" ] && SESSION_REACHED=true
if [ -n "$TMP_DIR" ] && [ -s "${TMP_DIR}/session.out" ]; then
  [ "$(jq -r '.serverReached // false' "${TMP_DIR}/session.out" 2>/dev/null)" = true ] && SESSION_REACHED=true
fi
# Episode opened directly (no capture consent): any body means the server answered.
if [ -n "$TMP_DIR" ] && [ -s "${TMP_DIR}/episode.out" ]; then
  SESSION_REACHED=true
  if [ -z "$MNEMO_SESSION_ID" ]; then
    MNEMO_SESSION_ID=$(jq -r '.id // empty' "${TMP_DIR}/episode.out" 2>/dev/null)
    [ -n "$MNEMO_SESSION_ID" ] && write_session_mapping "$SESSION_ID" "$MNEMO_SESSION_ID"
  fi
fi

# Workspace stats. STATS_REACHED (harden-hooks-and-measure-precision
# Requirement 4) records whether /health actually responded, so the
# printed section below can say "could not be reached" vs "responded but
# had nothing usable" instead of silently omitting the line either way —
# the prior behaviour a curl failure and a malformed/empty response were
# indistinguishable, both just vanishing.
STATS=""
STATS_REACHED=false
STATS_CODE=""
STATS_DENIED_SCOPE=""
if [ -n "$TMP_DIR" ] && [ -s "${TMP_DIR}/stats.code" ]; then
  STATS_CODE=$(cat "${TMP_DIR}/stats.code" 2>/dev/null)
fi
# Sólo se acepta lo que tiene forma de código HTTP. Cualquier otra cosa se
# descarta en vez de terminar impresa como `HTTP <basura>`: el archivo lo
# escribe curl, pero el banner es lo que lee una persona, y un valor inesperado
# ahí no debe convertirse en un diagnóstico inventado.
case "$STATS_CODE" in
  [1-5][0-9][0-9]) ;;
  *) STATS_CODE="" ;;
esac
# "000" es lo que reporta curl cuando no llegó a haber respuesta HTTP. Cualquier
# código real, incluido un 4xx/5xx, significa que el servidor SÍ contestó.
if [ -n "$STATS_CODE" ] && [ "$STATS_CODE" != "000" ]; then
  STATS_REACHED=true
fi
# Fallback: código ausente o ilegible, pero un cuerpo que jq sabe leer. Pasa con
# proxies que no propagan el status. El cuerpo llegó, así que el servidor
# contestó — decir "could not be reached" sería falso.
if [ -z "$STATS_CODE" ] && [ -n "$TMP_DIR" ] && [ -s "${TMP_DIR}/stats.out" ]; then
  STATS_REACHED=true
  STATS_CODE="200"
fi
if [ "$STATS_REACHED" = true ] && [ "$STATS_CODE" = "200" ] && [ -s "${TMP_DIR}/stats.out" ]; then
  # Shape plano de VitalsSchema (factsLive/factsClosed), no el anidado de
  # /admin/stats (facts.live/facts.closed).
  STATS=$(jq -r \
    '"Facts: \(.factsLive) live, \(.factsClosed) closed | Last write: \(.lastWriteAt // "never")"' \
    "${TMP_DIR}/stats.out" 2>/dev/null)
fi
# El servidor nombra el permiso que falta en el cuerpo del 403. Es la
# información útil, y era exactamente lo que -f estaba tirando.
if [ "$STATS_CODE" = "403" ] && [ -s "${TMP_DIR}/stats.out" ]; then
  STATS_DENIED_SCOPE=$(jq -r '.error.message // empty' "${TMP_DIR}/stats.out" 2>/dev/null)
fi

# Critical session context and the protocol precede auxiliary workspace details.
EPISODE_STATE="unreachable"
if [ -z "$SESSION_ID" ]; then
  EPISODE_STATE="no-host"
elif [ "$SESSION_REACHED" = true ]; then
  EPISODE_STATE="no-id"
fi
WORKSPACE_CONTEXT=$(

# Inject workspace context section
printf "\n---\n\n## Mnemosyne Workspace Context\n\n"
printf "Project: %s\n" "$PROJECT"

if [ -n "$EXPECTED_WS_ID" ]; then
  DISPLAY_NAME="${EXPECTED_LABEL:-$EXPECTED_WS_ID}"
  printf "Linked workspace: %s (via .mnemo.json)\n" "$DISPLAY_NAME"
  if [ -n "$ACTIVE_WS_ID" ] && [ "$ACTIVE_WS_ID" != "$EXPECTED_WS_ID" ]; then
    printf "⚠️ WARNING: This repo expects workspace \"%s\", but active key resolves to \"%s\".\n" "$DISPLAY_NAME" "$ACTIVE_WS_ID"
  fi
elif [ -n "$ACTIVE_WS_ID" ]; then
  if [ -n "$ACTIVE_WS_NAME" ]; then
    printf "Active workspace: %s (%s)\n" "$ACTIVE_WS_NAME" "$ACTIVE_WS_ID"
  else
    printf "Active workspace: %s\n" "$ACTIVE_WS_ID"
  fi
elif [ "$ME_REACHED" = true ]; then
  printf "Active workspace: unavailable — Mnemosyne responded but returned no workspace identity\n"
else
  printf "Active workspace: unavailable — Mnemosyne could not be reached\n"
fi

if [ -n "$ACTIVE_WS_ROLE" ]; then
  printf "Your role: %s\n" "$ACTIVE_WS_ROLE"
  if [ "$ACTIVE_WS_ROLE" = "read" ]; then
    printf "⚠️ read-only access: memory_recall/memory_search work, but memory_remember/memory_decide/memory_task etc. will 403. Ask a workspace admin for write access if needed — don't retry.\n"
  fi
fi

if [ -n "$STATS" ]; then
  printf "Stats: %s\n" "$STATS"
elif [ "$STATS_CODE" = "403" ]; then
  # Se nombra el permiso, no la red. Y se dice que sólo las stats se ven
  # afectadas: un 403 acá no dice nada sobre si se puede leer o escribir
  # memoria, que es lo que realmente importa en la sesión.
  if [ -n "$STATS_DENIED_SCOPE" ]; then
    printf "Stats: unavailable — %s. Only these stats are affected; recall and writes are unaffected.\n" \
      "$STATS_DENIED_SCOPE"
  else
    printf "Stats: unavailable — this API key lacks the 'memory:admin' scope. Only these stats are affected.\n"
  fi
elif [ "$STATS_REACHED" = true ] && [ -n "$STATS_CODE" ] && [ "$STATS_CODE" != "200" ]; then
  printf "Stats: unavailable — Mnemosyne answered HTTP %s\n" "$STATS_CODE"
elif [ "$STATS_REACHED" = true ]; then
  printf "Stats: unavailable — Mnemosyne responded but returned no usable stats\n"
else
  printf "Stats: unavailable — Mnemosyne could not be reached\n"
fi

if [ -n "$PERSONAL_WS_ID" ]; then
  printf "Personal workspace: %s\n" "$PERSONAL_WS_ID"
fi
)
printf '%s\n' "$WORKSPACE_CONTEXT" | emit_hook_output startup "$MNEMO_SESSION_ID" "$EPISODE_STATE"

exit 0
