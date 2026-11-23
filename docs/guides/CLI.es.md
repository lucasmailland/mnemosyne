# Especificación de la CLI — @mnemo-ai/cli

[English](CLI.md) · **Español**

> **Estado:** 🔶 Alfa (según el `CLAUDE.md` de la raíz), pero funcionalmente la superficie de comandos más amplia de la capa de clientes al 2026-07-31 (CLI-PARITY-1): cada una de las 10 primitivas cognitivas, los 9 verbos de relación bloqueados y las herramientas operativas (pin/timeline/judge/purge/consolidate/remind) se pueden alcanzar desde la CLI, igual que la superficie de herramientas MCP. Ejecuta `mnemo help` para ver la lista de comandos autorizada y siempre al día: este documento la refleja, pero si alguna vez difieren, la salida de `--help` del propio binario es la fuente de verdad.
> **Fuente:** [packages/cli/src/commands.ts](../../packages/cli/src/commands.ts) (implementación de los comandos) + [packages/cli/src/index.ts](../../packages/cli/src/index.ts) (despacho). Construida sobre `@mnemo-ai/client-ts`: no hay llamadas HTTP ad hoc, salvo en las pocas rutas que todavía no tienen un método tipado en el cliente (consulta `docs/archive/BACKLOG.md` P34/P35).

## Binario

`mnemo`: se instala con `npm install -g @mnemo-ai/cli` o `pnpm add -g @mnemo-ai/cli`

## Configuración

Prioridad (de mayor a menor):

1. Variables de entorno: `MNEMO_URL`, `MNEMO_KEY`
2. Archivo de configuración: `~/.mnemo/config.json`
3. Error (faltan campos obligatorios)

Formato del archivo de configuración:

```json
{
  "url": "http://localhost:3939",
  "apiKey": "mns_live_..."
}
```

Administrar la configuración:

```bash
mnemo config set url http://localhost:3939
mnemo config set apiKey mns_live_...
mnemo config get          # shows all, masks apiKey
mnemo config get url      # shows single key
```

## Preparación

```bash
mnemo login               # interactive: prompts for URL + API key, writes ~/.mnemo/config.json
mnemo init                 # setup wizard: verifies connectivity, optionally registers a user, wires MCP clients
mnemo init --docker        # full local bootstrap: starts Postgres/Redis/server via Docker Compose, generates a workspace + API key
mnemo install              # installs the Mnemosyne MCP server + plugin into every detected AI coding agent
mnemo install --local      # Claude Code only: installs the plugin from the local working tree (packages/plugin/) instead of the native marketplace — development install, not git-tracked
```

## Operaciones básicas de memoria

```bash
mnemo recall [--json] [--limit N] <query>   # 7-stage hybrid recall (vector + ACT-R + worth)
mnemo remember <text>                        # store a fact
mnemo forget <id>                            # soft-delete (bitemporal close, not a real delete)
mnemo list [--limit N]                       # recent facts, newest first
mnemo search <query>                         # full-text search (recall's FTS fallback path)
mnemo show <factId>                          # full JSON for one fact
mnemo pin <factId>                           # protect a fact from worth decay
mnemo unpin <factId>
mnemo timeline [--limit N] [--since <iso>]   # recent fact-lifecycle events
```

## Las 10 primitivas cognitivas

Los hechos ya están cubiertos arriba (`remember`/`forget`/`list`/`show`). Las otras 9:

```bash
# Decisions — architectural/policy calls with rationale
mnemo decide create --kind <k> --title <t> --body <b> [--topic-key tk] [--scope-ref sr]
mnemo decide list [--status active|superseded|withdrawn] [--limit N]
mnemo decide show <id>
mnemo decide supersede <id> --by <newDecisionId>
# kind: decision|architecture|policy|process|bugfix|learning|discovery|config

# Episodes — buffered sessions with richer LLM-summarized collapse extraction
mnemo episode start [--label l] [--agent-id a]
mnemo episode collapse <id> [--hint h] [--strategy auto|explicit]

# Entities — people, orgs, projects, concepts, places
mnemo entity create --name <n> --kind <k> [--aliases a,b] [--description d]
mnemo entity list [--kind k] [--q text] [--limit N]
mnemo entity show <id>
mnemo entity update <id> [--name n] [--kind k] [--aliases a,b] [--canonical-id id|null]
mnemo entity facts <id> [--limit N]     # facts linked via mnemo_fact.entity_id
# kind: person|organization|project|concept|place|other

# Link a kind=person entity to a real platform account (mnemo_user.id).
# Self-link (your own userId) is always allowed. Linking a DIFFERENT user —
# or reassigning an entity already linked to someone else — requires
# memory:admin scope and an owner/admin role in the workspace. Unlink is
# bitemporal (closes the row, creates an unlinked successor), never an
# in-place overwrite. linkedUserId is never settable via create/update.
mnemo entity link-user <id> <userId>
mnemo entity unlink-user <id>

# Strategies — "when X, do Y" heuristics
mnemo strategy create --trigger <t> --action <a> [--context c] [--scope-ref sr]
mnemo strategy list [--status active|superseded|archived] [--limit N]
mnemo strategy show <id>
mnemo strategy update <id> [--trigger t] [--action a] [--context c] [--status s]
mnemo strategy archive <id>
mnemo strategy rate <id> <success|failure>   # Beta-Bernoulli worth recompute

# Workflows — reusable multi-step process templates
mnemo workflow create --name <n> --steps '["step 1","step 2"]' [--description d] [--scope-ref sr]
mnemo workflow list [--status s] [--scope-ref sr] [--limit N]
# --steps accepts plain strings (shorthand for {action}, order/expectedDurationMs auto-filled)
# or full {action, expectedDurationMs?, condition?, tools?} objects for control over duration/tools —
# either way the CLI builds valid WorkflowStep objects before sending; a raw string array previously
# reached the server as-is and was rejected with 400 (server requires order + expectedDurationMs).
mnemo workflow show <id>

# Skills — reusable prompt templates
mnemo skill create --name <n> --prompt <p> [--variables v1,v2] [--required-context c1,c2] [--sensitivity s]
mnemo skill list [--limit N]
mnemo skill show <id>
# sensitivity: public|internal|confidential|restricted

# Tasks — action items with lifecycle
mnemo tasks [list]
mnemo tasks create --title <t> --assigned-to <agent> [--description d] [--priority critical|high|medium|low] [--due-at iso]
mnemo tasks show <id>
mnemo tasks update <id> [--status s] [--outcome o] [--lessons-learned l]
mnemo tasks delegate <id> --to <agent>

# Events — immutable, append-only occurrences
mnemo events [list]
mnemo events create --type <t> --name <n> --description <d> --source <s> [--occurred-at iso]
mnemo events show <id>
mnemo events archive <id>    # refused: events are immutable (the server answers 409, exit 1)
mnemo events sensitivity <id> <public|internal|confidential|restricted>   # raise-only; server 422s a lowering attempt
# type: system|external|user|agent|scheduled

# Reasoning — chain-of-thought cache
mnemo reasoning create --question <q> --conclusion <c> --chain '<json array>' [--topic-key tk]
mnemo reasoning list [--limit N]
mnemo reasoning show <id>
mnemo reasoning archive <id>
mnemo reasoning resolve <query>          # check the CoT cache before re-running inference
mnemo reasoning record --question <q> --conclusion <c> --chain '<json array>' [--outcome success|fail]
mnemo reasoning feedback <id> <success|fail>
# chain item shape: {"step":1,"reasoning":"...","conclusion":"..."}
```

## Relaciones (9 verbos bloqueados)

```bash
mnemo relate <sourceKind> <sourceId> <verb> <targetKind> <targetId> [--reason r] [--confidence c] [--marked-by-kind user|agent|system|llm_judge]
mnemo relate list [--judgment-status pending|judged|dismissed] [--limit N]
mnemo relate history <sourceKind> <id> [--max-depth N]   # walk the supersedes/derived_from chain from <id> — "why is this the current one, what did it replace"
# kind: fact|decision|entity|episode
# verb (locked, server 400-rejects anything else):
#   related | compatible | scoped | conflicts_with | supersedes |
#   not_conflict | derived_from | part_of | member_of
```

Hiperaristas (relaciones n-arias, 3 o más miembros en un mismo grupo de coactivación):

```bash
mnemo hyperedge create --members id1,id2,id3 [--label l] [--description d] [--context-query q]
mnemo hyperedge list [--member-id id] [--limit N]
mnemo hyperedge show <id>
mnemo hyperedge update <id> [--label l] [--description d] [--context-query q]
mnemo hyperedge archive <id>
```

## Memoria prospectiva

```bash
mnemo remind create --content <c> [--condition c] [--trigger-at iso]
mnemo remind list [--status pending|triggered|dismissed|all] [--limit N]
mnemo remind dismiss <id>
```

Se requiere al menos una de estas dos opciones: `--condition` (semántica, se evalúa en cada recuperación) o `--trigger-at` (temporal, se revisa cada 30 s).

