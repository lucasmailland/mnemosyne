# El harness del host

[English](HARNESS.md) · **Español**

Captura automática de sesiones para OpenCode, Claude Code y Codex, sin depender
de que un modelo se acuerde de llamar a una herramienta.

## Qué captura y qué no

El harness registra la **conversación visible**: los mensajes del usuario y las
respuestas del asistente. No registra llamadas a herramientas, salida de
herramientas, contenido de archivos, prompts de sistema ni nada más que ustedes
dos no se hayan dicho el uno al otro.

La captura es **opt-in por host**. Instalar el plugin no la activa; sin
consentimiento explícito, cada punto de entrada no hace nada.

### Qué sale de la máquina sin `--capture`

Una sola cosa lleva tus palabras: el recall automático del plugin de Claude Code.
En el **primer prompt de cada sesión**, `user-prompt-submit.sh` envía ese prompt
a `POST /recall` como consulta, para que la memoria relevante llegue al modelo
sin una llamada a herramienta. No es captura, así que no espera consentimiento,
pero no sale tal cual: primero se ocultan los secretos (las mismas formas que
`redact_secrets` quita de los turnos capturados: claves, tokens, bloques PEM,
credenciales en URLs, asignaciones del tipo `password=`) y el resultado se corta
en **500 caracteres**. El servidor guarda esa consulta en
`mnemo_recall_log.query_text` cuando el recall devuelve hechos. Los prompts
siguientes no se envían.

Todo lo demás que los hooks envían sin consentimiento no lleva texto de la
conversación: lecturas de `/me` y `/health`, y `POST /session/start` con una
etiqueta formada por el id de sesión del host. La salida de subagentes y las
respuestas del asistente se capturan solo con un marcador en modo `full`; los
prompts del usuario, solo con `full` o `user-only`.

## Cómo activarla

    mnemo install --capture opencode,claude-code,codex
    mnemo install --capture codex --accept-degraded

`--capture` recibe una lista separada por comas de `opencode`, `claude-code` y
`codex`, e instala la captura exactamente para esos. Cada host se configura como
ese host instala sus cosas: OpenCode recibe una entrada en su arreglo `plugin`,
el manifiesto de Claude Code viene con la copia del plugin, y Codex se instala
mediante su propio marketplace (`codex plugin marketplace add` + `codex plugin add`)
en lugar de escribir en la caché que gestiona su administrador de plugins. Los
hosts que no nombres no vuelven a mencionarse. Todo lo ambiguo se rechaza en vez
de adivinarse: `--capture` indicado dos veces, una entrada vacía, un nombre de
host desconocido o `--accept-degraded` sin `--capture` detienen el comando antes
de que escriba nada.

Un host que resuelve a `full` o `user-only` se instala sin una segunda pregunta:
pedirlo fue el consentimiento. Un host que solo alcanza `mcp-only` o
`unavailable` **se consulta**, porque de lo contrario aceptarías algo distinto de
lo que pediste. `--accept-degraded` responde esa pregunta por adelantado, para la
automatización. Si no hay terminal en la que preguntar y no se indicó el flag, ese
host se omite y el comando termina con un código distinto de cero: nadie fue
consultado, así que nadie consintió.

En el caso concreto de Codex, la captura también necesita `features.hooks = true`
en `~/.codex/config.toml`, que por defecto está desactivado. Cuando eso es lo que
limita el modo, el instalador ofrece activarlo; es una pregunta **separada**, que
`--accept-degraded` nunca da por respondida, porque cambia un ajuste global de
Codex que observan otros plugins, en lugar de limitarse a añadir nuestra propia
entrada.

Esa barrera se lee en **tu** máquina, al instalar y en `mnemo harness doctor`; no
viene fijada en el registro de cualificación que se distribuye. El registro dice
lo que demostró la build (`user-only` hoy) y guarda la barrera de la máquina que
cualificó solo como `qualifierGate`, a título informativo. Un registro que tomaba
`mcp-only` de la barrera de quien corrió el cualificador era un techo que ningún
usuario podía levantar activando los hooks (APP-035).

