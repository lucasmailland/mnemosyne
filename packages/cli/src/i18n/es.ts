import type { en } from "./en.js";

/** Same shape as `en`, every leaf a plain string (so `es` need not repeat en's literals). */
type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/**
 * Neutral Spanish (es-419), tú. Command names, flags, env vars, paths and
 * product names stay in English. In the help, the left column is byte-identical
 * to English so descriptions start at the same column.
 */
export const es = {
  help: {
    text: `
mnemo — CLI de Mnemosyne v{version}

USO
  mnemo <comando> [argumentos]

OPCIONES GLOBALES
  --locale <tag>              Idioma de los mensajes: en-US o es-419 (también MNEMO_LOCALE, locale en la configuración, LANG)

COMANDOS
  recall [--json] [--limit N] <query>
                              Recupera recuerdos (las 10 mejores coincidencias por defecto)
  remember [--json] <text>    Guarda un recuerdo nuevo (--json imprime el registro guardado)
  forget <id>                 Elimina un recuerdo por su ID
  version                     Imprime la versión de la CLI
  status [--json]             Muestra el estado del servidor
  health [--json]             Muestra la sonda de salud de 3 niveles (/health/ready + /health)
  sessions [list]             Lista las sesiones
  sessions show <id>          Muestra una sesión (incluye lastRecallAt)
  episode start [--label l] [--agent-id a]
                              Inicia un episodio (sesión con búfer, extracción de colapso más rica)
  episode collapse <id> [--hint h] [--strategy auto|explicit]
                              Colapsa un episodio en unidades de conocimiento duraderas
  tasks [list]                Lista las tareas
  tasks create --title <t> --assigned-to <agent> [--description d] [--priority p] [--due-at iso]
                              Crea una tarea
  tasks show <id>             Muestra una tarea
  tasks update <id> [--status s] [--outcome o] [--lessons-learned l]
                              Actualiza el estado o el resultado de una tarea
  tasks delegate <id> --to <agent>
                              Delega una tarea a otro agente
  events [list]               Lista los eventos
  events create --type <t> --name <n> --description <d> --source <s> [--occurred-at iso]
                              Registra un evento inmutable (type: system|external|user|agent|scheduled)
  events show <id>            Muestra un evento
  events archive <id>         Rechazado: los eventos son inmutables, así que el servidor responde 409 y el comando termina con 1
  events sensitivity <id> <public|internal|confidential|restricted>
                              Sube el nivel de sensibilidad de un evento (solo puede subir: el servidor responde 422 si intentas bajarlo)
  decide create --kind <k> --title <t> --body <b> [--topic-key tk] [--scope-ref sr]
                              Registra una decisión de arquitectura o de política (kind: decision|architecture|policy|process|bugfix|learning|discovery|config)
  decide list [--status s] [--limit N]
                              Lista las decisiones
  decide show <id>            Muestra una decisión
  decide supersede <id> --by <newId>
                              Marca una decisión como reemplazada por otra
  entity create --name <n> --kind <k> [--aliases a,b] [--description d]
                              Crea o actualiza una entidad (kind: person|organization|project|concept|place|other)
  entity list [--kind k] [--q text] [--limit N]
                              Lista las entidades
  entity show <id>            Muestra una entidad
  entity update <id> [--name n] [--kind k] [--aliases a,b] [--canonical-id id|null]
                              Actualiza una entidad (canonical-id la fusiona con otra entidad)
  entity facts <id> [--limit N]
                              Lista los hechos vinculados a una entidad
  entity link-user <id> <userId>
                              Vincula una entidad kind=person con una cuenta de la plataforma. Vincularte
                              a ti mismo siempre está permitido; vincular a otro usuario requiere memory:admin + rol owner/admin.
  entity unlink-user <id>     Desvincula una entidad kind=person de su cuenta de la plataforma (bitemporal)
  relate <sourceKind> <sourceId> <verb> <targetKind> <targetId> [--reason r] [--confidence c]
                              Crea una relación. kind: fact|decision|entity|episode.
                              verb (9 fijos): related|compatible|scoped|conflicts_with|supersedes|not_conflict|derived_from|part_of|member_of
  relate list [--judgment-status pending|judged|dismissed] [--limit N]
                              Lista las relaciones
  relate history <sourceKind> <id> [--max-depth N]
                              Recorre la cadena supersedes/derived_from desde <id> (por qué este es el vigente, qué reemplazó)
  strategy create --trigger <t> --action <a> [--context c] [--scope-ref sr]
                              Registra una heurística del tipo "cuando X, haz Y"
  strategy list [--status s] [--limit N]
                              Lista las estrategias
  strategy show <id>          Muestra una estrategia
  strategy update <id> [--trigger t] [--action a] [--context c] [--status s]
                              Actualiza una estrategia
  strategy archive <id>       Archiva una estrategia
  strategy rate <id> <success|failure>
                              Registra el resultado de la ejecución de una estrategia
  workflow create --name <n> --steps '<json array>' [--description d] [--scope-ref sr]
                              Guarda una plantilla reutilizable de proceso de varios pasos. --steps: arreglo de
                              cadenas simples (atajo de {action}) u objetos {action, expectedDurationMs?,
                              condition?, tools?} para tener control total.
  workflow list [--status s] [--scope-ref sr] [--limit N]
                              Lista los flujos de trabajo
  workflow show <id>          Muestra un flujo de trabajo
  skill create --name <n> --prompt <p> [--variables v1,v2] [--required-context c1,c2] [--sensitivity s]
                              Registra una plantilla de prompt reutilizable
  skill list [--limit N]      Lista las habilidades
  skill show <id>             Muestra una habilidad
  reasoning create --question <q> --conclusion <c> --chain '<json array>' [--topic-key tk]
                              Guarda un registro de cadena de razonamiento (elemento de la cadena: {"step":1,"reasoning":"..."})
  reasoning list [--limit N]  Lista las cadenas de razonamiento
  reasoning show <id>         Muestra una cadena de razonamiento
  reasoning archive <id>      Archiva una cadena de razonamiento
  reasoning resolve <query>   Consulta la caché de razonamiento antes de volver a inferir
  reasoning record --question <q> --conclusion <c> --chain '<json array>' [--outcome success|fail]
                              Registra una cadena de razonamiento completada en la caché de razonamiento
  reasoning feedback <id> <success|fail>
                              Envía el resultado de una cadena de razonamiento en caché
  hyperedge create --members id1,id2,id3 [--label l] [--description d] [--context-query q]
                              Vincula 3 o más hechos en un solo grupo de coactivación
  hyperedge list [--member-id id] [--limit N]
                              Lista los hiperaristas
  hyperedge show <id>         Muestra un hiperarista
  hyperedge update <id> [--label l] [--description d] [--context-query q]
                              Actualiza un hiperarista
  hyperedge archive <id>      Archiva un hiperarista
  pin <factId>                Fija un hecho para que no pierda valor con el tiempo
  unpin <factId>              Deja de fijar un hecho
  timeline [--limit N] [--since iso]
                              Muestra los eventos recientes del ciclo de vida de los hechos (creado/fijado/actualizado/cerrado)
  judge [list] [--limit N]    Lista los pares de hechos en conflicto sin resolver
  judge resolve <relationId> <supersede_a|supersede_b|keep_both|merge> [--merged-statement s]
                              Resuelve un conflicto entre dos hechos
  purge <factId> --confirm    Elimina un hecho de forma definitiva. Irreversible. Requiere el alcance memory:hard_delete.
  purge --all-closed --confirm
                              Elimina de forma definitiva todos los hechos cerrados (olvidados) del espacio de trabajo. Irreversible.
  erase --user <userId> --confirm <userId>
  erase --actor <actorId> --confirm <actorId>
                              Borrado criptográfico (RGPD): destruye las claves de cifrado de un usuario (todas) o de un actor,
                              y su memoria confidencial ya no se puede leer. Irreversible. Requiere el alcance memory:hard_delete.
  consolidate [--mode fast|deep] [--dry-run]
                              Inicia la consolidación de recuerdos (el modo deep y --dry-run devuelven 422 por ahora)
  remind create --content <c> [--condition c] [--trigger-at iso]
                              Define un disparador futuro (se requiere al menos uno de --condition/--trigger-at)
  remind list [--status pending|triggered|dismissed|all] [--limit N]
                              Lista los recordatorios
  remind dismiss <id>         Descarta un recordatorio
  list [--limit N]            Lista los hechos recientes (20 por defecto, ordenados por createdAt descendente)
  search <query>              Búsqueda de texto completo sin Claude (usa el respaldo FTS del flujo de recuperación)
  show <factId>               Muestra todos los campos de un hecho como JSON con formato
  export                      Descarga los recuerdos del espacio de trabajo como JSONL comprimido con gzip a stdout (canaliza a gunzip)
  import <file> [--from mem0|zep|claude] [--conflict-resolution skip|overwrite|newest]
                              Sube un archivo de exportación JSONL (o un arreglo JSON de otro proveedor) a este espacio de trabajo
  login                       Inicio de sesión interactivo: guarda la URL y la clave de API en ~/.mnemo/config.json
  install [--local]           Instala Mnemosyne en todos los agentes de programación con IA detectados (Claude Code, Cursor, OpenCode, Gemini CLI, Codex)
                              --local: solo Claude Code, instala el plugin desde el árbol de trabajo local en lugar del marketplace nativo (instalación de desarrollo)
  init [--docker]             Asistente de configuración: URL, clave de API y clientes MCP; o levanta un stack completo con Docker
  info                        Muestra el contexto completo de la sesión: servidor, espacio de trabajo, usuario, tenant, estadísticas, espacios de trabajo disponibles
  whoami                      Alias de info
  doctor [--json]             Ejecuta diagnósticos del servidor (conectividad, RLS, permisos, embeddings)
  harness <cmd>               Inspecciona y recupera la cola local de captura (queue, retry, discard, doctor, probe)
  workspace list              Lista los espacios de trabajo a los que pertenece el usuario actual
  workspace members <workspaceId>
                              Lista los miembros de un espacio de trabajo
  keys list [--expired]       Lista todas las claves de API del espacio de trabajo (--expired: solo las vencidas)
  keys create --label <l> --scopes <s1,s2> [--expires 30d] [--plan free|pro] [--test] [--ip-allowlist <cidr>] [--max-sensitivity public|internal|confidential|restricted]
                              Crea una clave de API nueva con alcances (mk_live_ o mk_test_)
  keys revoke <keyId>         Revoca una clave de inmediato
  keys show <keyId>           Muestra todos los metadatos de una clave (sin el secreto)
  keys rotate <keyId> [reason]
                              Rota una clave: imprime la clave nueva una sola vez, con 7 días de gracia
  keys scoped create --scopes <s1,s2> [--type live|sess|admin] [--expires 8h] [--ip-allowlist <cidr>] [--max-sensitivity <nivel>]
                              Emite una clave del esquema con alcances (la verifica MNEMO_SCOPED_AUTH=1); una clave admin también imprime su secreto TOTP una sola vez
  keys scoped rotate <id> [motivo]
                              Rota una clave del esquema con alcances (7 días de gracia)
  keys scoped revoke <id>     Revoca una clave del esquema con alcances de inmediato
  policy list                 Lista las políticas RBAC de los agentes del espacio de trabajo
  policy get <agentId>        Muestra la política RBAC de un agente (el id de su clave de API)
  policy set <agentId> --file <policy.json>
                              Crea o reemplaza la política RBAC de un agente (requiere memory:admin)
  policy delete <agentId>     Borra la política RBAC de un agente
  link [--label <name>] [--force]   Vincula este repositorio con el espacio de trabajo activo (escribe .mnemo.json)
  config set <key> <value>    Define un valor de configuración (claves: url, apiKey, uiMode, recallTimeoutMs, locale)
  config get [key]            Obtiene uno o varios valores de configuración
  completion <shell>          Imprime el script de autocompletado del shell (bash/zsh/fish/pwsh)
  help                        Muestra esta ayuda

SALIDA
  stdout solo lleva el resultado del comando (usa --json para una salida legible por máquinas);
  los banners, el progreso y los errores van a stderr.

CÓDIGOS DE SALIDA
  0  éxito
  1  falla genérica (valor por defecto)
  2  error de uso (comando u opción desconocidos, argumento faltante o inválido)
     también: mnemo export cuando la exportación espera a un segundo aprobador
  3  autenticación o autorización (sin servidor ni clave configurados, HTTP 401, 403)
  4  no encontrado (HTTP 404)
  5  falla transitoria que vale la pena reintentar (red, tiempo de espera, HTTP 408, 429, 5xx)

CONFIGURACIÓN
  Se guarda en ~/.mnemo/config.json
  Se puede reemplazar con variables de entorno: MNEMO_URL, MNEMO_KEY

EJEMPLOS
  mnemo login
  mnemo config set url http://localhost:3939
  mnemo config set apiKey msk_yourkey
  mnemo config set recallTimeoutMs 3000   # tiempo máximo para la recuperación automática del hook
  mnemo info
  mnemo whoami
  mnemo doctor
  mnemo workspace list
  mnemo workspace members 00000000-0000-0000-0000-000000000001
  mnemo keys list
  mnemo keys list --expired
  mnemo keys create --label "CI agent" --scopes memory:read,memory:write --expires 90d
  mnemo keys create --label "test key" --scopes memory:read --test
  mnemo keys create --label "read-only agent" --scopes memory:read --max-sensitivity internal
  mnemo keys revoke mk_abc123def456
  mnemo keys show mk_abc123def456
  mnemo keys rotate mk_abc123def456
  mnemo keys rotate mk_abc123def456 "scheduled rotation"
  mnemo policy set 6f1c2d3e-0000-4000-8000-000000000001 --file acme-agent-policy.json
  mnemo status
  mnemo health
  mnemo sessions
  mnemo sessions show ses_abc123
  mnemo episode start --label "auth refactor"
  mnemo episode collapse ses_abc123 --hint "focus on architecture decisions"
  mnemo tasks
  mnemo tasks create --title "Migrate fact table" --assigned-to agent_db_01 --priority high
  mnemo tasks delegate task_001 --to agent_specialist_02
  mnemo events
  mnemo events create --type system --name deploy.success --description "v3.1.0 deployed" --source ci
  mnemo events sensitivity evt_abc123 confidential
  mnemo decide create --kind architecture --title "Postgres over MongoDB" --body "ACID guarantees"
  mnemo entity create --name PostgreSQL --kind project
  mnemo entity facts ent_pg_001
  mnemo relate fact fact_xyz part_of entity ent_pg_001
  mnemo relate list --judgment-status pending
  mnemo relate history decision dec_pg_over_mongo
  mnemo strategy create --trigger "RLS fails" --action "check withMnemoTx first"
  mnemo workflow create --name "Cut a release" --steps '["bump version","tag","publish"]'
  mnemo skill create --name write-migration --prompt "Write a numbered SQL migration file"
  mnemo reasoning resolve "how to paginate with concurrent writes?"
  mnemo hyperedge create --members fact_1,fact_2,decision_1 --label "auth redesign"
  mnemo pin fact_xyz789
  mnemo unpin fact_xyz789
  mnemo timeline --limit 50
  mnemo judge
  mnemo judge resolve rel_abc keep_both
  mnemo purge fact_xyz789 --confirm
  mnemo purge --all-closed --confirm
  mnemo erase --actor key:mk_0123456789abcdef --confirm key:mk_0123456789abcdef
  mnemo consolidate
  mnemo remind create --content "check migration status" --trigger-at 2026-08-01T00:00:00Z
  mnemo remind list
  mnemo list
  mnemo list --limit 50
  mnemo search "TypeScript generics"
  mnemo show 01j9abc123def456
  mnemo export | gunzip > backup.jsonl
  mnemo remember "TypeScript generics allow type-safe reuse"
  mnemo recall "generics in TypeScript"
  mnemo recall --json "generics" | jq '.hits[].id'
  mnemo recall --limit 25 "machine learning"
  mnemo forget 01j9abc123def456
  mnemo version
`,
  },
  config: {
    noServer:
      "Error: No hay un servidor configurado. Ejecuta: mnemo config set url http://... && mnemo config set apiKey msk_...",
    setUsage: "Error: Uso: mnemo config set <key> <value>",
    setUnknownKey:
      "Error: Clave de configuración desconocida '{key}'. Claves válidas: url, apiKey, uiMode, recallTimeoutMs, locale",
    getUnknownKey:
      "Error: Clave de configuración desconocida '{key}'. Claves válidas: url, apiKey, uiMode, locale",
    invalidUiMode: "Error: uiMode inválido '{value}'. Valores válidos: delight, verbose, quiet",
    invalidRecallTimeout:
      "Error: recallTimeoutMs inválido '{value}'. Se esperaba un entero positivo en milisegundos (p. ej. 3000).",
    invalidLocale: "Error: Idioma inválido '{value}'. Valores válidos: {valid}",
    unknownSubcommand:
      "Error: Subcomando de config desconocido '{sub}'. Usa: config set | config get",
    setDone: "Se definió {key} = {value}",
  },
  main: {
    invalidLocaleFlag: "Error: Valor inválido para --locale '{value}'. Valores válidos: {valid}",
    unknownCommand: "Error: Comando desconocido '{cmd}'. Ejecuta mnemo help.",
    checkingStatus: "Consultando el estado",
    workspaceMismatch:
      'Advertencia: este repositorio espera el espacio de trabajo "{expected}", pero la clave activa corresponde a "{actual}".',
  },
  memory: {
    flagMustBeNumber: "Error: {name} debe ser un número",
    limitInvalid: "Error: {flag} debe ser un entero positivo",
    noResults: "No se encontraron resultados.",
    table: {
      id: "id",
      score: "puntaje",
      statement: "enunciado",
    },
    empty: {
      sessions: "No se encontraron sesiones.",
      decisions: "No se encontraron decisiones.",
      entities: "No se encontraron entidades.",
      facts: "No se encontraron hechos.",
      events: "No se encontraron eventos.",
    },
    recall: {
      usage: "Error: Uso: mnemo recall [--json] [--limit N] <query>",
      action: 'Recuperando recuerdos para "{query}"',
    },
    remember: {
      sessionIdRequired: "Error: --session-id requiere un valor",
      unknownFlag: "Error: Opción desconocida {arg}",
      usage: "Error: Uso: mnemo remember <text>",
      saved: "Recuerdo guardado",
    },
    forget: {
      usage: "Error: Uso: mnemo forget <id>",
      done: "Olvidado",
    },
    facts: {
      listing: "Listando hechos",
    },
    search: {
      usage: "Error: Uso: mnemo search <query>",
      action: 'Buscando "{query}"',
    },
    show: {
      usage: "Error: Uso: mnemo show <factId>",
      fetching: "Obteniendo hecho",
    },
    sessions: {
      listing: "Listando sesiones",
      showUsage: "Uso: mnemo sessions show <id>",
      fetching: "Obteniendo sesión",
    },
    decide: {
      createUsage:
        "Uso: mnemo decide create --kind <k> --title <t> --body <b> [--topic-key <tk>] [--scope-ref <sr>]",
      recorded: "Decisión registrada",
      listing: "Listando decisiones",
      showUsage: "Uso: mnemo decide show <id>",
      fetching: "Obteniendo decisión",
      supersedeUsage: "Uso: mnemo decide supersede <id> --by <newDecisionId>",
      superseded: "Decisión reemplazada por {id}",
      unknownSub:
        "Subcomando de decide desconocido '{sub}'. Usa: create, list, show <id>, supersede <id> --by <id>",
    },
    entity: {
      createUsage:
        "Uso: mnemo entity create --name <n> --kind <k> [--aliases a,b] [--description d]",
      created: "Entidad creada",
      listing: "Listando entidades",
      showUsage: "Uso: mnemo entity show <id>",
      fetching: "Obteniendo entidad",
      updateUsage:
        "Uso: mnemo entity update <id> [--name n] [--kind k] [--aliases a,b] [--canonical-id id|null]",
      updated: "Entidad actualizada",
      factsUsage: "Uso: mnemo entity facts <id> [--limit N]",
      linkUserUsage: "Uso: mnemo entity link-user <entityId> <userId>",
      linkUserNote:
        "  Vincular tu propio usuario (tu userId) siempre está permitido. Vincular a otro usuario —\n  o reasignar una entidad que ya está vinculada a otra persona— requiere el permiso\n  memory:admin y el rol de propietario o administrador en el espacio de trabajo.",
      linked: "Entidad vinculada al usuario",
      unlinkUsage: "Uso: mnemo entity unlink-user <entityId>",
      unlinked: "Entidad desvinculada del usuario",
      unknownSub:
        "Subcomando de entity desconocido '{sub}'. Usa: create, list, show <id>, update <id>, facts <id>, link-user <id> <userId>, unlink-user <id>",
    },
    episode: {
      started: "Episodio iniciado",
      collapseUsage: "Uso: mnemo episode collapse <id> [--hint h] [--strategy auto|explicit]",
      skipped: "Episodio omitido",
      skippedWithReason: "Episodio omitido: {reason}",
      collapseFailed: "Falló la consolidación del episodio",
      collapsePending: "Consolidación del episodio pendiente",
      collapsed: "Episodio consolidado",
      unknownSub: "Subcomando de episode desconocido '{sub}'. Usa: start, collapse <id>",
    },
    pin: {
      usage: "Uso: mnemo pin <factId>",
      done: "Hecho fijado",
      unpinUsage: "Uso: mnemo unpin <factId>",
      unpinDone: "Hecho desfijado",
    },
    timeline: {
      loading: "Cargando la línea de tiempo",
    },
  },
  health: {
    readiness: "Disponibilidad:",
    detail: "Detalle:",
    checkingHealth: "Comprobando el estado",
  },
  export: {
    error: "Error: {status} {statusText}\n{text}",
    approvalRequired:
      'La exportación requiere aprobación (control dual: no puedes aprobar tu propia solicitud).\nID de la solicitud de aprobación: {id}\n{expires}Pide a otro administrador que la apruebe: POST {url}/approvals/{rawId}/resolve {"status":"approved"}\nLuego vuelve a ejecutar: mnemo export --approval-request-id {rawId}',
    expires: "Vence: {expiresAt}\n",
  },
  import: {
    usageMnemoImportFile:
      "Uso: mnemo import <file.jsonl.gz> [--from mem0|zep|claude] [--conflict-resolution skip|overwrite|newest]",
    error: "Error: {status}",
    readError: "Error al leer el archivo: {message}",
  },
  reset: {
    errorWorkspaceResetIs:
      "Error: El restablecimiento del espacio de trabajo está bloqueado en producción (NODE_ENV=production).",
    errorResetRequiresExplicit:
      "Error: El restablecimiento requiere confirmación explícita. Pasa --confirm para continuar.",
    exampleMnemoResetWorkspace: "Ejemplo: mnemo reset --workspace <workspace-id> --confirm",
    usageMnemoResetWorkspace: "Uso: mnemo reset --workspace <workspace-id> --confirm",
    safeResetCheckCompleted:
      "Comprobación de restablecimiento seguro completada para el espacio de trabajo {workspaceId}",
  },
  login: {
    serverUrlHttpLocalhost: "URL del servidor [http://localhost:3939]: ",
    apiKeyMskOr: "Clave de API (msk_... o mk_live_...): ",
    errorApiKeyIs:
      "Error: Se requiere la clave de API. Pasa --key <API_KEY> o escríbela de forma interactiva.",
    loggedInConfigSaved: "Sesión iniciada. Configuración guardada en ~/.mnemo/config.json",
  },
  printManualMcpSnippet: {
    addThisToYour: "  Agrega esto a la configuración mcpServers de Claude Desktop:",
  },
  initDocker: {
    mnemosyneDockerBootstrap: "\nMnemosyne — arranque con Docker\n",
    dockerDaemonIsNot:
      "El daemon de Docker no está en ejecución. Inicia Docker Desktop e inténtalo de nuevo.",
    installHttpsDocsDocker: "Instalación: https://docs.docker.com/get-docker/",
    dockerComposeNotFound:
      "No se encontró Docker Compose. Instala Docker Desktop: https://docs.docker.com/get-docker/",
    dockerDockerComposeYml: "No se encontró docker/docker-compose.yml.",
    mnemoInitDockerRequires: "mnemo init --docker requiere un clon del monorepo de Mnemosyne.",
    forCloudSetupMnemo: "Para la configuración en la nube: mnemo init (sin --docker)",
    foundComposeFile: "Archivo compose encontrado: {composePath}",
    portRedisIsIn: "El puerto 6379 (Redis) está en uso. Usa 6380 o escribe otro puerto: ",
    portPostgresIsIn: "El puerto 5432 (Postgres) está en uso. Usa 5433 o escribe otro puerto: ",
    portServerIsIn: "El puerto 3939 (servidor) está en uso. Usa 3940 o escribe otro puerto: ",
    mnemoLlmApiKey:
      "MNEMO_LLM_API_KEY (pulsa Enter para omitirla; la recuperación semántica quedará desactivada): ",
    warningNoLlmKey:
      "  Advertencia: no hay clave de LLM. memory_recall y memory_search devolverán 501.",
    writtenDockerEnv: "Se escribió docker/.env",
    startingPostgresAndRedis: "\nIniciando Postgres y Redis...",
    failedToStartInfra: "No se pudo iniciar la infraestructura",
    waitingForPostgresAnd: "Esperando a que Postgres y Redis estén saludables... ",
    x: "x",
    postgresDidNotBecome: "Postgres no se volvió saludable en 90 s.",
    checkPostgresLogs: "Revisa los registros: docker compose -f {composePath} logs postgres",
    ready: "listo",
    runningMigrations: "\nEjecutando las migraciones...",
    migrationsFailed: "Las migraciones fallaron",
    startingServer: "\nIniciando el servidor...",
    failedToStartServer: "No se pudo iniciar el servidor",
    waitingForServerTo: "Esperando a que el servidor esté saludable (hasta 90 s)... ",
    serverDidNotBecome: "El servidor no se volvió saludable en 90 s.",
    checkServerLogs: "Revisa los registros: docker compose -f {composePath} logs server",
    healthy: "saludable",
    keyGenerationFailedOutput: "Falló la generación de la clave. Salida:",
    stderr: "Stderr:",
    apiKeyGenerated: "Clave de API generada",
    configWrittenToMnemo: "Configuración escrita en ~/.mnemo/config.json",
    mcpServerRegisteredIn: "Servidor MCP registrado en Claude Code",
    warningContainsInvalidJson: "  Advertencia: {desktopPath} contiene JSON inválido; se omite.",
    fixTheFileManually: "  Corrige el archivo manualmente y vuelve a ejecutar mnemo init.",
    claudeDesktopConfigUpdated: "Configuración de Claude Desktop actualizada en {desktopPath}",
    windowsNotSupportedYet: "  Windows aún no es compatible. Agrégalo manualmente:",
    pullingNomicEmbedText: "Descargando nomic-embed-text (Ollama, ~274 MB, embeddings locales)... ",
    ollamaNotHealthySkipping:
      "  Ollama no está saludable; se omite la descarga de nomic-embed-text",
    toPullManuallyDocker:
      "  Para descargarlo manualmente: docker compose exec ollama ollama pull nomic-embed-text",
    mnemosyneInitializedSuccessfully: "\nMnemosyne se inicializó correctamente.",
    server: "  Servidor:      {serverUrl}",
    apiKey: "  Clave de API:  {key}",
    copyTheKeyNow: "  (Copia la clave ahora: no se volverá a mostrar)",
    restartClaudeCodeTo: "\n  Reinicia Claude Code para activar el servidor MCP.",
    mnemoWorkspacesJsonUpdated: "  -> ~/.mnemo/workspaces.json actualizado",
    workspaceMappingSavedFor: "Asignación del espacio de trabajo guardada para el proyecto",
    pullDone: "listo",
    pullSkipped: "omitido (ejecuta: docker compose exec ollama ollama pull nomic-embed-text)",
  },
  init: {
    serverUrlHttpLocalhost: "URL del servidor [http://localhost:3939]: ",
    apiKeyMnsLive: "Clave de API (mns_live_..., mk_live_... o uk_live_...): ",
    invalidFormatExpectedMns:
      "  Formato inválido. Se espera: mns_live_<20+>, mk_live_<20+> o uk_live_<20+>",
    checkingServerConnectivity: "Comprobando la conexión con el servidor... ",
    ok: "ok",
    failed: "falló",
    startTheServerFirst: "Inicia primero el servidor y luego ejecuta mnemo init de nuevo.",
    registerAUserProfile: "¿Registrar un perfil de usuario en este servidor? {yn}: ",
    email: "Correo electrónico: ",
    creatingUser: "Creando el usuario... ",
    userId: "  ID de usuario: {userId}",
    tenantId: "  ID de tenant:  {tenantId}",
    userAlreadyExists: "el usuario ya existe",
    configWrittenToMnemo: "Configuración escrita en ~/.mnemo/config.json",
    configureClaudeCodeCli: "¿Configurar la CLI de Claude Code? {yn}: ",
    mcpServerRegisteredIn: "Servidor MCP registrado en Claude Code",
    addTheMcpServer: "  Agrega el servidor MCP manualmente en la configuración de Claude Code.",
    configureClaudeDesktopY: "¿Configurar Claude Desktop? {yn}: ",
    windowsNotSupportedYet: "  Windows aún no es compatible. Agrégalo manualmente:",
    warningContainsInvalidJson:
      "  Advertencia: {desktopPath} contiene JSON inválido; se omite para no perder datos.",
    fixTheFileManually: "  Corrige el archivo manualmente y vuelve a ejecutar mnemo init.",
    claudeDesktopConfigUpdated: "Configuración de Claude Desktop actualizada en {desktopPath}",
    mnemosyneInitializedSuccessfully: "\nMnemosyne se inicializó correctamente.",
    configMnemoConfigJson: "  Configuración:    ~/.mnemo/config.json",
    server: "  Servidor:         {url}",
    userId2: "  ID de usuario:    {userId}",
    tenantId2: "  ID de tenant:     {tenantId}",
    restartClaudeCodeClaude:
      "  Reinicia Claude Code / Claude Desktop para activar el servidor MCP.",
    saveWorkspaceMappingY: "¿Guardar la asignación del espacio de trabajo? {yn}: ",
    runMemoryDoctorAfter:
      "  Ejecuta memory_doctor después de la configuración para verificar que el ID del espacio de trabajo es correcto.",
    workspaceMappingSavedFor: "Asignación del espacio de trabajo guardada para el proyecto",
    personalWorkspaceIdSaved: "ID del espacio de trabajo personal guardado",
    cannotReach: "No se pudo conectar con {url}/health/live: {message}",
    okEmail: "ok ({email})",
    skippedStatus: "omitido ({status}: {body})",
    skippedError: "omitido ({message})",
    couldNotWrite: "  Advertencia: no se pudo escribir {desktopPath}: {message}",
    summaryClaudeCode: "  Claude Code:    {state}",
    summaryClaudeDesktop: "  Claude Desktop: {state}",
  },
  link: {
    error: "Error: {status} {message}",
    errorMessage: "Error: {message}",
    errorCouldNotResolve: "Error: no se pudo resolver un workspaceId para la clave de API activa.",
    written: "  -> {configPath} escrito",
    linkedToWorkspace: "{cwd} vinculado al espacio de trabajo {workspaceId}",
    alreadyExists:
      "Error: {configPath} ya existe (workspaceId: {workspaceId}{label}). Pasa --force para sobrescribirlo.",
    labelSuffix: ", etiqueta: {label}",
  },
  workspaceList: {
    noWorkspacesFound: "No se encontraron espacios de trabajo.",
    listingWorkspaces: "Listando espacios de trabajo",
  },
  workspaceShow: {
    usageMnemoWorkspaceShow: "Uso: mnemo workspace show <workspaceId>",
    id: "ID:           {id}",
    name: "Nombre:       {name}",
    tenant: "Tenant:       {tenantId}",
    visibility: "Visibilidad:  {visibility}",
    fetchingWorkspace: "Obteniendo el espacio de trabajo",
    slug: "Slug:         {slug}",
    created: "Creado:       {createdAt}",
  },
  workspaceMembers: {
    usageMnemoWorkspaceMembers: "Uso: mnemo workspace members <workspaceId>",
    noMembersFound: "No se encontraron miembros.",
    listingWorkspaceMembers: "Listando los miembros del espacio de trabajo",
  },
  workspaceCreate: {
    usageMnemoWorkspaceCreate:
      "Uso: mnemo workspace create --name <name> [--tenant <tenantId>] [--slug <slug>] [--visibility private|public]",
    errorTenantWasNot:
      "Error: no se indicó --tenant y la clave o el token actual no tiene un tenant asociado.",
    workspaceCreated: "Espacio de trabajo creado",
    tenant: "{id} ({name}, tenant {tenantId})",
  },
  workspaceInvite: {
    usageMnemoWorkspaceInvite:
      "Uso: mnemo workspace invite <workspaceId> <userId> [--role owner|admin|write|read]",
    added: "{userId} se agregó al espacio de trabajo {workspaceId}{asRole}",
    asRole: " como {role}",
  },
  workspaceSetRole: {
    usageMnemoWorkspaceSet:
      "Uso: mnemo workspace set-role <workspaceId> <userId> <owner|admin|write|read>",
    sRoleInWorkspace:
      "El rol de {userId} en el espacio de trabajo {workspaceId} se cambió a {role}",
  },
  workspaceRemove: {
    usageMnemoWorkspaceRemove: "Uso: mnemo workspace remove <workspaceId> <userId>",
    removedFromWorkspace: "{userId} se quitó del espacio de trabajo {workspaceId}",
  },
  decide: {
    kindDecisionArchitecturePolicy:
      "  kind: decision|architecture|policy|process|bugfix|learning|discovery|config",
  },
  entity: {
    kindPersonOrganizationProject: "  kind: person|organization|project|concept|place|other",
  },
  relate: {
    usageMnemoRelateHistory: "Uso: mnemo relate history <sourceKind> <id> [--max-depth N]",
    sourcekindFactDecisionEntity: "  sourceKind: fact|decision|entity|episode",
    walksTheSupersedesDerived:
      "  Recorre la cadena supersedes/derived_from desde <id>; úsalo para ver qué reemplazó un hecho o una decisión, no para explorar el grafo en general.",
    usageMnemoRelateSourcekind:
      "Uso: mnemo relate <sourceKind> <sourceId> <verb> <targetKind> <targetId> [--reason r] [--confidence c] [--marked-by-kind user|agent|system|llm_judge]",
    sourcekindTargetkindFactDecision: "  sourceKind/targetKind: fact|decision|entity|episode",
    mnemoRelateListJudgment:
      "  mnemo relate list [--judgment-status pending|judged|dismissed] [--limit N]",
    mnemoRelateHistorySourcekind: "  mnemo relate history <sourceKind> <id> [--max-depth N]",
    listingRelations: "Listando relaciones",
    walkingRelationHistory: "Recorriendo el historial de relaciones",
    relationCreated: "Relación creada",
    verbHint: "  verb: {verbs}",
    unknownVerb: "Error: verbo de relación desconocido '{verb}'. Verbos válidos: {verbs}",
  },
  strategy: {
    usageMnemoStrategyCreate:
      "Uso: mnemo strategy create --trigger <t> --action <a> [--context c] [--scope-ref sr]",
    usageMnemoStrategyShow: "Uso: mnemo strategy show <id>",
    usageMnemoStrategyUpdate:
      "Uso: mnemo strategy update <id> [--trigger t] [--action a] [--context c] [--status active|superseded|archived]",
    usageMnemoStrategyArchive: "Uso: mnemo strategy archive <id>",
    usageMnemoStrategyRate: "Uso: mnemo strategy rate <id> <success|failure>",
    unknownStrategySubcommandUse:
      "Subcomando de strategy desconocido '{subCmd}'. Usa: create, list, show <id>, update <id>, archive <id>, rate <id> <success|failure>",
    strategyCreated: "Estrategia creada",
    listingStrategies: "Listando estrategias",
    fetchingStrategy: "Obteniendo la estrategia",
    strategyUpdated: "Estrategia actualizada",
    archived: "Archivada",
    strategyRated: "Estrategia calificada como {outcome}",
  },
  workflow: {
    usageMnemoWorkflowCreate:
      "Uso: mnemo workflow create --name <n> --steps '<json array>' [--description d] [--scope-ref sr]",
    stepsAJsonArray:
      '  --steps: un arreglo JSON de cadenas simples (p. ej. \'["step 1","step 2"]\') o de',
    actionExpecteddurationmsConditionTools:
      "  objetos {action, expectedDurationMs?, condition?, tools?} para tener control total.",
    errorStepsMustBe:
      'Error: --steps debe ser un arreglo JSON: cadenas simples (\'["step 1","step 2"]\') u objetos {action, ...}',
    errorStepMustHave: 'Error: el paso {i} debe tener una cadena "action" no vacía',
    errorStepMustBe: "Error: el paso {i} debe ser una cadena o un objeto {action, ...}",
    usageMnemoWorkflowShow: "Uso: mnemo workflow show <id>",
    unknownWorkflowSubcommandUse:
      "Subcomando de workflow desconocido '{subCmd}'. Usa: create, list, show <id>",
    workflowCreated: "Flujo de trabajo creado",
    listingWorkflows: "Listando flujos de trabajo",
    fetchingWorkflow: "Obteniendo el flujo de trabajo",
  },
  skill: {
    usageMnemoSkillCreate:
      "Uso: mnemo skill create --name <n> --prompt <p> [--variables v1,v2] [--required-context c1,c2] [--sensitivity public|internal|confidential|restricted]",
    usageMnemoSkillShow: "Uso: mnemo skill show <id>",
    unknownSkillSubcommandUse:
      "Subcomando de skill desconocido '{subCmd}'. Usa: create, list, show <id>",
    skillCreated: "Habilidad creada",
    listingSkills: "Listando habilidades",
    fetchingSkill: "Obteniendo la habilidad",
  },
  reasoning: {
    errorChainIsRequired:
      'Error: --chain es obligatorio, p. ej. --chain \'[{"step":1,"reasoning":"..."}]\'',
    errorChainMustBe:
      "Error: --chain debe ser un arreglo JSON de objetos {step, reasoning, conclusion?}",
    usageMnemoReasoningCreate:
      "Uso: mnemo reasoning create --question <q> --conclusion <c> --chain '<json array>' [--topic-key tk]",
    chainItemShapeStep:
      '  forma de un elemento de la cadena: {"step":1,"reasoning":"...","conclusion":"..."}',
    usageMnemoReasoningShow: "Uso: mnemo reasoning show <id>",
    usageMnemoReasoningArchive: "Uso: mnemo reasoning archive <id>",
    usageMnemoReasoningResolve: "Uso: mnemo reasoning resolve <query>",
    usageMnemoReasoningRecord:
      "Uso: mnemo reasoning record --question <q> --conclusion <c> --chain '<json array>' [--outcome success|fail]",
    usageMnemoReasoningFeedback: "Uso: mnemo reasoning feedback <id> <success|fail>",
    unknownReasoningSubcommandUse:
      "Subcomando de reasoning desconocido '{subCmd}'. Usa: create, list, show <id>, archive <id>, resolve <query>, record, feedback <id> <success|fail>",
    reasoningRecorded: "Razonamiento registrado",
    listingReasoning: "Listando razonamientos",
    fetchingReasoning: "Obteniendo el razonamiento",
    archived: "Archivado",
    resolvingReasoning: "Resolviendo el razonamiento",
    reasoningLogged: "Razonamiento registrado",
    reasoningFeedbackRecorded: "Opinión sobre el razonamiento registrada: {outcome}",
  },
  hyperedge: {
    usageMnemoHyperedgeCreate:
      "Uso: mnemo hyperedge create --members id1,id2,id3 [--label l] [--description d] [--context-query q]",
    requiresAtLeastMember: "  Requiere al menos 3 ID de miembros.",
    usageMnemoHyperedgeShow: "Uso: mnemo hyperedge show <id>",
    usageMnemoHyperedgeUpdate:
      "Uso: mnemo hyperedge update <id> [--label l] [--description d] [--context-query q]",
    usageMnemoHyperedgeArchive: "Uso: mnemo hyperedge archive <id>",
    unknownHyperedgeSubcommandUse:
      "Subcomando de hyperedge desconocido '{subCmd}'. Usa: create, list, show <id>, update <id>, archive <id>",
    hyperedgeCreated: "Hiperarista creada",
    listingHyperedges: "Listando hiperaristas",
    fetchingHyperedge: "Obteniendo la hiperarista",
    hyperedgeUpdated: "Hiperarista actualizada",
    archived: "Archivada",
  },
  eventsExtended: {
    usageMnemoEventsCreate:
      "Uso: mnemo events create --type <t> --name <n> --description <d> --source <s> [--occurred-at iso]",
    typeSystemExternalUser: "  type: system|external|user|agent|scheduled",
    usageMnemoEventsShow: "Uso: mnemo events show <id>",
    usageMnemoEventsArchive: "Uso: mnemo events archive <id>",
    raiseOnlyTheServer:
      "  Solo se puede subir: el servidor responde 422 si intentas bajar el nivel.",
    eventRecorded: "Evento registrado",
    fetchingEvent: "Obteniendo el evento",
    archived: "Archivado",
    sensitivityUsage: "Uso: mnemo events sensitivity <id> <{tiers}>",
  },
  tasksExtended: {
    usageMnemoTasksCreate:
      "Uso: mnemo tasks create --title <t> --assigned-to <agent> [--description d] [--priority critical|high|medium|low] [--due-at iso]",
    usageMnemoTasksShow: "Uso: mnemo tasks show <id>",
    usageMnemoTasksUpdate:
      "Uso: mnemo tasks update <id> [--status s] [--outcome o] [--lessons-learned l]",
    usageMnemoTasksDelegate: "Uso: mnemo tasks delegate <id> --to <agent>",
    taskCreated: "Tarea creada",
    fetchingTask: "Obteniendo la tarea",
    taskUpdated: "Tarea actualizada",
    taskDelegatedTo: "Tarea delegada a {assignedTo}",
  },
  judge: {
    mergedStatementIsRequired: "  --merged-statement es obligatorio cuando la acción es 'merge'.",
    usageMnemoJudgeResolve: "Uso: mnemo judge resolve <relationId> merge --merged-statement <s>",
    mergeRequiresMergedStatement:
      "  merge requiere --merged-statement: el enunciado unificado corregido.",
    conflictResolved: "Conflicto resuelto: {action}",
    listingConflicts: "Listando conflictos",
    resolveUsage: "Uso: mnemo judge resolve <relationId> <{actions}> [--merged-statement s]",
  },
  purge: {
    errorPurgeIsA:
      "Error: purge es una eliminación definitiva e irreversible. Pasa --confirm para continuar.",
    usageMnemoPurgeFactid: "Uso: mnemo purge <factId> --confirm",
    mnemoPurgeAllClosed: "     mnemo purge --all-closed --confirm",
    purgedClosedFactS: "Se purgaron {deleted} hecho(s) cerrado(s).",
    purged: "Purgado",
  },
  erase: {
    usage: "Uso: mnemo erase --user <userId> --confirm <userId>",
    usageActor: "     mnemo erase --actor <actorId> --confirm <actorId>",
    erased: "Borrado: se destruyeron {keys} clave(s) de cifrado",
  },
  remind: {
    usageMnemoRemindCreate:
      "Uso: mnemo remind create --content <c> [--condition c] [--trigger-at iso]",
    atLeastOneOf: "  Se requiere al menos una de --condition o --trigger-at.",
    errorAtLeastOne: "Error: se requiere al menos una de --condition o --trigger-at.",
    usageMnemoRemindDismiss: "Uso: mnemo remind dismiss <id>",
    unknownRemindSubcommandUse:
      "Subcomando de remind desconocido '{subCmd}'. Usa: create, list, dismiss <id>",
    reminderCreated: "Recordatorio creado",
    listingReminders: "Listando recordatorios",
    dismissed: "Descartado",
  },
  install: {
    noApiKeyFound:
      "❌ No se encontró la clave de API. Ejecuta: mnemo init  O  define la variable de entorno MNEMO_KEY.",
    error: "Error: {error}",
    noAiCodingAgents: "No se detectaron agentes de programación con IA en esta máquina.",
    supportedClaudeCodeCursor:
      "Compatibles: Claude Code, Cursor, OpenCode, Codex, Gemini CLI, Windsurf",
    installingFor: "Instalando para {agentName}...",
    mcpRegisteredViaClaude: "  ✅ MCP registrado con claude mcp add",
    claudeMcpAddFailed: "  ❌ No se pudo registrar el servidor MCP con `claude mcp add`: {reason}",
    claudeMcpStagedKept:
      "{reason} (la entrada nueva sigue registrada como `{name}`, así que Claude Code conserva un servidor de Mnemosyne que funciona)",
    mcpHandshakeVerifiedInitialize:
      "  ✅ Handshake de MCP verificado (initialize devolvió instrucciones)",
    theServerWasRegistered:
      "    El servidor se registró, pero no se pudo verificar de forma independiente.",
    pluginHooksInstalledLocal:
      "  ✅ Hooks del plugin instalados (modo de desarrollo local), habilitados y verificados",
    pluginHooksWereInstalled:
      "  ❌ Los hooks del plugin se instalaron, pero no pasaron la verificación:",
    pluginInstallFailed: "  ❌ Falló la instalación del plugin:",
    pluginRegisteredViaClaude: "  ✅ Plugin registrado con claude plugin marketplace/install",
    pluginHooksInstalledEnabled:
      "  ✅ Hooks del plugin instalados, habilitados y verificados (session-start, user-prompt-submit, etc.)",
    hooksWereCopiedAnd:
      "    Los hooks se copiaron y registraron, pero la comprobación anterior falló; corrige lo anterior antes de depender de la captura automática de memoria.",
    mcpConfiguredInCursor: "  ✅ MCP configurado en ~/.cursor/mcp.json",
    hooksInstalledInCursor:
      "  ✅ hooks instalados en ~/.cursor/hooks.json (sessionStart → inyección de contexto, sessionEnd → colapso de episodios)",
    agentsMdInstalled: "  ✅ AGENTS.md instalado",
    mcpConfiguredInConfig: "  ✅ MCP configurado en ~/.config/opencode/opencode.json",
    geminiMdGeminiExtension: "  ✅ GEMINI.md + gemini-extension.json instalados",
    pluginDirNotFound:
      "  ⚠ No se encontró el directorio del plugin; copia packages/plugin/GEMINI.md manualmente",
    mcpConfiguredInCodex: "  ✅ MCP configurado en ~/.codex/config.toml",
    codexConfigRepaired:
      "  ✅ Se quitó la línea suelta que un 'mnemo install' anterior había dejado en ~/.codex/config.toml",
    codexConfigNotUpdated: "  ❌ Codex: {path} no se modificó — {reason}",
    codexInvalidToml:
      "no es TOML válido (línea {line}, columna {column}: {message}). Corrige el archivo y vuelve a ejecutar 'mnemo install'.",
    codexEntryNotEditable:
      "su entrada MCP de mnemosyne está escrita de una forma que no se puede reemplazar sin reescribir el resto del archivo (una tabla en línea, una clave con puntos o un valor de varias líneas). Quita esa entrada y vuelve a ejecutar 'mnemo install'.",
    mcpConfiguredInCodeium: "  ✅ MCP configurado en ~/.codeium/windsurf/mcp_config.json",
    manualConfigRequiredSee:
      "  ℹ Se requiere configuración manual; consulta packages/plugin/README.md",
    workspaceMappingSavedFor:
      "\n✅ Asignación del espacio de trabajo guardada para el proyecto: {projectName} ({resolvedWorkspaceId})",
    mnemosyneInstallCompletedWith:
      "\n⚠ La instalación de Mnemosyne terminó con fallas; consulta los mensajes de cada agente más arriba.",
    mnemosyneInstalledForAll: "\n✅ Mnemosyne se instaló para todos los agentes detectados.",
    restartYourAiAgents: "   Reinicia tus agentes de IA para activar el servidor MCP y los hooks.",
    captureWasNotFully:
      "\n⚠ La captura NO se configuró por completo; consulta la sección Captura más arriba.",
    hintAuth:
      "Es posible que el repositorio '{repo}' sea privado o no esté accesible para tu cuenta actual de GitHub. Autentícate con 'gh auth login' o con SSH, o usa 'mnemo install --local'.",
    hintNetwork: "Es posible que la red o GitHub no estén disponibles en este momento.",
    hintGitMissing: "Es posible que 'git' no esté instalado en esta máquina.",
    hintUnknown: "Falla no reconocida; la salida original se incluye más abajo.",
    preflightNoClaude:
      "⚠ Se detectó claude-code, pero la CLI 'claude' no está en el PATH; se omite.\n    Instálala (https://docs.claude.com/en/docs/claude-code/setup), reabre tu shell y vuelve a ejecutar 'mnemo install'.\n    La instalación solo de configuración no está disponible: el registro del plugin requiere la CLI.",
    fatalFooter:
      "    Alternativa manual:\n      claude plugin marketplace add {repo}\n      claude plugin install {pluginId}\n    O ejecuta 'mnemo install --local' para instalar desde tu árbol de trabajo local.",
    failureDetails: "    Detalles:\n{output}",
    noPluginEntry:
      "    'claude plugin install' terminó con código 0, pero no se encontró en installed_plugins.json una entrada válida de mnemosyne@mnemosyne (con gitCommitSha).",
    localInstalling:
      "  ⚠ --local: instalando desde el árbol de trabajo ({pluginDir}). Es una instalación de desarrollo: no está bajo control de git, no tiene gitCommitSha y Claude Code nunca la actualizará. Un 'mnemo install' posterior (sin la opción) la reemplaza con el plugin publicado.",
    localDone:
      "  ⚠ --local: instalación de desarrollo completa; no está bajo control de git ni tiene gitCommitSha; un 'mnemo install' posterior (sin la opción) la reemplazará con el plugin publicado.",
    existingFileKept:
      "  ⚠ {path} ya existe y no es de Mnemosyne; se dejó como estaba. Combina las instrucciones de Mnemosyne manualmente si hace falta.",
    symlinkSkipped:
      "  ⚠ {path} es un enlace simbólico; se omitió para no sobrescribir su destino. Combina la configuración de Mnemosyne manualmente si hace falta.",
    verify: {
      noScriptsDir: "no se encontró el directorio de scripts en {scriptsDir}",
      notExecutable: "{file}: no es ejecutable (modo {mode})",
      cannotStat: "{file}: no se pudo consultar ({message})",
      failedToExecute: "{file}: no se pudo ejecutar ({message})",
      exitedDetail: " — {stderr}",
      syntaxError: "{file}: error de sintaxis{detail}",
      toolMissing:
        "{tool}: no está en el PATH. Todos los hooks de Mnemosyne lo usan; sin él se ejecutan y no capturan nada. Instala {tool} y vuelve a ejecutar 'mnemo install'.",
    },
    handshake: {
      spawnFailed: "No se pudo iniciar el proceso MCP: {message}",
      timeout: "El servidor MCP no respondió a initialize dentro del tiempo límite",
      noInstructions: "la respuesta de initialize no tiene un campo instructions con contenido",
      processError: "Error del proceso MCP: {message}",
    },
    detectedAgents: "\nAgentes detectados: {agents}\n",
    handshakeFailed: "  ⚠ Falló la comprobación del handshake de MCP: {message}",
    localDirMissing:
      "  ⚠ Se pidió --local, pero no se encontró el directorio del plugin; se omitieron los hooks y las habilidades del plugin.",
    agentFailed: "  ⚠ {agentName}: {message}",
    workspaceUnresolved:
      "\n⚠ No se pudo resolver el ID del espacio de trabajo desde {url}/me; workspaces.json quedó sin cambios.\n  Vuelve a ejecutar 'mnemo install' cuando el servidor esté disponible, o configúralo a mano.",
  },
  tasks: {
    listingTasks: "Listando tareas",
  },
  events: {
    listingEvents: "Listando eventos",
  },
  consolidate: {
    consolidationTriggered: "Consolidación iniciada",
  },
  setup: {
    banner: {
      title: "ASISTENTE DE CONFIGURACIÓN DE MNEMOSYNE",
      open: "Ábrelo en tu navegador para crear tu espacio de trabajo:",
      expires: "El token vence en 15 minutos.",
    },
  },
  common: {
    missingFromResponse: "(falta en la respuesta)",
    none: "(ninguno)",
    unknown: "(desconocido)",
    unknownWord: "desconocido",
    never: "nunca",
    revokedUpper: "REVOCADA",
    activeUpper: "ACTIVA",
    configured: "configurado",
    skipped: "omitido",
    unknownError: "error desconocido",
    noneWord: "ninguno",
  },
  workspaceTable: {
    id: "ID",
    name: "Nombre",
    role: "Rol",
    visibility: "Visibilidad",
    userId: "ID de usuario",
    joinedAt: "Se unió",
  },
  completion: {
    usage: "Uso: mnemo completion <shell>\nShells compatibles: {shells}",
    unknownShell: "Shell desconocido '{shell}'. Shells compatibles: {shells}",
  },
  info: {
    server: "{BOLD}Servidor             {RESET}{url}  {statusColor}{status}{RESET}",
    workspace: "{BOLD}Espacio de trabajo   {RESET}{CYAN}{workspaceId}{RESET}",
    key: "{BOLD}Clave                {RESET}{keyId}",
    actorType: "{BOLD}Tipo de actor        {RESET}{actorType}",
    user: "{BOLD}Usuario              {RESET}{userId}",
    tenant: "{BOLD}Tenant               {RESET}{tenantId}",
    plan: "{BOLD}Plan                 {RESET}{plan}",
    scopes: "{BOLD}Permisos             {RESET}{scopes}",
    expires: "{BOLD}Vence                {RESET}{expiresAt}",
    hitRate: "{BOLD}Aciertos a 30 días   {RESET}{rate}%",
    active: " {GREEN}← activo{RESET}",
    fetchingSessionInfo: "Obteniendo la información de la sesión",
    mnemosyneSessionInfo: "\n{BOLD}Mnemosyne — información de la sesión{RESET}",
    factsLivePinnedClosed:
      "{BOLD}Hechos               {RESET}{live} vigentes  /  {pinned} fijados  /  {closed} cerrados",
    lastRecall: "{BOLD}Última recuperación  {RESET}{lastRecallAt}",
    availableWorkspaces: "{BOLD}Espacios de trabajo disponibles{RESET} ({length})",
  },
  doctor: {
    overall: "\nDiagnóstico de Mnemosyne — estado general: {status}\n",
    runningDiagnostics: "Ejecutando el diagnóstico",
  },
  tenant: {
    created: "Creado: {createdAt}",
    usageMnemoTenantCreate:
      "Uso: mnemo tenant create --name <name> [--kind personal|organization] [--plan <plan>] [--owner-token [--workspace-name <name>]]",
    tenantCreated: "Tenant creado",
    ownerToken: "Token del propietario (se muestra una sola vez; guárdalo ahora): {key}",
    ownerTokenWhere:
      "Actúa en el tenant {tenantId}, espacio de trabajo {workspaceId}: úsalo como clave de API de ese tenant.",
    noOwnerToken:
      "Tu clave actual sigue actuando en su propio tenant y no puede administrar este. Crea el tenant con --owner-token para obtener también un token que sí pueda.",
    usageMnemoTenantShow: "Uso: mnemo tenant show <tenantId>",
    fetchingTenant: "Obteniendo el tenant",
    usageMnemoTenantMembers: "Uso: mnemo tenant members <tenantId>",
    listingTenantMembers: "Listando los miembros del tenant",
    noMembersFound: "No se encontraron miembros.",
    usageMnemoTenantInvite:
      "Uso: mnemo tenant invite <tenantId> <email> [--role owner|admin|member] [--create-if-missing]",
    usageMnemoTenantRemove: "Uso: mnemo tenant remove <tenantId> <userId>",
    removedFromTenant: "{userId} se quitó del tenant {tenantId}",
    usageMnemoTenantWorkspaces: "Uso: mnemo tenant workspaces <tenantId>",
    listingTenantWorkspaces: "Listando los espacios de trabajo del tenant",
    noWorkspacesFound: "No se encontraron espacios de trabajo.",
    members: "{id}  {name}  ({visibility}, {memberCount} miembros)",
    unknownTenantSubcommandUse:
      "Subcomando de tenant desconocido '{subCmd}'. Usa: create, show <id>, members <id>, invite <id> <email>, remove <id> <userId>, workspaces <id>",
    idLine: "ID:      {id}",
    nameLine: "Nombre:  {name}",
    kindLine: "Tipo:    {kind}",
    planLine: "Plan:    {plan}",
    invited: "{email} fue invitado al tenant {tenantId}{asRole}",
    asRole: " como {role}",
  },
  token: {
    scopes: "  Permisos:            {scopes}",
    expires: "  Vence:               {expires}\n",
    row: "{id}  {status}  {label}  [{scopes}]  espacio de trabajo: {workspaceId}  vence: {expires}",
    usageMnemoTokenIssue:
      "Uso: mnemo token issue <tenantId> <userId> --label <label> --workspace <homeWorkspaceId> [--scopes <a,b,c>] [--expires <90d>] [--test]",
    errorLabelAndWorkspace: "Error: --label y --workspace son obligatorios.",
    mTokenMintedCopy:
      "\n\u001b[32m✓ Token emitido: cópialo ahora, no se volverá a mostrar:\u001b[0m\n",
    usageMnemoTokenList: "Uso: mnemo token list <tenantId> <userId>",
    listingTokens: "Listando tokens",
    noTokensFound: "No se encontraron tokens.",
    usageMnemoTokenRevoke: "Uso: mnemo token revoke <tenantId> <userId> <keyId>",
    tokenRevokedAt: "Token {keyId} revocado el {revokedAt}",
    unknownTokenSubcommandUse:
      "Subcomando de token desconocido '{subCmd}'. Usa: issue, list, revoke",
    idLine: "  ID:                  {id}",
    userLine: "  Usuario:             {userId}",
    workspaceLine: "  Espacio de trabajo:  {workspaceId}",
    tokenLine: "  Token:               {key}",
  },
  policy: {
    listing: "Listando las políticas de agente",
    noPolicies: "No hay políticas de agente en este espacio de trabajo.",
    fetching: "Obteniendo la política del agente",
    saved: "Política guardada para el agente {agentId}",
    deleted: "Política borrada para el agente {agentId}",
    usageGet: "Uso: mnemo policy get <agentId>",
    usageSet: "Uso: mnemo policy set <agentId> --file <policy.json>",
    usageDelete: "Uso: mnemo policy delete <agentId>",
    badFile: "Error: no se pudo leer un objeto JSON de {file}: {message}",
    unknownSubcommand: "Subcomando de policy desconocido '{subCmd}'. Usa: list, get, set, delete",
  },
  keys: {
    row: "{id}  {status}  {label}  [{scopes}]  creada: {created}  vence: {expiry}{ceiling}",
    ceiling: "  tope: {value}",
    invalidSensitivity: 'Error: --max-sensitivity debe ser uno de: {valid}. Se recibió: "{got}"',
    createScopes: "  Permisos:                {scopes}",
    createExpires: "  Vence:                   {expires}",
    createMaxSensitivity: "  Sensibilidad máxima:     {value}\n",
    showLabel: "Etiqueta:                  {label}",
    showScopes: "Permisos:                  {scopes}",
    showIpAllowlist: "Lista de IP permitidas:    {value}",
    unrestricted: "(sin restricciones)",
    showExpires: "Vence:                     {expires}",
    showLastUsed: "Último uso:                {lastUsed}",
    showMaxSensitivity: "Sensibilidad máxima:       {value}",
    rotateWarning: "Advertencia: guarda esta clave; no se mostrará otra vez",
    listingKeys: "Listando claves de API",
    noKeysFound: "No se encontraron claves de API.",
    mKeyCreatedCopy:
      "\n\u001b[32m✓ Clave de API creada: cópiala ahora, no se volverá a mostrar:\u001b[0m\n",
    usageMnemoKeysRevoke: "Uso: mnemo keys revoke <keyId>",
    keyRevokedAt: "Clave de API {keyId} revocada el {revokedAt}",
    usageMnemoKeysShow: "Uso: mnemo keys show <keyId>",
    fetchingKey: "Obteniendo la clave de API",
    usageMnemoKeysRotate: "Uso: mnemo keys rotate <keyId>",
    newKey: "Clave nueva:                  {newKey}",
    newKeyId: "ID de la clave nueva:         {newKeyId}",
    oldKeyValidUntil: "Clave anterior válida hasta:  {oldKeySunsetAt}",
    theOldKeyWill:
      "\nLa clave anterior seguirá funcionando hasta la fecha de cierre indicada arriba.",
    updateYourConfigurationWith: "Actualiza tu configuración con la clave nueva de inmediato.\n",
    unknownKeysSubcommandUse:
      "Subcomando de keys desconocido '{subCmd}'. Usa: list, create, revoke, show, rotate, scoped",
    usageScoped:
      "Uso: mnemo keys scoped create --scopes <s1,s2> [--type live|sess|admin] [--expires 8h] [--ip-allowlist <cidr>] [--max-sensitivity <nivel>]\n     mnemo keys scoped rotate <id> [motivo]\n     mnemo keys scoped revoke <id>",
    scopedMfaSecret:
      "  Secreto TOTP:            {secret}\n  Agrégalo ahora a una app de autenticación: no se mostrará otra vez. Envía cada código en x-mnemo-mfa.",
    scopedOtpauth: "  URI otpauth:             {uri}\n",
    createId: "  ID:                      {id}",
    showId: "ID:                        {id}",
    createKey: "  Clave:                   {key}",
    createLabel: "  Etiqueta:                {label}",
    createPlan: "  Plan:                    {plan}",
    showRevoked: "Revocada:                  {revokedAt}",
    showDeprecated: "Obsoleta:                  {deprecatedAt}",
    showRotatedFrom: "Rotada desde:              {rotatedFromId}",
    showCreated: "Creada:                    {createdAt}",
  },
  workspace: {
    unknownWorkspaceSubcommandUse:
      "Subcomando de workspace desconocido '{subCmd}'. Usa: list, show <id>, members <id>, create, invite, set-role, remove",
  },
  user: {
    usageMnemoUserCreate: "Uso: mnemo user create --email <email> [--display-name <name>]",
    userCreated: "Usuario creado",
    unknownUserSubcommandUse: "Subcomando de user desconocido '{subCmd}'. Usa: create",
    personalTenantLine: "  Tenant personal:              {id}",
    personalWorkspaceLine: "  Espacio de trabajo personal:  {id}",
  },
  harness: {
    queuePendingBytes: "cola:         {count} pendientes, {bytes} bytes",
    deadLetters: "fallidos:      {deadLetters}",
    filesystem: "archivos:      {mode}",
    queueIsEmptyPending: "la cola está vacía (0 pendientes, 0 en cuarentena)",
    pendingSeqB: "  pendiente  {eventId}  seq={enqueueSequence}  {type}  {bytes} B  {occurredAt}",
    deadB: "  fallido    {id}  {bytes} B",
    refusingToRetryThe:
      "no se reintenta: el vínculo de la cola ya no coincide con esta configuración",
    releasedQueuedRecordS: "se liberaron {released} registro(s) en cola para entregarlos",
    discardRequiresReasonWhy: "discard requiere --reason <motivo>",
    permanentlyDiscardTheQueued: "¿Descartar de forma permanente la captura en cola?",
    discardCancelled: "descarte cancelado",
    discardedRecordS: "se descartaron {discarded} registro(s)",
    harnessOk: "harness: ok",
    problem: "problema: {problem}",
    probePersistedStateThis:
      "la sonda persistió estado; es un error y no se puede confiar en el resultado",
    serverIsNotAccepting:
      "el servidor no acepta la captura de harness para el espacio de trabajo {workspaceId}",
    serverAvailableForWorkspace: "servidor disponible para el espacio de trabajo {workspaceId}",
    captured: "capturado",
    unknownHarnessCommand: "comando de harness desconocido: {subcommand}",
    oldest: "más antiguo:  {age} s",
    delivery: "entrega:      intento {attempt}{next}{blocked}",
    deliveryNext: ", siguiente {nextAttemptAt}",
    deliveryBlocked: ", BLOQUEADA ({status})",
    binding: "vínculo:      {serverUrl} espacio de trabajo {workspaceId}",
    bindingNone: "vínculo:      ninguno",
    capture: "captura:      {state}",
    fullFidelity: "fidelidad completa",
    incomplete: "INCOMPLETA",
    hostCapture: "  {host}: {mode} — {reason}",
    unknownQueueSubcommand: "subcomando de queue desconocido: {sub}",
    queueCounts: "{pending} pendientes, {quarantined} en cuarentena",
    help: "mnemo harness <command>\n\n  queue list              Muestra los registros en cola y en cuarentena (solo metadatos)\n  retry                   Libera una cola bloqueada o en espera para entregarla\n  discard --reason <why>  Descarta la cola de forma permanente (pregunta, salvo con --yes)\n  doctor                  Diagnostica la cola de captura local\n  probe                   Comprueba el servidor vinculado, sin persistir nada\n  hook                    Punto de entrada de captura del host (siempre termina con 0)\n\nCómo revertir la captura, en este orden:\n  disable <host>          Detiene la captura de este host; la cola conserva su destino\n  drain                   Entrega los eventos en cola hasta llegar a cero\n  quiesce                 Aísla el servidor; espera cero concesiones y escrituras en curso\n  uninstall <host>        Elimina los artefactos propios de Mnemosyne (requiere los pasos anteriores)\n",
    disableRequiresAHost: "disable requiere el nombre de un host",
    couldNotDisableCapture: "no se pudo desactivar la captura de {host}",
    captureDisabledFor: "captura desactivada para {host}",
    serverIngestionIsStill:
      "la ingesta del servidor sigue disponible, así que la cola aún se puede vaciar",
    deliveredQueuedRecordS: "se entregaron {delivered} registro(s) en cola",
    drainIncompleteRecordS: "vaciado incompleto: quedan {remaining} registro(s)",
    queueDrainedRemaining: "cola vaciada: 0 restantes",
    notQuiescedLiveLease:
      "no está aislado: {liveLeases} concesión(es) activa(s), {inFlight} escritura(s) en curso",
    workspaceQuiescedLeasesWrites:
      "espacio de trabajo aislado: 0 concesiones, 0 escrituras en curso",
    uninstallRequiresAHost: "uninstall requiere el nombre de un host",
    isStillCapturingRun: '{host} sigue capturando; primero ejecuta "mnemo harness disable {host}"',
    permanentlyDiscardQueuedRecord:
      "¿Descartar de forma permanente {queued} registro(s) en cola de {host}?",
    uninstallCancelled: "desinstalación cancelada",
    discardingQueuedRecordS: "descartando {queued} registro(s) en cola",
    removed: "eliminado: {artifact}",
    pluginPathIsEmpty: "la ruta del plugin está vacía o tiene espacios",
    configUnreadable: "no se pudo leer la configuración",
    configNotObject: "la configuración no es un objeto",
    pluginKeyNotList: "la clave plugin de la configuración no es una lista",
    mergedConfigUnparsable: "la configuración combinada no se podría volver a analizar",
    mergedConfigLacksPlugin: "la configuración combinada no contiene el plugin",
    mergedConfigWouldChange: "la configuración combinada cambiaría una clave ajena: {key}",
    configReplaceFailed: "no se pudo reemplazar la configuración de forma atómica{detail}",
    stillQueued:
      '{queued} registro(s) siguen en cola; ejecuta "mnemo harness drain" o pasa --discard-queued para descartarlos',
    preserved: "conservado (no es nuestro): {artifacts}",
    quiescenceNeeded:
      'el reposo del servidor aún requiere una acción del operador: ejecuta "mnemo harness quiesce" antes de revertir el servidor',
    lifecycleHelp:
      "mnemo harness <command>\n\n  disable <host>     Detiene la captura de este host. Los eventos en cola conservan su destino.\n  drain              Entrega los eventos en cola hasta llegar a cero.\n  quiesce            Aísla el servidor y espera cero concesiones y escrituras en curso.\n  uninstall <host>   Elimina los artefactos propios de Mnemosyne. Requiere los pasos anteriores.\n",
    configMalformed: "la configuración está mal formada: {code}",
    configIsASymlink: "la configuración es un enlace simbólico",
    configNotRegularFile: "la configuración no es un archivo normal",
  },
  capture: {
    codexHooksDoNot: "Los hooks de Codex no existen en Windows; MCP sigue disponible",
    featuresHooksIsNot:
      "features.hooks no está habilitado en config.toml (está desactivado por defecto)",
    pluginPayloadMissing: "no se pudo localizar el contenido del plugin de esta compilación",
    noOpencodeJsonTo: "no hay un opencode.json al cual agregar el plugin",
    noClaudeHookManifest: "esta compilación no incluye un manifiesto de hooks de Claude Code",
    theClaudeCodePlugin:
      "el plugin de Claude Code no está instalado; primero ejecuta 'mnemo install' para ese host",
    captureWouldBeLimited:
      "{host}: la captura se limitaría a {mode} — {reason}. ¿Instalar de todos modos?",
    enableItNow: "{host}: {gateReason} ¿Habilitarlo ahora?",
    couldNotDetect: "no se pudo detectar {host}: {error}",
    runMnemoInstallCapture: "ejecuta 'mnemo install --capture {host}' para reconsiderarlo",
    noWayToAsk:
      "{host}: no hay forma de pedir consentimiento; pasa --accept-degraded para responder por adelantado",
    gateEnableFailed: "{host}: no se pudo habilitar el interruptor del host: {reason}",
    restartForCaptureTo: "reinicia {host} para que comience la captura",
    configUnreadable: "no se pudo leer la configuración",
    configIsMalformed: "la configuración está mal formada: {reason}",
    mergedConfigUnparsable: "la configuración combinada no se podría volver a analizar",
    mergedConfigLacksHooks: "la configuración combinada no habilita features.hooks",
    mergedConfigWouldChange: "la configuración combinada cambiaría algo distinto de features.hooks",
    configReplaceFailed: "no se pudo reemplazar la configuración de forma atómica{detail}",
    noFeatureGate: "este host no tiene un interruptor de funciones",
    configTomlUnparsable: "no se pudo analizar config.toml: {reason}",
    featuresHooksIsEnabled: "features.hooks está habilitado",
    noCodexPluginPayload: "esta compilación no incluye el contenido del plugin de Codex",
    noHookScripts: "esta compilación no incluye scripts de hooks",
    noFeatureGateToEnable: "este host no tiene un interruptor de funciones que habilitar",
    configTomlNotTable: "config.toml no es una tabla TOML",
    configDeclaresFeaturesMore:
      "la configuración declara [features] más de una vez; define hooks = true a mano",
    configAssignsFeaturesHooks:
      "la configuración asigna features.hooks más de una vez; define hooks = true a mano",
    configTomlCouldNotRead: "no se pudo leer config.toml: {message}",
    codexMarketplaceAddFailed: "falló codex plugin marketplace add: {output}",
    codexPluginAddFailed: "falló codex plugin add: {output}",
    noOutput: "sin salida",
    couldNotResolve: "no se pudo resolver {host}: {message}",
    noWorkspaceToBind:
      "no se pudo resolver el espacio de trabajo desde el servidor, así que la captura no tiene un destino al cual vincularse",
    couldNotBind: "no se pudo vincular la captura a un destino: {message}",
    destinationChanged:
      "el destino de la captura cambió; ejecuta 'mnemo harness drain' para los eventos en cola bajo el destino anterior",
    summaryHeading: "Captura:",
    stateFailed: "no se pudo configurar",
    stateSkipped: "no configurado",
    stateAlready: "ya configurado",
    stateConfigured: "configurado",
    hostLine: "  {host}: {state} ({mode})",
    why: "    motivo: {reason}",
    youDeclinedThis: "    rechazaste este",
    youDeclinedGate: "    rechazaste habilitar el interruptor del host",
    gateNotOffered: "    no se ofreció el interruptor del host: no hay a quién preguntar",
    failed: "    falló: {failure}",
    next: "    siguiente: {nextStep}",
    inlineTable: "una tabla en línea",
    dottedKey: "una clave con puntos",
    featuresDeclaredAs:
      "features está declarado como {form}; agrega [features] con hooks = true a mano",
    ambiguousConfig: "hay más de una configuración candidata: {candidates}",
  },
  installArgs: {
    captureHasAnEmpty: "--capture tiene un nombre de host vacío en '{raw}'.",
    doesNotTakeA: "{name} no admite un valor.",
    captureMayOnlyBe: "--capture solo se puede indicar una vez.",
    acceptDegradedOnlyMeans:
      "--accept-degraded solo tiene sentido con --capture; no se instalaría nada.",
    unknownOption:
      "Opción desconocida para 'install': {tokens}.\nOpciones válidas: {valid}. Ejecuta 'mnemo --help' para ver el uso.",
    unknownOptions:
      "Opciones desconocidas para 'install': {tokens}.\nOpciones válidas: {valid}. Ejecuta 'mnemo --help' para ver el uso.",
    unknownHost: "--capture: host desconocido '{name}'. Hosts válidos: {hosts}.",
    requiresHostList: "--capture requiere una lista de hosts separada por comas ({hosts}).",
  },
  atomic: {
    symlink: "{target} es un enlace simbólico; se rechaza escribir a través de él",
    disappeared: "{target} desapareció después de resolverse",
    changed: "{target} ya no es el archivo que se resolvió",
    notJson: "{target} no es JSON válido; se dejó como estaba",
  },
  api: {
    error: "Error: {status} {message}",
    errorMessage: "Error: {message}",
  },
  cli: {
    error: "Error: {message}",
    warningCouldNotParse: "Advertencia: no se pudo analizar {configPath}; se ignora.",
    warningIsMissingA:
      'Advertencia: a {configPath} le falta un campo "workspaceId" válido; se ignora.',
  },
  empty: {
    tasks: "No se encontraron tareas.",
    relations: "No se encontraron relaciones.",
    strategies: "No se encontraron estrategias.",
    workflows: "No se encontraron flujos de trabajo.",
    skills: "No se encontraron habilidades.",
    reasoning: "No se encontraron razonamientos.",
    hyperedges: "No se encontraron hiperaristas.",
    pairs: "No se encontraron pares.",
    reminders: "No se encontraron recordatorios.",
  },
  prompt: {
    yesNoDefaultNo: "[s/N]",
    yesNoDefaultYes: "[S/n]",
  },
} satisfies Shape<typeof en>;