## Resolución de conflictos

```bash
mnemo judge [list] [--limit N]                                          # list unresolved conflicting fact pairs
mnemo judge resolve <relationId> <supersede_a|supersede_b|keep_both|merge> [--merged-statement s]
# --merged-statement is required when the resolution is 'merge' — the CLI rejects locally (no request made)
# before the server would 400 for the same reason.
```

## Consolidación

```bash
mnemo consolidate [--mode fast|deep] [--dry-run]
```

Por ahora, el modo `deep` manual y `--dry-run` devuelven HTTP 422: solo el modo `fast` sin simulación se ejecuta de verdad. Los indicadores se aceptan por compatibilidad futura.

## Operaciones destructivas

```bash
mnemo purge <factId> --confirm          # hard-delete one fact. IRREVERSIBLE. Requires memory:hard_delete scope.
mnemo purge --all-closed --confirm       # hard-delete every closed (forgotten) fact in the workspace. IRREVERSIBLE.
```

Ambas requieren `--confirm`: no hay un aviso de confirmación interactivo, el propio indicador es la compuerta. Úsalas solo en espacios de trabajo de prueba; purge no es un borrado conforme al GDPR.

```bash
mnemo erase --user <userId> --confirm <userId>      # GDPR crypto-erasure: destroy every encryption key of a user. IRREVERSIBLE.
mnemo erase --actor <actorId> --confirm <actorId>   # same for one actor (the key:<id> ref on its facts)
```

`erase` llama a `POST /admin/erasure` (alcance `memory:hard_delete`): la memoria confidencial y
restringida de esa persona o actor ya no se puede descifrar. `--confirm` debe repetir el id.

## Estado de las sesiones y operaciones

```bash
mnemo status                 # alias for `mnemo health`
mnemo health                 # readiness probe (/health/ready) + app-level detail (/health)
mnemo sessions [list]         # list every session in the workspace
mnemo sessions show <id>      # fetch one session (status, label, lastRecallAt)
mnemo info                    # server, workspace, user, tenant, stats, available workspaces
mnemo whoami                  # alias for info
mnemo doctor                  # 8 operational diagnostics: connectivity, grants, schema, migrations, embeddings, workspace_id, env config, MCP tool registration
```

## Gestión de espacios de trabajo y claves

Consulta [architecture/MULTI_TENANCY.md](../architecture/MULTI_TENANCY.md) para ver el modelo completo de usuario/tenant/espacio de trabajo/token sobre el que operan estos comandos.

```bash
mnemo workspace list                                    # your own workspace memberships, with your role in each
mnemo workspace show <workspaceId>
mnemo workspace members <workspaceId>
mnemo workspace create --name <name> [--tenant <id>] [--slug <slug>] [--visibility private|public] [--owner <userId>]
mnemo workspace invite <workspaceId> <userId> [--role owner|admin|write|read]     # default role: read
mnemo workspace set-role <workspaceId> <userId> <owner|admin|write|read>
mnemo workspace remove <workspaceId> <userId>

mnemo tenant create --name <name> [--kind personal|organization] [--plan <plan>] [--owner-token [--workspace-name <name>]]  # --owner-token also returns a token for the new tenant (your key keeps acting in its own)
mnemo tenant show <tenantId>
mnemo tenant members <tenantId>
mnemo tenant invite <tenantId> <email> [--role owner|admin|member] [--create-if-missing]  # auto-provisions the account if it doesn't exist yet
mnemo tenant remove <tenantId> <userId>
mnemo tenant workspaces <tenantId>

mnemo user create --email <email> [--display-name <name>]

mnemo token issue <tenantId> <userId> --label <label> --workspace <homeWorkspaceId> [--scopes <s1,s2>] [--expires 90d] [--test]  # mints a uk_live_* token for ANOTHER user — requires tenant owner/admin
mnemo token list <tenantId> <userId>
mnemo token revoke <tenantId> <userId> <keyId>

mnemo keys list [--expired]
mnemo keys create --label <l> --scopes <s1,s2> [--expires 30d] [--plan free|pro] [--test] [--ip-allowlist <cidr>] [--max-sensitivity public|internal|confidential|restricted]
mnemo keys revoke <keyId>
mnemo keys show <keyId>
mnemo keys rotate <keyId> [reason]
mnemo link [--label <name>] [--force]    # writes .mnemo.json binding this repo to the active workspace
```

### ¿Contra qué espacio de trabajo se ejecuta un comando?