Cada host solicitado se informa con su modo, el motivo de ese modo y el siguiente
paso concreto, si lo hay. Rechazar un host no es un fallo y no afecta al código de
salida.

### No copies a mano el plugin de OpenCode

`mnemo install --capture opencode` registra una ruta absoluta en el arreglo
`plugin` de `opencode.json`, y el plugin resuelve `@mnemo-ai/harness` desde ahí.

Copiar `mnemosyne.ts` en cambio al directorio `~/.config/opencode/plugins/` de
OpenCode no funciona: `@mnemo-ai/harness` no se resuelve desde ese directorio
(`Cannot find module`) y, como la importación está al principio del archivo, el
fallo ocurre antes de que se ejecute código propio del plugin, por lo que no puede
degradarse con elegancia ni explicarse. Verificado contra un OpenCode 1.18.29 en
funcionamiento.

## Qué activa realmente la captura

Un archivo por host:

    ~/.mnemo/harness/capture/<host>.json

Lo escribe `mnemo install --capture` después de dejar los artefactos en su sitio, y
lo elimina `mnemo harness disable <host>`. Todos los puntos de entrada lo
comprueban: el plugin de OpenCode, `harness-hook.sh` para los dos hosts con
hooks y los propios hooks del plugin de Claude Code. Solo un marcador cuyo `mode`
sea `full` o `user-only` es consentimiento; uno registrado como `mcp-only` o
`unavailable` no captura nada.

`MNEMO_HARNESS_V1_ENABLED` es la bandera del **servidor**. En el cliente es solo
un interruptor de emergencia: `MNEMO_HARNESS_V1_ENABLED=false` (o `0`) en el
entorno del host detiene la captura diga lo que diga el marcador, sin tocar el
sistema de archivos. Ponerla en `true` ahí no concede nada; antes reemplazaba al
marcador, y así una variable pensada para el servidor encendía la captura.

El marcador existe porque un instalador no puede establecer una variable de
entorno en un proceso del host que arrancará mañana. Cuando la variable era la
única barrera, el manifiesto de hooks se instalaba sin problemas, informaba de
éxito y no capturaba nada.

En Claude Code el marcador además elige **un solo escritor**. Una instalación
`full` escribe `"writer": "managed"`, y solo entonces los hooks del plugin pasan
por `harness-hook.sh`; cualquier otro marcador deja la captura al escritor
heredado, y el runtime gestionado rechaza el evento (`legacy_writer_selected`).
Nunca capturan los dos el mismo turno.

Los hooks se ejecutan con el `PATH` con el que se lanzó el host, que bajo launchd
o systemd no suele incluir el directorio bin de npm. Por eso el instalador
registra en `.mnemo-runtime.json` del plugin el binario de `node` y el punto de
entrada de la CLI que usó, y `harness-hook.sh` ejecuta exactamente esos. Un
registro obsoleto se ignora, nunca se ejecuta.

## Dónde vive cada cosa

    ~/.mnemo/harness/
      outbox/       one file per undelivered event
      state/        acknowledgements, generation mappings, binding, retry schedule
      quarantine/   events the server will never accept
      audit/        content-free records of what was dropped and why

La bandeja de salida contiene conversaciones, así que todo el árbol se crea con
`0700`, cada archivo con `0600`, y el harness se niega a ejecutarse si encuentra
otra cosa. Nunca sigue un enlace simbólico hacia su interior.

## Modos de captura

Un host recibe el modo que se ha **ganado**, a partir de un registro de
cualificación producido al ejecutarse contra esa compilación exacta:

| Modo          | Significado                                                                 |
| ------------- | --------------------------------------------------------------------------- |
| `full`        | Captura de usuario y asistente, reconciliación y cierre                     |
| `user-only`   | Solo mensajes del usuario; nunca se demostró la transcripción ni el borrado |
| `mcp-only`    | Sin captura alguna; las herramientas MCP siguen funcionando                 |
| `unavailable` | El harness no puede ejecutarse aquí de forma segura                         |

Todo lo que no se pueda verificar se resuelve **a la baja**. Un registro que no
coincide con la versión instalada, la plataforma, el paquete o los hashes de los
fixtures no concede nada. Es deliberado: suscribirse a eventos del host que no
existen no captura nada, no da ningún error y a otros proyectos les ha costado
meses.

La regla de versión depende de lo que haya leído el cualificador:

- **OpenCode:** el cualificador inspecciona el host instalado, así que su registro
  cubre únicamente la versión en la que se cualificó.
- **Codex:** un registro sin `hostVersionMatch` se lee como `same-major`
  (`DEFAULT_VERSION_MATCH` en `harness/src/adapters/capabilities.ts`). Codex
  publica una versión menor cada pocos días, y su cualificador lee del host solo
  la cadena de versión y la barrera `features.hooks`; el conjunto de eventos sale
  del fixture incluido en el repositorio. Así que la versión cualificada es un
  piso, toda versión `codex-cli 0.x` posterior queda cubierta mientras Codex no
  llegue a 1.0, una versión mayor nueva o un binario con otro nombre nunca, y los
  hashes de paquete y fixture y la plataforma siguen fijando lo que se demostró.
  Un registro que dice `"exact"` conserva su fijación.
- **Claude Code:** el registro lleva `hostVersionMatch: "same-major"`, porque su
  cualificador nunca lee el host. Comprueba el `hooks.json` del propio plugin
  contra el fixture incluido en el repositorio. El registro cubre su versión y
  todas las versiones posteriores de esa versión mayor; una versión anterior o una
  versión mayor nueva no concede nada. Antes de esto, cada actualización de
  Claude Code desactivaba la captura sin que se obtuviera ninguna evidencia.

Vuelve a cualificar después de cambiar cualquier cosa de la que se construyan los
artefactos de captura: el paquete del harness o los archivos de plugin de un host.
El digest se calcula a partir de esos bytes en tiempo de ejecución, de modo que un
registro obsoleto simplemente deja de coincidir y el host baja en silencio a
`mcp-only`. Ambos paquetes deben compilarse primero: no puedes cualificar un
artefacto que no has compilado.

    pnpm build
    node scripts/qualify-harness-host.mjs <host>
    node scripts/qualify-harness-host.mjs validate-all

## Diagnóstico

    mnemo harness doctor           # queue, retries, binding, filesystem, capture mode
    mnemo harness doctor --self-test   # proves the local queue end to end, no network
    mnemo harness queue list       # metadata only, never content
    mnemo harness probe            # is the bound server accepting?

`doctor` es la forma rápida de distinguir un problema local de uno del servidor.
Su informe no contiene claves de API, contenido de mensajes ni rutas de
transcripciones, así que es seguro pegarlo en un issue.

Termina con una línea por host: el modo en el que la captura está realmente, y
por qué. Es el menor entre el modo consentido, los artefactos para los que se dio
el consentimiento, el registro de cualificación (versión del host, plataforma,
hashes de paquete y fixture) y la barrera viva del host, y el motivo es el
primero de ellos que lo bajó; por ejemplo `codex: mcp-only — qualification:
qualification is for host version codex-cli 0.163.0, this is codex-cli 0.170.0`.
Un host consentido que quedó por debajo de su consentimiento se informa como
problema (`capture_dropped_<host>`).

### Lo que el hash de artefactos no cubre

El digest con el que se emparejan un registro y un marcador de consentimiento se
calcula a partir del `dist/` del harness más los archivos de captura de cada host
(`hooks/hooks.json` y `scripts/harness-hook.sh` en Claude Code) **del paquete de
plugin incluido en la CLI**. De ahí salen dos huecos, conocidos y todavía
abiertos:

- Claude Code ejecuta la copia que instaló su propio marketplace, que puede ser de
  otra versión que la incluida en la CLI. Un cambio que llega a los usuarios solo
  por el marketplace no lo ve el hash.
- Los scripts del escritor heredado (`user-prompt-submit.sh`, `_helpers.sh`,
  `session-stop.sh`, …) no están en el digest, y el escritor heredado no lo vuelve
  a comprobar en cada evento; solo lo hace el escritor gestionado
  (`harness-hook.sh`).

Cerrarlos exige hashear el plugin instalado por igual al consentir, en cada hook
y en el cualificador.

## Cuando la entrega se detiene

No se pierde nada. La cola es duradera frente a reinicios y fallos, y la entrega
reintenta indefinidamente los fallos transitorios con espera exponencial con
variación aleatoria.

Hay tres casos que no son transitorios, y `doctor` los nombra:

- **blocked** — el servidor rechazó la credencial (401/403). La entrega se detiene
  en lugar de reintentar, porque martillear con una clave rechazada puede bloquear
  la cuenta. Corrige la clave y luego ejecuta `mnemo harness retry`.
- **quarantined** — el servidor dijo que la cola pertenece a otro vínculo (409), o
  que un solo evento es demasiado grande para él. Entregar la conversación de otro
  espacio de trabajo es peor que perderla.
- **capture incomplete** — algo no se pudo capturar de forma duradera. El hueco se
  registra en lugar de taparse.

## Cómo revertirlo

El orden importa, y cada paso protege al siguiente:

    mnemo harness disable <host>   # stop capturing; the queue keeps its destination
    mnemo harness drain            # deliver the queue, to zero
    mnemo harness quiesce          # fence the server; wait for zero leases
    mnemo harness uninstall <host> # remove Mnemosyne's artifacts, and only those

Quitar los artefactos mientras la captura sigue activa deja a un host escribiendo
en una cola que nadie va a entregar. Vaciar la cola antes de desactivar compite
con el host, que sigue añadiéndole elementos. Desinstalar antes de silenciar deja
al servidor reteniendo arrendamientos de un cliente que ya no existe.

`uninstall` se niega a continuar salvo que esos pasos estén hechos. Anularlo exige
decir qué ocurre con las conversaciones en cola (`--discard-queued`, más una
confirmación), e informa exactamente de cuántas se descartaron.

## Retención

Las transcripciones gestionadas tienen su propia ventana, separada de los niveles
de sensibilidad que rigen el conocimiento extraído, porque la conversación literal
es lo más sensible que se almacena y lo que menos tiempo vive.

    MNEMO_RETENTION_TRANSCRIPT_DAYS   # default 30
    PUT /config/retention             # { "transcriptDays": 7 }

La purga nocturna cuenta desde el momento en que la sesión llegó a un estado
terminal, no desde la antigüedad de cada turno. Deja una lápida sin contenido que
conserva la identidad del mensaje y su confirmación de recepción original, de modo
que un mensaje reenviado meses después se sigue reconociendo sin que vuelvan las
palabras.

Olvidar un episodio borra también su transcripción, de inmediato y por la misma
vía. De lo contrario, «olvidado» significaría solo que el resumen desapareció
mientras la conversación en bruto seguía pudiendo reproducirse.

## Despliegue

El servidor primero, siempre. El servidor acepta y almacena eventos del harness
antes de que se habilite a ningún host para enviarlos; lo contrario deja a un host
encolando contra un servidor que los va a rechazar.

Después habilita **un** host cualificado, en una instalación, obsérvalo y ensaya
la reversión descrita arriba antes de promover otros. Los hosts tienen barreras
independientes, así que no hay motivo para habilitarlos juntos.

Barreras de entorno:

    MNEMO_HARNESS_V1_ENABLED=true   # server: runs the managed-session worker; client: only =false counts (kill switch)
