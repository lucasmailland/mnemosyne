#!/bin/bash
# El presupuesto del recall automático de user-prompt-submit.sh tiene que ser
# configurable, no un 1.5 hardcodeado.
#
# POR QUÉ
# -------
# El `--max-time 1.5` del hook se eligió midiendo contra el stack local: el
# propio comentario del script dice "~0.9-1.1s (Ollama, cold-start)". Contra un
# servidor remoto ese supuesto no se sostiene. Medido contra una instancia real
# detrás de TLS con embeddings de Bedrock: entre 0.53s y 1.82s según pegue o no
# la caché del embedding. O sea el corte cae JUSTO en el medio de la
# distribución, y el recall automático falla de forma intermitente — el peor
# modo de falla posible, porque no se lee como una configuración mal puesta
# sino como un servidor que a veces anda.
#
# Subir el default para todos sería cobrarle esa latencia a quien corre
# Mnemosyne local, que es justamente para quien 1.5s alcanza de sobra. De ahí
# que sea configuración y no un número nuevo.
#
# EL CONTRATO QUE FIJAN ESTOS TESTS
# ---------------------------------
#   - sin `recallTimeoutMs` en ~/.mnemo/config.json → 1.5s (lo de hoy; nadie
#     que no toque nada nota el cambio)
#   - con un valor válido en ms → ese valor, en segundos, para curl
#   - valor no numérico, cero o negativo → default, nunca un curl roto
#   - por encima del techo → clampeado a RECALL_TIMEOUT_MAX_S, porque
#     hooks.json le pone un timeout duro al hook y un presupuesto mayor que ese
#     techo no compra nada: Claude Code mata el hook igual, y encima sin el
#     mensaje de degradación que el script sí sabe emitir.
#
# Correr con: bash packages/plugin/scripts/__tests__/recall-timeout.test.sh
# Sale 0 si pasa todo, 1 ante cualquier falla.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="${SCRIPT_DIR}/user-prompt-submit.sh"
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

TEST_SESSION_IDS="rt1 rt2 rt3 rt4 rt5 rt6 rt7 rt8"
for sid in $TEST_SESSION_IDS; do
  rm -f "/tmp/mnemo-claude-${sid}-loaded"
done

TMP_HOME=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
ARGS_LOG="${FAKE_BIN}/curl-args.log"
trap 'rm -rf "$TMP_HOME" "$FAKE_BIN"; for sid in $TEST_SESSION_IDS; do rm -f "/tmp/mnemo-claude-${sid}-loaded"; done' EXIT
export HOME="$TMP_HOME"
export PATH="$FAKE_BIN:$PATH"

# curl falso que registra los argumentos de CADA invocación en su propia línea
# y devuelve una respuesta de recall válida. El hook llama a curl más de una vez
# por turno (el POST /session/:id/turn corre detached), así que el test tiene
# que quedarse con la línea del /recall y no con la primera que aparezca.
cat > "$FAKE_BIN/curl" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >> "$ARGS_LOG"
echo '{"hits":[]}'
EOF
chmod +x "$FAKE_BIN/curl"

# El presupuesto que el hook le pasó a curl en la llamada a /recall.
# Devuelve vacío si no hubo llamada a /recall.
recall_max_time() {
  grep -- '/recall' "$ARGS_LOG" 2>/dev/null \
    | tail -1 \
    | sed -n 's/.*--max-time \([^ ]*\).*/\1/p'
}

run_hook() {
  local sid="$1"
  : > "$ARGS_LOG"
  printf '%s' "{\"session_id\":\"${sid}\",\"cwd\":\"/tmp\",\"prompt\":\"que decidimos sobre auth\"}" \
    | bash "$HOOK" > /dev/null 2>&1
}

write_config() {
  # $1 = fragmento JSON extra (ya con la coma inicial), o vacío
  mkdir -p "$TMP_HOME/.mnemo"
  cat > "$TMP_HOME/.mnemo/config.json" <<EOF
{
  "url": "http://localhost:3939",
  "apiKey": "mns_test_fake"${1:-}
}
EOF
}

# El env gana sobre el archivo en get_mnemo_url/get_mnemo_key, así que se
# limpia: estos tests son sobre lo que se lee del config.
unset MNEMO_URL MNEMO_KEY 2>/dev/null || true

# ── Test 1: sin recallTimeoutMs → el default de siempre, 1.5 ────────────────
# Este pasa HOY. Está para que los que siguen no sean vacíos: prueban que el
# valor cambia, y eso sólo significa algo si existe un valor base contra el
# cual cambiar.

write_config ""
run_hook rt1
assert_eq "sin recallTimeoutMs: usa el default 1.5" "1.5" "$(recall_max_time)"

