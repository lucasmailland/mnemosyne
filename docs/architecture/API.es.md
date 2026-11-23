# Mnemosyne v3 — especificación de la API pública

[English](API.md) · **Español**

> **El contrato completo y de referencia es el documento OpenAPI 3.1 que el servidor sirve en
> `GET /openapi.json`** (vista para personas: `GET /docs`). Se genera a partir de las definiciones de
> las rutas, así que siempre coincide con la versión en ejecución; como toda ruta, requiere una clave de
> API bearer. Este archivo es una guía escrita a mano que cubre un subconjunto de las rutas y puede
> quedar desactualizada; donde los dos no coincidan, manda `/openapi.json`.

> **Estado:** implementada parcialmente: algunas rutas devuelven 501; consulta docs/STATUS.md — verificado el 2026-06-13

> **Revisión**: 2026-06-12 (prefijos de ruta corregidos el 2026-07-31)  
> **Alcance**: guía de `@mnemo-ai/server` y `@mnemo-ai/mcp` (gRPC vive en `@mnemo-ai/server`)  
> **URL base**: donde ejecutes `@mnemo-ai/server` (puerto por defecto 3939; por ejemplo, `http://localhost:3939`)
>
> **⚠️ No hay prefijo de ruta `/v1` en la red.** `packages/server/src/app.ts` monta el
> router `v1` de OpenAPIHono en la raíz de la aplicación (`app.route("/", v1)`), no bajo
> `/v1`. Toda ruta real de este documento es una ruta simple: `POST /recall`,
> `POST /remember`, `GET /admin/stats`, etc., **no** `POST /v1/recall`. Las únicas
> rutas que conservan realmente un segmento `/memory/` son la federación
> (`/memory/federation/*`), el endpoint de recuperación de eventos perdidos por WS (`/memory/events`)
> y el propio endpoint WebSocket (`/memory/ws`); consulta §5. Todos los ejemplos de curl y todas las rutas
> de abajo se corrigieron para coincidir con las rutas reales desplegadas.
> `@mnemo-ai/client-ts` ya llama a estas rutas simples; `sdk-go` y
> `sdk-python` se corrigieron para coincidir el 2026-07-31 (antes tenían fijo un
> prefijo `/v1/...` y devolvían 404 contra un servidor real).

---

## Tabla de contenidos