Una clave de espacio de trabajo `mk_live_*`/`mns_live_*` siempre se ejecuta contra su único espacio de trabajo: nada de lo que sigue aplica. Un token de usuario `uk_live_*` puede apuntar a CUALQUIER espacio de trabajo al que el usuario pertenezca mediante `X-Workspace-Id`, que se resuelve con esta precedencia (de más a menos específico):

1. El indicador global `--workspace <id>`: **debe ir antes del subcomando** (`mnemo --workspace ws_123 recall "query"`), no después. Varios subcomandos ya definen su propio indicador `--workspace <id>` sin relación con este (`mnemo reset --workspace <id>` apunta a un espacio de trabajo para una acción administrativa destructiva; `mnemo token issue ... --workspace <id>` define el espacio de trabajo de origen de un token NUEVO): si el indicador global fuera después del subcomando, chocaría con ellos.
2. La variable de entorno `MNEMO_WORKSPACE_ID`.
3. El campo `workspaceId` de `.mnemo.json` (lo escribe `mnemo link`).

### Idioma

El indicador global `--locale <tag>` (`en-US` o `es-419`; cualquier `es*` se asigna a `es-419`): igual que `--workspace`, **debe ir antes del subcomando** (`mnemo --locale es-419 recall "query"`); la forma `--locale=es-419` no es compatible (igual que `--workspace`); después del subcomando se le pasa al comando sin tocar y no cambia el idioma. Sin el indicador, el idioma sale de `MNEMO_LOCALE`, luego de `"locale"` en `~/.mnemo/config.json` (`mnemo config set locale es-419`), luego de `LC_ALL`, `LC_MESSAGES` y `LANG`, y por último `en-US`. En español, los avisos muestran `[s/N]` y también aceptan `s`, `sí` o `si`. La salida con `--json` nunca cambia. Detalles: [`packages/cli/README.md`](../../packages/cli/README.es.md).

## Importar y exportar

```bash
mnemo export | gunzip > backup.jsonl                                              # gzip JSONL to stdout
mnemo import <file.jsonl.gz> [--from mem0|zep|claude] [--conflict-resolution skip|overwrite|newest]
```

## Autocompletado de shell

```bash
mnemo completion bash    # source <(mnemo completion bash)
mnemo completion zsh     # source <(mnemo completion zsh)
mnemo completion fish    # mnemo completion fish > ~/.config/fish/completions/mnemo.fish
mnemo completion pwsh    # Invoke-Expression (mnemo completion pwsh)
```

## `mnemo help`

Imprime la lista completa y actual de comandos. Ejecútalo después de actualizar, porque los comandos nuevos aparecen ahí antes de que este documento se actualice.

## Códigos de salida

| Código | Significado                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0      | Éxito                                                                                                                                                                                      |
| 1      | Cualquier error: falla de autenticación, servidor inalcanzable, recurso no encontrado, falta la configuración, falta un indicador obligatorio, falta `--confirm` en un comando destructivo |

## Manejo de errores

Todos los errores se escriben en stderr (nunca en stdout) y terminan con el código 1:

```
Error: 401 Unauthorized
Error: 404 fact_01j9abc123 does not exist in this workspace
Error: No server configured. Run: mnemo config set url http://... && mnemo config set apiKey msk_...
```

La salida de la mayoría de los comandos es una línea legible (`✓ Pinned: fact_xyz`) o JSON con formato: no existe un indicador `--format`; la salida JSON es la predeterminada para todo lo que vaya más allá de una confirmación simple.

## Notas de implementación

- Cada comando es un envoltorio delgado sobre un método tipado de `@mnemo-ai/client-ts`: ninguna ruta tiene lógica de fetch propia, salvo que `client-ts` realmente todavía no tenga un método para ella (la lista de `sessions` y `/admin/embedding-migrations` para `reset`).
- La configuración se guarda como JSON en texto plano en `~/.mnemo/config.json` (modo `0600`, directorio `0700`).
- La clave de API se enmascara en la salida de `config get`.
- No hay lógica de reintento: un 500 del servidor termina de inmediato con el estado y el mensaje.
- `mnemo recall` pide 10 resultados por defecto (usa `--limit N` para cambiarlo).
- Pruebas: `pnpm --filter @mnemo-ai/cli test`: reemplaza `global.fetch` por un stub y verifica la ruta, el método y el cuerpo de cada comando. Es una red de seguridad para el cableado de los comandos y la forma de la salida; no verifica de forma independiente la ruta ni el esquema reales del servidor (consulta [`docs/architecture/API.md`](../architecture/API.es.md) para ese contrato).