# ── Test 2: valor válido en ms → ese valor, en segundos ────────────────────

write_config ',
  "recallTimeoutMs": 3000'
run_hook rt2
assert_eq "recallTimeoutMs 3000: usa 3 segundos" "3" "$(recall_max_time)"

# ── Test 3: un valor con fracción no se trunca ─────────────────────────────
# 2500ms tiene que ser 2.5, no 2: curl acepta decimales y redondear para abajo
# le sacaría al usuario medio segundo que pidió explícitamente.

write_config ',
  "recallTimeoutMs": 2500'
run_hook rt3
assert_eq "recallTimeoutMs 2500: usa 2.5 segundos (no trunca)" "2.5" "$(recall_max_time)"

# ── Test 4: basura → default, nunca un curl roto ───────────────────────────
# `--max-time abc` hace fallar a curl entero. Un config mal tipeado tiene que
# degradar al default, no dejar sin recall automático al usuario.

write_config ',
  "recallTimeoutMs": "abc"'
run_hook rt4
assert_eq "recallTimeoutMs no numérico: cae al default 1.5" "1.5" "$(recall_max_time)"

# ── Test 5: cero o negativo → default ──────────────────────────────────────
# `--max-time 0` en curl significa "sin límite", que es lo contrario de lo que
# alguien que escribe 0 espera, y deja al hook colgado hasta que lo mate
# Claude Code. Se trata como inválido.

write_config ',
  "recallTimeoutMs": 0'
run_hook rt5
assert_eq "recallTimeoutMs 0: cae al default 1.5" "1.5" "$(recall_max_time)"

# ── Test 6: por encima del techo → clampeado ───────────────────────────────
# hooks.json le pone un timeout duro al hook. Pedir más que eso no alarga nada:
# Claude Code mata el proceso igual, y el usuario pierde además el mensaje de
# degradación ("llamá memory_recall vos mismo") que el script sí emite cuando
# es curl el que corta.

write_config ',
  "recallTimeoutMs": 60000'
run_hook rt6
assert_eq "recallTimeoutMs 60000: clampea al techo (8)" "8" "$(recall_max_time)"

# ── Test 7: la captura sincrónica gasta del mismo presupuesto ─────────────
# hooks.json mata el hook a los 10s. Si la captura tarda 3s y el recall igual
# recibe sus 8s, el hook muere sin emitir ni el contexto ni la degradación. El
# recall tiene que recibir lo que queda (9s de presupuesto - 3s gastados).

# Capture needs the consent marker; MNEMO_HARNESS_V1_ENABLED=true no longer grants it.
mkdir -p "$TMP_HOME/.mnemo/harness/capture"
printf '{"version":1,"host":"claude-code","mode":"user-only"}' > "$TMP_HOME/.mnemo/harness/capture/claude-code.json"
SLOW_MNEMO="${FAKE_BIN}/slow-mnemo"
printf '#!/bin/bash\ncat >/dev/null\nsleep 3\n' > "$SLOW_MNEMO"
chmod +x "$SLOW_MNEMO"
write_config ',
  "recallTimeoutMs": 8000'
: > "$ARGS_LOG"
printf '%s' '{"session_id":"rt7","cwd":"/tmp","prompt":"que decidimos sobre auth"}' \
  | MNEMO_BIN="$SLOW_MNEMO" bash "$HOOK" > /dev/null 2>&1
RT7=$(recall_max_time)
assert_eq "captura lenta: el recall recibe lo que queda del presupuesto (<= 6s)" "yes" \
  "$(awk -v t="$RT7" 'BEGIN{ print (t != "" && t + 0 > 0 && t + 0 <= 6.01) ? "yes" : "no (" t ")" }')"

# ── Test 8: sin presupuesto restante no se intenta el recall ───────────────
# y el hook igual contesta con el mensaje de degradación.

printf '#!/bin/bash\ncat >/dev/null\nsleep 9\n' > "$SLOW_MNEMO"
: > "$ARGS_LOG"
RT8_OUT=$(printf '%s' '{"session_id":"rt8","cwd":"/tmp","prompt":"que decidimos sobre auth"}' \
  | MNEMO_BIN="$SLOW_MNEMO" bash "$HOOK" 2>/dev/null)
assert_eq "presupuesto agotado: no llama a /recall" "" "$(recall_max_time)"
assert_eq "presupuesto agotado: igual emite la degradación" "yes" \
  "$(printf '%s' "$RT8_OUT" | jq -r '.systemMessage' | grep -q 'could not be reached' && echo yes || echo no)"

echo
echo "─────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
