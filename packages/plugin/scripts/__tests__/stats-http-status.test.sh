#!/bin/bash
# session-start.sh tiene que distinguir "no llegué al servidor" de "el servidor
# me dijo que no".
#
# POR QUÉ
# -------
# El banner imprimía `Stats: unavailable — Mnemosyne could not be reached` para
# un workspace cuyo servidor estaba perfectamente vivo. La causa es la `-f` de
# `curl -sf`: ante un HTTP >= 400 curl DESCARTA el cuerpo y sale con error, así
# que el 403 `INSUFFICIENT_SCOPE` — que trae escrito exactamente qué falta
# ("requires 'memory:admin'") — llegaba al script como un archivo vacío,
# indistinguible de una red caída.
#
# El costo real es de diagnóstico. "No pude conectarme" manda a revisar DNS,
# VPN, el contenedor, el nginx. La respuesta era "te falta un scope en la key",
# y el servidor la estaba diciendo en cada llamada.
#
# EL CONTRATO
# -----------
#   - 200 con stats usables → se imprimen
#   - 403 → se nombra el permiso faltante, y NO se dice "could not be reached"
#   - otro error HTTP → se nombra el código, tampoco "could not be reached"
#   - curl que no conecta → ahí sí "could not be reached"
#
# Correr con: bash packages/plugin/scripts/__tests__/stats-http-status.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="${SCRIPT_DIR}/session-start.sh"
PASS=0
FAIL=0

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (esperaba encontrar: $needle)"
    echo "  actual: $(printf '%s' "$haystack" | grep -i 'stats' || echo '(sin línea Stats)')"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "FAIL: $label (no esperaba: $needle)"
    echo "  actual: $(printf '%s' "$haystack" | grep -i 'stats' || echo '(sin línea Stats)')"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: $label"
    PASS=$((PASS + 1))
  fi
}

TMP_HOME=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
trap 'rm -rf "$TMP_HOME" "$FAKE_BIN"' EXIT
export HOME="$TMP_HOME"
export PATH="$FAKE_BIN:$PATH"
source "$SCRIPT_DIR/__tests__/legacy-runtime-fixture.sh"
install_legacy_runtime_fixture consent
export MNEMO_URL="http://localhost:3939"
export MNEMO_KEY="mns_test_fake"

# curl falso parametrizable por STATS_MODE. Honra `-o <archivo>` y
# `-w <formato>` como el real: cuerpo al archivo de -o (o a stdout si no hay),
# código HTTP a stdout cuando -w lo pide. Eso es lo que permite al script
# separar "no conecté" de "conecté y me dijeron 403".
cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/bash
URL=""
OUT_FILE=""
WANT_CODE=false
FAIL_FLAG=false
prev=""
for arg in "$@"; do
  case "$prev" in
    -o) OUT_FILE="$arg" ;;
    -w) case "$arg" in *http_code*) WANT_CODE=true ;; esac ;;
  esac
  case "$arg" in
    # -f / --fail, incluido combinado como -sf. Emularlo es el punto de este
    # fake: es la flag que borraba el cuerpo del 403 y dejaba al script
    # creyendo que no había servidor.
    -*f*) case "$arg" in --*) [ "$arg" = "--fail" ] && FAIL_FLAG=true ;; -*) FAIL_FLAG=true ;; esac ;;
  esac
  case "$arg" in
    *"/me") URL="me" ;;
    *"/session/start") URL="session" ;;
    *"/admin/stats") URL="stats" ;;
    *"/health") URL="health" ;;
  esac
  prev="$arg"
done

emit() { # $1=cuerpo $2=codigo
  if [ "$2" -ge 400 ] && [ "$FAIL_FLAG" = true ]; then
    # Lo que hace curl -f de verdad: nada de cuerpo, exit 22.
    if [ "$WANT_CODE" = true ]; then printf '%s' "$2"; fi
    exit 22
  fi
  if [ -n "$OUT_FILE" ]; then printf '%s' "$1" > "$OUT_FILE"; else printf '%s' "$1"; fi
  if [ "$WANT_CODE" = true ]; then printf '%s' "$2"; fi
  [ "$2" -ge 400 ] && exit 22
  return 0
}

