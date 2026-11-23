# Mnemosyne MCP — guía de usuario

[English](MCP_GUIDE.md) · **Español**

Público objetivo: desarrollador que tiene un servidor de Mnemosyne en marcha y quiere conectarle un agente de programación con IA.

---

## Tabla de contenidos

1. [Cómo funciona](#1-cómo-funciona)
2. [Opciones de instalación](#2-opciones-de-instalación)
3. [Claude Desktop](#3-claude-desktop)
4. [Captura pasiva — memoria automática](#4-captura-pasiva--memoria-automática)
5. [Las 37 herramientas — cuándo usar cada una](#5-las-37-herramientas--cuándo-usar-cada-una)
6. [Uso sin repositorio](#6-uso-sin-repositorio)
7. [Preguntas frecuentes](#7-preguntas-frecuentes)

---

## 1. Cómo funciona

```
Claude Code / Cursor / Claude Desktop
        │
        │  (stdio JSON-RPC)
        ▼
  @mnemo-ai/mcp  ← thin adapter process (npx -y @mnemo-ai/mcp)
        │
        │  (HTTP + Bearer token)
        ▼
  Mnemosyne server  (your local Docker or remote VPS)
        │
        ├── PostgreSQL + pgvector  (storage + HNSW semantic index)
        └── Redis                  (hot-tier session cache)
```

El proceso MCP es un **proxy delgado**. No contiene lógica de negocio: cada llamada a una herramienta se convierte en una solicitud HTTP al servidor de Mnemosyne. La lógica de negocio (pipeline de recuperación, RLS, registro de auditoría, consolidación) vive exclusivamente en el servidor.

**Solo se necesitan dos variables de entorno:**

| Variable    | Ejemplo                      | Qué es                                |
| ----------- | ---------------------------- | ------------------------------------- |
| `MNEMO_URL` | `https://memory.example.com` | URL base de tu servidor de Mnemosyne  |
| `MNEMO_KEY` | `mns_live_abc123`            | Clave de API de tu espacio de trabajo |

**¿Por qué stdio (y no un servidor HTTP)?**

Los clientes MCP (Claude Code, Cursor, Claude Desktop) lanzan el servidor MCP como un proceso hijo y se comunican con él mediante tramas JSON-RPC por stdin/stdout. Esto significa que:

- No hace falta abrir ningún puerto: sin reglas de firewall ni conflictos de puertos
- El proceso MCP arranca bajo demanda y termina cuando el cliente se desconecta
- `npx -y @mnemo-ai/mcp` funciona de inmediato, sin instalación global

---

## 2. Opciones de instalación

Elige una opción según tu situación.

### Opción A — Instalación local completa (monorepo)

Para colaboradores o usuarios que quieren ejecutar el servidor ellos mismos.

```bash
# Clone and start everything with Docker
git clone https://github.com/lucasmailland/mnemosyne
cd mnemosyne
pnpm install
pnpm docker:up          # starts Postgres + pgvector
pnpm build
pnpm --filter @mnemo-ai/server dev   # server on :3939

# Or use mnemo install to auto-configure all detected agents (Claude Code, Cursor, OpenCode, Codex, Gemini CLI)
mnemo install
```

O añádelo manualmente a Claude Code:

```bash
claude mcp add mnemosyne --scope user \
  --env MNEMO_URL=http://localhost:3939 \
  --env MNEMO_KEY=mns_live_... \
  -- npx -y @mnemo-ai/mcp
```

### Opción B — Servidor en la nube o remoto (sin repositorio)

Tienes Mnemosyne en un VPS o en un host en la nube. Solo necesitas npm: no hace falta clonar el repositorio.

```bash
# Claude Code (one-time command)
claude mcp add mnemosyne --scope user \
  --env MNEMO_URL=https://your-server.com \
  --env MNEMO_KEY=mns_live_... \
  -- npx -y @mnemo-ai/mcp
```

O usa la CLI para configurarlo de forma interactiva:

```bash
npm install -g @mnemo-ai/cli
mnemo init   # prompts for MNEMO_URL and MNEMO_KEY, writes ~/.mnemo/config.json
```

### Opción C — Plugin (recomendada para Claude Code)

Además de las herramientas MCP, el plugin te da captura automática de recuerdos mediante hooks.

```bash
# Step 1 — Register the marketplace (once per machine)
claude plugin marketplace add lucasmailland/mnemosyne

# Step 2 — Install the plugin
claude plugin install mnemosyne@mnemosyne
```

Después, define las variables de entorno en el perfil de tu shell (`~/.zshrc` o `~/.bashrc`):

```bash
export MNEMO_URL=https://your-server.com
export MNEMO_KEY=mns_live_...
```

Claude Code conectará los hooks de sesión automáticamente. En el siguiente inicio de sesión se inyecta el protocolo de memoria y los hooks empiezan a capturar.

---

## 3. Claude Desktop

Claude Desktop admite las herramientas MCP, pero no los hooks de Claude Code. Las herramientas funcionan; la captura pasiva automática no.

Edita `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) o `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["-y", "@mnemo-ai/mcp"],
      "env": {
        "MNEMO_URL": "http://localhost:3939",
        "MNEMO_KEY": "mns_live_..."
      },
      "type": "stdio"
    }
  }
}
```

Reinicia Claude Desktop. Las herramientas del servidor aparecerán en el selector: las 37, o solo las 9 más usadas (recall, fact, remember, decide, update, forget, search, status, context) con `"MNEMO_MCP_TOOLS": "core"` en `env`.

**Nota sobre los hooks:** los hooks de sesión (`session-start.sh`, `subagent-stop.sh`, etc.) son una función de Claude Code y no se ejecutan en Claude Desktop. La IA todavía puede llamar a las herramientas manualmente, pero no recuperará contexto automáticamente al inicio de la sesión a menos que le pidas explícitamente que llame a `memory_recall`.

---

## 4. Captura pasiva — memoria automática

Hay dos modos de funcionamiento:

### Modo manual (base)

Sin el plugin, la IA decide cuándo llamar a las herramientas de memoria según sus instrucciones. Con el protocolo de memoria cargado (`SKILL.md`), la IA:

- Llama a `memory_recall` antes de responder al primer mensaje de cada sesión
- Llama a `memory_remember` de forma proactiva tras decisiones, correcciones de errores y preferencias
- Llama a `memory_episode_end` antes de decir «listo» para conservar la sesión completa

Esto es lo que obtienes con la Opción B (solo MCP) o con Claude Desktop.

### Modo automático (hooks del plugin)

El plugin conecta cinco hooks de shell que se ejecutan sin intervención de la IA:

| Hook                    | Cuándo se dispara                                                                               | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-start.sh`      | En `SessionStart` (inicio o limpieza)                                                           | Llama a `POST /session/start`, guarda el id de sesión de Mnemosyne en un mapa de correlación indexado por el id de sesión propio de Claude (`~/.mnemo/sessions/<claude_session_id>.json`, con limpieza a los 7 días; lo leen `user-prompt-submit.sh` y `session-stop.sh`, más abajo) e inyecta `SKILL.md` más las estadísticas del espacio de trabajo como `additionalContext`                                                                                                                                                                                                                                                                                                                           |
| `post-compaction.sh`    | En `SessionStart` (compactación)                                                                | Activa el protocolo de recuperación posterior a la compactación (reproduce el búfer mediante `memory_episode_end`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `user-prompt-submit.sh` | En cada `UserPromptSubmit`                                                                      | **Primer mensaje** (requisito 2 de la memoria autónoma): llama él mismo a `POST /recall` usando el prompt como consulta (más el id de sesión correlacionado, si existe) e inyecta los resultados mediante `additionalContext`: el modelo recibe contexto recuperado real sin ninguna llamada a herramientas. Junto con eso se sigue enviando un aviso reducido de `ToolSearch` para recuperar más información si el tema cambia, que pasa a ser el único recurso si el servidor no responde o no devuelve resultados. **Mensajes posteriores**: sin cambios; comprueba `lastWriteAt` en `/admin/stats` y avisa para que se guarde algo si han pasado más de 15 minutos desde el último `memory_remember` |
| `subagent-stop.sh`      | En `SubagentStop` (asíncrono)                                                                   | Envía el `stdout` del subagente a `POST /capture` para la extracción automática de hechos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `session-stop.sh`       | En `Stop` (asíncrono a nivel del arnés, síncrono internamente; consulta la cabecera del script) | Garantiza que el episodio de la sesión se colapse aunque el modelo nunca haya llamado a `memory_episode_end` (no vuelve a colapsar si ya está `collapsed`). Después ejecuta la **verificación de cumplimiento** del requisito 4 de la memoria autónoma: comprueba si alguna recuperación se correlacionó con esta sesión (`lastRecallAt`) y si el colapso tuvo éxito, y muestra un informe de brechas como `systemMessage` SOLO cuando algo realmente no ocurrió (por ejemplo, el servidor estuvo inaccesible toda la sesión); nunca insiste con algo que ya funcionó                                                                                                                                    |

El resultado: los recuerdos se capturan y se recuperan incluso cuando la IA olvida llamar explícitamente a las herramientas. La recuperación se inyecta automáticamente en el primer mensaje, los episodios se colapsan solos al terminar la sesión y una verificación de cumplimiento señala el raro caso en que no ocurrió ninguna de las dos cosas. Además, cada salida de subagente se analiza automáticamente en busca de hechos extraíbles.

---

## 5. Las 37 herramientas — cuándo usar cada una

Las 37 se sirven por defecto; `MNEMO_MCP_TOOLS=core` reduce la lista a las 9 más usadas, para que cada request lleve menos.

La IA elige las herramientas según la tarea. Esta sección explica la intención de cada una para que puedas referirte a ella en tus prompts o configurar un protocolo personalizado.

### Operaciones con recuerdos

| Herramienta                | Cuándo usarla                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_remember`          | Guarda un hecho duradero. Llámala de forma proactiva tras decisiones, correcciones de errores, preferencias o descubrimientos poco evidentes. Es la herramienta principal.                        |
| `memory_forget`            | Borrado lógico de un hecho que ya no es cierto. Establece `validTo = NOW()`: la fila se conserva para auditoría. NO lo elimina.                                                                   |
| `memory_update`            | Corrige un hecho que guardaste de forma incorrecta. Úsala cuando el enunciado era erróneo, no solo estaba desactualizado.                                                                         |
| `memory_fact`              | Lee un hecho completo por id. Úsala cuando un resultado compacto de recall dice `truncated: true` y necesitas el texto entero.                                                                    |
| `memory_relocate`          | Mueve un hecho al espacio de trabajo al que pertenece. Cierra el original y crea el sucesor allí, unidos por `supersedes`; los hechos confidenciales y restringidos no pueden moverse.            |
| `memory_suggest_topic_key` | Deriva un `topicKey` estable a partir de un asunto y un cuerpo antes de guardar, para que un guardado posterior sobre el mismo tema lo actualice en lugar de duplicarlo.                          |
| `memory_pin`               | Evita que la consolidación fusione un hecho (no sube su posición en la recuperación). Úsala para invariantes críticas que deben conservarse tal cual (p. ej., «RLS must always use withMnemoTx»). |
| `memory_timeline`          | Consulta la actividad reciente del espacio de trabajo. Útil para resúmenes de sesión o para «qué pasó esta semana».                                                                               |
| `memory_status`            | Resumen rápido del estado del espacio de trabajo: número de hechos vigentes, última escritura y feature flags. Llámala al inicio de la sesión o cuando algo parezca raro.                         |

### Recuperación y búsqueda

| Herramienta     | Cuándo usarla                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_recall` | Pipeline híbrido de 7 etapas (vectores + activación ACT-R + puntuación de valor). Úsala para consultas semánticas: «qué decidimos sobre X», «cómo manejamos Y». Es la herramienta principal de recuperación.              |
| `memory_search` | Búsqueda de texto completo pura. Úsala para coincidencias exactas de palabras clave (códigos de error, nombres de funciones, frases conocidas). Funciona sin clave de API de un LLM. Es más rápida, pero no es semántica. |

**Cómo elegir entre ambas:** `memory_recall` casi siempre es mejor para comprender. `memory_search` es más rápida para «encontrar el mensaje de error exacto que documentamos».

### Grafo de conocimiento

| Herramienta        | Cuándo usarla                                                                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_relate`    | Enlaza dos hechos con un verbo de relación tipado (uno de los 9 verbos fijos: `related`, `compatible`, `scoped`, `conflicts_with`, `supersedes`, `not_conflict`, `derived_from`, `part_of`, `member_of`). Llámala cuando notes una conexión significativa. |
| `memory_hyperedge` | Enlaza 3 o más hechos en un único grupo de coactivación. Úsala para decisiones que abarcan varios componentes o para hechos que siempre se aplican juntos.                                                                                                 |
| `memory_compare`   | Compara dos hechos: muestra qué cambió entre dos versiones de una decisión o de un conocimiento.                                                                                                                                                           |
| `memory_judge`     | Resuelve un conflicto entre dos hechos que se contradicen. Elige la versión de referencia y registra el razonamiento.                                                                                                                                      |

### Primitivas estructuradas

Estas herramientas crean registros tipados más ricos que el simple `memory_remember`.

| Herramienta        | Cuándo usarla                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_decide`    | Registra una decisión de arquitectura o de política con su justificación completa, el contexto y las alternativas consideradas. Es más rica que `memory_remember` para todo lo que requirió deliberación. |
| `memory_entity`    | Crea o actualiza una persona, organización, proyecto, concepto o lugar. Úsala cuando un actor recurrente necesite su propio nodo en el grafo (p. ej., «Ada», «Mnemosyne», «PostgreSQL»).                  |
| `memory_strategy`  | Registra una heurística del tipo «cuando X, haz Y» que la IA debe volver a aplicar en sesiones futuras (p. ej., «cuando RLS falle, revisa primero withMnemoTx»).                                          |
| `memory_reasoning` | Guarda un registro de cadena de pensamiento con decaimiento de valor. Úsala cuando quieras conservar una línea de razonamiento y no solo su conclusión.                                                   |
| `memory_task`      | Da seguimiento a una tarea pendiente con ciclo de vida (`pending` → `completed`). Úsala para trabajo que quieras que la IA recuerde entre sesiones.                                                       |
| `memory_event`     | Registra un hecho inmutable que ocurrió. Sin `updatedAt`: los eventos son de solo anexado por diseño. Úsala para «desplegamos v3.2 el 2026-06-10».                                                        |
| `memory_workflow`  | Guarda una plantilla reutilizable de un proceso de varios pasos (p. ej., «cómo preparar una versión»). La IA puede recuperarla y ejecutarla más adelante.                                                 |
| `memory_skill`     | Registra una capacidad de la IA o una plantilla de prompt (p. ej., «sé escribir archivos de migración en este proyecto»). Se recupera y se aplica automáticamente.                                        |

### Gestión de sesiones

| Herramienta            | Cuándo usarla                                                                                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_episode_start` | Inicia una sesión de trabajo. Los hechos se guardan temporalmente en un búfer. Llámala al comenzar un trabajo importante que se espere que dure más de 5 minutos.                                                                                                                  |
| `memory_episode_end`   | Cierra la sesión y colapsa el búfer en memoria duradera. Llámala antes de decir «listo». El LLM resume todo el búfer, lo que permite una extracción más rica que las llamadas individuales a `memory_remember`.                                                                    |
| `memory_session`       | Herramienta unificada de control de sesión con las acciones: `pin` (promover un hecho temporal), `scratch` (añadir una nota temporal), `collapse` (colapso manual) y `discard` (abandonar la sesión sin guardar). Para un control fino de la sesión dentro de un episodio abierto. |

### Metacognición

| Herramienta          | Cuándo usarla                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_introspect`  | Pregunta «¿qué sé bien? ¿cuáles son mis lagunas?». Devuelve una autoevaluación estructurada de la cobertura de conocimiento del espacio de trabajo. Llámala al iniciar una nueva fase del proyecto.                       |
| `memory_anticipate`  | Predice qué hechos harán falta a continuación según el contexto de la tarea actual. Útil para precargar contexto relevante al inicio de una tarea compleja.                                                               |
| `memory_consolidate` | Fusiona hechos duplicados o redundantes. Activa `POST /consolidation/trigger`, que ejecuta el pipeline de consolidación en segundo plano. Úsala tras importaciones masivas o sesiones largas con muchos hechos solapados. |
| `memory_compose`     | Motor de inferencia: compone hechos nuevos a partir de los existentes mediante reglas declarativas. Úsala cuando quieras que el sistema derive conocimiento implícito de lo que ya sabe.                                  |

### Recordatorios

| Herramienta          | Cuándo usarla                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_remind_when` | Define un disparador futuro: por tiempo («recuérdame X en 3 días») o semántico («recuérdame X la próxima vez que trabajemos en autenticación»). El sondeo en segundo plano evalúa los disparadores cada 30 segundos. |

### Autoedición

| Herramienta        | Cuándo usarla                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_self_edit` | Permite que el sistema de memoria proponga ediciones a sus propios hechos guardados a partir de nueva evidencia. Úsala con cuidado: es una operación de nivel de gobernanza. |

### Operaciones

| Herramienta     | Cuándo usarla                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_doctor` | Ejecuta 8 diagnósticos operativos: conectividad con Postgres, permisos de app_user, esquemas sombra, versión de migración, atraso de embeddings, validez de workspace_id, configuración de entorno de MCP y número de herramientas MCP registradas. Llámala de inmediato ante cualquier error 500, antes de reintentar.                     |
| `memory_stats`  | Estadísticas detalladas del espacio de trabajo: número de hechos por tipo de primitiva, volumen del registro de recuperaciones y uso de almacenamiento.                                                                                                                                                                                     |
| `memory_purge`  | Borra definitivamente un hecho por ID (`action='fact'`) o todos los hechos olvidados del espacio de trabajo (`action='closed'`). **El borrado es permanente y no se puede deshacer.** No es un borrado conforme al GDPR; para el olvido habitual usa `memory_forget`. Solo en espacios de trabajo de prueba; nunca la llames en producción. |

### Identidad y espacio de trabajo

Consulta [architecture/MULTI_TENANCY.md](../architecture/MULTI_TENANCY.md) para ver el modelo completo. **Ninguna de las dos herramientas cambia el espacio de trabajo activo**: queda fijo durante toda la sesión y se establece una sola vez al iniciar el proceso mediante la clave de API o el token (o `MNEMO_WORKSPACE_ID`). Tu rol (propietario `owner`, administrador `admin`, colaborador `write` o lector `read`), y no solo los permisos en bruto de tu clave, es el verdadero límite de lo que puedes hacer: si una herramienta de escritura devuelve 403, lo más probable es que se deba a tu rol y no a una caída; llama a `memory_context` para confirmarlo antes de reintentar y dile al usuario que pida acceso a un administrador del espacio de trabajo en lugar de entrar en un bucle.

| Herramienta        | Cuándo usarla                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory_context`   | Llamada opcional de identidad y orientación: devuelve en una sola respuesta el espacio de trabajo activo, userId, tenantId, permisos y estadísticas en vivo. El alcance del espacio de trabajo ya lo establece la clave de API en cada llamada (incluida `memory_recall`); esto es para orientarse, no un requisito al iniciar la sesión.                                                              |
| `memory_workspace` | 8 acciones: `list` (tus propias pertenencias y rol), `describe`, `members` (y sus roles), `current`, más 4 acciones de modificación que requieren ser propietario (`owner`) o administrador (`admin`) del espacio de trabajo: `create`, `invite`, `set_role`, `remove`; un usuario con rol `read` o `write` recibe un 403 real del servidor en esas acciones, no solo un rechazo del lado del cliente. |

---

## 6. Uso sin repositorio

No necesitas clonar el repositorio de Mnemosyne para usarlo como cliente. El repositorio solo hace falta si quieres ejecutar el servidor localmente.

### Solo la CLI

```bash
npm install -g @mnemo-ai/cli
mnemo init   # prompts for MNEMO_URL + MNEMO_KEY, writes ~/.mnemo/config.json
mnemo status
mnemo recall "what did we decide about RLS?"
```

### Solo el MCP (Claude Code)

```bash
claude mcp add mnemosyne --scope user \
  -e MNEMO_URL=https://your-server.com \
  -e MNEMO_KEY=mns_live_... \
  -- npx -y @mnemo-ai/mcp
```

Comprueba que quedó registrado:

```bash
claude mcp list
```

### Script de instalación en una línea (próximamente)

Cuando los paquetes se publiquen en npm, habrá disponible un instalador de shell:

```bash
# Not yet available — packages must be published first
curl -fsSL https://raw.githubusercontent.com/lucasmailland/mnemosyne/main/scripts/install.sh | bash
```

Este script todavía no existe. Mientras tanto, usa `npm install -g @mnemo-ai/cli` y `claude mcp add`, como se indica arriba.

---

## 7. Preguntas frecuentes

**¿Necesito clonar el repositorio?**

No. Para conectar un cliente a Mnemosyne solo necesitas `npx @mnemo-ai/mcp` (el proceso MCP) y, opcionalmente, `@mnemo-ai/cli`. El repositorio solo hace falta si quieres ejecutar el servidor tú mismo.

**¿Cuál es la diferencia entre `memory_recall` y `memory_search`?**

`memory_recall` ejecuta el pipeline completo de 7 etapas: búsqueda vectorial HNSW → expansión de relaciones a 1 salto → puntuación de activación ACT-R → ponderación de valor → techo de sensibilidad → resultados estructurados. Es semántica: encuentra hechos relacionados conceptualmente aunque las palabras clave no coincidan.

`memory_search` es una búsqueda de texto completo pura (FTS de PostgreSQL). Es más rápida y funciona sin clave de API de un LLM, pero solo encuentra documentos que contengan las palabras clave exactas.

Usa `memory_recall` para comprender y razonar. Usa `memory_search` cuando conozcas la frase exacta que guardaste.

**¿Puedo usarlo sin una clave de API de un LLM?**

Sí. `memory_recall` y `memory_search` recurren ambas a la búsqueda de texto completo cuando no hay un modelo de embeddings configurado. Todas las demás herramientas funcionan con normalidad. Lo único que pierdes es el índice vectorial semántico: los hechos se guardan, pero no se vectorizan hasta que añadas una clave de LLM con soporte de embeddings.

**¿Funciona con Cursor, Codex o Gemini?**

- **Herramientas MCP**: sí, si el entorno de ejecución admite MCP. El modo Agent de Cursor, Codex y Gemini CLI admiten MCP.
- **Hooks del plugin**: Cursor tiene un manifiesto en `packages/plugin/.cursor-plugin/`. Codex tiene uno en `packages/plugin/.codex-plugin/`. Gemini CLI usa `packages/plugin/GEMINI.md` y `packages/plugin/gemini-extension.json`.
- **Hooks de sesión automáticos**: usan el sistema de hooks `SessionStart` / `SubagentStop` / `Stop` de Claude Code. Los demás entornos no tienen APIs de hooks equivalentes, así que obtienes acceso a las herramientas, pero no la captura automática.

**¿El MCP escucha de forma pasiva, como Engram?**

No por defecto. La IA llama explícitamente a las herramientas MCP. Sin embargo, con el plugin de Claude Code instalado ocurren tres cosas de forma automática, sin ninguna llamada a herramientas por parte de la IA: `user-prompt-submit.sh` recupera contexto para el primer mensaje de una sesión y lo inyecta directamente, `subagent-stop.sh` envía la salida de cada subagente a `POST /capture` para su extracción en segundo plano, y `session-stop.sh` garantiza que el episodio de la sesión se colapse (y se extraigan los hechos) aunque el modelo nunca haya llamado a `memory_episode_end`. Consulta la tabla de hooks de la sección 4 para ver el comportamiento completo. Sin el plugin, la IA debe llamar activamente a las herramientas.

**¿Qué pasa si el servidor de Mnemosyne está fuera de línea?**

El proceso MCP arrancará correctamente, pero las llamadas a herramientas devolverán errores HTTP. La IA debería llamar a `memory_doctor` para diagnosticar la conectividad. Todos los errores se muestran en stderr (nunca en stdout, que es el canal JSON-RPC). Claude Code muestra stderr en su interfaz, así que verás un mensaje de error claro.

**El formato de mi clave de API: ¿cuál es válido?**

Las claves usan el formato `mns_live_...` (producción) o `mns_test_...` (pruebas o staging). El prefijo se elimina y se valida en el servidor. Las claves están acotadas a un espacio de trabajo y aplican RLS automáticamente.

**¿Cómo decide la IA cuándo usar cada herramienta?**

La IA sigue el protocolo de comportamiento definido en `packages/plugin/skills/memory/SKILL.md`. Las herramientas principales (`memory_recall`, `memory_remember`, `memory_status`, `memory_search`, `memory_episode_start`, `memory_episode_end`) están siempre en contexto. Las herramientas ampliadas se cargan mediante `ToolSearch` cuando la tarea las requiere. Con el plugin instalado, el protocolo se inyecta automáticamente al inicio de la sesión. Sin el plugin, pega el contenido de `SKILL.md` en tu prompt de sistema o en las instrucciones del proyecto.