1. [Autenticación y espacios de trabajo](#1-autenticación-y-espacios-de-trabajo)
2. [API REST](#2-api-rest)
3. [Herramientas MCP (26 herramientas)](#3-herramientas-mcp)
4. [Servicio gRPC (ConnectRPC)](#4-servicio-grpc-connectrpc)
5. [Protocolo WebSocket](#5-protocolo-websocket)
6. [Formato de error](#6-formato-de-error)
7. [Paginación](#7-paginación)
8. [Versionado de la API](#8-versionado-de-la-api)
9. [Idempotencia](#9-idempotencia)
10. [Encabezados de respuesta](#10-encabezados-de-respuesta)
11. [Entrega de webhooks](#11-entrega-de-webhooks)
12. [Límites de frecuencia](#12-límites-de-frecuencia)

---

## 1. Autenticación y espacios de trabajo

Todas las solicitudes requieren un token Bearer en el encabezado `Authorization`. El token identifica de forma única un espacio de trabajo; no hace falta indicar un ID de espacio de trabajo explícito.

```
Authorization: Bearer mns_live_abc123...  # Production key (legacy bearer format)
Authorization: Bearer mns_test_abc123...  # Sandbox key (legacy bearer format)
Authorization: Bearer mk_live_abc123...   # Production scoped key
Authorization: Bearer mk_test_abc123...   # Sandbox scoped key
```

**Prefijos de clave:**

| Prefijo     | Tipo          | Notas                                                                          |
| ----------- | ------------- | ------------------------------------------------------------------------------ |
| `mns_live_` | Legacy bearer | Producción; límites de frecuencia completos; formato `mns_(live\|test)_<cuid>` |
| `mns_test_` | Legacy bearer | Sandbox; espacio de trabajo aislado; se descarta al final bajo carga           |
| `mk_live_`  | Scoped        | Producción; lleva permisos explícitos y un techo de sensibilidad opcional      |
| `mk_test_`  | Scoped        | Clave con permisos para sandbox                                                |
| `mk_sess_`  | Scoped        | Clave con la vida útil de una sesión                                           |
| `mk_fed_`   | Scoped        | Clave de par de federación (se usa con vínculo mTLS)                           |
| `mk_admin_` | Scoped        | Clave con permisos de administración                                           |

**Permisos** (se asignan al crear la clave):

| Permiso      | Concede                                              |
| ------------ | ---------------------------------------------------- |
| `read`       | Endpoints GET, recuperación                          |
| `write`      | POST, PATCH, DELETE sobre el conocimiento            |
| `admin`      | Consolidar, exportar, importar, configurar proveedor |
| `federation` | Sincronización y resolución entre instancias         |

### 1.1 Escrituras entre espacios de trabajo (`targetWorkspaceId`)

`POST /remember` y otros 9 endpoints de creación (`/decisions`, `/entities`,
`/tasks`, `/events`, `/reasoning`, `/strategies`, `/workflows`, `/skills`,
`/reminders`) aceptan un campo opcional `targetWorkspaceId` (UUID) en el cuerpo para
escribir en un espacio de trabajo distinto del que está vinculado a la clave del solicitante,
sin necesitar una sesión o una clave de API aparte por espacio de trabajo.

| Campo               | Tipo                      | Notas                                                                                                                                            |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `targetWorkspaceId` | `string` (UUID, optional) | Omítelo para escribir en el espacio de trabajo del propio solicitante (sin cambios, comportamiento por defecto). Indícalo para escribir en otro. |

Requisitos, resueltos por un único helper del servidor
(`resolveTargetWorkspace`, `packages/server/src/workspace-target.ts`) compartido
por las 10 rutas:

- La clave de API del solicitante DEBE estar vinculada a un usuario (`mk_user_*`/`mk_live_*` con un
  `user_id`, o cualquier otra clave vinculada a un usuario; **no** se limita a un
  prefijo `uk_*`). Una clave solo de espacio de trabajo que envía `targetWorkspaceId` se rechaza.
- Ese usuario DEBE tener `role: "write"`, `"admin"` o `"owner"` en
  `mnemo_workspace_member` para el espacio de trabajo de destino. `role: "read"` y «ninguna
  fila de membresía» se rechazan de forma idéntica (indistinguibles para el
  solicitante, por diseño).
- Todo rechazo devuelve `403` con el cuerpo plano
  `{ "error": "forbidden", "message": "..." }`, la misma forma que
  `POST /remember` ya usaba antes de extender este mecanismo a los
  otros 9 endpoints.

El cuerpo de la respuesta `201` de cada uno de estos 10 endpoints incluye un
campo `workspaceId` que indica qué espacio de trabajo recibió realmente la escritura:
el del propio solicitante cuando se omitió `targetWorkspaceId`, el espacio de
destino cuando se indicó y se aceptó. Este valor también se expone
en el contenido del resultado de la herramienta MCP correspondiente, nunca se descarta.

`memory_pin`, `memory_relate` y `memory_hyperedge` **no** aceptan
`targetWorkspaceId`: hacen referencia a ids de primitivos ya existentes en lugar de
crear filas nuevas, así que «apuntar a otro espacio de trabajo» no encaja
con ellas. Es deliberado, no un descuido (`docs/archive/openspec/
p57-cross-workspace-tool-parity/spec.md`, Non-Goals).

---

## 2. API REST

### Especificación OpenAPI

La especificación OpenAPI 3.1 en vivo se genera automáticamente a partir de las definiciones de rutas y se sirve en:

```
GET /openapi.json   — machine-readable spec
GET /docs           — Scalar interactive browser UI
```

No hay ningún archivo estático en el repositorio: la especificación siempre está al día con el servidor desplegado. Ambas
rutas están detrás de la misma autenticación con clave bearer que cualquier otra ruta (`Authorization: Bearer <key>`).

### Inicio rápido — ejemplos con curl

Operaciones del camino feliz. Define primero `MNEMO_URL` y `MNEMO_KEY`:

```bash
export MNEMO_URL=http://localhost:3939
export MNEMO_KEY=mns_live_...

# 1. Store a fact
curl -s -X POST "$MNEMO_URL/remember" \
  -H "Authorization: Bearer $MNEMO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"PostgreSQL is the primary datastore","type":"fact","topicKey":"infra/db","confidence":0.99}' | jq .

# 2. Recall by semantic query
curl -s -X POST "$MNEMO_URL/recall" \
  -H "Authorization: Bearer $MNEMO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"database stack","limit":5}' | jq '.hits[].content'

# 3. Log a decision
curl -s -X POST "$MNEMO_URL/decisions" \
  -H "Authorization: Bearer $MNEMO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"kind":"architecture","title":"PostgreSQL over MongoDB","body":"Chosen for ACID guarantees and native pgvector support."}' | jq .

# 4. Soft-forget a fact (close validity window)
FACT_ID=fact_01j9abc123...
curl -s -X DELETE "$MNEMO_URL/facts/$FACT_ID" \
  -H "Authorization: Bearer $MNEMO_KEY" | jq .

# 5. Health check
curl -s "$MNEMO_URL/health/live" && curl -s "$MNEMO_URL/health/ready" | jq .
```

**Forma de la respuesta de error** (todos los errores):

```json
{
  "error": {
    "type": "not_found_error",
    "code": "not_found",
    "message": "fact_xyz does not exist in this workspace",
    "request_id": "req_..."
  }
}
```

Códigos de error comunes: `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `unprocessable_entity` (422), `not_implemented` (501), `internal_error` (500).

#### Rutas que pueden devolver 501

Verificado contra `packages/server/src/routes/*.ts` (2026-07-31): todas las rutas cuyo bloque
`responses` de OpenAPI declara `501`, con la condición real que lo provoca:

| Ruta                             | Causa                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /remember`                 | No hay un proveedor de embeddings configurado (`MNEMO_LLM_PROVIDER`/`MNEMO_LLM_API_KEY` sin definir) **y** la solicitud no incluye un `vector` precalculado. `POST /facts` se eliminó (flatten-legacy-dual-core, D2) y ya no sirve como punto de comparación. `POST /recall` tampoco responde 501 en el mismo caso de proveedor ausente: se degrada con elegancia a búsqueda de texto completo (consulta la nota `debug.searchMode: "fts"` en §2.2). Un proveedor configurado pero **inaccesible** tampoco hace fallar la escritura: el recuerdo se guarda, se devuelve `embeddingDeferred: true` y el embedding se encola para el worker del outbox (CHAOS-5). |
| `PUT /admin/config/llm`          | `MNEMO_MASTER_KEY` no está configurada: la dependencia de cifrado en reposo de la configuración del espacio de trabajo no está disponible.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PUT /admin/config/retention`    | Igual: `MNEMO_MASTER_KEY` no está configurada.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DELETE /admin/config/retention` | Igual: `MNEMO_MASTER_KEY` no está configurada.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PUT /config/llm`                | Igual: anulación por espacio de trabajo de las rutas anteriores; misma dependencia de cifrado.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PUT /config/retention`          | Igual.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DELETE /config/retention`       | Igual.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Convenciones comunes

- Todos los cuerpos de solicitud y respuesta son `application/json`
- Las marcas de tiempo son ISO 8601 con zona horaria (`2026-06-09T12:00:00Z`)
- Los IDs llevan un prefijo según el tipo: `sess_`, `fact_`, `ent_`, `task_`, `evt_`, `ep_`, `rel_`, `rsn_`, `wh_`
- Los borrados lógicos archivan los registros; el borrado definitivo no se expone públicamente
- `PATCH` acepta cuerpos parciales (solo se actualizan los campos enviados)

---

### 2.1 Ciclo de vida de la sesión

Las sesiones son memoria de trabajo efímera. Se colapsan en unidades de conocimiento duraderas.

> **No implementado.** Ninguna ruta responde bajo `/memory/sessions`: los encabezados marcados "(no implementado)" de abajo son un diseño anterior que nunca se construyó. Las rutas reales usan el prefijo `/session` (sin `/memory/`, sin `/v1/`), más los alias `POST /sessions`, `GET /sessions`, `POST /sessions/:id/turns` y `DELETE /sessions/:id`. Cada encabezado nombra su ruta real en **Implementado**; sus formas exactas están en `GET /openapi.json`.

#### `POST /memory/sessions` (no implementado)

Inicia una sesión nueva para un agente.

**Permisos**: `write`

```json
// Request
{
  "agentId": "agent_coder_01",
  "label": "PR review for feat/auth",
  "metadata": { "task": "code-review" }
}

// Response 201
{
  "id": "sess_abc123",
  "agentId": "agent_coder_01",
  "label": "PR review for feat/auth",
  "status": "active",
  "createdAt": "2026-06-09T12:00:00Z",
  "scratchpad": {}
}
```

**Implementado** (`POST /session/start`, 2026-06-12): el cuerpo de la solicitud es opcional; la respuesta es `{ id, agentId, status, createdAt }` (todavía sin los campos `label` ni `scratchpad`).

**Errores**: `unprocessable_entity`

---

#### `POST /memory/sessions/:id/turns` (no implementado)

Añade un turno a una sesión activa.

**Permisos**: `write`

```json
// Request
{
  "role": "user",
  "content": "What do we know about the auth module?",
  "metadata": { "tokens": 14 }
}

// Response 201
{
  "turnIndex": 0,
  "sessionId": "sess_abc123",
  "role": "user",
  "content": "What do we know about the auth module?",
  "createdAt": "2026-06-09T12:00:01Z"
}
```

**Implementado** (`POST /session/:id/turn`, 2026-06-12): devuelve **204 No Content** (sin cuerpo). La forma de la solicitud es la misma.

**Errores**: `not_found`, `unprocessable_entity`, `conflict` (la sesión ya se colapsó)

---

#### `POST /memory/sessions/:id/pin` (no implementado)

Fija un turno para que el pipeline de colapso lo extraiga como una unidad de conocimiento de alta prioridad.

**Permisos**: `write`

```json
// Request
{ "turnIndex": 3, "label": "Key decision on JWT expiry" }

// Response 200
{ "pinned": true, "turnIndex": 3, "label": "Key decision on JWT expiry" }
```

**Estado**: reemplazado: se implementó antes y de forma distinta a lo planificado, como
`POST /session/:id/pin` (`{ turnIndex }`, sin campo `label`). Consulta `session.ts:489`.

---

#### `POST /memory/sessions/:id/scratch` (no implementado)

Escribe en el scratchpad de la sesión (almacén efímero de clave/valor).

**Permisos**: `write`

```json
// Request
{ "key": "auth_module_path", "value": "packages/auth/src/index.ts" }

// Response 200
{ "scratchpad": { "auth_module_path": "packages/auth/src/index.ts" } }
```

**Estado**: reemplazado: se implementó como `POST /session/:id/scratch` (cuerpo `{ key, value }`).
Consulta `session.ts:535`. La forma de la respuesta no se verificó de forma independiente contra
la afirmación `{ scratchpad }` de este documento en esta pasada.

---

#### `POST /memory/sessions/:id/collapse` (no implementado)

Colapsa la sesión en unidades de conocimiento duraderas. Requiere un proveedor de LLM (nivel Cognitive) o devuelve un prompt de extracción para quien llama (modo inherited).

**Permisos**: `write`  
**Idempotencia**: compatible mediante el encabezado `Idempotency-Key`

```json
// Request
{
  "hint": "Focus on architectural decisions and gotchas",
  "extractTypes": ["fact", "decision", "strategy"]
}

// Response 202 (async — LLM-backed)
{
  "jobId": "job_coll_xyz",
  "sessionId": "sess_abc123",
  "status": "processing",
  "estimatedMs": 3000
}

// OR Response 200 (inherited mode — caller must complete extraction)
{
  "status": "extraction_required",
  "extractionPrompt": "Given the following conversation...",
  "extractionSchema": { ... },
  "callbackEndpoint": "POST /memory/sessions/sess_abc123/collapse/complete"
}
```

**Implementado** (`POST /session/:id/collapse`): cuerpo `{ strategy?: "auto" | "explicit", collapseHint? }`; ejecuta el pipeline de extracción y devuelve 202 `{ accepted, sessionId, resumed, status, skipReason? }`, donde `status` es `completed`, `skipped`, `failed` o `collapse_pending`. Un colapso `skipped` no extrajo nada.

**Errores**: `not_found`, `capability_unavailable` (sin proveedor de LLM y fuera del modo inherited)

---

#### `DELETE /memory/sessions/:id` (no implementado)

Descarta una sesión sin colapsarla. Se pierden todos los turnos.

**Permisos**: `write`

```
// Response 204 No Content
```

**Errores**: `not_found`

**Implementado** (`POST /session/:id/discard`, no `DELETE`): consulta `session.ts:576`.

---

#### `GET /session/:id` y `GET /session/list`

No forma parte de la especificación planificada original de arriba: se añadió para la
red de seguridad de cumplimiento de la memoria autónoma (2026-07). Lee el estado actual
de una sesión, o lista todas las sesiones del espacio de trabajo.

**Permisos**: `read`

```json
// GET /session/sess_abc123 — Response 200
{
  "id": "sess_abc123",
  "agentId": "agent_coder_01",
  "status": "active",
  "createdAt": "2026-06-09T12:00:00Z",
  "label": "PR review for feat/auth",
  "lastRecallAt": "2026-07-31T14:22:00.000Z"
}

// GET /session/list — Response 200
{ "sessions": [ /* same shape as above, one per session */ ] }
```

`lastRecallAt` (memoria autónoma, requisito 1/4): marca de tiempo ISO de la llamada
`POST /recall` más reciente que proporcionó el id de esta sesión como `sessionId`, o
`null` si no ha habido ninguna. Se lee de `metadata.lastRecallAt`; consulta `sessionId` en
§2.2 para ver cómo se establece. Los métodos `getSession()`/`listSessions()` de `client-ts`
y las acciones `get`/`list` de la herramienta MCP `memory_session` envuelven
estas rutas (añadidos el 2026-07-31, cerrando una brecha de rutas huérfanas; consulta
`docs/archive/BACKLOG.md` P36).

**Errores**: `not_found` (solo en get, id de sesión desconocido)

---

### 2.2 Recuperación

#### `POST /recall`

Búsqueda combinada léxica + vectorial. El endpoint principal de recuperación.

Con `debug: true` opcional se devuelve `debug.trace` (conteo de candidatos y tiempos por etapa; `ms` es el tiempo desde la etapa anterior en orden de ejecución, solo se incluye la traza del nivel que respondió en una recuperación de varios niveles, y un tier sin resultados informa 0 candidatos).

Conteos de la traza y techo de sensibilidad: las etapas anteriores a `eligibility` (`embed`, los tiers, `cache`, `vector`, `lexical`, `nonfact_candidates`, `fusion`) cuentan candidatos que el techo todavía no filtró. Informan `candidatesIn: null, candidatesOut: null` salvo que el techo efectivo de quien llama admita todos los tiers (una clave `memory:admin` y `MNEMO_SENSITIVITY_CEILING=restricted`; el techo por defecto del entorno, `internal`, limita también a las claves admin). Para esos casos, `eligibility` informa los candidatos que la superaron tanto en `candidatesIn` como en `candidatesOut`; las etapas posteriores ya pasaron el techo y conservan sus conteos. Los nombres de etapa y `ms` siempre están presentes. En la ruta fría híbrida, `lexical` y `nonfact_candidates` informan como `candidatesOut` los candidatos que agregaron. `debug.lexicalCandidateCount` también cuenta candidatos antes del techo, así que solo aparece para quien tiene un techo efectivo que admite todos los tiers.

**Permisos**: `read`

> **Corregido el 2026-07-31**: la forma de solicitud y respuesta de abajo se reescribió para
> coincidir con el `RecallRequestSchema`/`RecallResponseSchema` reales de
> `packages/server/src/routes/recall.ts` (verificado directamente contra el código fuente de Zod, sin
> suposiciones). La versión anterior de esta sección (campos de solicitud `types`, `limit`,
> `includeGraph`, `agentId`; `results[]` con campos de respuesta `type`/`worth`/
> `relevanceScore`/`graph`) no coincidía con ningún campo que la ruta real lea o devuelva:
> era texto anterior a la implementación, aspiracional, que nunca se reconcilió tras publicar la ruta.

```json
// Request
{
  "query": "What do we know about Redis caching strategy?",
  "topK": 5,
  "asOf": "2026-05-01T00:00:00Z",
  "scope": "global",
  "scopeRef": "project:infra",
  "actorId": "key:ak_01H8Z9QK3X",
  "mode": "auto",
  "sessionId": "sess_abc123",
  "includeLowWorth": false
}

// Response 200
{
  "hits": [
    {
      "id": "fact_abc",
      "content": "Redis is used in transaction mode via PgBouncer",
      "score": 0.94,
      "lexicalScore": 0.4,
      "vectorScore": 0.91,
      "validFrom": "2026-04-01T00:00:00Z",
      "validTo": null,
      "attribution": { "source": "user_stated" },
      "tags": ["infra"],
      "actorId": "key:ak_01H8Z9QK3X",
      "userId": "usr_01H8Z8P7YQ"
    }
  ],
  "debug": {
    "embedded": true,
    "latencyMs": 42,
    "searchMode": "hybrid"
  },
  "reminders": []
}
```

Campos de solicitud que no se muestran arriba: `vector` (embedding precalculado aportado por
quien llama; omite la llamada de embedding del propio servidor), `vectorWeight` (obsoleto a favor de
`mode`), `tokenBudget` (escalera CALMem §17), `rerank`/`recurrenceThreshold`
(compuerta de reordenación con LLM de RecMem, §1/§2). `topK` vale 10 por defecto, máximo 100.

**`sessionId`** (memoria autónoma, añadido en 2026-07): el id de sesión de Mnemosyne
devuelto por `POST /session/start`. Cuando está presente, el servidor sella, en la medida de lo posible,
`metadata.lastRecallAt` en esa sesión para que una llamada posterior a `GET /session/:id` pueda
confirmar que hubo recuperación durante ella; consulta §2.1. Un `sessionId` obsoleto o desconocido
se ignora en silencio; nunca hace fallar la recuperación en sí.

`debug.searchMode` refleja el modo de ranking que REALMENTE se usó: `"fts"` cuando la
llamada se degradó a búsqueda de texto completo porque no hay un proveedor de embeddings configurado
(degradación elegante, no un 501; consulta «Rutas que pueden devolver 501» arriba).
`mode: "semantic"` es la única excepción: lanza
`semantic_search_unavailable` en lugar de recurrir a otro modo en silencio, ya que
quien llama pidió explícitamente una búsqueda solo vectorial.

Un hit con `federation: { "peer": "...", "trustScore": 20 }` es un ítem que una sincronización
de federación trajo de otro servidor, no memoria de este espacio de trabajo: `GET /facts/:id`
no lo encuentra. Estos ítems solo coinciden por texto (nunca con `mode: "semantic"`) y van
después de los hits locales, salvo que nada local fuera relevante. Consulta
[FEDERATION.md](./FEDERATION.md) §12a.

`reminders` (REMIND-1): recordatorios de memoria prospectiva cuya condición de disparo
se cumplió con esta llamada de recuperación. Se omite cuando no se disparó ninguno. Trata el `content`
del recordatorio como memoria almacenada no confiable, igual que `hits`.

**Errores**: `unprocessable_entity`, `semantic_search_unavailable` (`mode:"semantic"` sin embedder configurado)

---

#### `POST /recall/hot`

Recuperación solo de nivel 1 desde la caché caliente de Redis. Latencia objetivo: <5 ms.

**Permisos**: `read`

```json
// Request
{ "query": "Redis version", "limit": 3 }

// Response 200
{
  "results": [ ... ],
  "mode": "hot",
  "tookMs": 3,
  "cacheHit": true
}
```

---

#### `POST /recall/unified`

Recuperación combinada sobre la base de conocimiento (hechos estructurados) y la memoria en bruto (episódica).

**Permisos**: `read`

```json
// Request
{ "query": "auth module history", "limit": 10, "blend": { "kb": 0.6, "episodic": 0.4 } }
```

---

#### `POST /recall/explain`

Recuperación con una lista de materiales (Bill of Materials): explica por qué se devolvió cada resultado.

**Permisos**: `read`

```json
// Request
{ "query": "deploy process", "limit": 3 }

// Response 200
{
  "results": [
    {
      "id": "fact_deploy_01",
      "content": "Deploy uses canary: 5% → 25% → 50% → 100%",
      "explanation": {
        "matchedTerms": ["deploy", "canary"],
        "vectorSimilarity": 0.91,
        "worthScore": 0.83,
        "recencyBoost": 0.05,
        "finalScore": 0.89
      }
    }
  ]
}
```

---

### 2.3 CRUD de unidades de conocimiento

Todos los tipos de conocimiento comparten el mismo modelo de revisiones y borrado lógico. `PATCH` crea una revisión nueva; la original se conserva para las consultas bitemporales.

#### Hechos

```
GET    /facts/:id
PATCH  /facts/:id
DELETE /facts/:id
```

> **CAMBIO INCOMPATIBLE (flatten-legacy-dual-core, D2):** `POST /facts` se ha
> **eliminado**. `POST /remember` (`packages/server/src/routes/remember.ts`,
> usado por la herramienta MCP `memory_remember` y por `mnemo remember` de la CLI) es
> ahora la **única** vía de escritura de hechos: las dos rutas ejecutaban antes dos implementaciones
> mantenidas de forma independiente (`deps.core.createFact` frente a
> `deps.cognitive.remember`) sobre el mismo esquema físico; los hooks de escritura de plugins
> de `/remember` y la difusión de eventos/webhooks `fact.created` (los dos
> comportamientos que solo tenía `/facts`) se portaron primero y después `/facts`
> se eliminó. Migra los cuerpos de solicitud con un remapeo de campos sin pérdida:
> `{content, attribution, tags}` → `{statement: content, attribution, tags}`;
> los lectores de respuestas deben cambiar `content` → `statement`. La respuesta de
> `/remember` también incluye `confidence`/`status`/`sensitivity`/
> `conflict.judgmentRequired`, nada de lo cual tenía la antigua forma `Fact`.
> `/remember` también crea primitivos que no son hechos mediante su campo `kind`
> (decision, entity, strategy, workflow, skill, task, event, reasoning) y
> realmente **puede devolver 501**; consulta «Rutas que pueden devolver 501» cerca
> del inicio de este archivo. MCP y la CLI ya apuntaban solo a `/remember`, así que no
> hizo falta ningún cambio allí; `client-ts`/`sdk-go`/`sdk-python`/el dashboard
> se remapean en un cambio posterior.

**`GET /facts/:id`** — **Permisos**: `read`

Parámetros de consulta: `?asOf=2026-05-01` (viaje en el tiempo), `?includeClosed=true` (los hechos cerrados se devuelven en lugar de un 404), `?provenance=true` (agrega `sessionId`, `supersededById`, `supersededAt`, `supersedesIds`; un episodio sucesor o de origen por encima del techo de sensibilidad se lee como `null`, igual que si no existiera, y los hechos reemplazados por encima del techo se dejan fuera de `supersedesIds`). Con `provenance` o sin él, `episodeId` se lee `null` cuando ese episodio está por encima del techo de quien llama

Además de `content`/`attribution`/`tags`/vigencia, la respuesta incluye `kind`, `subject`,
`scopeRef`, `confidence`, `topicKey`, `episodeId`, `status` y `revisionCount` (CLIENTS-20,
aditivo).

**`GET /facts`** — **Permisos**: `read` — lista paginada por keyset (WP-5):

- **Por defecto: solo filas vigentes**: `status: active` con un intervalo de vigencia abierto. `includeClosed=true`
  (sin `status`) lista también el historial; un `status` explícito o una instantánea `asOf` se aplica tal cual.
- El techo de sensibilidad de quien llama se aplica **en la consulta**, de modo que las páginas salen completas y `total` cuenta solo las
  filas legibles (PRIM-8).
- El cursor lleva la marca de tiempo de ordenación con precisión completa de microsegundos. Los cursores emitidos antes de este cambio
  llevaban milisegundos y pueden omitir filas: reinicia la paginación tras actualizar.
- `q` coincide con búsqueda de texto completo (en ambos idiomas) o `ILIKE`; cuando esa coincidencia estricta no encuentra nada para
  todo el conjunto de filtros, recurre a las filas que coinciden con al menos dos de los términos de contenido de la pregunta (RECALL-7).

**`PATCH /facts/:id`** — **Permisos**: `write`

Acepta actualizaciones parciales. Campos admitidos (todos opcionales):

| Campo        | Tipo           | Notas                                                       |
| ------------ | -------------- | ----------------------------------------------------------- |
| `pinned`     | `boolean`      | Fija o desfija el hecho para su promoción al nivel caliente |
| `statement`  | `string`       | Revisa el texto del hecho                                   |
| `confidence` | `number` (0–1) | Ajusta la puntuación de confianza                           |

```json
// Request — any combination of fields
{ "statement": "Updated statement text", "confidence": 0.98, "pinned": true }

// Response 200 — full MemoryFact including updated confidence
{ "id": "fact_xyz789", "statement": "Updated statement text", "confidence": 0.98, "pinned": true, "revision": 2, "previousRevision": 1, ... }
```

> **Nota de implementación (2026-06-12):** Ahora se admiten los tres campos (`pinned`, `statement`, `confidence`). Las compilaciones anteriores solo aplicaban `pinned`; `statement` y `confidence` lanzaban 501. Esto está totalmente resuelto.

PATCH actualiza el hecho **en el sitio** (mismo id, `revisionCount + 1`) bajo un bloqueo de fila, y copia la revisión
que reemplaza en `mnemo_fact_revision` (migración 0044; se propaga en cascada con el borrado definitivo). El campo opcional
`expectedRevision`: el parche se aplica solo si el hecho sigue en esa revisión; de lo contrario, **409
`revision_conflict`** y no cambia nada. Un `statement` nuevo se vuelve a incrustar a través del outbox (CHAOS-8,
PRIM-4). PATCH, `POST /facts/:id/pin` y `POST /facts/:id/restore` responden **404** para un hecho por encima del
techo de quien llama (PRIM-14).

**`DELETE /facts/:id`** — **Permisos**: `write` — Archiva (borrado lógico), respuesta `204`. Repetible y
serializado: de varios borrados concurrentes uno recibe `204` y el resto `404`; un hecho olvidado, restaurado y olvidado
de nuevo conserva su última instantánea en `mnemo_fact_archive` (PRIM-3). `POST /facts/:id/restore` reabre el
hecho y lo vuelve a incrustar; restaurar un hecho vivo no hace nada.

**`POST /facts/compare`** (docs/archive/openspec/decompose-recall-and-compare, Slice 2) — reubicación,
ahora a cargo del servidor, de lo que `memory_compare` calculaba antes en local dentro del proceso MCP. Obtiene ambos
hechos con exactamente la misma protección de lectura que usa `GET /facts/:id` (activo + intervalo abierto + techo de
sensibilidad; 404, no 403, anti-sondeo según §5), y luego devuelve una comparación estructurada.

```json
// Request
{ "factIdA": "mfact_01J...abc", "factIdB": "mfact_01J...xyz" }

// Response 200
{
  "factA": { "id": "mfact_01J...abc", "content": "...", "...": "..." },
  "factB": { "id": "mfact_01J...xyz", "content": "...", "...": "..." },
  "differences": ["content: \"...\" → \"...\""],
  "suggestedVerb": "supersedes",
  "sameSubject": true
}
```

`suggestedVerb` es exactamente uno de 4 valores: `supersedes | conflicts_with | compatible | scoped`
(nunca `related` — docs/archive/openspec/complete-mcp-tools B6). Si falta alguno de los ids, está cerrado o está por encima del
techo de sensibilidad de quien llama → `404`. La lógica de comparación vive en
`packages/server/src/facts/compare.ts`, un módulo puro sin E/S.

---

#### Decisiones, estrategias, flujos de trabajo y habilidades

La misma forma de CRUD que los hechos. Solo POST (por ahora no hay endpoints GET/:id individuales; se recuperan mediante recall).

```
POST /decisions    # Record a decision with rationale
POST /strategies   # Store behavioral pattern ("when X, do Y")
POST /workflows    # Store multi-step procedural recipe
POST /skills       # Store reusable capability
```

Los 4 aceptan el campo opcional `targetWorkspaceId` en el cuerpo; consulta §1.1. `POST /strategies`
también acepta un `validFrom` opcional (desde cuándo aplica la estrategia); un instante futuro
responde 400.

**`POST /decisions`**

```json
// Request
{
  "summary": "Use cursor-based pagination for all list endpoints",
  "rationale": "Offset pagination is O(n) at depth; cursor is O(1) and stable under writes",
  "alternatives": ["offset-based", "keyset"],
  "chosenAlternative": "cursor-based",
  "confidence": 0.99,
  "relatedEntities": ["ent_api"]
}
```

---

### 2.4 Entidades y grafo

#### `POST /entities`

Crea una entidad o la busca y, si no existe, la crea.

**Permisos**: `write`

Acepta el campo opcional `targetWorkspaceId` en el cuerpo; consulta §1.1.

```json
// Request
{
  "name": "PostgreSQL",
  "kind": "system",
  "aliases": ["PG", "Postgres"],
  "findOrCreate": true
}

// Response 200 (found) or 201 (created)
{
  "id": "ent_pg_001",
  "name": "PostgreSQL",
  "kind": "system",
  "aliases": ["PG", "Postgres"],
  "factCount": 12,
  "createdAt": "2026-01-01T00:00:00Z"
}
```

Toda respuesta con una entidad (`GET /entities`, `GET /entities/:id`, su `/facts`, crear,
actualizar, vincular y desvincular) lleva `mentionCount`: los hechos activos de la entidad más
los episodios relacionados con ella, contando solo los que quien llama puede leer. Es el mismo
número que `GET /graph` muestra para el nodo. `linkedFactCount` en `GET /entities/:id` también
cuenta solo los hechos legibles. `PATCH /entities/:id` responde 404 para una entidad por encima
del techo de quien llama, y un `canonicalId` por encima del techo responde 400 exactamente igual
que uno que no existe.

---

#### `POST /entities/:id/link-user` / `DELETE /entities/:id/link-user`

Vincula (o desvincula) una entidad `kind: "person"` con una cuenta real de la plataforma
(`linkedUserId`, un `mnemo_user.id`); consulta «Provenance identity» en CLAUDE.md
para la distinción entre `userId` (procedencia: quién escribió la fila) y `linkedUserId` (sujeto:
de quién trata la fila).

**Permisos**: vincularse a uno mismo (tu propio `userId`) no requiere ningún permiso especial más allá
del acceso de lectura a la entidad. Vincular a un usuario _distinto_, o reasignar una
entidad ya vinculada a otra persona, requiere `memory:admin` **y** un rol de
propietario/administrador en este espacio de trabajo.

```json
// POST /entities/:id/link-user — Request
{ "userId": "usr_01H8Z8P7YQ" }

// Response 200
{ "id": "ent_pg_001", "kind": "person", "linkedUserId": "usr_01H8Z8P7YQ", "sensitivity": "internal", "..." : "..." }
```

`DELETE /entities/:id/link-user` no lleva cuerpo. La desvinculación es bitemporal: cierra
la fila vinculada (`validTo = now()`) y devuelve una fila sucesora nueva, sin vincular, enlazada con la predecesora
mediante una relación `supersedes`, en lugar de
dejar `linkedUserId` en blanco en el sitio.

404 cuando la entidad no existe, el techo de sensibilidad de quien llama no puede
leerla (antisondeo: misma respuesta que si no existiera) o (solo al vincular) el
usuario de destino no es miembro de este espacio de trabajo. 400 (solo al vincular) cuando el
`kind` de la entidad no es `person`.

---

#### `GET /entities/:id/graph`

Devuelve el subgrafo alrededor de una entidad (BFS hasta una profundidad).

**Permisos**: `read`  
Parámetros de consulta: `?depth=2&types=system,person`

**Implementado** como alias de ruta en `app.ts` (T6.6): reenvía internamente a
`GET /graph?focus=:id`; consulta `packages/server/src/routes/graph.ts`.

Los nodos por encima del techo de sensibilidad de quien llama se omiten, junto con las aristas que los tocan, y `factCount` cuenta solo los hechos que esa persona puede leer (lo mismo vale para `GET /graph`). El `mentionCount` de una entidad es su `factCount` más los episodios relacionados con ella que esa persona puede leer.

```json
// Response 200
{
  "root": { "id": "ent_pg_001", "name": "PostgreSQL", "kind": "system" },
  "nodes": [ ... ],
  "edges": [
    { "from": "ent_pg_001", "to": "ent_pgbouncer", "verb": "proxied_by", "weight": 0.9 }
  ]
}
```

---

#### `POST /relations`

Crea una relación entre dos primitivos de memoria (hecho/decisión/entidad/episodio).

**Permisos**: `write`

> **Corregido el 2026-07-31**: la versión anterior de esta sección usaba una
> forma `from`/`to`/`verb`/`weight` y un verbo inventado (`"proxied_by"`)
> que no existen en la ruta real. Se reescribió para coincidir con la
> solicitud/respuesta reales de `packages/server/src/routes/relations.ts`, que el
> comentario de cabecera de ese mismo archivo documenta campo por campo.

```json
// Request
{
  "sourceKind": "entity",
  "sourceId": "ent_pg_001",
  "targetKind": "entity",
  "targetId": "ent_pgbouncer",
  "relation": "related",
  "markedByKind": "agent",
  "reason": "Connection pooling in transaction mode",
  "confidence": 0.9
}

// Response 201
{
  "id": "rel_abc",
  "sourceKind": "entity",
  "sourceId": "ent_pg_001",
  "targetKind": "entity",
  "targetId": "ent_pgbouncer",
  "relation": "related",
  "judgmentStatus": "pending"
}
```

`relation` debe ser uno de los 9 **verbos bloqueados**: `related`, `compatible`,
`scoped`, `conflicts_with`, `supersedes`, `not_conflict`, `derived_from`,
`part_of`, `member_of`; cualquier otro valor responde 400 con la lista permitida.
El desacuerdo entre varios actores se captura creando varias filas de relación para
el mismo origen/destino/verbo con distinto `markedByKind`/`markedByUserId`;
deliberadamente no hay ninguna restricción `UNIQUE` sobre esa tupla.

---

#### `POST /relations/traverse`

BFS direccional desde un nodo raíz: devuelve la estructura completa de nodos y aristas
alcanzables. Distinto de `GET /graph/traverse` (§2.2-adyacente, bidireccional,
devuelve en su lugar una lista de vecinos con puntuación por decaimiento); consulta GRAPH-DUP-1 en
`docs/archive/BACKLOG.md` para saber por qué existen ambos.

Ambos recorren el grafo **actual**: no se sigue una relación cerrada por `DELETE /relations/:id`
o por el borrado definitivo de un hecho. `GET /graph/traverse?asOf=` sigue
reconstruyendo el grafo en un instante pasado, aristas cerradas incluidas.

Ambos, y también `GET /graph/path`, se detienen en los nodos por encima del techo de
sensibilidad de quien llama: ese nodo nunca se devuelve ni se atraviesa, y no se lista
ninguna arista que lo toque, así que no se encuentra un camino que pase por él. Una raíz
por encima del techo responde igual que un id desconocido (sin resultados, sin camino,
sin aristas).

El resto de la superficie de relaciones sigue la misma regla: `GET /relations` no lista ninguna
relación que toque ese nodo, y `PATCH`/`DELETE /relations/:id` responden 404 para ella y la
dejan sin cambios. `GET /hyperedges` omite una hiperarista con un miembro por encima del techo
(de `items` y de `total`), y `GET`, `PATCH` y `DELETE /hyperedges/:id` responden 404 para ella.

**Permisos**: `read`

> **Corregido el 2026-07-31**: el mismo problema que en `POST /relations` de arriba: la
> forma anterior (`startEntity`, `traversal`, `paths`, `visitedNodes`) no
> tenía relación alguna con la ruta real.

```json
// Request
{
  "rootId": "ent_auth_module",
  "rootKind": "entity",
  "maxDepth": 3,
  "verbs": ["derived_from", "supersedes"]
}

// Response 200
{
  "nodes": [{ "id": "ent_auth_module", "kind": "entity" }, { "id": "mdec_xyz", "kind": "decision" }],
  "edges": [{ "id": "rel_1", "sourceKind": "decision", "sourceId": "mdec_xyz", "targetKind": "entity", "targetId": "ent_auth_module", "relation": "derived_from" }],
  "truncated": false
}
```

`maxDepth` vale 2 por defecto, máximo 5. `verbs` restringe cuáles de los 9 verbos
bloqueados se siguen; omítelo para seguirlos todos. `truncated: true` indica que se alcanzó un
tope por capa muy generoso (2000 nodos): un techo de seguridad real, no una
pérdida silenciosa de aristas (TRAVERSE-1).

**`memory_relate(action:'history')`** (herramienta MCP, añadida el 2026-07-31) compone
exactamente este endpoint con `verbs` fijado en `['supersedes', 'derived_from']`:
sin código nuevo en el servidor, sin método nuevo en `client-ts`. Pensada para «por qué esta
decisión/este hecho es el vigente, qué reemplazó» en lugar de
una exploración genérica del grafo; consulta `packages/mcp/src/tools/relate.ts` y
el análisis del caso 1 en `docs/archive/BACKLOG.md` para saber por qué se eligió una acción estrecha
en lugar de una herramienta genérica que exponga traverse.

---

### 2.5 Episodios y línea de tiempo

#### `POST /episodes`

Crea un episodio (un segmento de actividad con nombre).

**Permisos**: `write`

```json
// Request
{
  "name": "Auth refactor — June 2026",
  "startedAt": "2026-06-01T09:00:00Z",
  "endedAt": null,
  "relatedEntities": ["ent_auth_module"],
  "tags": ["refactor", "auth"]
}

// Response 201
{ "id": "ep_001", "name": "Auth refactor — June 2026", ... }
```

---

#### `GET /episodes/:id/timeline`

Eventos y turnos dentro de un episodio concreto.

**Permisos**: `read`  
Parámetros de consulta: `?cursor=xxx&limit=20`

---

#### `GET /timeline`

Línea de tiempo global de todos los episodios y eventos.

**Permisos**: `read`  
Parámetros de consulta: `?from=2026-05-01&to=2026-06-09&entityId=ent_auth_module&types=event,session&limit=50&cursor=xxx`

Los eventos también incluyen `decision_created`, `decision_superseded` y `decision_withdrawn` (con `decisionId`, sin `factId`).

```json
// Response 200
{
  "data": [
    {
      "type": "event",
      "id": "evt_001",
      "name": "deploy.success",
      "timestamp": "2026-06-08T14:32:00Z",
      "entities": ["ent_deploy_pipeline"]
    }
  ],
  "cursor": "cur_encoded_next",
  "hasMore": true
}
```

---

#### `GET /timeline/counts`

Cuántos eventos de decisión listaría `GET /timeline` desde un instante, sin recorrer sus
páginas. Solo los tipos de decisión: el tipo de un evento de un hecho se deriva fila por fila, así
que esos no se cuentan. Las decisiones por encima del techo de sensibilidad de quien llama
quedan fuera.

**Permisos**: `read`  
Parámetros de consulta: `?since=2026-06-09T00:00:00Z` (por defecto, hace 24 horas)

```json
// Response 200
{
  "since": "2026-06-09T00:00:00.000Z",
  "counts": { "decision_created": 4, "decision_superseded": 1, "decision_withdrawn": 0 }
}
```

---

### 2.6 Tareas y eventos

#### `POST /tasks`

Crea una tarea.

**Permisos**: `write`

Acepta el campo opcional `targetWorkspaceId` en el cuerpo; consulta §1.1.

```json
// Request
{
  "title": "Migrate fact table to bitemporal schema",
  "description": "Add valid_from/valid_to columns to mnemo_fact",
  "priority": "high",
  "assignedTo": "agent_db_01",
  "dueAt": "2026-06-15T00:00:00Z",
  "relatedFacts": ["fact_xyz789"]
}

// Response 201
{
  "id": "task_001",
  "title": "Migrate fact table to bitemporal schema",
  "status": "pending",
  "priority": "high",
  "assignedTo": "agent_db_01",
  "dueAt": "2026-06-15T00:00:00Z",
  "createdAt": "2026-06-09T12:00:00Z"
}
```

---

#### `PATCH /tasks/:id`

Actualiza el estado o el resultado de una tarea.

**Permisos**: `write`

```json
// Request
{
  "status": "completed",
  "outcome": "Migration completed. Added 2 columns, backfilled 50K rows.",
  "lessonsLearned": "Run ANALYZE after bulk backfill to update planner stats"
}
```

---

#### `GET /tasks`

Lista tareas con filtros.

**Permisos**: `read`  
Parámetros de consulta: `?status=pending&assignedTo=agent_db_01&cursor=xxx&limit=20`

---

#### `POST /tasks/:id/delegate`

Delega una tarea a otro agente.

**Permisos**: `write`

```json
// Request
{ "toAgent": "agent_specialist_02", "context": "Needs schema expertise" }
```

---

#### `POST /events`

Registra un evento inmutable (ancla temporal).

**Permisos**: `write`

Los eventos no se pueden borrar ni olvidar: `DELETE /events/:id` y `DELETE /forget/event/:id` responden **409
`event_immutable`** y no cambian nada (antes informaban de éxito sin cambiar nada — PRIM-10).
Para retractar lo que dice un evento, olvida los hechos derivados de él.

Acepta el campo opcional `targetWorkspaceId` en el cuerpo; consulta §1.1.

```json
// Request
{
  "name": "deploy.success",
  "description": "v3.1.0 deployed to production",
  "type": "system",
  "relatedEntities": ["ent_deploy_pipeline"],
  "metadata": { "version": "3.1.0", "sha": "d0428e7" }
}

// Response 201
{ "id": "evt_001", "name": "deploy.success", "recordedAt": "2026-06-09T14:00:00Z" }
```

---

#### `GET /events`

Consulta eventos por rango de tiempo.

**Permisos**: `read`  
Parámetros de consulta: `?since=2026-06-01T00:00:00Z&until=2026-06-09T00:00:00Z&name=deploy.*&cursor=xxx&limit=50`

---

#### `POST /reminders`

Crea un recordatorio de memoria prospectiva: aparece durante la recuperación cuando se cumple su condición
de tiempo (`triggerAt`), su condición semántica, o ambas (REMIND-1).
Respalda la `action: "create"` de la herramienta MCP `memory_remind_when`.

**Permisos**: `write`

Acepta el campo opcional `targetWorkspaceId` en el cuerpo; consulta §1.1.

```json
// Request
{ "content": "Follow up on the pgvector migration", "triggerAt": "2026-06-20T00:00:00Z" }

// Response 201
{
  "id": "rem_001",
  "content": "Follow up on the pgvector migration",
  "condition": null,
  "triggerAt": "2026-06-20T00:00:00Z",
  "status": "pending",
  "createdAt": "2026-06-09T14:00:00Z",
  "workspaceId": "ws_default"
}
```

---

### 2.7 Destilación de CoT

#### `POST /reasoning`

Crea directamente un registro de cadena de razonamiento (distinto de `/reasoning/record`,
más abajo, que guarda una cadena resuelta mediante el flujo de comprobación de caché de `/reasoning/resolve`).
Respalda la `action: "create"` de la herramienta MCP `memory_reasoning`.

**Permisos**: `write`

Acepta el campo opcional `targetWorkspaceId` en el cuerpo; consulta §1.1.

```json
// Request
{
  "question": "How to handle cursor pagination with concurrent writes?",
  "chain": [{ "step": "Considered offset vs. keyset pagination" }],
  "conclusion": "Use composite cursor (timestamp + id) to maintain stability under concurrent inserts"
}

// Response 201
{ "id": "rsn_002", "question": "...", "conclusion": "...", "workspaceId": "ws_default" }
```

---

#### `POST /reasoning/resolve`

Comprueba si existe una cadena de razonamiento similar antes de ejecutar inferencia con LLM.

**Permisos**: `read`

```json
// Request
{ "query": "How to handle cursor pagination with concurrent writes?", "similarityThreshold": 0.88 }

// Response 200
{
  "cacheHit": true,
  "reasoning": {
    "id": "rsn_001",
    "input": "How to handle cursor pagination...",
    "output": "Use composite cursor (timestamp + id) to maintain stability under concurrent inserts",
    "model": "claude-sonnet-4-5",
    "usedAt": "2026-06-07T10:00:00Z",
    "successRate": 0.95
  }
}
```

---

#### `POST /reasoning/record`

Guarda una cadena de razonamiento exitosa.

**Permisos**: `write`

```json
// Request
{
  "input": "How to handle cursor pagination with concurrent writes?",
  "reasoning": "<full chain of thought>",
  "output": "Use composite cursor (timestamp + id)...",
  "model": "claude-sonnet-4-5",
  "tokensUsed": 512
}
```

---

#### `POST /reasoning/feedback`

Informa de si un resultado de razonamiento en caché tuvo éxito o falló.

**Permisos**: `write`

```json
// Request
{ "reasoningId": "rsn_001", "outcome": "success" }
```

---

### 2.8 Autoedición

#### `POST /self/edit`

El agente edita su propia memoria: añadir, reemplazar, reforzar o debilitar un hecho.

**Permisos**: `write`

```json
// Request
{
  "action": "weaken",
  "target": "fact_abc",
  "reason": "Turned out Redis Sentinel failed to promote in under 5s during the June incident"
}

// Response 200
{ "id": "fact_abc", "confidence": 0.61, "previousConfidence": 0.85, "revision": 3 }
```

Acciones: `append | replace | strengthen | weaken`

`append` y `replace` requieren un `content` no vacío (**400 `self_edit_content_required`**; no se
cambia ni se cobra nada — PRIM-1).

Los presupuestos (PRIM-6) pertenecen a la **credencial autenticada**, nunca al `agentId` del cuerpo: 5 ediciones por
sesión, los topes diarios de borrar/reforzar/debilitar y un enfriamiento de 300 s **por objetivo**. Un `sessionId` abre su
propio presupuesto solo cuando nombra una sesión del espacio de trabajo (`POST /session/start`); en caso contrario, la edición consume
del presupuesto sin sesión de la credencial. HTTP y gRPC comparten los mismos contadores.

---

#### `POST /self/reflect`

Dispara una pasada de autorreflexión: saca a la luz incoherencias, hechos desactualizados y lagunas.

**Permisos**: `write`  
**Nota**: nivel Cognitive (requiere un proveedor de LLM)

```json
// Request
{ "focus": "auth module", "depth": "shallow" }

// Response 202
{ "jobId": "job_reflect_001", "status": "processing" }
```

---

#### `GET /self/profile`

Obtiene el resumen de perfil calculado del agente (fortalezas, lagunas, actividad reciente).

**Permisos**: `read`  
Parámetros de consulta: `?agentId=agent_coder_01`

```json
// Response 200
{
  "agentId": "agent_coder_01",
  "factCount": 142,
  "avgWorth": 0.74,
  "strongAreas": ["PostgreSQL", "authentication"],
  "weakAreas": ["frontend testing"],
  "recentActivity": { "recalls": 23, "writes": 7, "period": "last_7d" }
}
```

---

### 2.9 Memoria procedimental

#### `POST /procedural/optimize`

Envía una trayectoria completada para la evolución del prompt (mejora con el tiempo el prompt de sistema del agente).

**Permisos**: `write`

```json
// Request
{
  "agentId": "agent_coder_01",
  "trajectory": { "steps": [...], "outcome": "success", "rating": 0.9 },
  "currentPromptVersion": "v12"
}
```

---

#### `GET /procedural/prompt/:agent`

Obtiene el prompt de sistema evolucionado actual de un agente.

**Permisos**: `read`

```json
// Response 200
{
  "agentId": "agent_coder_01",
  "promptVersion": "v13",
  "content": "You are a code reviewer...",
  "evolvedAt": "2026-06-08T00:00:00Z",
  "improvementDelta": "+8% task success rate vs v12"
}
```

---

### 2.10 Gobernanza

#### `GET /governance/worth`

Puntuaciones de valor de la memoria: identifica conocimiento de alto y bajo valor.

**Permisos**: `read`  
Parámetros de consulta: `?sort=asc&type=fact&limit=20&cursor=xxx`

```json
// Response 200
{
  "data": [
    {
      "id": "fact_stale_01",
      "content": "...",
      "worth": 0.03,
      "type": "fact",
      "lastRecalledAt": null
    }
  ],
  "cursor": "cur_next",
  "hasMore": false
}
```

---

#### `POST /governance/gate`

Bloquea o desbloquea manualmente una ejecución de consolidación.

**Permisos**: `admin`

```json
// Request
{ "action": "gate", "reason": "Major refactor in progress — hold consolidation" }

// Response 200
{ "consolidationGated": true, "reason": "Major refactor in progress...", "gatedAt": "2026-06-09T12:00:00Z" }
```

---

#### `GET /governance/drift`

Informe de deriva de la memoria: hechos que se han alejado del comportamiento observado.

**Permisos**: `read`

```json
// Response 200
{
  "driftScore": 0.12,
  "driftedFacts": [
    { "id": "fact_001", "statement": "...", "driftReason": "Contradicted by 3 recent events" }
  ],
  "generatedAt": "2026-06-09T06:00:00Z"
}
```

---

### 2.11 Salud y administración

#### `GET /health`

Signos vitales cognitivos del espacio de trabajo para quien llama autenticado (`mountVitals` en
`packages/server/src/routes/health.ts`, respaldado por
`deps.storage.getWorkspaceVitals()`). Requiere
autenticación y se limita al espacio de trabajo de quien llama: NO es una comprobación genérica
de salud de infraestructura o dependencias (esa es `GET /health/ready`, de abajo, sin autenticación y para toda la instancia).

**Permisos**: `read`

```json
// Response 200
{
  "workspaceId": "ws_default",
  "factsLive": 1420,
  "factsClosed": 87,
  "pinnedCount": 34,
  "lastRecallAt": "2026-06-09T05:58:00Z",
  "lastWriteAt": "2026-06-09T04:12:00Z",
  "embeddings": { "indexed": 1390, "pending": 12 }
}
```

La herramienta MCP `memory_status` (`packages/mcp/src/tools/status.ts`) no recibe
parámetros y llama a esta ruta y a otras tres en paralelo, combinándolas
en una sola respuesta: `GET /health/ready` (estado real por dependencia, expuesto
como `dependencyHealth`; de toda la instancia, no del espacio de trabajo), `GET /admin/stats`
(desglose `factsByScopeRef`) y `GET /me` (id del espacio de trabajo personal + recuento de
hechos en vivo, cuando la clave de API está vinculada a un usuario). Cualquiera de las tres llamadas opcionales
que falle se convierte en `null` en lugar de hacer fallar toda la herramienta.

---

#### `GET /health/ready`

Sondeo de disponibilidad real por dependencia (postgres/vector/cache). Sin autenticación
y de toda la instancia; no se limita a un espacio de trabajo. Si postgres cae, devuelve 503;
si caen cache o vector, sigue devolviendo 200 con `degraded: true`.

```json
// Response 200
{
  "status": "ready",
  "degraded": false,
  "checks": { "postgres": "ok", "vector": "ok", "cache": "ok" }
}

// Response 503 (postgres unreachable)
{ "status": "not_ready", "reason": "postgres_unavailable" }
```

---

#### `GET /health/history`

Deriva histórica de la salud. Parámetros de consulta: `?from=2026-06-01&to=2026-06-09&resolution=1h`

**Permisos**: `admin`

---

#### `POST /admin/consolidate`

**Implementado** como alias de ruta en `app.ts` (T6.6): reenvía internamente a
`POST /consolidation/trigger`; consulta `packages/server/src/routes/consolidation.ts`.

Dispara manualmente la consolidación de la memoria (normalmente se ejecuta según un calendario).

**Permisos**: `admin`

```json
// Request (both fields optional; "deep" and dryRun: true answer 422)
{ "mode": "fast", "dryRun": false }

// Response 200 (one tick, run synchronously)
{ "accepted": true, "workspaceId": "00000000-0000-0000-0000-000000000001", "mode": "fast", "dryRun": false, "mergedPairs": 2, "skippedPairs": 5, "candidatesProcessed": 40, "errors": 0, "tookMs": 180 }

// Response 503 when @mnemo-ai/consolidation is not installed
{ "error": { "code": "consolidation_unavailable", "message": "@mnemo-ai/consolidation is not installed. Add it as a dependency and restart the server to enable this endpoint." } }
```

---

#### `GET /admin/stats`

Estadísticas de uso del espacio de trabajo.

**Permisos**: `read` (versión reducida: las claves marcadas como "admin only" más abajo se omiten, no se devuelven como `null`) o `admin` (completa).

```json
// Response 200
{
  "workspaceId": "00000000-0000-0000-0000-000000000001",
  "generatedAt": "2026-11-14T12:00:00.000Z",
  "facts": {
    "live": 1420,
    "closed": 96,
    "pinned": 12,
    "archived": 40, // null when no usable health snapshot
    "withZeroHits": 310, // admin only; null without a snapshot
    "byScopeRef": [{ "scopeRef": "project:abc", "count": 210 }] // admin only
  },
  "decisions": { "active": 87 }, // null without a snapshot
  "relations": { "conflicts": 3 }, // live: the pairs GET /conflicts can list
  "embeddings": { "indexed": 1400, "pending": 20 }, // admin only
  "snapshot": { "at": "2026-11-14T11:55:00.000Z", "ageSeconds": 300, "available": true }, // admin only
  "recall": {
    "hitRate30d": 0.62,
    "lastRecallAt": "2026-11-14T11:59:00.000Z",
    "latencyP50Ms7d": 38, // null with no samples
    "latencyP95Ms7d": 140,
    "precisionAtK": [
      { "k": 1, "precision": 0.8, "sampleSize": 50 },
      { "k": 3, "precision": 0.7, "sampleSize": 140 },
      { "k": 5, "precision": 0.62, "sampleSize": 220 } // precision is null while sampleSize is 0
    ], // admin only, as are the next five; always k = 1, 3 and 5
    "precisionTotalHits": 230,
    "precisionPendingHits": 4,
    "precisionInsufficientData": false,
    "precisionUnavailable": false,
    "precisionMethodologyNote": "…"
  },
  "writesPerDay14d": [{ "day": "2026-11-01", "count": 14 }], // 14 zero-filled UTC days, oldest first
  "lastWriteAt": "2026-11-14T11:58:00.000Z"
}
```

`recall.latencyP50Ms7d` / `latencyP95Ms7d` son percentiles sobre el registro de recuperaciones, que tiene una fila por recuerdo servido: ponderan cada recuperación por la cantidad de recuerdos que sirvió, y una recuperación que no sirvió nada no cuenta. `writesPerDay14d` cuenta `mnemo_fact.created_at`.

---

#### `GET /recall/metrics`

Actividad de recuperación por día UTC. Parámetro: `?days=30` (de 7 a 90, 30 por defecto; fuera de ese rango, 400).

**Permisos**: `read`

```json
// Response 200
{
  "days": [
    { "day": "2026-10-19", "queries": 0, "zeroHitShare": null, "p50Ms": null, "p95Ms": null },
    { "day": "2026-11-17", "queries": 42, "zeroHitShare": 0.07, "p50Ms": 36, "p95Ms": 128 }
  ], // exactly `days` entries ending today, zero-filled, oldest first
  "totals": { "queries": 610, "zeroHitShare": 0.09, "p50Ms": 34, "p95Ms": 140 } // the whole window
}
```

- `queries` cuenta llamadas de recuperación (`POST /recall`, `/recall/hot`, `/recall/unified`, `/recall/explain`): cada una escribe una entrada `recall` en la auditoría, devuelva lo que devuelva. El registro de recuperaciones no puede contarlas, porque tiene una fila por hecho servido y ninguna para una llamada que no sirvió nada.
- `zeroHitShare` es la proporción de esas llamadas que no devolvieron nada, sobre las llamadas cuyo detalle de auditoría se puede leer. Un detalle cifrado con la clave del actor oculta su cantidad de resultados, así que esas llamadas quedan fuera de la proporción. `null` cuando ninguna llamada de la ventana se puede leer.
- `p50Ms` / `p95Ms` son por llamada: la fila de primer rango del registro de recuperaciones de cada llamada que sirvió un hecho (a diferencia de `/admin/stats`, que pondera una llamada por la cantidad de recuerdos que sirvió). `null` sin muestras.

---

#### `GET /facts/stats`

Conteos de los hechos vivos (abiertos, `active`) que quien llama puede leer. Los hechos por encima de su techo de sensibilidad no se cuentan, igual que en cualquier listado.

**Permisos**: `read`

```json
// Response 200
{
  "live": 1420,
  "pinned": 12,
  "neverRecalled": 310, // hit_count = 0
  "lastWriteAt": "2026-11-17T18:02:11.000Z", // the latest created_at of these same facts; null when none
  "byKind": [
    { "kind": "preference", "count": 610 },
    { "kind": "architecture", "count": 220 }
  ],
  "bySensitivity": [
    { "sensitivity": "internal", "count": 1300 },
    { "sensitivity": "public", "count": 120 }
  ],
  "byMemoryType": [
    { "memoryType": "semantic", "count": 1400 },
    { "memoryType": "episodic", "count": 20 }
  ]
}
```

Cada desglose lista sus grupos de mayor a menor y omite los vacíos; los conteos de un desglose suman `live`.

---

#### `GET /graph/stats`

Conteos del grafo que quien llama puede leer, sacados de la misma instantánea que dibuja `GET /graph?includeMentions=true`: entidades canónicas, decisiones activas y episodios no sintéticos en su techo de sensibilidad o por debajo, y las relaciones tipadas abiertas entre ellos (las descartadas y los vecinos semánticos quedan fuera).

**Permisos**: `read`

```json
// Response 200
{
  "entities": 84,
  "decisions": 12,
  "episodes": 30,
  "relations": 140, // open typed relations between readable nodes
  "conflicts": 2, // open fact conflicts, the same count as GET /conflicts' total
  "isolated": 9, // entities with no relation and no mention
  "entitiesByKind": [{ "kind": "person", "count": 31 }],
  "relationsByType": [{ "relation": "related", "count": 96 }],
  "hubs": [{ "id": "ent_…", "label": "Atlas", "degree": 22 }] // top 5 by links (relations and mentions)
}
```

Los grupos van de mayor a menor y luego por nombre; los vacíos se omiten.

---

#### `GET /session/stats`

Sesiones y episodios en una ventana de días UTC. Parámetro: `?days=30` (de 7 a 90, 30 por defecto; fuera de ese rango, 400).

**Permisos**: `read`

```json
// Response 200
{
  "days": [{ "day": "2026-11-17", "active": 2, "collapsed": 5, "archived": 0 }], // sessions started that day, by current status; `days` entries, oldest first
  "totals": {
    "sessions": 41, // sessions started in the window
    "collapsed": 33, // of those, collapsed into memory
    "avgTurns": 12.4, // null with no session
    "episodes": 30, // non-synthetic episodes that occurred in the window, under the ceiling
    "factsPerEpisode": 3.1 // mean of their linked facts the caller can read; null with no episode
  },
  "topics": [{ "topic": "checkout", "count": 7 }] // the five topics most of those episodes carry
}
```

Las sesiones no tienen contenido y se cuentan todas; los episodios y los hechos vinculados por encima del techo de sensibilidad de quien llama, no.

---

#### `GET /health/snapshots`

Las instantáneas diarias de salud del espacio (`mnemo_health`, que escribe el job de instantáneas), como proporciones y tasas. Parámetro: `?days=30` (de 7 a 90, 30 por defecto; fuera de ese rango, 400).

**Permisos**: `admin`

```json
// Response 200
{
  "days": [
    {
      "day": "2026-11-16",
      "recallHitRate30d": null,
      "zeroHitShare": null,
      "embeddedShare": null,
      "failedJobs7d": null
    },
    {
      "day": "2026-11-17",
      "recallHitRate30d": 0.42,
      "zeroHitShare": 0.31,
      "embeddedShare": 0.97,
      "failedJobs7d": 0
    }
  ] // exactly `days` entries ending today, oldest first; a day without a snapshot is all null
}
```

Cada día es la última instantánea de ese día. Una instantánea abarca todos los niveles de sensibilidad, así que solo se devuelven proporciones y tasas, nunca conteos de filas: `zeroHitShare` es hechos nunca recuperados sobre hechos activos y `embeddedShare`, con embedding sobre con y sin embedding.

---

#### `GET /audit/stats`

El registro de deshacer (`GET /audit`) contado por día UTC: olvidos de personas y archivados del sistema. Parámetro: `?days=30` (de 7 a 90, 30 por defecto; fuera de ese rango, 400).

**Permisos**: `read`

```json
// Response 200
{
  "days": [{ "day": "2026-11-17", "user": 3, "system": 12 }], // exactly `days` entries ending today, zero-filled, oldest first
  "totals": { "user": 41, "system": 230 } // the whole window
}
```

Los hechos por encima del techo de sensibilidad de quien llama no se cuentan, igual que en el listado.

---

#### `GET /me/activity`

Las entradas propias de quien llama en el registro de auditoría de este espacio: la persona que inició sesión en el dashboard o la clave en la API. Parámetro: `?days=30` (de 7 a 90, 30 por defecto; fuera de ese rango, 400).

**Permisos**: `read`

```json
// Response 200
{
  "days": [{ "day": "2026-11-17", "count": 14 }], // exactly `days` entries ending today, zero-filled, oldest first
  "byAction": [{ "action": "recall", "count": 120 }], // the window's entries, largest first
  "lastAt": "2026-11-17T18:02:11.000Z" // the latest entry ever; null when none
}
```

---

#### `POST /admin/erasure`

Borrado criptográfico (RGPD, artículo 17) de una persona o actor en el espacio de trabajo de
quien llama (`routes/admin-erasure.ts`, sección 8 de SECURITY.md). `userId` destruye todas las
claves de cifrado de ese usuario de la plataforma; `actorId` (la referencia `key:<id>` que
llevan los hechos del actor) destruye la clave de ese actor. Las columnas confidenciales y
restringidas cifradas con esas claves ya no se pueden descifrar; no se borra ninguna fila.
Irreversible. CLI: `mnemo erase`.

**Permisos**: `memory:hard_delete`

```json
// Request: exactly one of userId / actorId; confirm repeats it
{ "actorId": "key:mk_0123456789abcdef", "confirm": "key:mk_0123456789abcdef" }

// Response 200
{ "subject": { "kind": "actor", "id": "key:mk_0123456789abcdef" }, "keysDestroyed": 1 }
```

`400` si vienen los dos sujetos o ninguno, o si `confirm` no lo repite; `404` si ese sujeto no
tiene ninguna clave activa (ya se borró); `501` si el adaptador de almacenamiento no puede
destruir claves. Auditoría: `erasure_initiated` antes de tocar ninguna clave (si no se puede
escribir, no se destruye nada) y después un `erasure_complete` terminal.

---

#### `POST /admin/export`

**Implementado** como alias de ruta en `app.ts` (T6.6): reenvía internamente a
`POST /export`.

Inicia una exportación completa de la memoria (asíncrona, formato JSONL).

**Permisos**: `admin`

El filtro `types` todavía no está implementado: un cuerpo que lo envía recibe `400`, y la exportación siempre incluye todos los tipos.

```json
// Request
{ "format": "jsonl", "includeEmbeddings": false }

// Response 202
{ "jobId": "job_exp_001", "status": "processing", "estimatedSeconds": 30 }
```

Formato del archivo de exportación: `workspace_{id}_{timestamp}.jsonl.gz`  
Cada línea: `{ "type": "fact", "id": "...", "data": {...}, "metadata": { "createdAt": "...", "worth": 0.87 } }`

---

#### `POST /admin/import`

**Implementado** como alias de ruta en `app.ts` (T6.6): reenvía internamente a
`POST /import`.

Importación masiva desde un archivo de exportación. Admite los formatos de Mem0, Zep/Graphiti y memoria de Claude mediante el indicador `--from`.

**Permisos**: `admin`

```json
// Request
{
  "format": "jsonl",
  "sourceFormat": "mnemosyne-export-v1",
  "conflictResolution": "theirs_wins",
  "dryRun": false
}
// Body: multipart/form-data with file upload, OR { "url": "https://..." }

// Response 202
{ "jobId": "job_imp_001", "status": "processing" }
```

`conflictResolution`: `"theirs_wins" | "ours_wins" | "newest_wins" | "skip"`

Techo de sensibilidad: una línea cuya propia `sensitivity` supera el techo de quien llama se omite
(motivo `above-ceiling`), y una fila existente por encima de él nunca se empareja ni se sobrescribe
(la línea se importa como una fila nueva, igual que con un id que no nombra nada).

---

### 2.12 Federación

#### `POST /memory/federation/sync`

Envía o recibe conocimiento de una instancia remota de Mnemosyne.

**Permisos**: `federation`

```json
// Request
{ "peerId": "peer_instance_02", "direction": "bidirectional", "since": "2026-06-08T00:00:00Z" }

// Response 202
{ "jobId": "job_sync_001", "status": "processing" }
```

---

#### `GET /memory/federation/peers`

Lista las instancias par conectadas.

**Permisos**: `federation`

```json
// Response 200
{
  "data": [
    {
      "id": "peer_instance_02",
      "url": "https://remote.example.com",
      "lastSync": "2026-06-09T06:00:00Z",
      "status": "healthy"
    }
  ]
}
```

---

#### `POST /memory/federation/resolve`

Resuelve un conflicto entre instancias (hechos en conflicto de dos pares).

**Permisos**: `federation`

```json
// Request
{
  "conflictId": "conf_001",
  "resolution": "local_wins",
  "reason": "Local instance has more recent evidence"
}
```

---

### 2.13 Webhooks

```
POST   /webhooks          # Register endpoint
GET    /webhooks          # List endpoints
DELETE /webhooks/:id      # Remove endpoint
POST   /webhooks/:id/test # Send test event
GET    /webhooks/:id/deliveries  # Delivery log (last 30 days)
```

Consulta la [sección 11 — Entrega de webhooks](#11-entrega-de-webhooks) para ver todos los detalles.

---

### 2.14 Multi-tenancy: tenants, espacios de trabajo, usuarios y tokens

Consulta [MULTI_TENANCY.md](./MULTI_TENANCY.md) para ver el modelo completo (tenant frente a espacio de trabajo, los dos planos de autoridad, el estrechamiento de rol→permisos, la receta de incorporación y lo que se decidió deliberadamente no construir). Esta sección es solo la referencia de rutas.

Las 16 rutas de abajo las monta `packages/server/src/routes/tenants.ts` (13 rutas) y `packages/server/src/routes/user-tokens.ts` (3 rutas). `TenantRole` = `owner | admin | member` (gobierna las operaciones del plano de tenant, permiso `admin:tenant`). `WorkspaceRole` = `owner | admin | write | read` (gobierna las operaciones del plano de espacio de trabajo —hechos/recall/remember/etc.— mediante el estrechamiento de rol→permisos del servidor, no mediante un permiso propio).

#### `POST /tenants`

Crea un tenant. **Permisos**: `admin:tenant`; quien llama, si está vinculado a un usuario, debe ser `owner` o `admin` de su propio tenant (si no, 403), y pasa a ser el `owner` del nuevo tenant. Su clave sigue actuando en su tenant anterior (MULTI_TENANCY.md §5). Con `"issueOwnerToken": true` (y un `workspaceName` opcional), la respuesta también incluye `workspace`, el primer espacio de trabajo del tenant, y `ownerToken`, un token `uk_live_*` del usuario de quien llama vinculado al nuevo tenant, dentro de los permisos y el techo propios de quien llama; la `key` en texto plano se muestra una sola vez. 400 cuando la clave no tiene usuario.

```json
// Request
{ "name": "Acme", "kind": "organization", "plan": "free" }
// Response 201
{ "id": "tenant_1", "name": "Acme", "kind": "organization", "plan": "free", "createdAt": "2026-01-01T00:00:00Z" }
```

#### `GET /tenants/:tenantId`

Obtiene la información del tenant. **Permisos**: `admin:tenant`. 404 si la clave o el token de quien llama está vinculado a otro tenant.

#### `GET /tenants/:tenantId/members`

Lista los miembros del tenant con su `TenantRole`. **Permisos**: `admin:tenant`.

```json
// Response 200
{ "members": [{ "userId": "user_1", "role": "owner", "joinedAt": "2026-01-01T00:00:00Z" }] }
```

#### `POST /tenants/:tenantId/members`

Invita a un usuario por correo electrónico. **Permisos**: `admin:tenant`; quien llama debe ser owner/admin del tenant.

```json
// Request
{ "email": "new@example.com", "role": "member", "createIfMissing": true }
// Response 200
{ "ok": true }
```

`createIfMissing: true` aprovisiona automáticamente un usuario (+ tenant personal + espacio de trabajo personal, el mismo flujo que `POST /users`) cuando el correo aún no tiene cuenta, y después añade la membresía: cierra en una sola llamada la brecha de «invitar a alguien que nunca ha usado Mnemosyne». El valor por defecto `false` conserva el comportamiento original de 404 ante un correo desconocido. Quien llama, si está vinculado a un usuario, solo encuentra miembros de su propio tenant y cuentas que ese tenant aprovisionó: cualquier otro correo registrado responde 404, o 409 con `createIfMissing` (MULTI_TENANCY.md §5 explica el porqué).

#### `DELETE /tenants/:tenantId/members/:userId`

Elimina a un miembro del tenant. **Permisos**: `admin:tenant`; quien llama debe ser owner/admin del tenant.

#### `POST /users`

Crea un usuario (crea automáticamente un tenant personal + un espacio de trabajo personal, ambos propiedad del usuario). **Permisos**: `admin:tenant`; quien llama, si está vinculado a un usuario, debe ser `owner` o `admin` de su propio tenant (si no, 403). El usuario nuevo no se une a ningún tenant de quien llama: invítalo con `POST /tenants/:tenantId/members`, que encuentra las cuentas que el tenant de quien llama aprovisionó.

```json
// Response 201
{
  "user": {
    "id": "user_1",
    "email": "a@b.com",
    "displayName": null,
    "personalTenantId": "tenant_1",
    "createdAt": "..."
  },
  "personalTenant": {
    "id": "tenant_1",
    "name": "a@b.com",
    "kind": "personal",
    "plan": "free",
    "createdAt": "..."
  },
  "personalWorkspace": {
    "id": "ws_1",
    "name": "a@b.com's workspace",
    "slug": null,
    "tenantId": "tenant_1",
    "visibility": "private",
    "createdAt": "..."
  }
}
```

400 si el correo ya está registrado.

#### `GET /users/me`

Obtiene la fila del usuario actual (id/email/displayName/personalTenantId), derivada del vínculo `userId` de la clave de API (no de `actorId`; consulta «Provenance identity» en CLAUDE.md). **Permisos**: `memory:read`. Distinto de `GET /me` (abajo), que devuelve campos del contexto de autenticación (permisos, workspaceRole, etc.), no la fila de usuario de la base de datos.

#### `POST /tenants/:tenantId/workspaces`

Crea un espacio de trabajo dentro de un tenant. **Permisos**: `admin:tenant`; quien llama, si está vinculado a un usuario, debe ser `owner` o `admin` del tenant. `ownerUserId` toma por defecto el usuario de quien llama y debe ser miembro del tenant (si no, 403 y no se crea nada); el propietario recibe la primera membresía del espacio de trabajo, con rol `owner`. Una clave sin usuario y sin `ownerUserId` crea un espacio de trabajo sin miembros.

```json
// Request
{ "name": "Prod memory", "slug": "prod", "visibility": "private", "ownerUserId": "user_1" }
// Response 201
{ "id": "ws_2", "name": "Prod memory", "slug": "prod", "tenantId": "tenant_1", "visibility": "private", "createdAt": "..." }
```

#### `GET /tenants/:tenantId/workspaces`

Lista los espacios de trabajo de un tenant. **Permisos**: `admin:tenant`.

```json
// Response 200
{
  "workspaces": [
    { "id": "ws_1", "name": "...", "slug": null, "visibility": "private", "memberCount": 3 }
  ]
}
```

#### `GET /workspaces/mine`

Lista los espacios de trabajo a los que pertenece el usuario autenticado, CON el rol de quien llama en cada uno. **Permisos**: cualquiera de `memory:read`, `memory:admin` (un miembro con rol `read` debe poder descubrir igualmente sus propias membresías; consulta la tabla de rol→permisos de MULTI_TENANCY.md). 404 cuando la clave no tiene vínculo con un usuario.

```json
// Response 200
{
  "workspaces": [
    {
      "workspaceId": "ws_1",
      "workspaceName": "Prod memory",
      "role": "write",
      "visibility": "private"
    }
  ]
}
```

#### `GET /workspaces/:workspaceId`

Obtiene un espacio de trabajo por id. Requiere ser miembro: devuelve 404 (no 403) a quien no lo es, según el invariante antisondeo (CLAUDE.md S6). **Permisos**: `memory:read` o `memory:admin`.

#### `POST /workspaces/:workspaceId/members`

Invita a un usuario a un espacio de trabajo con un `WorkspaceRole` (por defecto `read`). **Permisos**: `memory:admin`; quien llama debe ser owner/admin del espacio de trabajo. El usuario invitado ya debe pertenecer al tenant del espacio de trabajo (si no, 403).

```json
// Request
{ "userId": "user_2", "role": "write" }
```

#### `GET /workspaces/:workspaceId/members`

Lista los miembros del espacio de trabajo con su `WorkspaceRole`. **Permisos**: `memory:read` o `memory:admin`.

#### `DELETE /workspaces/:workspaceId/members/:userId`

Elimina a un miembro del espacio de trabajo. **Permisos**: `memory:admin`; quien llama debe ser owner/admin del espacio de trabajo.

#### `PATCH /workspaces/:workspaceId/members/:userId`

Cambia el rol de un miembro del espacio de trabajo. **Permisos**: `memory:admin`; quien llama debe ser owner/admin del espacio de trabajo.

```json
// Request
{ "role": "admin" }
```

#### `POST /tenants/:tenantId/users/:userId/tokens`

Emite un token de usuario `uk_live_*` para **otro** miembro del tenant (no para quien llama). **Permisos**: `admin:tenant`; quien llama debe ser owner/admin del tenant. Es deliberadamente una ruta propia, no una extensión de `POST /admin/keys`, porque `admin:keys` es alcanzable con rol de administrador del espacio de trabajo tras el estrechamiento y permitiría a un administrador del espacio de trabajo suplantar a cualquier miembro del tenant. Consulta MULTI_TENANCY.md.

```json
// Request
{ "label": "B's token", "homeWorkspaceId": "ws_1", "scopes": ["memory:read", "memory:write"], "expiresIn": "90d" }
// Response 201
{ "id": "uk_abc", "key": "uk_live_...", "label": "B's token", "scopes": ["memory:read", "memory:write"], "userId": "user_2", "tenantId": "tenant_1", "workspaceId": "ws_1", "expiresAt": "...", "createdAt": "..." }
```

`key` se devuelve **una sola vez**; no se puede recuperar de nuevo. Orden de validación (cada paso es un 404 antisondeo distinto, salvo el último, que es accionable y por eso sigue siendo 400): el destino es miembro del tenant → el espacio de trabajo principal pertenece a este tenant → el destino es miembro de ese espacio de trabajo → los permisos solicitados (si los hay) ⊆ los permisos propios de quien LLAMA.

#### `GET /tenants/:tenantId/users/:userId/tokens`

Lista los tokens de usuario de un miembro del tenant (secretos enmascarados; nunca se devuelven después de la creación). **Permisos**: `admin:tenant`; quien llama debe ser owner/admin del tenant.

#### `DELETE /tenants/:tenantId/users/:userId/tokens/:keyId`

Revoca un token de usuario. **Permisos**: `admin:tenant`; quien llama debe ser owner/admin del tenant. 404 si el token no existe, ya está revocado o pertenece a otro usuario o tenant.

---

## 3. Herramientas MCP

> **Estado de la implementación (2026-06-22, v3.3):** las 26 herramientas están activas en `@mnemo-ai/mcp`. 0 stubs.
> **Activas (registradas, 26):** memory_recall, memory_remember, memory_pin, memory_forget, memory_timeline, memory_search, memory_relate, memory_decide, memory_entity, memory_status, memory_remind_when, memory_consolidate, memory_episode_start, memory_episode_end, memory_event, memory_reasoning, memory_strategy, memory_self_edit, memory_hyperedge, memory_introspect, memory_anticipate, memory_compose, memory_workflow, memory_skill, memory_task, memory_session
> Los esquemas de herramientas documentados en esta especificación no coinciden 1:1 con las herramientas implementadas: la especificación usa nombres más antiguos (numeración Herramienta 1–13). Consulta [packages/mcp/README.es.md](../../packages/mcp/README.es.md) para ver la lista de herramientas activas y los esquemas de referencia.

El servidor MCP expone herramientas por stdio. Las llamadas a herramientas se limitan al espacio de trabajo de la clave de API usada para conectar el servidor MCP.

### 3.1 Herramientas efímeras dinámicas (memoria ejecutable) — IDEA FUTURA, NO IMPLEMENTADA

> **Nota:** el mecanismo de herramientas efímeras `mnemo_exec_*` descrito a continuación **no existe** en la implementación actual. Ningún código de `@mnemo-ai/mcp` registra herramientas automáticamente en el momento de la recuperación. Esta sección describe una idea de diseño futura y se conserva solo como contexto.

La idea: Mnemosyne podría ampliar dinámicamente el espacio de acciones del agente.
Cuando `memory_recall` recupera un primitivo `mnemo_skill` o `mnemo_workflow` que el Core considera muy relevante (confianza > 0.9), el servidor MCP de Mnemosyne registraría automáticamente una herramienta efímera al vuelo.

- Ejemplo: si el agente recupera la habilidad «Deploy to pre-prod», una herramienta efímera `mnemo_exec_deploy_pre_prod` pasaría a estar disponible en el contexto MCP.
- Estas herramientas desaparecerían cuando termine la sesión o cambie el contexto.

**Realidad actual:** las habilidades y los flujos de trabajo se devuelven como resultados estructurados de recuperación: el agente lee los pasos y actúa directamente sobre ellos.

Todos los esquemas de herramientas de abajo son compatibles con JSON Schema (Draft 7).

---

### Herramienta 1: `memory_recall`

Busca en la memoria conocimiento relevante. Devuelve hechos, decisiones y estrategias ordenados por relevancia y valor.

```json
{
  "name": "memory_recall",
  "description": "Search your memory for relevant knowledge. Returns facts, decisions, strategies ranked by relevance and worth.",
  "inputSchema": {
    "type": "object",
    "required": ["query"],
    "properties": {
      "query": { "type": "string", "description": "Natural language question or topic" },
      "types": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": ["fact", "decision", "strategy", "episode", "workflow", "skill"]
        },
        "description": "Filter by memory type"
      },
      "limit": { "type": "number", "default": 5, "maximum": 20 },
      "includeGraph": {
        "type": "boolean",
        "default": false,
        "description": "Expand results via knowledge graph relations"
      },
      "asOf": {
        "type": "string",
        "format": "date-time",
        "description": "ISO date for time-travel query"
      }
    }
  }
}
```

**Ejemplo**:

```json
{ "query": "What do we know about Redis caching?", "types": ["fact", "strategy"], "limit": 3 }
```

**Respuesta**: arreglo de elementos de memoria con `id`, `type`, `content`, `confidence`, `worth`, `relevanceScore`.

---

### Herramienta 2: `memory_remember`

Guarda conocimiento nuevo en la memoria a largo plazo. Detecta conflictos automáticamente y gestiona la deduplicación.

```json
{
  "name": "memory_remember",
  "inputSchema": {
    "type": "object",
    "required": ["content", "type"],
    "properties": {
      "content": { "type": "string", "description": "What to remember" },
      "type": { "type": "string", "enum": ["fact", "decision", "strategy", "workflow", "skill"] },
      "topicKey": {
        "type": "string",
        "description": "Stable key for evolving facts — same key = update, not duplicate"
      },
      "confidence": { "type": "number", "minimum": 0, "maximum": 1, "default": 0.8 },
      "relatedEntities": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Entity names to link"
      },
      "validUntil": {
        "type": "string",
        "format": "date-time",
        "description": "When this knowledge becomes outdated"
      }
    }
  }
}
```

**Ejemplo**:

```json
{
  "content": "PostgreSQL is the primary datastore. Redis is optional and gracefully degraded if unavailable.",
  "type": "fact",
  "topicKey": "infra/datastore-stack",
  "confidence": 0.99
}
```

---

### Herramienta 3: `memory_forget`

Marca el conocimiento como ya no válido. Cierra la ventana de vigencia pero conserva el historial.

```json
{
  "name": "memory_forget",
  "inputSchema": {
    "type": "object",
    "required": ["factId", "reason"],
    "properties": {
      "factId": { "type": "string", "description": "ID of the fact to forget" },
      "reason": { "type": "string", "description": "Why this is no longer valid" }
    }
  }
}
```

**Ejemplo**:

```json
{ "factId": "fact_redis_v7", "reason": "Upgraded to Redis 8.0 in June 2026" }
```

---

### Herramienta 4: `memory_session`

Gestiona la sesión de trabajo. Fija turnos importantes, añade notas de borrador y colapsa al terminar.

```json
{
  "name": "memory_session",
  "inputSchema": {
    "type": "object",
    "required": ["action"],
    "properties": {
      "action": { "type": "string", "enum": ["pin", "scratch", "collapse", "discard"] },
      "pin": {
        "type": "object",
        "properties": {
          "turnIndex": { "type": "number" },
          "label": { "type": "string" }
        }
      },
      "scratch": {
        "type": "object",
        "properties": {
          "key": { "type": "string" },
          "value": {}
        }
      },
      "collapseHint": { "type": "string", "description": "Guidance for extraction during collapse" }
    }
  }
}
```

**Ejemplo (colapsar)**:

```json
{ "action": "collapse", "collapseHint": "Extract decisions about pagination and auth" }
```

---

### Herramienta 5: `memory_task`

Crea, actualiza, delega o completa tareas. Las tareas completadas generan estrategias automáticamente.

```json
{
  "name": "memory_task",
  "inputSchema": {
    "type": "object",
    "required": ["action"],
    "properties": {
      "action": { "type": "string", "enum": ["create", "update", "delegate", "list", "complete"] },
      "create": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "description": { "type": "string" },
          "priority": { "type": "string", "enum": ["low", "medium", "high", "critical"] },
          "dueAt": { "type": "string", "format": "date-time" },
          "relatedFacts": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["title"]
      },
      "update": {
        "type": "object",
        "properties": {
          "taskId": { "type": "string" },
          "status": {
            "type": "string",
            "enum": ["pending", "in_progress", "blocked", "completed", "cancelled"]
          },
          "outcome": { "type": "string" }
        },
        "required": ["taskId"]
      },
      "delegate": {
        "type": "object",
        "properties": {
          "taskId": { "type": "string" },
          "toAgent": { "type": "string" },
          "context": { "type": "string" }
        },
        "required": ["taskId", "toAgent"]
      },
      "complete": {
        "type": "object",
        "properties": {
          "taskId": { "type": "string" },
          "outcome": { "type": "string" },
          "lessonsLearned": { "type": "string" }
        },
        "required": ["taskId", "outcome"]
      },
      "list": {
        "type": "object",
        "properties": {
          "status": { "type": "string" },
          "assignedTo": { "type": "string" }
        }
      }
    }
  }
}
```

---

### Herramienta 6: `memory_event`

Registra que algo ocurrió. Los eventos son inmutables y crean anclas temporales.

```json
{
  "name": "memory_event",
  "inputSchema": {
    "type": "object",
    "required": ["name", "description", "type"],
    "properties": {
      "name": {
        "type": "string",
        "description": "Event name, e.g. 'deploy.success', 'user.complained'"
      },
      "description": { "type": "string" },
      "type": { "type": "string", "enum": ["system", "external", "user", "agent", "scheduled"] },
      "relatedEntities": { "type": "array", "items": { "type": "string" } },
      "metadata": { "type": "object" }
    }
  }
}
```

**Ejemplo**:

```json
{
  "name": "deploy.failure",
  "description": "v3.0.1 rollback triggered — p99 latency exceeded 2s",
  "type": "system",
  "relatedEntities": ["deploy_pipeline"],
  "metadata": { "version": "3.0.1", "p99Ms": 2340 }
}
```

---

### Herramienta 7: `memory_reasoning`

Comprueba si ya resolviste un problema similar antes (ahorra tokens mediante CoT en caché).

```json
{
  "name": "memory_reasoning",
  "inputSchema": {
    "type": "object",
    "required": ["action"],
    "properties": {
      "action": { "type": "string", "enum": ["resolve", "record", "feedback"] },
      "resolve": {
        "type": "object",
        "properties": { "query": { "type": "string" } },
        "required": ["query"]
      },
      "record": {
        "type": "object",
        "properties": {
          "input": { "type": "string" },
          "reasoning": { "type": "string" },
          "output": { "type": "string" },
          "model": { "type": "string" }
        },
        "required": ["input", "reasoning", "output", "model"]
      },
      "feedback": {
        "type": "object",
        "properties": {
          "reasoningId": { "type": "string" },
          "outcome": { "type": "string", "enum": ["success", "failure"] }
        },
        "required": ["reasoningId", "outcome"]
      }
    }
  }
}
```

---

### Herramienta 8: `memory_self_edit`

Edita tu propia memoria. Corrige errores, refuerza el conocimiento útil y debilita los hechos poco fiables.

```json
{
  "name": "memory_self_edit",
  "inputSchema": {
    "type": "object",
    "required": ["action", "target", "reason"],
    "properties": {
      "action": {
        "type": "string",
        "enum": ["append", "replace", "strengthen", "weaken", "reflect"]
      },
      "target": { "type": "string", "description": "fact_id or 'profile'" },
      "content": { "type": "string", "description": "New content for append or replace actions" },
      "reason": {
        "type": "string",
        "description": "Required — explains why this edit is warranted"
      }
    }
  }
}
```

**Ejemplo**:

```json
{
  "action": "strengthen",
  "target": "fact_pg_serializable",
  "reason": "Confirmed in production — zero idempotency collisions over 30 days"
}
```

---

### Herramienta 9: `memory_entity`

Gestiona entidades (personas, proyectos, sistemas) en tu grafo de conocimiento.

```json
{
  "name": "memory_entity",
  "inputSchema": {
    "type": "object",
    "required": ["action"],
    "properties": {
      "action": { "type": "string", "enum": ["find", "create", "link", "graph"] },
      "find": {
        "type": "object",
        "properties": { "name": { "type": "string" } },
        "required": ["name"]
      },
      "create": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "kind": {
            "type": "string",
            "enum": ["person", "project", "system", "concept", "organization"]
          },
          "aliases": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["name", "kind"]
      },
      "link": {
        "type": "object",
        "properties": {
          "fromEntity": { "type": "string" },
          "toEntity": { "type": "string" },
          "verb": { "type": "string" },
          "context": { "type": "string" }
        },
        "required": ["fromEntity", "toEntity", "verb"]
      },
      "graph": {
        "type": "object",
        "properties": {
          "entityId": { "type": "string" },
          "depth": { "type": "number", "default": 2 }
        },
        "required": ["entityId"]
      }
    }
  }
}
```

---

### Herramienta 10: `memory_timeline`

Consulta la línea de tiempo de eventos y episodios. Útil para entender qué ocurrió y cuándo.

```json
{
  "name": "memory_timeline",
  "inputSchema": {
    "type": "object",
    "properties": {
      "from": { "type": "string", "format": "date-time" },
      "to": { "type": "string", "format": "date-time" },
      "entityId": { "type": "string", "description": "Filter by entity" },
      "types": {
        "type": "array",
        "items": { "type": "string", "enum": ["event", "session", "episode", "task"] }
      },
      "limit": { "type": "number", "default": 20, "maximum": 100 }
    }
  }
}
```

---

### Herramienta 11: `memory_introspect`

Devuelve el `SelfModel` del espacio de trabajo (metacognición §31, `buildSelfModel` en
`packages/core/src/cognitive/metacognition.ts`, servido mediante
`GET /metacognition`): temas bien conocidos (valor alto + evidencia), lagunas de
conocimiento (recuperadas a menudo pero con poca certeza) y un resumen agregado.

```json
{
  "name": "memory_introspect",
  "inputSchema": {
    "type": "object",
    "properties": {
      "aspect": {
        "type": "string",
        "enum": [
          "coverage",
          "trends",
          "gaps",
          "strengths",
          "all",
          "health",
          "worth",
          "drift",
          "types",
          "recent_changes"
        ],
        "default": "all"
      },
      "entity": {
        "type": "string",
        "description": "Case-insensitive substring filter on topic/entity name"
      },
      "limit": { "type": "number", "default": 10, "minimum": 1, "maximum": 200 }
    }
  }
}
```

Ningún campo es obligatorio: `aspect` vale `"all"` por defecto. Los últimos cinco valores
del enum (`health`, `worth`, `drift`, `types`, `recent_changes`) son alias heredados de §29
que la herramienta asigna a los aspectos reales de §31 antes de llamar al backend:
`health`→`all`, `worth`→`strengths`, `drift`→`trends`, `types`→`coverage`,
`recent_changes`→`trends`. `limit` limita cada una de las cuatro listas devueltas
(`confidenceMap`, `strongTopics`, `strengths`, `gaps`) de forma independiente; no
limita la respuesta en su conjunto.

**Ejemplo**:

```json
{ "aspect": "gaps", "limit": 5 }
```

**Respuesta** (la forma es siempre el mismo `SelfModel`; los aspectos no solicitados
vuelven como arreglos vacíos en lugar de omitirse):

```json
{
  "workspaceId": "ws_default",
  "generatedAt": "2026-06-09T06:00:00Z",
  "confidenceMap": [
    {
      "entity": "auth-module",
      "coverage": "familiar",
      "freshness": "recent",
      "factCount": 12,
      "avgWorth": 0.68
    }
  ],
  "strongTopics": [
    { "topicKey": "auth-module", "memoryCount": 12, "avgWorth": 0.81, "evidenceVolume": 9 }
  ],
  "strengths": [{ "topic": "auth-module", "avgWorth": 0.81, "factCount": 12 }],
  "gaps": [
    {
      "topicKey": "billing-webhooks",
      "gapScore": 0.62,
      "recallHits30d": 7,
      "avgWorth": 0.18,
      "memoryCount": 2,
      "suggestedAction": "search_codebase"
    }
  ],
  "summary": {
    "totalTopics": 34,
    "strongTopicsCount": 6,
    "gapsCount": 3,
    "blindCount": 1,
    "avgWorthAcrossWorkspace": 0.5421
  }
}
```

`trends` (solo presente cuando `aspect` es `"trends"` o `"all"`) es
`{ recallHitRate, avgRecallLatency, sessionCollapseQuality, strategySuccessRate }`,
cada uno una tripleta `{ current, previous, delta }`.

---

### Herramienta 12: `memory_strategy`

Guarda o recupera estrategias de comportamiento: patrones «cuando X, haz Y» aprendidos de la experiencia.

```json
{
  "name": "memory_strategy",
  "inputSchema": {
    "type": "object",
    "required": ["action"],
    "properties": {
      "action": { "type": "string", "enum": ["recall", "store", "rate"] },
      "recall": {
        "type": "object",
        "properties": { "situation": { "type": "string" } },
        "required": ["situation"]
      },
      "store": {
        "type": "object",
        "properties": {
          "trigger": { "type": "string", "description": "When this situation occurs" },
          "action": { "type": "string", "description": "What to do" },
          "context": { "type": "string" },
          "relatedFacts": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["trigger", "action"]
      },
      "rate": {
        "type": "object",
        "properties": {
          "strategyId": { "type": "string" },
          "outcome": { "type": "string", "enum": ["success", "failure"] }
        },
        "required": ["strategyId", "outcome"]
      }
    }
  }
}
```

---

### Herramienta 13: `memory_anticipate`

Devuelve recuerdos que probablemente serán útiles en los próximos minutos (motor de
anticipación §8, `buildAnticipationFeed` en `packages/core/src/cognitive/anticipation.ts`,
servido mediante `GET /anticipation`). No precarga ni calienta ninguna caché: solo
ordena y devuelve recuerdos candidatos.

```json
{
  "name": "memory_anticipate",
  "inputSchema": {
    "type": "object",
    "properties": {
      "recentlyRecalledId": {
        "type": "string",
        "description": "Last recalled memory id — drives sequential + co-occurrence predictions"
      },
      "context": {
        "type": "string",
        "maxLength": 500,
        "description": "Free-text query context — drives conditional predictions"
      },
      "lookAhead": {
        "type": "number",
        "minimum": 0,
        "maximum": 10080,
        "default": 30,
        "description": "Minutes to anticipate ahead (server-side default 30, max one week)"
      },
      "limit": { "type": "number", "minimum": 1, "maximum": 100 }
    }
  }
}
```

Todos los campos son opcionales. Se combinan cuatro señales con pesos fijos que suman 1.0:
**secuencial** (0.35, «recuperar X suele ir seguido de Y en pocos minutos»; requiere
`recentlyRecalledId`), **periódica** (0.25, «este recuerdo aparece en esta franja de
día de la semana/3 h UTC»; siempre se ejecuta, no necesita parámetro),
**condicional** (0.25, «las consultas que mencionan Z suelen recuperar esto»;
requiere `context`, independiente de `recentlyRecalledId`) y
**coocurrencia/hebbiana** (0.15, «recuperado junto con X»; requiere
`recentlyRecalledId`). Un elemento alcanzado por más de una señal suma sus
puntuaciones ponderadas y vuelve con `source: "blended"`. Cuando se indica `context`
y el servidor tiene configurado un adaptador de LLM, `GET /anticipation`
además pide al LLM 2-3 consultas de búsqueda relacionadas, las ejecuta con
`core.recall()` y fusiona los aciertos nuevos en el feed (`source:
"conditional"`, puntuación base baja, deduplicados por id); este enriquecimiento es
puramente aditivo y, ante cualquier error, vuelve en silencio al feed estadístico.

**Ejemplo**:

```json
{ "recentlyRecalledId": "fact_042", "context": "auth module refactor", "lookAhead": 30 }
```

**Respuesta**:

```json
{
  "workspaceId": "ws_default",
  "generatedAt": "2026-06-09T06:00:00Z",
  "cue": { "recentlyRecalledId": "fact_042" },
  "items": [
    {
      "id": "fact_017",
      "score": 0.31,
      "source": "blended",
      "rationale": "Follows fact_042 82% of the time (avg lag 45s). Also: Co-recalled with fact_042 6 times (Hebbian weight 0.71)."
    }
  ]
}
```

---

## 4. Servicio gRPC (ConnectRPC)

Estado: **Implementado** (packages/server/src/grpc.ts — Wave R)  
Paquete: `@mnemo-ai/server` (la capa de transporte ConnectRPC es interna del servidor; las definiciones proto viven en `packages/server/src/proto/`)  
Protocolo: [ConnectRPC](https://connectrpc.com) (admite gRPC, gRPC-Web y el protocolo Connect)  
Transporte: Connect y gRPC-Web sobre HTTP/1.1 en `PORT`; el protocolo gRPC y las 2 RPC bidireccionales necesitan el listener h2c en `MNEMO_GRPC_PORT` ([SDK_INTEGRATION.es.md](../integration/SDK_INTEGRATION.es.md) §5)

**RPC implementadas:**

- **10 unarias:** `Recall`, `Remember`, `Forget`, `ResolveReasoning`, `RecordReasoning`, `CreateTask`, `UpdateTask`, `RecordEvent`, `SelfEdit`, `GetHealth`
- **3 de streaming del servidor:** `WatchMemory`, `WatchTasks`, `StreamHealth`
- **2 de streaming del cliente:** `IngestBatch`, `ImportMemory`
- **2 bidireccionales:** `Session` (ciclo de vida de sesión bidi), `FederationSync` (impulsa SyncEngine)

```protobuf
syntax = "proto3";
package mnemosyne.v1;

import "google/protobuf/timestamp.proto";
import "google/protobuf/struct.proto";

service MnemosyneService {
  // ─── Unary ───────────────────────────────────────────────────────────
  rpc Recall(RecallRequest) returns (RecallResponse);
  rpc Remember(RememberRequest) returns (RememberResponse);
  rpc Forget(ForgetRequest) returns (ForgetResponse);
  rpc ResolveReasoning(ResolveReasoningRequest) returns (ResolveReasoningResponse);
  rpc RecordReasoning(RecordReasoningRequest) returns (RecordReasoningResponse);
  rpc CreateTask(CreateTaskRequest) returns (Task);
  rpc UpdateTask(UpdateTaskRequest) returns (Task);
  rpc RecordEvent(RecordEventRequest) returns (Event);
  rpc SelfEdit(SelfEditRequest) returns (SelfEditResponse);
  rpc GetHealth(HealthRequest) returns (HealthSnapshot);

  // ─── Server Streaming ────────────────────────────────────────────────
  rpc WatchMemory(WatchMemoryRequest) returns (stream MemoryEvent);
  rpc WatchTasks(WatchTasksRequest) returns (stream TaskEvent);
  rpc StreamHealth(HealthRequest) returns (stream HealthSnapshot);

  // ─── Client Streaming ────────────────────────────────────────────────
  rpc IngestBatch(stream IngestItem) returns (IngestSummary);
  rpc ImportMemory(stream MemoryChunk) returns (ImportResult);

  // ─── Bidirectional Streaming ─────────────────────────────────────────
  rpc Session(stream SessionMessage) returns (stream SessionResponse);
  rpc FederationSync(stream SyncMessage) returns (stream SyncMessage);
}

// ─── Core Messages ───────────────────────────────────────────────────────

message RecallRequest {
  string query = 1;
  repeated string types = 2;
  int32 limit = 3;             // default 5
  bool include_graph = 4;
  string as_of = 5;            // ISO 8601 timestamp string
}

message RecallResponse {
  repeated MemoryItem results = 1;
  string mode = 2;             // "hybrid" | "fts_only" | "hot"
  int64 took_ms = 3;
}

message MemoryItem {
  string id = 1;
  string type = 2;
  string content = 3;
  double confidence = 4;
  double worth = 5;
  double relevance_score = 6;
  string valid_from = 7;
  string valid_to = 8;
}

message RememberRequest {
  string content = 1;
  string type = 2;             // "fact" | "decision" | "strategy" | "workflow" | "skill"
  string topic_key = 3;
  double confidence = 4;
  repeated string related_entities = 5;
  string valid_until = 6;
}

message RememberResponse {
  string id = 1;
  bool conflict_detected = 2;
  string conflicting_id = 3;   // Set if conflict_detected = true
  int32 revision = 4;
}

message ForgetRequest {
  string fact_id = 1;
  string reason = 2;
}

message ForgetResponse {
  bool archived = 1;
  string archived_at = 2;
}

// ─── Watch / Streaming ───────────────────────────────────────────────────

message WatchMemoryRequest {
  repeated string channels = 1;  // e.g. "facts.*", "tasks.*"
  string agent_id = 2;
  string entity_id = 3;
}

message MemoryEvent {
  string id = 1;
  string channel = 2;
  string type = 3;
  google.protobuf.Struct payload = 4;
  google.protobuf.Timestamp timestamp = 5;
  string trace_id = 6;
}

message TaskEvent {
  string task_id = 1;
  string previous_status = 2;
  string new_status = 3;
  google.protobuf.Timestamp occurred_at = 4;
}

message HealthSnapshot {
  string status = 1;             // "healthy" | "degraded" | "down"
  string recall_mode = 2;
  map<string, string> checks = 3;
  google.protobuf.Timestamp snapshot_at = 4;
}

// ─── Session Bidirectional ───────────────────────────────────────────────

message SessionMessage {
  oneof payload {
    StartSession start = 1;
    AddTurn turn = 2;
    PinTurn pin = 3;
    ScratchUpdate scratch = 4;
    CollapseSession collapse = 5;
    DiscardSession discard = 6;
  }
}

message SessionResponse {
  oneof payload {
    SessionStarted started = 1;
    TurnAdded turn_added = 2;
    CollapseStarted collapse_started = 3;
    CollapseCompleted collapse_completed = 4;
    SessionError error = 5;
  }
}

// ─── Federation Bidirectional ────────────────────────────────────────────

message SyncMessage {
  string peer_id = 1;
  string sync_cursor = 2;
  repeated SyncItem items = 3;
  bool end_of_batch = 4;
}

message SyncItem {
  string id = 1;
  string type = 2;
  bytes payload = 3;            // CBOR-encoded knowledge unit
  string content_hash = 4;
  string region = 5;
}
```

**Autenticación**: encabezado de metadatos de gRPC `authorization: Bearer mk_live_xxx`

---

## 5. Protocolo WebSocket

Estado: **Implementado**  
Endpoint: `ws://host/memory/ws`

### 5.1 Conexión

```
ws://host/memory/ws?token=mk_live_xxx
```

Como alternativa, pasa el token en el encabezado `Sec-WebSocket-Protocol` (para entornos donde las cadenas de consulta no están disponibles).

### 5.2 Mensaje de suscripción

Lo envía el cliente inmediatamente tras conectarse (o al reconectar).

```json
{
  "action": "subscribe",
  "channels": ["facts.*", "tasks.*", "session.sess_abc123", "health"],
  "filter": {
    "entityId": "ent_pg_001",
    "agentId": "agent_coder_01"
  }
}
```

**Canales disponibles:**

| Canal               | Descripción                                                  |
| ------------------- | ------------------------------------------------------------ |
| `facts.*`           | Todos los eventos de hechos (creado, actualizado, archivado) |
| `facts.created`     | Solo hechos nuevos                                           |
| `tasks.*`           | Cambios de estado de tareas                                  |
| `events.*`          | Nuevos eventos registrados                                   |
| `session.{id}`      | Actualizaciones de una sesión concreta                       |
| `agent.{id}.recall` | Lo que un agente concreto está recuperando                   |
| `health`            | Actualizaciones de métricas de salud                         |
| `federation.sync`   | Actividad de sincronización entre instancias                 |

### 5.3 Eventos que el servidor envía

```json
{
  "id": "evt_ws12_1717500000000_0042",
  "channel": "facts.created",
  "type": "fact.created",
  "payload": {
    "id": "fact_xyz",
    "content": "Redis 8.0 deployed to production",
    "confidence": 0.97
  },
  "timestamp": "2026-06-09T12:00:00Z",
  "traceId": "trace_abc123"
}
```

**Tipos de evento:**

| Tipo de evento        | Disparador                                        |
| --------------------- | ------------------------------------------------- |
| `fact.created`        | Hecho nuevo guardado                              |
| `fact.updated`        | Hecho revisado                                    |
| `fact.archived`       | Hecho borrado de forma lógica                     |
| `task.created`        | Tarea creada                                      |
| `task.transitioned`   | Cambió el estado de la tarea                      |
| `task.completed`      | Tarea completada                                  |
| `event.recorded`      | Evento inmutable registrado                       |
| `recall.hit`          | Un agente recuperó de la memoria                  |
| `session.collapsed`   | Sesión colapsada en conocimiento                  |
| `health.alert`        | La comprobación de salud se degradó o se recuperó |
| `federation.conflict` | Conflicto entre instancias detectado              |

### 5.4 Reconexión y reproducción de eventos

Al reconectar, envía un mensaje `resubscribe` con el ID del último evento recibido:

```json
{
  "action": "resubscribe",
  "channels": ["facts.*", "tasks.*"],
  "lastEventId": "evt_ws12_1717500000000_0042"
}
```

**Respuesta del servidor — reproducción (el evento sigue en el búfer):**

```json
{
  "type": "replay",
  "events": [ ... ],
  "gapDetected": false
}
```

**Respuesta del servidor — hueco (el evento fue expulsado del búfer):**

```json
{
  "type": "gap",
  "oldestAvailable": "evt_ws12_1717500100000_0001",
  "message": "Events between your lastEventId and this point are lost. Use GET /memory/events?since=... to sync."
}
```

**Política del búfer:**

- Búfer circular por canal: 1000 eventos, antigüedad máxima de 1 hora
- Almacenamiento: clave de lista de Redis `mnemo:{workspace}:ws_buffer:{channel}`
- Formato del ID de evento: `evt_{workspace_short}_{timestamp_ms}_{sequence}` — crece de forma monótona por espacio de trabajo

### 5.5 Contrapresión

- Política de descarte: `drop_oldest` (el búfer circular expulsa los eventos más antiguos cuando se llena)
- Detección de consumidores lentos: se marca una conexión con retraso > 500 ms en P99
- Los consumidores lentos reciben un evento de aviso `slowConsumer`; si no se resuelve tras 30 s, la conexión se cierra con el código 1008

---

## 6. Formato de error

Todos los errores usan un sobre `error` anidado (estilo Stripe). La forma en la red es:

```json
{
  "error": {
    "type": "conflict_error",
    "code": "conflict",
    "message": "A fact with similar content already exists",
    "param": "statement",
    "details": {
      "existing_fact_id": "fact_xyz789",
      "similarity": 0.92
    },
    "request_id": "req_abc123"
  }
}
```

Campos:

- `type` — cadena de categoría estilo Stripe derivada del estado HTTP: `invalid_request_error` (400/422), `authentication_error` (401), `permission_error` (403), `not_found_error` (404), `conflict_error` (409), `rate_limit_error` (429), `api_error` (500/otros)
- `code` — código snake_case legible por máquinas (contrato estable)
- `message` — descripción legible por personas
- `param` — (opcional) nombre del campo que causó un error de validación 400
- `details` — (opcional) conjunto estructurado de contexto adicional
- `request_id` — (opcional) ID de la solicitud para correlacionar con soporte
- `retryable` — indica si reintentar más tarde la misma solicitud puede tener éxito (429 y 503)
- `retryAfterSeconds` — (opcional) cuánto esperar, igual que el encabezado `Retry-After`

### Códigos de error

Todos los códigos son estables entre versiones de la API. Eliminarlos requiere una compuerta de versión.

| Código                        | Estado HTTP | Descripción                                                                                                                                                                          |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `not_found`                   | 404         | El recurso solicitado no existe                                                                                                                                                      |
| `conflict`                    | 409         | Conflicto de contenido (p. ej., un hecho casi duplicado). Se proporcionan `details.existing_fact_id` y `details.similarity`                                                          |
| `rate_limited`                | 429         | Se superó el límite de frecuencia. Se define el encabezado `Retry-After`. `details.limit_type` indica qué capa                                                                       |
| `forbidden`                   | 403         | La clave de API carece del permiso requerido. Se proporciona `details.required_scope`                                                                                                |
| `unprocessable_entity`        | 422         | El cuerpo de la solicitud no pasó la validación del esquema. `param` indica el campo que falla                                                                                       |
| `poisoning_rejected`          | 422         | La compuerta antienvenenamiento rechazó el contenido. `details.categories` lista lo que coincidió; el texto coincidente nunca se devuelve                                            |
| `service_unavailable`         | 503         | La base de datos está caída o demasiado lenta ahora mismo, o hay un circuit breaker de almacenamiento abierto. Se define `Retry-After`; el resultado de una escritura es desconocido |
| `semantic_search_unavailable` | 503         | Recuperación con `mode:"semantic"` sin que responda ningún embedder. Se define `Retry-After`                                                                                         |
| `capability_unavailable`      | 503         | La función requiere un proveedor (LLM/embeddings/Redis) que no está configurado o no está disponible en este momento                                                                 |
| `degraded`                    | 206         | La solicitud tuvo éxito pero con calidad reducida (p. ej., se usó el respaldo FTS en lugar de la búsqueda vectorial). Informativo, no es un estado de error                          |
| `internal_error`              | 500         | Error inesperado del servidor. Se proporciona `error.request_id` para soporte                                                                                                        |

### Ejemplo con curl

```bash
curl -s -X POST https://mnemo.example.com/remember \
  -H "Authorization: Bearer mns_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "statement": "Redis is optional" }' \
  | jq '.error.code'
# "conflict"
```

---

## 7. Paginación

Todos los endpoints de lista usan paginación basada en cursor. No se admite la paginación por offset.

### Solicitud

```
GET /timeline?cursor=eyJpZCI6ImV2dF8wMDEiLCJ0cyI6MTcxNzUwMDAwMH0&limit=20
```

- `cursor`: cadena opaca (clave compuesta codificada en base64; no la analices)
- `limit`: 1–100, por defecto 20

### Respuesta

```json
{
  "data": [ ... ],
  "cursor": "eyJpZCI6ImV2dF8wMjAiLCJ0cyI6MTcxNzUwMDIwMH0",
  "hasMore": true
}
```

- El cursor es estable ante escrituras concurrentes (a diferencia del offset, que se desplaza cuando se insertan registros nuevos antes de la página actual)
- Cuando `hasMore` es `false`, se omite `cursor`
- Los cursores expiran a las 24 horas; los cursores expirados devuelven `unprocessable_entity`

---

## 8. Versionado de la API

Mnemosyne usa **versionado basado en fechas** (patrón de Stripe), no semver ni versionado en la ruta de la URL. No hay ningún prefijo de ruta `/v1/` en la red (consulta la nota al inicio de este documento): el versionado lo lleva por completo el encabezado `Mnemosyne-Version` de abajo, no la ruta.

### Encabezado de versión

```
Mnemosyne-Version: 2026-06-15
```

**Comportamiento:**

- La primera llamada a la API de un espacio de trabajo fija automáticamente ese espacio de trabajo a la versión actual
- Las llamadas posteriores usan la versión fijada salvo que el encabezado la anule
- El espacio de trabajo puede actualizarse globalmente desde Studio (en un solo sentido, irreversible)

### Reglas de compatibilidad

| Tipo de cambio                               | Requiere compuerta de versión |
| -------------------------------------------- | ----------------------------- |
| Añadir un campo nuevo a la respuesta         | No (aditivo)                  |
| Añadir un endpoint nuevo                     | No (aditivo)                  |
| Eliminar un campo de la respuesta            | Sí                            |
| Cambiar el tipo o la semántica de un campo   | Sí                            |
| Eliminar un endpoint                         | Sí                            |
| Cambiar el significado de un código de error | Sí                            |

### Módulo de compuerta de versión (interno)

Cada cambio incompatible hacia atrás se entrega como un módulo autocontenido:

```typescript
{
  date: "2026-06-15",
  description: "recall response includes worth scores",
  transform: {
    backward: (response) => { delete response.results[*].worth; return response; },
    forward: (request) => request   // no request shape change
  }
}
```

En cada solicitud: se recorren hacia atrás todas las compuertas, desde la última hasta la versión fijada del espacio de trabajo, transformando la respuesta en el borde. El código del núcleo siempre se ejecuta en la última versión.

---

## 9. Idempotencia

Compatible con todos los endpoints `POST` que crean o modifican estado.

### Encabezado

```
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

- Valor: UUID generado por el cliente (cualquier formato)
- TTL: 72 horas
- Alcance: por espacio de trabajo (la misma clave en espacios de trabajo distintos es independiente)
- Duplicados concurrentes: la segunda solicitud recibe `409 conflict` hasta que la primera termina, y después se reproduce la respuesta almacenada

### Puntos de recuperación multifase

Para operaciones de larga duración (p. ej., `POST /session/:id/collapse`):

| Punto de recuperación | Significado                                                                 |
| --------------------- | --------------------------------------------------------------------------- |
| `session_locked`      | Sesión marcada como en colapso; es seguro reintentar                        |
| `llm_called`          | Resumen con LLM completado; es seguro reintentar sin volver a llamar al LLM |
| `facts_persisted`     | Unidades de conocimiento escritas en PostgreSQL                             |
| `completed`           | Sesión eliminada de Redis; respuesta completa almacenada                    |

Al reintentar: la operación se reanuda desde el último punto de recuperación persistido, omitiendo las fases completadas. Todas las escrituras locales ocurren antes de las llamadas externas (LLM), lo que garantiza un reintento seguro si la llamada al LLM falla a mitad de camino.

---

## 10. Encabezados de respuesta

Toda respuesta incluye estos encabezados:

```
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 587
X-RateLimit-Reset: 1717500060
X-Request-Id: req_abc123xyz
Mnemosyne-Version: 2026-06-15
```

En `429`:

```
Retry-After: 13
Mnemosyne-Rate-Limited-Reason: request_rate
```

Valores de `Mnemosyne-Rate-Limited-Reason`: `request_rate` y `concurrency` (`429`), `fleet_shed` (`503`, `Retry-After: 5`)

---

## 11. Entrega de webhooks

### Registro

```bash
curl -X POST https://mnemo.example.com/webhooks \
  -H "Authorization: Bearer mk_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://yourapp.example.com/hooks/mnemo",
    "events": ["fact.created", "task.completed", "session.collapsed"],
    "secret": "whsec_your_signing_secret"
  }'
```

```json
// Response 201
{
  "id": "wh_001",
  "url": "https://yourapp.example.com/hooks/mnemo",
  "events": ["fact.created", "task.completed", "session.collapsed"],
  "status": "active",
  "createdAt": "2026-06-09T12:00:00Z"
}
```

### Firma de la carga útil

Cada entrega incluye `Mnemosyne-Signature`:

```
Mnemosyne-Signature: t=1717500060,v1=3a4b5c6d...
```

Verificación:

1. Analiza `t` (marca de tiempo Unix) y `v1` (resumen hexadecimal HMAC-SHA256)
2. Rechaza si `|now - t| > 300` segundos (protección contra repetición)
3. Calcula `HMAC-SHA256(webhook_secret, t + "." + raw_body)`
4. Compara con `v1` usando igualdad en tiempo constante

### Garantías de entrega

- **Orden**: mejor esfuerzo (usa `event.timestamp` para ordenar, no la secuencia de entrega)
- **Entrega**: al menos una vez (el receptor debe deduplicar por `event.id`)
- **Tiempo de espera**: el endpoint debe responder `2xx` en 10 segundos

### Calendario de reintentos

| Intento | Retraso    |
| ------- | ---------- |
| 1       | Inmediato  |
| 2       | 5 minutos  |
| 3       | 30 minutos |
| 4       | 2 horas    |
| 5       | 24 horas   |

Tras 5 fallos: se mueve a la cola de mensajes fallidos (dead-letter).  
Tras 3 fallos consecutivos del endpoint: el endpoint se desactiva y se avisa al administrador del espacio de trabajo.

### Eventos a los que se puede suscribir

| Evento                | Disparador                                   |
| --------------------- | -------------------------------------------- |
| `fact.created`        | Hecho nuevo escrito                          |
| `fact.updated`        | Hecho revisado                               |
| `fact.archived`       | Hecho borrado de forma lógica                |
| `decision.created`    | Decisión registrada                          |
| `decision.superseded` | Decisión reemplazada por una más reciente    |
| `task.created`        | Tarea creada                                 |
| `task.completed`      | Tarea completada                             |
| `task.delegated`      | Tarea delegada a otro agente                 |
| `session.collapsed`   | Sesión colapsada en unidades de conocimiento |
| `event.recorded`      | Evento inmutable registrado                  |
| `health.alert`        | Cambió el estado de la comprobación de salud |
| `federation.conflict` | Conflicto entre instancias detectado         |

### Carga útil del evento de webhook

```json
{
  "id": "evt_wh_abc123",
  "type": "fact.created",
  "created": 1717500060,
  "workspaceId": "ws_default",
  "data": {
    "object": "fact",
    "id": "fact_xyz789",
    "content": "Redis 8.0 deployed to production",
    "confidence": 0.97,
    "createdAt": "2026-06-09T12:00:00Z"
  }
}
```

---

## 12. Límites de frecuencia

Arquitectura de cuatro capas. Falla abierta: si el almacén de límites de frecuencia de Redis no está disponible, se permite todo el tráfico.

| Capa                                     | Alcance          | Free              | Pro                 | Enterprise            |
| ---------------------------------------- | ---------------- | ----------------- | ------------------- | --------------------- |
| Frecuencia de solicitudes (token bucket) | Por clave de API | 10 rps / burst 20 | 100 rps / burst 200 | 1000 rps / burst 2000 |
| Concurrencia                             | Por clave de API | 5 en curso        | 25 en curso         | 100 en curso          |
| Descarte por carga de la flota           | Global           | —                 | —                   | —                     |
| Utilización de workers                   | Por instancia    | —                 | —                   | —                     |

El bucket de frecuencia de solicitudes se mantiene por clase de operación (recall, write, export, admin, federation,
other). `POST /session/:id/turn` tiene su propia clase `turn` (600/min, burst 100 en el plan Free), de modo que
volcar una transcripción larga no gasta el presupuesto de escritura. Una solicitud rechazada por concurrencia
no gasta ningún token de frecuencia. En `429`, `Retry-After` es el tiempo real de recarga del bucket (1 s para
concurrencia), que también se da como `error.details.retryAfterSeconds`.

**Prioridad de descarte por carga de la flota:**

| Prioridad                   | Endpoints                 | Se descarta con una utilización de la flota de |
| --------------------------- | ------------------------- | ---------------------------------------------- |
| Crítica (nunca se descarta) | recall, session.collapse  | —                                              |
| Importante                  | write, reasoning.resolve  | 85%                                            |
| Normal                      | export, admin, federation | 70%                                            |

**Orden de descarte por utilización de workers** (cuando la CPU de la instancia > 90%):

1. Primero las claves `mk_test_*`
2. Solicitudes GET
3. Solicitudes POST
4. Las rutas críticas en último lugar (devuelven `503` con `Retry-After` como último recurso)

---

---

## 13. Proyección de la recuperación

`POST /recall` devuelve solo JSON. No existe el parámetro de consulta `?format=` ni la exportación
`renderRecallResults()`. Cuánto de cada resultado vuelve se elige con el campo `projection` del
cuerpo (`packages/server/src/routes/recall.ts`):

| `projection`         | `content` de cada resultado                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full` (por defecto) | El texto completo.                                                                                                                                       |
| `compact`            | Los primeros 300 caracteres, más `truncated: true` en los resultados que se cortaron. Los de 300 caracteres o menos, y los federados, vuelven completos. |

El resto del resultado (`id`, `kind`, `score`, `similarity`, `validFrom`, `validTo`, `tags`,
`sensitivity`, `status`, …) es igual en ambos. El corte ocurre en el borde HTTP: el ranking siempre
se calcula sobre el texto completo. Para leer completo un resultado cortado, pídelo por id con
`GET /facts/:id` (la herramienta MCP `memory_fact` hace esto).

```json
// POST /recall
{ "query": "auth module", "topK": 5, "projection": "compact" }
```

Para inyectar en un prompt desde TypeScript, `@mnemo-ai/core` exporta `renderFactsCompact(facts, opts)`,
que convierte `MnemoFact[]` (no resultados de recuperación) en un bloque con presupuesto de tokens
(`maxTokensApprox`, 200 por defecto; `format: "structured" | "prose"`).

---

_El contrato de referencia es `GET /openapi.json`; este documento es una guía de él. Los cambios incompatibles requieren un módulo de compuerta de versión y al menos 90 días de aviso a los espacios de trabajo fijados._