case "$URL" in
  me)      emit '{"workspaceId":"ws-1","workspaceName":"Test WS","workspaceRole":"write"}' 200 ;;
  session) emit '{"id":"sess-1"}' 200 ;;
  stats)
    case "${STATS_MODE:-ok}" in
      ok)
        emit '{"facts":{"live":7,"closed":1},"lastWriteAt":"2026-08-26T10:00:00Z"}' 200 ;;
      forbidden)
        # Cuerpo real del servidor. Con -f, curl lo tira a la basura.
        emit '{"error":{"type":"permission_error","code":"INSUFFICIENT_SCOPE","message":"API key scope insufficient: requires '"'"'memory:admin'"'"'"}}' 403 ;;
      server_error)
        emit '{"error":{"message":"boom"}}' 500 ;;
      no_admin)
        # Lo que hace el servidor real con una key sin memory:admin.
        emit '{"error":{"type":"permission_error","code":"INSUFFICIENT_SCOPE","message":"API key scope insufficient: requires '"'"'memory:admin'"'"'"}}' 403 ;;
      unreachable)
        # Sin conexión: ni cuerpo ni código real. curl sale 7.
        if [ "$WANT_CODE" = true ]; then printf '%s' "000"; fi
        exit 7 ;;
    esac
    ;;
  health)
    # Mismos vitals que /admin/stats, en el shape plano de VitalsSchema, y
    # alcanzables con memory:read. STATS_MODE se ejerce ACÁ además de en
    # /admin/stats: los casos de error tienen que probarse sobre el endpoint
    # que el hook realmente pide, o dejan de probar nada en cuanto cambie.
    case "${STATS_MODE:-ok}" in
      ok|no_admin)
        emit '{"workspaceId":"ws-1","factsLive":7,"factsClosed":1,"pinnedCount":0,"lastRecallAt":null,"lastWriteAt":"2026-08-26T10:00:00Z","embeddings":{"indexed":7,"pending":0}}' 200 ;;
      forbidden)
        emit '{"error":{"type":"permission_error","code":"INSUFFICIENT_SCOPE","message":"API key scope insufficient: requires '"'"'memory:admin'"'"'"}}' 403 ;;
      server_error)
        emit '{"error":{"message":"boom"}}' 500 ;;
      unreachable)
        if [ "$WANT_CODE" = true ]; then printf '%s' "000"; fi
        exit 7 ;;
    esac
    ;;
esac
EOF
chmod +x "$FAKE_BIN/curl"

run_hook() {
  printf '%s' '{"session_id":"stats-status-test","cwd":"/tmp"}' | bash "$HOOK" 2>/dev/null
}

# ── Test 1: 200 con stats → se imprimen ────────────────────────────────────
# Pasa hoy. Es el ancla: sin él, "no dice could not be reached" se cumpliría
# también si el bloque de stats desapareciera por completo.

OUT=$(STATS_MODE=ok run_hook)
assert_contains "200: imprime las stats" "$OUT" "7 live"
assert_not_contains "200: no dice unavailable" "$OUT" "Stats: unavailable"

# ── Test 2: 403 → nombra el permiso, no culpa a la red ─────────────────────

OUT=$(STATS_MODE=forbidden run_hook)
assert_not_contains "403: NO dice could not be reached" "$OUT" "could not be reached"
assert_contains "403: nombra el scope que falta" "$OUT" "memory:admin"

# ── Test 3: 500 → nombra el código ─────────────────────────────────────────

OUT=$(STATS_MODE=server_error run_hook)
assert_not_contains "500: NO dice could not be reached" "$OUT" "could not be reached"
assert_contains "500: nombra el código HTTP" "$OUT" "HTTP 500"

# ── Test 4: sin conexión → ahí sí "could not be reached" ───────────────────
# El mensaje no se elimina: se reserva para el caso que describe. Sin este
# test, el fix podría ser borrarlo, y se perdería información real.

OUT=$(STATS_MODE=unreachable run_hook)
assert_contains "sin conexión: sí dice could not be reached" "$OUT" "could not be reached"

# ── Test 5: el hook sigue emitiendo lo demás en todos los casos ────────────
# Las stats son cosmética; el SKILL.md y el contexto de workspace no.

OUT=$(STATS_MODE=forbidden run_hook)
assert_contains "403: el protocolo SKILL.md se sigue inyectando" "$OUT" \
  "# Mnemosyne Memory Protocol"
assert_contains "403: el contexto de workspace se sigue emitiendo" "$OUT" "Test WS"

# ── Test 6: una key SIN memory:admin igual ve sus stats ────────────────────
#
# El fondo del asunto, y la razón por la que el mensaje honesto del 403 no
# alcanzaba: el hook no necesita permisos de admin para nada de lo que muestra.
#
# `GET /admin/stats` y `GET /health` llaman a la MISMA función del storage
# (`getWorkspaceVitals(workspaceId)`), y el banner sólo usa tres de sus campos.
# Lo único que separa a los dos es app-scope.ts:72, que resuelve el scope por
# el PREFIJO del path: cualquier `/admin/*` pide `memory:admin`, aunque el
# handler — como éste — sea estrictamente workspace-scoped y no cruce nada.
#
# El doble responde 403 en /admin/stats y 200 en /health, que es exactamente lo
# que hace el servidor real con una key normal. La aserción es sobre el
# comportamiento y no sobre qué URL se pide: lo que importa es que el usuario
# vea sus stats, no por dónde se las traen.

OUT=$(STATS_MODE=no_admin run_hook)
assert_contains "sin memory:admin: las stats igual se muestran" "$OUT" "7 live"
assert_not_contains "sin memory:admin: no se pide un permiso que no hace falta" "$OUT" \
  "memory:admin"

echo
echo "─────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
