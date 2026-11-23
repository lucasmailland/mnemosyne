# Referencia ampliada — MCP Tools de Mnemosyne

[English](MCP_TOOLS.md) · **Español**

> Documento de referencia día a día para las 37 herramientas MCP de Mnemosyne (`packages/mcp/src/tools/`). Cada herramienta fue investigada contra el código fuente real (schemas Zod, handlers HTTP en `packages/server/src/routes/`, lógica de negocio en `packages/core/`) — no contra la descripción de una línea de la herramienta ni contra `docs/architecture/API.md`, que en varios casos (`memory_introspect`, `memory_anticipate`, `memory_status`) documenta contratos desactualizados o directamente inventados.
>
> Para una introducción de más alto nivel (setup, arquitectura MCP↔server, passive capture) ver [`MCP_GUIDE.md`](./MCP_GUIDE.es.md), que este documento complementa y no reemplaza — aquí el foco es cada herramienta en profundidad: qué hace por dentro, todos sus parámetros, casos de uso reales, y sobre todo **casos borde y discrepancias verificadas entre lo que la herramienta promete y lo que el código realmente hace**.
>
> Última verificación de código: 2026-08-09.
>
> Las cargas de ejemplo de esta guía son datos de muestra, escritos en español.

## Índice

**Memoria core**: [`memory_context`](#memory_context) · [`memory_recall`](#memory_recall) · [`memory_remember`](#memory_remember) · [`memory_forget`](#memory_forget) · [`memory_search`](#memory_search) · [`memory_status`](#memory_status) · [`memory_relate`](#memory_relate)

**Decisiones y entidades**: [`memory_decide`](#memory_decide) · [`memory_entity`](#memory_entity) · [`memory_pin`](#memory_pin) · [`memory_timeline`](#memory_timeline) · [`memory_episode_start`](#memory_episode_start) · [`memory_episode_end`](#memory_episode_end) · [`memory_consolidate`](#memory_consolidate)

**Edición avanzada y admin**: [`memory_remind_when`](#memory_remind_when) · [`memory_self_edit`](#memory_self_edit) · [`memory_update`](#memory_update) · [`memory_judge`](#memory_judge) · [`memory_doctor`](#memory_doctor) · [`memory_stats`](#memory_stats) · [`memory_purge`](#memory_purge)

**Sesiones, tareas y eventos**: [`memory_compare`](#memory_compare) · [`memory_session`](#memory_session) · [`memory_task`](#memory_task) · [`memory_event`](#memory_event) · [`memory_reasoning`](#memory_reasoning) · [`memory_strategy`](#memory_strategy) · [`memory_hyperedge`](#memory_hyperedge)

**Metacognición y espacio de trabajo**: [`memory_introspect`](#memory_introspect) · [`memory_anticipate`](#memory_anticipate) · [`memory_compose`](#memory_compose) · [`memory_workflow`](#memory_workflow) · [`memory_skill`](#memory_skill) · [`memory_workspace`](#memory_workspace) · [`memory_suggest_topic_key`](#memory_suggest_topic_key)

Ver también el resumen de [hallazgos críticos verificados](#hallazgos-críticos-verificados-resumen) al final del documento — la lista consolidada de discrepancias reales entre documentación/nombre de herramienta y comportamiento de código, útil como checklist rápido antes de depender de alguna de estas herramientas en un flujo crítico.

---

# Documentación de referencia — MCP Tools de Mnemosyne

## `memory_context`

**Qué hace**: Es la herramienta de orientación de sesión. Devuelve, en una sola llamada, la identidad completa detrás de la API key/token activo: espacio de trabajo en el que está operando el agente (incluyendo su **rol** real ahí — `owner`/`admin`/`write`/`read`), usuario y tenant asociados a la key, stats livianas del espacio de trabajo, y un listado de las propias membresías de espacio de trabajo de quien llama.

Existe como herramienta separada de `memory_recall` porque cumple una función distinta: no busca memoria, orienta al agente sobre "dónde estoy y qué puedo hacer" antes de operar. El código deja explícito (comentario del handler) que el espacio de trabajo activo es **fijo para toda la sesión** — lo determina la API key/token al arrancar el proceso, y ninguna herramienta lo cambia a mitad de sesión. Esto es una decisión de diseño deliberada (M2/M4): cambiar de espacio de trabajo en medio de una tarea fragmentaría silenciosamente la memoria (escribes en B, después recuperas desde A y nunca te enteras). Si se necesita otro espacio de trabajo, hay que iniciar sesión nueva con la key/token correspondiente, o, si la key es un `uk_live_*` (user token), fijar `X-Workspace-Id` vía `MNEMO_WORKSPACE_ID` **antes** del primera herramienta call.

Internamente hace 3 llamadas en paralelo: `GET /me` (identidad de la key), `GET /admin/stats` (stats, opcional), y `listMyWorkspaces()`. Para el listado de "otros espacios de trabajo" usa **`GET /workspaces/mine`** como fuente primaria (las membresías propias de quien llama) — si esa lista viene vacía, cae a `GET /tenants/:tenantId/workspaces` (todos los espacios de trabajo del tenant) como fallback etiquetado (`workspacesSource: "tenant_fallback"`). Esto corrige un bug histórico (fijado 2026-07-31): antes se usaba la lista de espacios de trabajo del _tenant_ como fuente primaria, lo cual mostraba espacios de trabajo ajenos como si fueran de quien llama.

**Parámetros**:

| Parámetro                | Tipo    | Requerido | Default | Descripción                                                                                                                                          |
| ------------------------ | ------- | --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `includeStats`           | boolean | No        | `true`  | Incluye stats del espacio de trabajo (hechos, sesiones, último recall)                                                                               |
| `includeOtherWorkspaces` | boolean | No        | `true`  | Lista las propias membresías de espacio de trabajo de quien llama (con fallback a espacios de trabajo del tenant si no hay ninguna membresía propia) |

**Cuándo usarla — casos de uso**:

- Al inicio de una sesión de agente, para confirmar en qué espacio de trabajo se va a escribir/recordar antes de hacer la primera escritura.
- Antes de intentar una escritura (`memory_remember`, `memory_decide`, etc.) cuando no se sabe si la key/rol tiene permiso de escritura — evita gastar una llamada que devuelva 403.
- Para obtener el `personalWorkspaceId` o el `tenantId` necesarios como parámetros de otras herramientas (`targetWorkspaceId`, `scopeOwner: 'tenant:<id>'`).
- Para diagnosticar por qué una key no puede ver ciertos espacios de trabajo (verificar `otherWorkspacesSource`: si es `tenant_fallback`, la key no tiene membresías propias).

**Casos borde y gotchas**:

- Si el rol de quien llama en el espacio de trabajo activo es `'read'`, la respuesta incluye un campo `_roleNote` explícito advirtiendo que las escrituras van a devolver 403 y que no tiene sentido reintentarlas esperando que el retry lo resuelva — hay que pedirle a un admin del espacio de trabajo que suba el rol.
- Todas las sub-llamadas (`getMe`, `getStats`, `listMyWorkspaces`, `listWorkspacesForCurrentTenant`) están envueltas en `.catch(() => null)` — un fallo parcial (ej. stats no disponibles) nunca hace fallar la herramienta completa; simplemente omite esa sección de la respuesta.
- El campo `key.scopes` refleja los permisos _crudos_ de la credencial, no el techo real de permisos — el rol de espacio de trabajo (`workspaceRole`) es el que manda en la práctica.
- El JSDoc del archivo deja constancia de que una versión anterior de este comentario documentaba un parámetro `memory_remember(..., workspaceId=...)` que **nunca existió** — fue removido; es un recordatorio de que la documentación embebida en el código puede quedar desactualizada y hay que cruzarla con el schema real.

**Ejemplos**:

```json
{}
```

(todos los parámetros son opcionales con default `true`)

```json
{ "includeStats": false, "includeOtherWorkspaces": true }
```

Respuesta típica (resumida):

```json
{
  "workspace": { "id": "ws_...", "name": "acme-prod", "plan": "pro", "role": "write" },
  "key": { "id": "mns_live_...", "actorType": "agent", "scopes": ["memory:write", "memory:read"] },
  "user": { "id": "user_...", "personalWorkspaceId": "ws_personal_..." },
  "tenant": { "id": "tenant_..." },
  "stats": { "factsLive": 128, "factsPinned": 4, "lastRecallAt": "2026-08-05T10:00:00Z" },
  "otherWorkspaces": [{ "id": "ws_...", "role": "admin" }],
  "otherWorkspacesSource": "membership",
  "_note": "The active workspace is FIXED for the whole session..."
}
```

---

## `memory_recall`

**Qué hace**: Ejecuta el pipeline de recall "cold" de 7 etapas contra la memoria del espacio de trabajo: parseo de la query a embedding + filtros → búsqueda vectorial HNSW (top 50) → expansión de relaciones a 1 hop → scoring de activación Petrov (`A(t) = ln(∑ t_j^-d)`, d=0.5) → ponderación por worth → filtro de ceiling de sensibilidad + contest CaMeL → ensamblado de `RecallHit[]`. Es la herramienta de recuperación de conocimiento durable más completa del set: combina búsqueda léxica (FTS) y vectorial en modo `hybrid`/`auto`, soporta recall bitemporal (`asOf`) y aplica el pipeline completo (no el atajo "hot" desde Redis).

En el servidor, la ruta `POST /recall` resuelve un `RecallQuery` que además implementa el "CALMem token-budget ladder" (§17): según `tokenBudget` se decide cuántas etapas correr (hot-only, hot+pointer, o pipeline completo), y un gate RecMem que decide si vale la pena gastar una llamada LLM de rerank (default: `rerank: true`, pero el propio gate se salta el LLM si la señal de recurrencia entre candidatos está por debajo de `recurrenceThreshold`, default 0.6 — la ruta de "ahorro del 87%"). También hace **multi-level recall**: si la key tiene `userId` y/o `tenantId`, mezcla automáticamente hits del espacio de trabajo activo + espacio de trabajo personal del usuario (peso 0.8) + hechos del tenant. **Corregido (B1, 2026-08-10)**: pasar `scope: 'personal'` ahora sí restringe el resultado — `multiLevelRecall` corre en modo `{ only: 'personal' }`, salteando espacio de trabajo/tenant y devolviendo solo hits del espacio de trabajo personal del usuario, con peso 1.0 en vez de 0.8. Sin ese `scope`, el comportamiento de mezcla automática de arriba sigue igual.

El payload de salida viene envuelto con `_mnemo_label: "untrusted_external_content"` (estilo CaMeL): la intención es que el modelo llamante trate el contenido recuperado como dato externo no confiable, no como instrucciones a ejecutar.

**Parámetros**:

| Parámetro      | Tipo                                         | Requerido | Default                                                | Descripción                                                                                                                                   |
| -------------- | -------------------------------------------- | --------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`        | string (min 1)                               | Sí        | —                                                      | Texto libre de qué se quiere recordar                                                                                                         |
| `limit`        | int [1,25]                                   | No        | 5 (mapea a `topK`)                                     | Máximo de hits. El servidor acepta hasta 100 pero la herramienta clamp a 25 para acotar el payload                                            |
| `asOf`         | string ISO 8601 datetime                     | No        | ahora                                                  | Recall bitemporal: qué sabía la memoria en ese instante                                                                                       |
| `scope`        | enum `global`\|`conversation`\|`personal`    | No        | (todos)                                                | Filtra por ámbito. `'personal'` restringe a solo el espacio de trabajo personal de quien llama (peso 1.0) — corregido en B1, ver gotcha abajo |
| `scopeRef`     | string                                       | No        | —                                                      | Filtra por proyecto/entidad (ej. `'mnemosyne'`). Si nombra una entidad `project` (nombre o alias), trae también sus otras grafías             |
| `actorId`      | string                                       | No        | —                                                      | Filtra por el `ActorRef` exacto que escribió el hecho (ej. `"key:<id>"`) — NO es confiablemente un userId                                     |
| `mode`         | enum `lexical`\|`semantic`\|`hybrid`\|`auto` | No        | `auto`                                                 | Modo explícito de ranking                                                                                                                     |
| `vectorWeight` | number [0,1]                                 | No        | 0.5 en el server, pero solo si se envía explícitamente | Peso léxico/vectorial — obsoleto en favor de `mode`                                                                                           |
| `sessionId`    | string                                       | No        | —                                                      | Id de sesión activa; marca `lastRecallAt` best-effort; id inválido se ignora silenciosamente                                                  |

**Cuándo usarla — casos de uso**:

- Un agente de código retoma una tarea y necesita recuperar decisiones arquitectónicas previas sobre el módulo que va a tocar.
- Antes de sugerir una solución, recordar preferencias explícitas del usuario (ej. "el cliente prefiere X librería") para no repetir un error ya corregido.
- Recall bitemporal para auditar "¿qué sabía el sistema sobre este cliente el mes pasado, antes de este cambio?" usando `asOf`.
- Filtrar por `scopeRef` para aislar el contexto recordado a un proyecto específico cuando el espacio de trabajo mezcla memoria de varios repos.

**Casos borde y gotchas**:

- **`scope: 'personal'` SÍ filtra a solo hechos del espacio de trabajo personal (corregido, B1, 2026-08-10)**. `recall.ts` ahora detecta `scope === "personal"` y llama a `multiLevelRecall(..., { only: "personal" })`, que saltea por completo las promesas de espacio de trabajo/tenant y corre recall únicamente contra el espacio de trabajo personal de quien llama, con peso 1.0 (no 0.8). Si la key no tiene `userId` asociado, o el usuario no tiene espacio de trabajo personal configurado, el server responde **400** con el mismo mensaje que usa `memory_remember` para el mismo caso — nunca un resultado vacío silencioso ni un 500. El filtro de sensitivity ceiling sigue aplicándose después del merge, sin cambios. Omitir `scope` deja el comportamiento de mezcla automática (peso 0.8) exactamente igual que antes.
- Cuando `MNEMO_LLM_API_KEY` no está configurada, degrada automáticamente a full-text search (FTS) — `debug.searchMode` refleja `"fts"` en ese caso, no falla.
- `mode: 'semantic'` explícito SÍ lanza `semantic_search_unavailable` si no hay embedder configurado (a diferencia del default `'auto'`, que degrada silenciosamente). Es un diseño deliberado (B5.9, "no silent fallback").
- Bug histórico corregido (MCP-1, 2026-07-29): antes, `mode`/`vectorWeight` se parseaban en el schema pero se descartaban antes de llegar a `RecallQuery` — toda llamada resolvía a `mode: "auto"` sin importar lo pedido. Ya está arreglado; ambos campos llegan realmente a `recallCold()`.
- `sessionId` inválido o desconocido nunca hace fallar el recall — se ignora silenciosamente (best-effort, vía `setImmediate`).
- El filtro por `sensitivity ceiling` se aplica dos veces en el server (antes y después de los hooks de plugins) — ceiling violations no aparecen como error, simplemente el hit se excluye del array (404-style anti-probing, no 403).

**Ejemplos**:

```json
{ "query": "preferencias de deploy del cliente Acme", "limit": 10 }
```

```json
{
  "query": "qué decidimos sobre la estrategia de auth",
  "scopeRef": "mnemosyne",
  "mode": "hybrid",
  "asOf": "2026-06-01T00:00:00Z"
}
```

Respuesta (resumida):

```json
{
  "memories": [{ "id": "mfact_...", "content": "...", "score": 0.83, "hitFreshness": "recent" }],
  "debug": { "embedded": false, "searchMode": "hybrid", "latencyMs": 42 },
  "_mnemo_label": "untrusted_external_content"
}
```

---

## `memory_remember`

**Qué hace**: Persiste un nuevo primitivo cognitivo durable en el espacio de trabajo (por default `kind: 'fact'`, pero soporta los 10 primitivos excepto `hyperedge`, que requiere `memberIds` y solo se crea vía `POST /hyperedges`). Internamente llama a `POST /remember`, que resuelve el `kind`, valida el `subtype` correspondiente, y delega a `deps.cognitive.remember()`.

Tiene tres mecanismos de idempotencia/deduplicación superpuestos, cada uno con semántica distinta:

1. **Idempotency-Key** (middleware global §34.9, Stripe-style): si se reenvía la misma key en un retry, el server devuelve la respuesta original sin re-ejecutar. Implementado con `begin`/`complete` bajo SERIALIZABLE — colisión concurrente da 409, key reusada con hash de request distinto da 422.
2. **Content-hash dedupe**: reenviar el mismo `statement` no duplica el hecho.
3. **`topicKey`**: si ya existe un hecho/decision activo con la misma `topicKey` en el espacio de trabajo, la llamada lo **actualiza en lugar de crear un duplicado** (revisión incrementada) — solo aplica a `kind: 'fact'` y `'decision'`.

La escritura siempre se persiste y la respuesta trae `status: 'active'` con un `id` que corresponde a una fila real. Hasta P74 esto no era así: cuando el contenido se parecía mucho a algo ya guardado, el **surprise-gate** lo desviaba a un `staging` que no existía en ningún lado —sin tabla, sin consumidor— y devolvía un id fabricado. Ese camino fue eliminado; el prediction error se registra en el audit log en vez de decidir si el dato se escribe. Además, si el nuevo hecho contradice hechos existentes, la respuesta incluye `conflict.judgmentRequired: true` con una lista de `candidates` — es obligatorio resolver cada uno con `memory_judge(action='resolve', relationId=...)` (una llamada por candidato) antes de continuar; los candidatos con `action: 'supersede'` sin `relationId` son solo informativos (el server ya archivó el hecho dominado).

**Parámetros**:

| Parámetro           | Tipo                                      | Requerido | Default       | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------- | --------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `statement`         | string [1,1000]                           | Sí        | —             | El hecho en una oración corta. El server acepta hasta 50.000 chars, la herramienta clamp a 1000                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `subject`           | string                                    | No        | `'workspace'` | Sobre quién/qué es el hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `kind`              | string (no enum)                          | No        | `'fact'`      | `fact\|decision\|episode\|entity\|strategy\|workflow\|skill\|task\|event\|reasoning`. Valor no reconocido → 400                                                                                                                                                                                                                                                                                                                                                                                                         |
| `subtype`           | string (no enum)                          | No        | según kind    | Solo aplica si `kind` es `fact`/`decision`/`entity`. hecho: `preference\|trait\|event\|relationship\|skill\|concern\|architecture\|bugfix\|config\|discovery\|policy\|process\|other`. decision: `decision\|architecture\|policy\|process\|bugfix\|learning\|discovery\|config`. entity: `person\|organization\|project\|concept\|place\|other`. Sin distinguir mayúsculas. Valor fuera de la lista → se guarda como `other` (decision: `decision`) y la respuesta trae `warnings` (`subtype_substituted`). Vacío → 400 |
| `confidence`        | number [0,1]                              | No        | 0.7           | Usar <0.5 para hechos derivados/inferidos                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `agentId`           | string                                    | No        | —             | Quién originó el hecho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `conversationId`    | string                                    | No        | —             | Para trazabilidad (cite-back)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `idempotencyKey`    | string                                    | No        | —             | UUID v4 recomendado; evita duplicar en retries                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `scope`             | enum `global`\|`conversation`\|`personal` | No        | `'global'`    | `'personal'` requiere key con `userId` asociado — falla en runtime si no lo tiene                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `scopeRef`          | string                                    | No        | —             | Ref de proyecto/entidad. Si nombra una entidad `kind: project` por nombre o alias (sin distinguir mayúsculas), se guarda el nombre canónico y la respuesta trae `warnings` (`scope_ref_canonicalized`); si se parece a un proyecto sin coincidir, se guarda tal cual con `scope_ref_unrecognized` y `suggestion` (P135)                                                                                                                                                                                                 |
| `scopeOwner`        | string                                    | No        | —             | `'workspace:<id>'`\|`'user:<id>'`\|`'tenant:<id>'`. Validado del lado del servidor: no se puede forjar (403 si no coincide con la identidad autenticada)                                                                                                                                                                                                                                                                                                                                                                |
| `targetWorkspaceId` | string                                    | No        | —             | Escribe en otro espacio de trabajo; requiere membresía write/admin ahí                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `topicKey`          | string                                    | No        | —             | Clave de upsert idempotente por tema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Cuándo usarla — casos de uso**:

- Al descubrir una preferencia explícita del usuario durante la conversación ("siempre usa TypeScript strict mode").
- Registrar una decisión de configuración aprendida (aunque para decisiones "puras" existe `memory_decide`, que es más específica).
- Guardar un hecho con baja confianza cuando se infiere algo indirectamente (`confidence: 0.3`).
- Usar `topicKey` para mantener un único hecho "vivo" por tema (ej. `'infra/pg-version'`) que se actualiza en vez de acumular duplicados con cada nueva sesión.

**Casos borde y gotchas**:

- `scope: 'personal'` sin key user-bound falla en runtime con el mensaje literal `"scope 'personal' requires a user-bound key"` — no es un error silencioso, hay que comprobar con `memory_context` antes.
- `scopeOwner` mal formado (no empieza con `workspace:`/`user:`/`tenant:`) da 400; si empieza correcto pero no coincide con la identidad autenticada (ej. `user:<otro-id>`), da 403 — previene que un LLM se atribuya una identidad ajena.
- La herramienta NO expone el hash de contenido usado para dedupe deliberadamente — evita que quienes llaman dependan de un detalle interno que puede cambiar.
- `kind` es `string` suelto en el schema Zod (no enum) a propósito: la taxonomía del producto evoluciona más rápido que el protocolo MCP; congelarla rompería clientes en cada kind nuevo. Pero el server SÍ valida contra `PRIMITIVE_KINDS` y devuelve 400 si no matchea.
- El `501` documentado en el schema OpenAPI del server ("no embed provider configurado y sin `vector` precomputado") no es alcanzable desde esta herramienta MCP, porque no expone el parámetro `vector`.

**Ejemplos**:

```json
{
  "statement": "El cliente Acme prefiere comunicación en español.",
  "subject": "acme",
  "subtype": "preference",
  "confidence": 0.9
}
```

```json
{
  "statement": "Se decidió usar event sourcing para el audit log.",
  "kind": "decision",
  "subtype": "architecture",
  "topicKey": "infra/audit-log-strategy",
  "scopeRef": "mnemosyne"
}
```

Respuesta con conflicto (resumida):

```json
{
  "id": "mfact_...",
  "status": "active",
  "conflict": {
    "judgmentRequired": true,
    "candidates": [{ "id": "mfact_old", "action": "review", "relationId": "mrel_..." }]
  }
}
```

---

## `memory_forget`

**Qué hace**: Archiva (soft-delete) cualquier primitivo cognitivo — **nunca destruye datos**. Es la implementación directa del principio bitemporal del proyecto: cierra `validTo = NOW()` y preserva la fila para auditoría; el primitivo desaparece del recall pero sigue siendo recuperable/auditable.

El código internamente bifurca en dos rutas HTTP completamente distintas según el `kind`:

- **`kind: 'fact'` (o ausente, default)**: usa `client.forgetFact()` → `DELETE /facts/:id`, que soporta `idempotencyKey` (a través del header `Idempotency-Key`, manejado por middleware global).
- **Cualquier otro kind** (`decision`, `episode`, `entity`, `strategy`, `workflow`, `skill`, `task`, `event`, `reasoning`, `hyperedge`): usa `client.forgetPrimitive()` → `DELETE /forget/{kind}/{id}` (ruta genérica P18). **Corregido (B2, 2026-08-10)**: `forgetPrimitive()` ahora acepta `idempotencyKey` como 5to parámetro y lo reenvía como header `Idempotency-Key`, igual que `forgetFact` — el middleware global de idempotencia ya cubría `DELETE` en todas las rutas, el único bug real era que el SDK nunca forwardeaba la key para esta rama genérica.

`factId` es un alias backward-compat de `primitiveId` únicamente cuando `kind === 'fact'`; para cualquier otro kind, `primitiveId` es obligatorio y `factId` se ignora.

**Parámetros**:

| Parámetro        | Tipo              | Requerido   | Default  | Notas                                                                                                        |
| ---------------- | ----------------- | ----------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `factId`         | string (min 1)    | Condicional | —        | Solo válido cuando `kind='fact'` (o ausente) — alias backward-compat de `primitiveId`                        |
| `primitiveId`    | string (min 1)    | Condicional | —        | Requerido si `kind` no es `'fact'`                                                                           |
| `kind`           | enum (11 valores) | No          | `'fact'` | `fact\|decision\|episode\|entity\|strategy\|workflow\|skill\|task\|event\|reasoning\|hyperedge`              |
| `reason`         | string            | No          | —        | Queda en audit log; el server lo trunca a 200 chars (Zod acepta cualquier longitud, el server trunca)        |
| `idempotencyKey` | string            | No          | —        | Efecto real para **todos** los kinds (corregido en B2) — un retry con la misma key no re-aplica el archivado |

**Cuándo usarla — casos de uso**:

- El agente detecta que un hecho grabado previamente ya no es correcto o quedó obsoleto (típicamente se prefiere `memory_update` si es una corrección con reemplazo, pero `memory_forget` sirve cuando simplemente ya no aplica).
- Un dato quedó marcado con sensibilidad incorrecta o expuesto por error y hay que sacarlo del pool de recall inmediato sin perder el rastro de auditoría.
- Archivar una `task` completada/cancelada, un `episode` irrelevante, o una `entity` duplicada.
- Limpieza automática tras detectar duplicados via `memory_compare`.

**Casos borde y gotchas**:

- Si no se pasa ni `primitiveId` ni `factId` (cuando aplica), la herramienta devuelve error ANTES de llamar al server (`isError: true`, sin red round-trip) — mensaje explícito: `"primitiveId (or factId for facts) is required."`.
- **Corregido (B2, 2026-08-10)**: pasar `idempotencyKey` junto con `kind` distinto de `'fact'` ahora sí protege contra doble-archivado en un retry, igual que `kind: 'fact'` — `forgetPrimitive()` reenvía la key como header `Idempotency-Key`, cubierto por el mismo middleware global de idempotencia que ya aplicaba a todo `DELETE`.
- El `reason` default cuando no se provee explícitamente es literalmente el string `"mcp_forget"` en la respuesta de la herramienta (no significa que el server lo haya usado así — es solo lo que la herramienta devuelve como eco si `reason` vino undefined).
- NO hay confirmación de que el id exista antes de intentar archivar más allá del 404 nativo del server — un id inexistente devuelve error de la llamada HTTP, no un `forgotten: false`.

**Ejemplos**:

```json
{ "factId": "mfact_abc123", "reason": "Dato desactualizado — cliente cambió de plan" }
```

```json
{
  "primitiveId": "mtask_xyz789",
  "kind": "task",
  "reason": "Tarea cancelada por el usuario"
}
```

Respuesta:

```json
{
  "id": "mfact_abc123",
  "kind": "fact",
  "forgotten": true,
  "reason": "Dato desactualizado — cliente cambió de plan"
}
```

---

## `memory_search`

**Qué hace**: Búsqueda semántica en el pool de memoria del espacio de trabajo. A diferencia de `memory_recall`, que expone control fino de modo/peso léxico-vectorial, esta herramienta está pensada para priorizar similitud conceptual — pero **no** fuerza `mode: 'semantic'` estricto ni `vectorWeight: 1.0` a propósito, y esto está extensamente documentado en el código fuente como resultado de un hallazgo real del proyecto (MCP-1, 2026-07-29): antes, `POST /recall` descartaba silenciosamente `vectorWeight`/`mode` del request antes de que llegaran a `RecallQuery` — toda llamada resolvía a `mode: "auto"` sin importar lo pedido. Una vez arreglado ese bug de ruteo, forzar `mode: 'semantic'` estricto en esta herramienta haría que **cada llamada sin embedder configurado tirara un error duro** (`semantic_search_unavailable`, diseño B5.9 sin fallback silencioso), rompiendo la promesa documentada de esta misma herramienta de degradar a FTS. Por eso omite `mode`/`vectorWeight` por completo y confía en el default `'auto'`, que — probado en un test de integración dedicado — produce ranking/scores **idénticos** a `'semantic'` estricto cuando SÍ hay embedder disponible (ambos corren la misma cascada vectorial HNSW), pero degrada a FTS en vez de tirar error cuando no lo hay.

Bajo el capó, `memory_search` llama exactamente al mismo endpoint que `memory_recall` (`client.recall()` → `POST /recall`), solo que con un subconjunto más chico de parámetros expuestos (sin `asOf`, sin `mode`, sin `sessionId`) y un formato de salida ligeramente distinto (`memories` con `content` en vez de `statement`, sin campo `subject`/`kind` explícito).

**Parámetros**:

| Parámetro  | Tipo                                      | Requerido | Default | Notas                                                                                                                 |
| ---------- | ----------------------------------------- | --------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `query`    | string (min 1)                            | Sí        | —       | Texto libre a buscar semánticamente                                                                                   |
| `limit`    | int [1,20]                                | No        | 5       | Máximo de hits (más restrictivo que `memory_recall`, que permite hasta 25)                                            |
| `scope`    | enum `global`\|`conversation`\|`personal` | No        | (todos) | Mismo comportamiento que `memory_recall`: `'personal'` filtra a solo el espacio de trabajo personal (corregido en B1) |
| `scopeRef` | string                                    | No        | —       | Filtra por proyecto/entidad                                                                                           |
| `actorId`  | string                                    | No        | —       | Filtra por `ActorRef` exacto que escribió el hecho                                                                    |

**Cuándo usarla — casos de uso**:

- Buscar memoria por concepto cuando no se conoce la terminología exacta usada al guardarla (ej. buscar "manejo de errores" y encontrar un hecho que dice "estrategia de retry con backoff").
- Cuando `memory_recall` ya se usó para contexto general y se necesita un segundo pase más enfocado en similitud pura, sin el ruido de la expansión de relaciones a 1-hop.
- Preferirla sobre `memory_recall` cuando no se necesitan los campos extra (reminders, debug de composición) y se quiere una respuesta más compacta.

**Casos borde y gotchas**:

- El campo `score` en la respuesta **no es coseno puro** — es una mezcla de similitud coseno con activación ACT-R y worth, igual que en `memory_recall`. El nombre "búsqueda semántica" en la descripción puede sugerir un score de similitud vectorial aislado, pero no lo es.
- `debug.searchMode` es el único lugar confiable para saber si la llamada realmente corrió modo vectorial o cayó a FTS — el texto de respuesta (`content[0].text`) también lo indica en lenguaje natural ("Found N semantic memories" vs "Found N memories via FTS keyword fallback").
- Comparado con `memory_recall`, esta herramienta NO soporta `asOf` (sin recall bitemporal) ni `mode`/`vectorWeight` explícitos — si se necesita ese control, hay que usar `memory_recall` directamente.
- Mismo comportamiento de `scope: 'personal'` que `memory_recall` (corregido en B1): filtra a solo hechos del espacio de trabajo personal de quien llama, con 400 si la key no tiene `userId` o no hay espacio de trabajo personal configurado. Sin ese `scope`, los hechos personales del usuario ya se mezclan automáticamente vía multi-level recall si la key tiene `userId`.

**Ejemplos**:

```json
{ "query": "cómo manejamos reintentos de red", "limit": 8 }
```

```json
{ "query": "convenciones de nombres de branches", "scopeRef": "mnemosyne", "actorId": "key:abc123" }
```

Respuesta:

```json
{
  "memories": [
    {
      "id": "mfact_...",
      "content": "Usamos conventional commits, sin AI attribution.",
      "score": 0.71,
      "hitFreshness": "current"
    }
  ],
  "debug": { "searchMode": "hybrid" },
  "_mnemo_label": "untrusted_external_content"
}
```

---

## `memory_status`

**Qué hace**: Snapshot de salud y disponibilidad del espacio de trabajo de memoria. Hace 4 llamadas en paralelo (`GET /health` autenticado, `GET /admin/stats`, `GET /me`, `GET /health/ready`), todas best-effort (`.catch(() => null)`), y ensambla un resumen combinado.

Es importante distinguir lo que esta herramienta realmente reporta, porque el propio JSDoc del archivo documenta un hallazgo de auditoría (2026-07-28) sobre una versión anterior de la documentación que era **incorrecta**: la vieja versión afirmaba que `GET /health` "expone el estado individual de sub-componentes (db, embedder, queue)" — eso NUNCA fue así. `client.health()` golpea `GET /health` (autenticado, scoped al espacio de trabajo de quien llama), que devuelve una **snapshot de vitals del espacio de trabajo** (conteo de hechos, backlog de embeddings) — nunca un `status`/`components` por db/embedder/queue. Ese estado real por dependencia (postgres/vector/cache) vive en un endpoint completamente distinto: `GET /health/ready` (**no autenticado, a nivel de instancia — no scoped al espacio de trabajo de quien llama**), que fue cableado a esta herramienta el 2026-07-31 bajo el campo `dependencyHealth`.

También expone (P10) el espacio de trabajo personal del usuario cuando la key tiene `userId` asociado: id + conteo de hechos activos ahí. Esto estuvo roto en cualquier deployment real hasta el 2026-07-29 por un bug de recursión infinita en la policy RLS de `mnemo_workspace_member` (la policy de lectura hacía un EXISTS subquery contra sí misma) — el error de Postgres quedaba silenciosamente absorbido por un try/catch genérico, indistinguible de "este usuario no tiene espacio de trabajo personal". Se arregló con una función `SECURITY DEFINER` que evita re-disparar la misma policy RLS (migración `0012_workspace_member_rls_recursion.sql`).

**Parámetros**: ninguno — GET sin query string, `inputSchema: {}`.

**Cuándo usarla — casos de uso**:

- Diagnóstico rápido antes de una sesión larga de trabajo, para confirmar que la instancia está `ready` y no `degraded`.
- Ver la distribución de memoria por proyecto (`factsByScopeRef`) para entender cuánto contexto hay acumulado antes de decidir si vale la pena hacer un `memory_recall` amplio.
- Confirmar el backlog de embeddings pendientes cuando se sospecha que un `memory_search` reciente cayó a FTS por falta de indexación, no por falta de embedder.
- Chequeo operativo superficial antes de escalar a `memory_doctor` (que sí hace diagnóstico profundo de grants/schema).

**Casos borde y gotchas**:

- `dependencyHealth` es **instance-wide**, no específico de este espacio de trabajo — un `degraded` ahí afecta a todos los espacios de trabajo de la instancia, no solo al de quien llama. El texto de respuesta lo aclara explícitamente ("instance-wide, not workspace-scoped").
- Si `client.healthReady` no está disponible en el client-ts instalado (chequeo `typeof client.healthReady === "function"`), esta sección simplemente se omite — no rompe la herramienta.
- El desglose `factsByScopeRef` SÍ está verificado como preciso contra Postgres real (test de integración dedicado) — a diferencia de otros campos de esta herramienta que tuvieron bugs históricos, este nunca estuvo señalado como sospechoso.
- Para diagnóstico más profundo (grants, schema, estado de embeddings a nivel de motor), la propia descripción de la herramienta redirige explícitamente a `memory_doctor` — `memory_status` es deliberadamente superficial.

**Ejemplos**:

```json
{}
```

Respuesta (resumida):

```json
{
  "workspaceId": "ws_...",
  "factsLive": 340,
  "embeddings": { "indexed": 335, "pending": 5 },
  "factsByScopeRef": [
    { "scopeRef": "mnemosyne", "count": 210 },
    { "scopeRef": "acme", "count": 130 }
  ],
  "personal": { "workspaceId": "ws_personal_...", "factsLive": 12 },
  "dependencyHealth": {
    "status": "ready",
    "degraded": false,
    "checks": { "postgres": "ok", "vector": "ok", "cache": "ok" }
  }
}
```

---

## `memory_relate`

**Qué hace**: Crea o lista relaciones tipadas entre primitivos de memoria (hecho/decision/entity/episode), o reconstruye el linaje de una de ellas, sobre el grafo de conocimiento del espacio de trabajo. El vocabulario de verbos está **bloqueado en 9 valores** — locked set con CHECK constraint en SQL — y el server valida explícitamente contra `LOCKED_VERBS` devolviendo un 400 descriptivo (`invalid_verb`) si se intenta usar algo fuera de ese set, distinguiéndolo de un 422 genérico de validación Zod.

Tiene tres `action`:

- **`create`**: `POST /relations`. Requiere `sourceKind`, `from`, `targetKind`, `to`, `verb` — todos obligatorios cuando `action='create'`; si falta alguno, la herramienta devuelve error ANTES de llamar al server.
- **`list`**: `GET /relations`. Lista relaciones existentes (con `limit`, hasta 200 desde la herramienta, hasta 500 desde el server directo).
- **`history`**: reusa `POST /relations/traverse` fijando **deliberadamente** `verbs: ['supersedes', 'derived_from']` — ignora a propósito los otros 7 verbos. No es un traverse genérico: sirve específicamente para reconstruir "¿qué reemplazó esta primitiva?" o "¿de qué se derivó?" caminando la cadena desde el id dado. El propio código documenta que se evaluó y descartó una herramienta `memory_graph`/traverse genérico separada por falta de un caso de uso claro con gatillo de lenguaje natural.

Hay un efecto colateral no obvio documentado en el código (ENTITY-1): una relación `part_of` o `member_of` con `sourceKind='fact'` y `targetKind='entity'` **también** vincula el hecho a esa entidad (`mnemo_fact.entity_id`), haciendo que `memory_entity(action:'linked_facts')` lo devuelva. Esto solo aplica en esa dirección exacta y esos 2 verbos exactos — cualquier otro verbo o la dirección inversa (`entity→fact`) no vincula nada. Y gana la **primera** relación: si el hecho ya está vinculado a una entidad, una relación posterior a una entidad distinta no la pisa (aunque la relación en sí igual se crea en el grafo).

**Parámetros**:

| Parámetro        | Tipo                                         | Requerido   | Default                | Aplica a                                                                                                             |
| ---------------- | -------------------------------------------- | ----------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `action`         | enum `create`\|`list`\|`history`             | No          | `'create'`             | —                                                                                                                    |
| `sourceKind`     | enum `fact`\|`decision`\|`entity`\|`episode` | Condicional | —                      | `create`/`history`                                                                                                   |
| `from`           | string                                       | Condicional | —                      | `create`/`history` — id origen (para `history`, el id desde donde se camina)                                         |
| `targetKind`     | enum `fact`\|`decision`\|`entity`\|`episode` | Condicional | —                      | `create`                                                                                                             |
| `to`             | string                                       | Condicional | —                      | `create` — id destino                                                                                                |
| `verb`           | enum (9 valores locked)                      | Condicional | —                      | `create` — `related\|compatible\|scoped\|conflicts_with\|supersedes\|not_conflict\|derived_from\|part_of\|member_of` |
| `reason`         | string                                       | No          | —                      | Contexto opcional de por qué existe la relación                                                                      |
| `confidence`     | number [0,1]                                 | No          | asignado por el server | Confianza en la relación                                                                                             |
| `limit`          | int [1,200]                                  | No          | —                      | `list`                                                                                                               |
| `maxDepth`       | int [1,5]                                    | No          | 5 (máximo soportado)   | `history` — profundidad de la cadena de linaje                                                                       |
| `idempotencyKey` | string                                       | No          | —                      | Evita duplicar relaciones en retries                                                                                 |

**Cuándo usarla — casos de uso**:

- Vincular un hecho recién creado a la entidad que representa (`part_of`/`member_of`, hecho→entity) para que aparezca luego en `memory_entity(action:'linked_facts')`.
- Marcar que una decisión nueva `supersedes` a una anterior, en vez de dejar ambas como igualmente vigentes.
- Usar `action='history'` cuando un agente necesita explicar por qué la decisión/hecho actual es la vigente y qué reemplazó — ej. al responder "¿por qué elegimos esta arquitectura y no la anterior?".
- Marcar dos hechos como `not_conflict` cuando el sistema los detectó como potencialmente contradictorios pero en realidad no lo son (desambiguación explícita).

**Casos borde y gotchas**:

- `action='history'` NO sirve para el caso inverso: "¿qué reemplazó a ESTA vieja decisión?" sin conocer el id de la más nueva — el traverse subyacente es direccional únicamente (source→target).
- No confundir `memory_relate(action='history')` con `GET /graph/traverse` (otro endpoint del server, no expuesto por esta herramienta): ese es bidireccional, devuelve una lista rankeada por decay sin detalle de aristas, y soporta `asOf` bitemporal — están documentados en el código como intencionalmente NO redundantes, ambos se mantienen.
- Verbo fuera del set de 9 → 400 explícito (`invalid_verb`) tanto en `create` como al hacer `PATCH` (judgment), nunca crashea silenciosamente.
- El efecto colateral de auto-vinculación a entidad (ENTITY-1) es fácil de pasar por alto: crear una relación `related` entre un hecho y una entidad NO la vincula — solo `part_of`/`member_of` en la dirección `fact→entity` lo hacen.
- `action='create'` sin todos los campos requeridos devuelve error de la propia herramienta (sin round-trip al server): `"action='create' requires sourceKind, from, targetKind, to, and verb."`.

**Ejemplos**:

```json
{
  "action": "create",
  "sourceKind": "fact",
  "from": "mfact_pricing_pref",
  "targetKind": "entity",
  "to": "d0522e17-bd87-4ced-bc38-2b9a499beea7",
  "verb": "part_of",
  "reason": "Preferencia de pricing pertenece a la entidad Acme"
}
```

```json
{
  "action": "history",
  "sourceKind": "decision",
  "from": "mdec_auth_strategy_v3",
  "maxDepth": 3
}
```

```json
{ "action": "list", "limit": 50 }
```

## `memory_decide`

**Qué hace**: Persiste una decisión durable (arquitectónica, de política, de proceso, etc.) en `mnemo_decision` — una tabla distinta de `mnemo_fact`. Una decisión representa un compromiso explícito ("vamos a hacer X porque Y"), no una observación transitoria. El handler MCP llama a `client.createDecision()`, que resuelve a `POST /decisions` en el servidor.

La deduplicación funciona por upsert sobre `(workspace_id, topic_key)`. Desde el fix DECIDE-1 (2026-07-31), la comparación de `topicKey` es case/whitespace-insensitive (`lower(btrim(topic_key))`), tanto en la query de lookup como en el índice único parcial `uniq_mnemo_decision_topic` (migración 0017) — así que "Auth-Strategy" y "auth-strategy " (con espacio) matchean la misma fila, sin condición de carrera entre escrituras concurrentes con distinto casing. El valor almacenado conserva el casing original de quien creó la decisión primero; solo el matching se normaliza. Si se omite `topicKey`, el sistema **no lo deriva** de `title` — cada llamada sin `topicKey` crea una fila nueva, sin deduplicar (esto nunca estuvo implementado, pese a lo que la documentación original insinuaba).

Además del topic-key upsert, el servidor aplica dedup por `normalizedHash` (visible en el schema de respuesta), aunque el campo estructurado principal de control de duplicados que ve el LLM es `topicKey`.

Una decisión también soporta lifecycle: `PATCH /decisions/:id` la marca `status: "superseded"` y setea `supersededById` — pero esa operación no está expuesta en la herramienta `memory_decide` (solo create); habría que ir directo a la API o usar `memory_relate` para crear la relación `supersedes` correspondiente, que el servidor no crea automáticamente.

**Parámetros**:

- `kind` (enum, requerido): uno de `decision | architecture | policy | process | bugfix | learning | discovery | config` (8 valores, locked).
- `title` (string, requerido, 1–500 caracteres): resumen en una oración.
- `body` (string, requerido, mínimo 1 carácter, tope servidor 50 000): el rationale completo — alternativas consideradas y cuál se eligió van aquí en prosa libre; no existen campos estructurados separados para "alternativas"/"elegida".
- `topicKey` (string, opcional): clave de deduplicación normalizada.
- `conversationId` (string, opcional).
- `sensitivity` (enum, opcional): `public | internal | confidential | restricted`, default `internal`.
- `scopeRef` (string, opcional): alcance de proyecto/entidad.
- `idempotencyKey` (string, opcional): evita duplicar la decisión si la llamada se reintenta.

**Cuándo usarla — casos de uso**:

1. Registrar por qué se eligió Postgres sobre otra DB, con las alternativas evaluadas en `body`.
2. Documentar un bugfix con causa raíz (`kind: "bugfix"`).
3. Fijar una política de equipo ("todos los PR requieren 2 aprobaciones") con `kind: "policy"`.
4. Actualizar el rationale de una decisión existente reusando el mismo `topicKey`.

**Casos borde y gotchas**:

- **Discrepancia confirmada en código** (`packages/server/src/routes/decisions.ts`, comentario explícito): `deps.core.createDecision` (en `@mnemo-ai/core/factory.ts`) **no reenvía `actorId`/`userId`/`actorType` a storage hoy** — es un gap preexistente. Las decisiones creadas vía esta herramienta actualmente **no guardan atribución de autor real**, aunque el route ya pasa el valor correcto de `resolveProvenance(c)` (listo para cuando se corrija el core).
- Violación de sensitivity ceiling en lectura (`GET /decisions/:id`) devuelve 404, no 403 (anti-probing, S6).
- `POST /decisions` responde 201 tanto si crea como si topic-key ya existía (upsert), nunca 409.

**Ejemplos**:

```json
{
  "kind": "architecture",
  "title": "Usar PostgreSQL + pgvector como store principal",
  "body": "Se evaluó Pinecone y Postgres+pgvector. Se eligió Postgres por RLS nativo, transacciones ACID compartidas con el resto de los datos, y menor costo operativo a la escala actual.",
  "topicKey": "vector-store-choice",
  "sensitivity": "internal"
}
```

```json
{
  "kind": "bugfix",
  "title": "Fix: RLS bypass en consolidation scheduler",
  "body": "El scheduler corría con rol superuser, bypasseando FORCE RLS. Se movió a withMnemoTx.",
  "topicKey": "rls-bypass-consolidation"
}
```

---

## `memory_entity`

**Qué hace**: Gestiona el ciclo de vida completo de entidades (personas, organizaciones, proyectos, conceptos, lugares) en `mnemo_entity` vía `/entities`. Es un única herramienta multi-acción: `create`, `get`, `list`, `update`, `linked_facts`, `link_user`, `unlink_user`. Las entidades no decaen (`validTo` solo se setea por borrado explícito) y el sistema deduplica menciones vía `aliases`.

`linkedUserId` — el campo que vincula una entity `kind: "person"` a una cuenta real de la plataforma (`mnemo_user.id`) — **nunca puede establecerse vía `create`/`update`**: los schemas `CreateEntitySchema`/`PatchEntitySchema` del servidor directamente no incluyen ese campo. Solo `link_user`/`unlink_user` pueden tocarlo. El auto-vínculo (`userId` propio) siempre está permitido; vincular a otro usuario requiere permiso `memory:admin` **y** rol `owner`/`admin` en el espacio de trabajo, verificado vía `deps.apiKeys.getWorkspaceMemberRole`. Si la entidad ya estaba vinculada a otro usuario distinto, reasignarla exige el mismo permiso admin+rol **también** sobre el usuario que tenía el vínculo actual (no alcanza con tener permiso sobre el nuevo target) — para que quien llama no pueda "robarse" un vínculo ajeno con solo nombrarse a sí mismo como nuevo target.

Tanto `link_user` como `unlink_user` son operaciones **bitemporales**: nunca sobreescriben el campo in-place. Cierran la fila actual (`validTo = now()`), crean una fila sucesora con el nuevo estado, y las conectan con una relación `supersedes` — igual que la convención de `forget()`.

**Parámetros**:

- `action` (enum, default `create`): `create | get | list | update | linked_facts | link_user | unlink_user`.
- `id` (string, opcional): requerido para `get`/`update`/`linked_facts`/`link_user`/`unlink_user`.
- `userId` (string, opcional): requerido para `link_user` — debe ser miembro del espacio de trabajo.
- `name` (string, 1–200, opcional): requerido para `create`.
- `kind` (enum, opcional): `person | organization | project | concept | place | other` (6 valores) — requerido para `create`.
- `description` (string, opcional).
- `aliases` (array de strings, opcional).
- `q` (string, opcional): substring search para `list`.
- `limit` (número, 1–200, opcional).
- `metadata` (record, opcional).
- `sensitivity` (enum, opcional, default `internal`).
- `idempotencyKey` (string, opcional).

**Cuándo usarla — casos de uso**:

1. Crear una entidad `person` la primera vez que se menciona a alguien en una conversación.
2. `link_user` para vincular la entidad "Ada" con la cuenta real `mnemo_user.id` de Ada, habilitando queries "qué sabe el sistema sobre este usuario real".
3. `linked_facts` para ver todos los hechos asociados a un proyecto (entity `kind: "project"`).
4. `list` con `q` para buscar por nombre o alias antes de crear (evitar duplicados por el 409).

**Casos borde y gotchas**:

- `create` con `(name, kind)` duplicado devuelve **409 Conflict** — la descripción de la herramienta instruye explícitamente usar `get`/`list` en ese caso en vez de reintentar `create`.
- La herramienta **no expone `canonicalId`** (el "merge knob" que existe en `PATCH /entities/:id` de la API HTTP para fusionar entidades duplicadas) — fusionar dos entidades no es posible desde este MCP herramienta, solo vía HTTP directo.
- Violación de sensitivity ceiling en cualquier lectura → 404 (anti-probing).
- `link_user` sobre una entidad que no es `kind: "person"` → 400.
- `unlink_user` sobre una entidad sin vínculo actual → 404.

**Ejemplos**:

```json
{
  "action": "create",
  "name": "Acme",
  "kind": "organization",
  "description": "Consulting client: HR platform",
  "aliases": ["Acme HR"]
}
```

```json
{
  "action": "link_user",
  "id": "d0522e17-bd87-4ced-bc38-2b9a499beea7",
  "userId": "usr_9f8e7d6c5b4a"
}
```

---

## `memory_pin`

**Qué hace**: Marca (o desmarca) un hecho como `pinned` en `mnemo_fact.pinned`, protegiéndolo de fusión/poda automática por el pipeline de consolidación. Se implementó como herramienta separada (no como flag de `remember`) deliberadamente: pinear es una acción de curación posterior — típicamente después de que el hecho demostró su valor — y bundlearla con la creación tentaría a un LLM a pinear todo lo que escribe, anulando el propósito.

**Verificación de la promesa vs. el código real** (auditoría 2026-07-28, confirmada contra Postgres real y el gate de consolidación sin mockear):

- **"Protege de prune/forget automáticos" → VERDADERO.** `pinFact()` escribe la misma columna/tabla que `ConsolidationGate.ts` lee en su condición `pinned` — un hecho pineado falla esa condición de forma confiable y nunca es fusionado.
- **"Le da prioridad en recall" → FALSO en el path real.** `memory_recall`/`memory_search` resuelven a `POST /recall` → `recallCold()`. La proyección `viewFact()` de ese pipeline **nunca copia** `fact.pinned` al `PrimitiveView` que lee la fórmula de blended-score de Stage 5 — un hecho pineado y uno idéntico sin pinear salen con **el mismo score**, sin boost de ranking. Existe un módulo legacy (`packages/core/src/recall/search.ts`) que sí computa una columna `pin_bonus`, pero respalda `deps.core.recall`/`searchMnemo`, que **no es** el código path que ejercen `memory_recall`/`memory_search` — ese bonus es inalcanzable desde esta herramienta.

**Parámetros**:

- `factId` (string, requerido, mínimo 1 carácter): id del hecho a pinear.
- `unpin` (boolean, opcional, default `false`): `true` para despinear en vez de pinear.
- `idempotencyKey` (string, opcional).

**Cuándo usarla — casos de uso**:

1. Proteger un hecho crítico (ej. "el usuario prefiere TypeScript strict mode") de ser fusionado por consolidación con hechos similares de bajo worth.
2. Despinear (`unpin: true`) un hecho que ya no es crítico, permitiendo que vuelva a ser candidato de consolidación.
3. Curar manualmente conocimiento después de revisar resultados de `memory_timeline` o `memory_recall`.

**Casos borde y gotchas**:

- **No usar esta herramienta esperando subir el hecho en los resultados de recall** — no funciona hoy, pese a lo que sugeriría el nombre. Es puramente una protección contra merge/forget automático.
- El servidor devuelve error si el hecho ya está archivado (`status: "forgotten"`) — el mensaje se surface verbatim porque es accionable.
- Bajo el capó, pin/unpin son la misma ruta HTTP (`POST /facts/:id/pin` con `{ pinned: true|false }`); el SDK expone `pinFact`/`unpinFact` como wrappers separados, la herramienta elige uno u otro según el flag `unpin`.

**Ejemplos**:

```json
{ "factId": "fct_8a2b1c3d4e5f6789" }
```

```json
{ "factId": "fct_8a2b1c3d4e5f6789", "unpin": true }
```

---

## `memory_timeline`

**Qué hace**: Devuelve los hechos más recientemente creados/actualizados/archivados del espacio de trabajo, ordenados por el evento más reciente de cada uno — no solo por fecha de creación. El caso de uso primario es un diff tipo "¿qué aprendió mi IA esta semana?". Delega a `client.timeline()` → `GET /timeline`, que a su vez llama a `core.timeline()`.

El ordenamiento por "evento más reciente" está garantizado a nivel DB: `mnemo_fact` tiene un trigger `BEFORE UPDATE` que estampa `updated_at = now()` en **cualquier** mutación (pin/unpin, el path de archive-on-forget, ediciones), y la query ordena `ORDER BY updated_at DESC` — verificado contra un rol Postgres NOSUPERUSER real (test de integración dedicado).

El servidor solo soporta los query params `since`/`limit` en `GET /timeline` — no tiene filtro por `kind`/`status` — por lo que la herramienta MCP deliberadamente no expone esos parámetros (para no advertir un no-op). El campo `sinceIso` de la herramienta se mapea directo al `since` del servidor.

**Parámetros**:

- `limit` (número, 1–100, opcional, default 20): valores fuera de rango son **rechazados** como error de herramienta MCP, no recortados silenciosamente a 100.
- `sinceIso` (string, opcional): fecha ISO; solo eventos posteriores. Si se omite, el servidor por defecto usa las últimas 24 horas.

**Cuándo usarla — casos de uso**:

1. Un resumen semanal/diario de qué conocimiento nuevo entró al espacio de trabajo.
2. Paginación incremental: usar `sinceIso = lastSeenEventTime` del último evento recibido (el servidor devuelve eventos newest-first, así que esto da paginación limpia sin offsets).
3. Auditoría rápida de qué hechos fueron pineados/despineados recientemente.
4. Detectar hechos recién cerrados (`forget()`) para revisión.

**Casos borde y gotchas**:

- **Corregido (B3, 2026-08-10)**: ahora sí se emite `kind: "created"` para un hecho recién creado. El fix vive fuera de `factory.ts` (owned file, sin crecimiento permitido de `CoreLike`): `FactFilter` ganó un campo aditivo `createdSince?: Date`, y `GET /timeline` mergea el stream legacy de `core.timeline()` (sigue emitiendo solo `closed | pinned | updated`, sin cambios) con una segunda lectura vía `storage.queryFacts({ createdSince })`, mapeada a eventos `kind: "created"`. Dedupe: cuando el evento legacy de un hecho tiene el mismo `at` que su `createdAt` (hecho nunca tocado), se descarta el `"updated"` fantasma y se conserva solo `"created"`. Si `deps.storage` no está wireado, degrada al stream legacy sin fallar (sin eventos `created`, comportamiento pre-fix).
- "max 100" se aplica por el propio schema Zod de la herramienta (rechazo, no clamp).
- La respuesta incluye `nextCursor` (string o null) además de `events`, aunque la herramienta documentada (v3.2) recomienda paginar manualmente con `sinceIso`.

**Ejemplos**:

```json
{ "limit": 50 }
```

```json
{ "sinceIso": "2026-08-01T00:00:00.000Z", "limit": 100 }
```

---

## `memory_episode_start`

**Qué hace**: Inicia una sesión efímera (episodio) llamando a `client.createSession()` → `POST /session/start`. Los recuerdos generados dentro de la sesión (turnos) viven en estado volátil (buffer de sesión, potencialmente respaldado por Redis vía `sessionBuffer` si está wireado) hasta que `memory_episode_end` colapsa el contenido en memoria durable. Devuelve un `sessionId` que el llamador debe guardar.

Internamente, el servidor también intenta una pre-inyección de anticipación (§30): si `deps.storage` y `deps.workingMemory` están wireados, pre-carga en el slot L0 de working memory las memorias que el motor de anticipación predice relevantes para esta sesión — best-effort, cualquier falla se loguea y no bloquea la creación de la sesión. Esos ids anticipados vuelven en el campo `anticipated` de la respuesta HTTP (aunque la herramienta MCP no los expone en su texto de salida).

**Parámetros**:

- `agentId` (string, opcional): agente que inicia el episodio. Si se omite, usa el agente por defecto del espacio de trabajo.
- `label` (string, opcional): etiqueta legible (ej. `"Reunión con cliente 2026-06-12"`) para búsqueda/debug posterior.
- `metadata` (record, opcional): metadatos arbitrarios (ej. `{ projectId, ticketUrl }`).
- `idempotencyKey` (string, opcional): si se reintenta el arranque, el servidor devuelve la sesión original.

**Cuándo usarla — casos de uso**:

1. Al comenzar una conversación multi-turno significativa que se espera genere conocimiento durable.
2. Antes de una sesión de trabajo larga (ej. debugging extenso) donde vale la pena extraer decisiones/hechos al final.
3. Con `label` descriptivo para poder encontrar la sesión después vía `memory_session`.

**Casos borde y gotchas**:

- La respuesta de la herramienta **no usa `structuredContent`** — a diferencia de `memory_decide`/`memory_entity`/`memory_pin`/`memory_timeline`/`memory_consolidate`, esta herramienta solo devuelve un bloque de texto plano: `` `Episode started. sessionId: ${id}${labelSuffix}` ``. Quien llama de forma programática debe parsear el `sessionId` del texto, no leerlo de un campo estructurado.
- No hay garantía de que la sesión se colapse automáticamente — `memory_episode_end` es el "cierre obligatorio" del ciclo; una sesión nunca cerrada queda abierta indefinidamente (sujeta a los timeouts de `CollapsePolicy` si hay un colapso automático wireado por inactividad).
- Iniciar una sesión no crea ningún hecho/decision por sí sola — solo abre el contenedor.

**Ejemplos**:

```json
{ "label": "Debug RLS bypass en scheduler", "agentId": "claude-code" }
```

```json
{ "metadata": { "projectId": "mnemosyne", "ticketUrl": "https://github.com/org/repo/issues/42" } }
```

---

## `memory_episode_end`

**Qué hace**: Cierra un episodio y ejecuta el pipeline de colapso completo — `client.collapseSession()` → `POST /session/:id/collapse` → `collapseSession()` en `packages/core/src/session/collapse.ts` (función exportada como `runCollapseSession` en el factory; nótese que **no** vive bajo `packages/core/src/cognitive/session/`, sino bajo `packages/core/src/session/`). El pipeline real tiene 8 pasos:

1. **Carga** de sesión + turnos (desde el `sessionBuffer` Redis-backed si está wireado, si no directo de storage).
2. **Viabilidad mínima**: si `turns.length < minTurnsForCollapse` (default 3), se salta (`skipReason: "too_few_turns"`). También existe un gate `requirePin` (forzado a `true` en modo `hybrid`) que salta si ningún turno está pineado.
3. **Gate RecMem**: coherencia temática vía mean-of-max de similitud coseno pairwise entre embeddings de turnos. Por debajo de `recurrenceThreshold` (default 0.6) se salta sin gastar LLM (`skipLlmIfBelowThreshold`, default `true`).
4. **Una única llamada LLM** (temperature 0.1, para reproducibilidad) que devuelve `{ goal, outcome, facts[], decisions[], strategies[], discoveries[], nextSteps[], relevantEntities[], keyDecisions[] }`.
5. **Gate de sorpresa (prediction error)** por cada hecho extraído: `PE = 1 − similitud_máxima_a_conocimiento_existente`. Por debajo de `config.surpriseThreshold` (default 0.3) se descarta por no ser suficientemente novedoso.
6. **Persistencia**: crea cada hecho/decision/strategy individualmente (no hay transacción única — "atomic" aquí significa "sin batching", no ACID cross-item). Si una escritura falla, la sesión **no** se cierra, permitiendo retry completo.
7. **Co-ocurrencia hebbiana**: crea relaciones `related` entre cada par de hechos extraídos en la misma sesión (alimenta la expansión de relaciones Stage 3 de recall). Luego crea un `MnemoEpisode` (delta-encoded contra el episodio más similar si supera 0.85, DELTAMEM §16), extrae hyperedges vía LLM si hay ≥3 hechos, propaga worth por outcome (salvo en modo cold-start/`learningMode`), y corre TD(λ) credit propagation.
8. **Cierre** de sesión, contadores de graduación de modo (learning→production), ciclo de auto-reflexión cada `REFLECTION_CADENCE` colapsos, cómputo de accuracy de anticipación, y limpieza del footprint en Redis.

Degradación: si el LLM no está disponible, `status: "failed"`, sesión preservada para reintento.

**Parámetros**:

- `sessionId` (string, requerido, mínimo 1 carácter): id devuelto por `memory_episode_start`.
- `collapseHint` (string, opcional): pista en lenguaje natural embebida en el prompt del LLM ("influye pero no garantiza" la extracción).
- `idempotencyKey` (string, opcional): evita colapsar la misma sesión dos veces.

**Cuándo usarla — casos de uso**:

1. Cierre normal de una sesión iniciada con `memory_episode_start` una vez terminada la conversación.
2. Forzar extracción completa incluso en sesiones cortas usando `collapseHint` (que fuerza `strategy: "explicit"`, y por lo tanto `reason: "explicit"` en el pipeline, en vez de `"inactivity"`).
3. Guiar la extracción ("priorizar decisiones del usuario, ignorar mensajes de sistema") vía `collapseHint`.

**Casos borde y gotchas**:

- **El HTTP 202 "Accepted" es engañoso**: pese al código de estado que sugiere procesamiento asíncrono, el propio comentario del SDK (`client.ts`) lo aclara: _"The server returns 202 Accepted after the collapse pipeline completes"_ — el handler hace `await collapseWithPhases(...)` **antes** de responder. Es decir, la llamada MCP bloquea hasta que el pipeline de 8 pasos termina.
- La herramienta MCP **descarta** el `CollapseResult` rico (factsCreated, decisionsCreated, strategiesCreated, outcome, anticipationAccuracy, etc.) — solo devuelve el texto `"Episode ended and collapsed. sessionId: X"`, sin ningún conteo. Para ver cuántos hechos se crearon hay que consultar `memory_timeline` después.
- Soporta reintentos idempotentes con recovery points (`session_locked` → `llm_called` → `facts_persisted` → `completed`): un retry después de `facts_persisted` **no vuelve a correr** el pipeline (`resumed: true`), evitando doble extracción.
- Sesión no encontrada o ya colapsada → 404 (`isError: true`). Fallo del LLM en pleno colapso → error degradado `MNEMO_004`, sesión queda activa para reintentar.

**Ejemplos**:

```json
{ "sessionId": "sess_3f8a9b2c1d0e" }
```

```json
{
  "sessionId": "sess_3f8a9b2c1d0e",
  "collapseHint": "Priorizar la decisión de arquitectura tomada sobre el vector store; ignorar saludos."
}
```

---

## `memory_consolidate`

**Qué hace**: Dispara un pass de consolidación manual e inmediato para el espacio de trabajo de quien llama, delegando a `POST /consolidation/trigger` → `runConsolidationTick()` de `@mnemo-ai/consolidation` — **la misma función que corre el scheduler de fondo en cada tick**, pero acotada al espacio de trabajo de quien llama. Existe un scheduler de fondo separado (`packages/consolidation/src/scheduler.ts`) que corre en un `setInterval` simple (no es un sistema de colas completo — eso es v3.1) cada 60 segundos aproximadamente, wireado en el boot del servidor.

**Modo fast (cosine-only, único modo soportado manualmente)**: consulta candidatos de bajo worth (excluye `confidential`/`restricted` de entrada), agrupa clusters por similitud de embedding, y corre el `ConsolidationGate` de 6+ condiciones sobre cada cluster — **cualquier condición que falle aborta el merge de ese cluster completo** (diseño deliberadamente conservador: "no fusionar pares — demasiado agresivo"). Condiciones: cluster ≥ 3 miembros, ningún miembro `canonical`, `worth < 0.5` en TODOS los miembros, ninguno recordado en los últimos 14 días, ningún límite inferior de Wilson de confianza > 0.7, ninguno pineado, ninguno `contested`, sensibilidad uniforme entre miembros, y similitud coseno pairwise mínima ≥ 0.85.

**Modo deep (solo vía scheduler de fondo, NO alcanzable manualmente)**: además del clustering por coseno, clasifica cada par candidato con LLM (`classifyFactPair`) y memoiza el resultado por par leyendo relaciones ya existentes (`loadLinkedFactIds`) para no re-pagar el costo LLM en cada tick — puede escribir relaciones `conflicts_with` o `not_conflict` según el veredicto. El scheduler de fondo tiene **`mode: "deep"` habilitado por defecto en producción** (kill switch: `MNEMO_CONSOLIDATION_DEEP_MODE_ENABLED=false`), pero esto es completamente independiente de esta herramienta.

**Parámetros**:

- `mode` (enum, opcional, default `fast`): `fast | deep`. Pedir `deep` manualmente devuelve HTTP 422.
- `dryRun` (boolean, opcional, default `false`): pedir `true` devuelve HTTP 422 — no hay modo dry-run implementado todavía.
- `idempotencyKey` (string, opcional): evita disparar dos pasadas si el trigger se reintenta.

**Cuándo usarla — casos de uso**:

1. Forzar una pasada inmediata después de un batch grande de `memory_remember`, sin esperar el próximo tick del scheduler.
2. Un orquestador que quiere procesar el conjunto acotado de candidatos de bajo worth antes de razonar sobre el estado del grafo.
3. Operación manual/debug para verificar que el gate de consolidación efectivamente fusiona (o no) un cluster esperado.

**Casos borde y gotchas**:

- `mode: "deep"` o `dryRun: true` son rechazados **antes** de tocar storage — la validación (`assertSupportedConsolidationRequest`) corre sobre el body parseado, no requiere que storage esté disponible para fallar con 422.
- Si `@mnemo-ai/consolidation` no está instalado → 503 `consolidation_unavailable` (la herramienta agrega la sugerencia de instalarlo y reiniciar). Si no hay adapter de storage wireado → 503 `storage_unavailable`.
- El contexto de trigger manual **no inyecta el replay validator del scheduler de boot** salvo que esté explícitamente configurado (`deps.replayValidator`/`deps.getReplayValidator`) — el comportamiento de validación de un trigger manual puede diferir del de un tick automático de fondo.
- La respuesta siempre trae `mode: "fast"` y `dryRun: false` literalmente en el schema — reflejando que son los únicos valores que llegan a ejecutarse.
- Si no hay candidatos o ningún cluster pasa el gate, la herramienta imprime una nota amigable en vez de solo ceros.

**Ejemplos**:

```json
{}
```

```json
{ "mode": "fast", "dryRun": false, "idempotencyKey": "consolidate-2026-08-06-manual" }
```

---

## `memory_remind_when`

**Qué hace**: Crea, lista o descarta recordatorios de memoria prospectiva. Un recordatorio se activa por dos mecanismos: un disparador temporal (`triggerAt`, evaluado por un poller de background cada 30 segundos) y/o un disparador semántico (`condition`, evaluado en cada llamada real a `memory_recall`, contra la query real del usuario). El evaluador puro vive en `packages/core/src/reminders/evaluator.ts` (`evaluatePendingReminders`) y prueba, en orden, tres estrategias de match semántico: (1) similitud coseno si hay `conditionEmbedding` guardado y hay embedding de la query disponible (umbral 0.7), (2) juicio LLM YES/NO si hay un adapter LLM configurado, (3) fallback por keyword-match FTS. Un recordatorio disparado pasa a `status='triggered'` vía `dismissReminder()` — la fila nunca se borra.

**Parámetros** (schema Zod en `packages/mcp/src/tools/remind_when.ts`):

- `action`: `"create" | "list" | "dismiss"`, default `"create"`.
- `id`: string, opcional — requerido solo para `action='dismiss'`.
- `status`: `"pending" | "triggered" | "dismissed" | "all"`, opcional — filtro para `action='list'`, default `"pending"`.
- `content`: string, min 1 — requerido para `action='create'`, es el texto que se surfacea al disparar.
- `condition`: string, min 1, opcional — condición semántica; requerida si no se pasa `triggerAt`.
- `triggerAt`: string ISO 8601 datetime, opcional — requerida si no se pasa `condition`.
- `limit`: number, entero, 1–200, opcional — para `action='list'`.
- `idempotencyKey`: string, opcional — evita duplicados en retries de `action='create'`.

**Cuándo usarla — casos de uso**:

1. Recordar revisar algo en una fecha futura ("recuérdame revisar el deploy el lunes 10:00").
2. Recordatorio puramente semántico sin fecha fija: "cuando el usuario mencione Kubernetes, recuérdale la limitación de recursos del cluster".
3. Recordatorio combinado (AND real): "a partir del lunes, si la query menciona el proyecto X, recuerda el bloqueo pendiente" — solo dispara en un `memory_recall` real posterior a `triggerAt` cuya query satisfaga `condition`.
4. Auditar recordatorios ya disparados con `action='list', status='triggered'` para revisar qué se le mostró al agente.

**Casos borde y gotchas**:

- **Verificación del bug AND/OR reportado**: el código actual (`evaluator.ts` línea 322: `fires = timeMatch && semanticMatch`) implementa correctamente lógica **AND** para recordatorios compuestos. Esto corresponde a la fase REMIND-1 (2026-07-27, ver `docs/STATUS.md`) — **el bug fue corregido**, no está roto hoy.
- **Gotcha real que persiste** (no es un bug, es diseño documentado en el propio código): el poller de background de 30s (`packages/server/src/index.ts`, alrededor de la línea 1178) **solo puede disparar recordatorios sin `condition` en absoluto** — su query SQL de descubrimiento filtra explícitamente `condition IS NULL OR btrim(condition) = ''`. Cualquier recordatorio compuesto (`triggerAt` + `condition`) o puramente semántico **nunca dispara vía el poller** — únicamente puede disparar dentro de una llamada real a `memory_recall` que traiga una query con la que evaluar `condition`. Si el agente nunca vuelve a llamar `memory_recall` después de crear un recordatorio compuesto, ese recordatorio queda pendiente indefinidamente aunque el `triggerAt` ya haya pasado.
- El embedding de `condition` se calcula una sola vez, al crear el recordatorio (`routes/reminders.ts`) — si en ese momento no hay LLM adapter configurado, el recordatorio queda sin `conditionEmbedding` y siempre usará el fallback FTS (menos preciso) en vez de coseno.
- `action='list'` sin `status` solo muestra `pending` — el contenido de un recordatorio ya disparado sigue existiendo en la base pero es invisible a menos que pidas `status='triggered'` o `'all'` explícitamente.
- La ruta de disparo (`memory_recall`) es RLS-scoped, por lo que un recordatorio jamás cruza espacios de trabajo.

**Ejemplos**:

```json
{
  "action": "create",
  "content": "Revisar si el deploy a producción de chatbot-service terminó bien",
  "triggerAt": "2026-08-10T14:00:00Z"
}
```

```json
{
  "action": "create",
  "content": "Recordar la limitación de memoria del cluster K8s de staging",
  "condition": "el usuario pregunta sobre performance o escalado en Kubernetes"
}
```

```json
{ "action": "list", "status": "triggered", "limit": 20 }
```

---

## `memory_self_edit`

**Qué hace**: Permite que el propio agente edite su memoria con 6 acciones (spec §13): `append`/`replace` (modifican contenido), `strengthen`/`weaken` (ajustan `worth` vía un mecanismo de crédito bayesiano — `updateWorth(..., { success, failure, creditWeight })`, no un delta fijo), `reflect` (corre el ciclo completo de auto-reflexión) y `link` (crea un hyperedge n-ario: `target` es el miembro ancla, `content` son los demás ids separados por coma, mínimo 3 miembros totales). `target` es polimórfico: `fact_id`, `"profile"`, o `"strategy:{id}"`. Toda la lógica de política vive del lado del servidor en `packages/core/src/cognitive/self-edit.ts` (`evaluateSelfEdit`) contra `DEFAULT_SELF_EDIT_POLICY`.

**Corregido (B4, 2026-08-10)**: `action: "forget"` fue **eliminada** del enum — ya no es una acción soportada por esta herramienta. Antes quedaba atascada permanentemente en `202 { approvalRequired: true }` sin ningún flujo de aprobación real que completar (no existía `ApprovalStore`, ni resume executor, ni wrapper en `client-ts`). El server ahora responde **422** `self_edit_forget_unsupported` si de todos modos se intenta (por ejemplo con una versión antigua de quien llama), con un mensaje que indica usar `memory_forget` (`kind: 'fact' | 'strategy'`) — que ya cubre exactamente lo mismo que hacía internamente `applySelfEdit("forget")` (`archiveFact`/`archiveStrategy`). `client-ts` mantiene `"forget"` en el union de tipos marcado `@deprecated` para que el 422 siga siendo tipado/observable sin romper compilación de quienes llaman con versiones antiguas.

**Parámetros** (schema Zod en `packages/mcp/src/tools/self_edit.ts`):

- `action`: `"append" | "replace" | "strengthen" | "weaken" | "reflect" | "link"` — requerido. No soporta `forget` — usar `memory_forget`.
- `target`: string, min 1 — `fact_id`, `"profile"` o `"strategy:{id}"`.
- `content`: string, máx 20.000 chars, opcional — requerido efectivamente para `append`/`replace`/`link`.
- `reason`: string, min 1, máx 2.000 — obligatorio siempre, contexto para la política.
- `idempotencyKey`: string, opcional.

**Cuándo usarla — casos de uso**:

1. Agregar información a un hecho existente sin perder lo anterior (`append`).
2. Bajar el peso de una preferencia que resultó ser incorrecta sin borrarla del todo (`weaken`).
3. Vincular 3+ hechos relacionados en un solo hyperedge semántico (`link`).
4. Disparar manualmente el ciclo de reflexión de un agente (`reflect`) para consolidar aprendizajes de la sesión.

**Casos borde y gotchas**:

- **`action='forget'` ya no existe en esta herramienta (corregido, B4)**: el schema Zod ya no la acepta — quien la intente recibe un error de validación local antes de llegar al server. Si el server recibe igual un `action:"forget"` (versión antigua de quien llama sin actualizar), responde **422** `self_edit_forget_unsupported` en vez del antiguo `202 { approvalRequired: true }` que nunca tenía forma de resolverse (no había `ApprovalStore` ni resume executor). **Para borrar/invalidar un hecho o strategy usa la herramienta dedicada `memory_forget` (bitemporal, cierra `validTo`)** — hace exactamente lo mismo que hacía internamente el viejo `action='forget'`.
- Límites diarios/por sesión hardcodeados en `DEFAULT_SELF_EDIT_POLICY`: `maxEditsPerSession: 5`, `maxDeletesPerDay: 3`, `maxStrengthensPerDay: 3`, `maxWeakensPerDay: 5`, `editCooldown: 300` segundos (5 min entre ediciones consecutivas del mismo agente) — al superarlos, la respuesta es 429 con el mensaje explicando qué límite se agotó.
- `strengthen` tiene además un tope de **máximo 1 por hecho por día** (`strengthensTodayForTarget`), independiente del tope diario global.
- `reason` es obligatorio por schema pero, según el propio JSDoc del archivo, **todavía no se audita de forma durable** — es contexto de política, no un audit-log persistido.
- `target="profile"` no admite `strengthen`/`weaken` — tira error explícito ("requires a hecho or strategy target, not profile").
- Los contadores de budget se persisten en Redis (`CacheAdapter.incrWithTtl`) cuando hay cache configurado; sin cache caen a un `Map` en memoria del proceso, válido solo para dev local — en multi-instancia sin Redis el límite se evade fácilmente.

**Ejemplos**:

```json
{
  "action": "weaken",
  "target": "fact_01HZXK...",
  "reason": "La preferencia resultó desactualizada tras confirmación del usuario"
}
```

```json
{
  "action": "link",
  "target": "fact_A",
  "content": "fact_B, fact_C",
  "reason": "Los tres facts describen la misma decisión de arquitectura desde ángulos distintos"
}
```

---

## `memory_update`

**Qué hace**: Wrapper ergonómico y delgado sobre `client.selfEdit({ action: "replace", target: factId, content: statement, reason })`. A diferencia de `memory_self_edit`, esta herramienta no expone las 6 acciones — solo cubre el caso de uso de "corrige este hecho". Del lado del servidor se aplica el **replace bitemporal completo**: cierra `validTo` en el hecho original y crea una fila nueva con el statement corregido — el `id` del hecho cambia. Toda la lógica de autorización, RLS y herencia de `worth` vive en `SelfEditPolicy`, esta herramienta no reimplementa nada.

**Parámetros** (schema Zod en `packages/mcp/src/tools/update.ts`):

- `factId`: string, min 1 — requerido, id del hecho a corregir.
- `statement`: string, min 1, máx 1000 — requerido, nuevo contenido que reemplaza el statement actual.
- `reason`: string, opcional — default `"Updated via memory_update"` si se omite.

**Cuándo usarla — casos de uso**:

1. El usuario corrige un dato guardado incorrectamente ("no, mi timezone es GMT-3 no GMT-5").
2. Actualizar un hecho que quedó desactualizado por un cambio de contexto (cambio de rol, cambio de stack).
3. Corregir un typo o ambigüedad en un statement guardado por `memory_remember`.

**Casos borde y gotchas**:

- A diferencia de `memory_self_edit` con `action='forget'`, este SÍ se aplica sin gating de aprobación: `parsedTarget.kind === "fact"` para un `replace` deja `approvalScope = null` en `self.ts` (el gate `edit_entity` solo aplica cuando el target **no** es un hecho — p. ej. `"profile"` o `"strategy:{id}"`). Un `memory_update` sobre un hecho real corre directo.
- Ownership: la ruta verifica `fact.userId`/`fact.actorId` contra la procedencia de quien llama en dos campos separados — nunca contra `apiKeyPrefix`. Si el hecho pertenece a otro actor/usuario y quien llama no tiene permiso `memory:admin`, la respuesta es 404 (no 403 — mismo patrón anti-probing de sensitivity ceiling).
- `statement` tiene un límite de 1000 caracteres — más corto que el límite de 20.000 de `memory_self_edit`'s `content`, porque esta herramienta está pensada para correcciones puntuales, no para reescrituras extensas.
- Consume el mismo budget `maxEditsPerSession: 5` / `editCooldown: 300s` que cualquier `memory_self_edit`, porque internamente ES un self-edit `replace`.
- El hecho original queda preservado (cierra `validTo`, no se borra) — es auditable vía el mismo mecanismo bitemporal que `forget()`.

**Ejemplos**:

```json
{
  "factId": "fact_01HZXK...",
  "statement": "Ada prefiere TypeScript en modo strict en todos los proyectos nuevos"
}
```

```json
{
  "factId": "fact_01HZY2...",
  "statement": "El deploy de chatbot-service se hace vía GitLab CI, no acceso directo al server",
  "reason": "Corrección tras confirmar el flujo real con el usuario"
}
```

---

## `memory_judge`

**Qué hace**: Expone conflictos no resueltos entre hechos (relaciones `conflicts_with` creadas por el pase de consolidación) y permite resolverlos interactivamente. `action='list'` trae pares de conflicto vía `GET /conflicts`; `action='resolve'` aplica una resolución vía `POST /conflicts/:id/resolve`. Cuatro estrategias: `supersede_a` (olvida factA, la relación original se pasa a `not_conflict` y se crea una relación nueva separada `factB --supersedes--> factA`), `supersede_b` (espejo), `keep_both` (relación pasa a `not_conflict`, ningún hecho se toca), `merge` (olvida ambos originales, crea un hecho nuevo con `mergedStatement`, crea dos relaciones `supersedes` nuevas hacia el merged). Las 4 estrategias retiran correctamente la relación `conflicts_with` original, así que un conflicto resuelto nunca vuelve a aparecer en un `list` posterior.

**Parámetros** (schema Zod en `packages/mcp/src/tools/judge.ts`):

- `action`: `"list" | "resolve"` — requerido.
- `limit`: number, entero, 1–20, opcional — solo `action='list'`, default 5.
- `relationId`: string, opcional — requerido para `action='resolve'` (viene del campo `relationId` que devuelve `list`).
- `resolution`: `"supersede_a" | "supersede_b" | "keep_both" | "merge"`, opcional — requerido para `action='resolve'`.
- `mergedStatement`: string, opcional — requerido solo cuando `resolution='merge'`.

**Cuándo usarla — casos de uso**:

1. Revisar periódicamente conflictos detectados por consolidación antes de que se acumulen.
2. El usuario corrige explícitamente cuál de dos hechos contradictorios es el correcto (`supersede_a`/`supersede_b`).
3. Dos hechos parecen contradecirse pero en realidad aplican a contextos distintos (`keep_both`).
4. Fusionar dos versiones parciales de un mismo hecho en un statement unificado y más completo (`merge`).

**Casos borde y gotchas**:

- **Relación con `decideAutoResolution` (`packages/core/src/conflict/decide.ts`)**: verificado el código — el gate de auto-resolución exige `confidence > 0.7` (estrictamente mayor, no `>=`). De las 4 reglas de prioridad, solo la regla 1 (**trust-anchor**, confidence 0.9) supera ese umbral y auto-resuelve sin intervención. La regla 2 (**recency**) tiene confidence exactamente 0.7 — **no** cruza el umbral `> 0.7`, así que **siempre** cae a revisión manual pese a ser una regla "de prioridad". Las reglas 3 (**worth-gap**, 0.6) y 4 (**ambiguous**, 0) también siempre caen a revisión. En la práctica, esto significa que casi todos los conflictos que llegan a `memory_judge` son por recency/worth-gap/ambigüedad — los de trust-anchor claro ya se resolvieron solos antes de llegar aquí.
- **`merge` NO es atómico** (hallazgo de auditoría documentado en el propio código, aún abierto — no es un bug corregido): a diferencia de `memory_update`/`memory_self_edit`'s `replace`, que usan `StorageAdapter.replaceFact` en una sola transacción, `merge` en `packages/server/src/routes/conflicts.ts` encadena **seis transacciones `withMnemoTx` separadas** (dos `closeFact` en paralelo, un `createFact`, un `patchRelation`, dos `createRelation` en paralelo) sin atomicidad cruzada. Un crash a mitad de camino puede dejar ambos originales olvidados sin un hecho fusionado, o un hecho fusionado con lineage incompleto.
- `merge` además pierde `subject`/`kind` de los hechos fuente: `createFact` los hardcodea a `subject:"workspace", kind:"other"` — a diferencia de `replaceFact`, que sí los preserva.
- El hallazgo histórico de que `GET /conflicts` y `POST /conflicts/:id/resolve` **404eaban siempre** porque `mountConflicts(v1, deps)` nunca se llamaba en `app.ts` está **corregido** (verificado 2026-07-27) — las rutas están montadas y funcionan.
- `mergedStatement` faltante con `resolution='merge'` retorna error explícito de la herramienta antes de siquiera llamar al server.

**Ejemplos**:

```json
{ "action": "list", "limit": 10 }
```

```json
{
  "action": "resolve",
  "relationId": "rel_01HZAB...",
  "resolution": "merge",
  "mergedStatement": "El usuario prefiere reuniones async por Slack, salvo decisiones críticas que requieren llamada"
}
```

---

## `memory_doctor`

**Qué hace**: Corre 8 diagnósticos operacionales y devuelve un `DoctorReport` estructurado. Las comprobaciones 1–6 se ejecutan del lado del servidor, vía `client.doctor()` → `GET /doctor`: (1) `connectivity` — Postgres alcanzable vía `deps.core.ping()`; (2) `app_user_grants` — el rol `app_user` tiene `USAGE` en el schema `mnemosyne`; (3) `schema_shadows` — detecta nombres de tabla duplicados entre schema `public` y `mnemosyne`; (4) `migration_version` — última migración aplicada; (5) `embedding_backlog` — hechos vivos sin embedding o con embedding desactualizado; (6) `workspace_id_valid` — el `workspace_id` autenticado es un UUID bien formado. Checks 7–8 corren dentro del propio proceso MCP: (7) `env_config` — `MNEMO_URL`/`MNEMO_KEY` presentes; (8) `mcp_tools` — el servidor MCP tiene exactamente `MCP_TOOL_COUNT` herramientas registrados, medido con un `ToolRegistrationProbe` en vivo (no una tautología). Sin parámetros de entrada, no hace auto-remediación — es solo reporte.

**Parámetros**: ninguno (`inputSchema: {}`).

**Cuándo usarla — casos de uso**:

1. Diagnosticar un 500 inesperado antes de asumir que es un bug de código.
2. Verificar que un deploy fresco (por ejemplo a `agents.example.com` en otros proyectos, o cualquier nuevo entorno de Mnemosyne) está sano antes de darlo por terminado.
3. Confirmar que las variables de entorno del cliente MCP (`MNEMO_URL`, `MNEMO_KEY`) están cargadas correctamente.
4. Detectar backlog de embeddings pendientes antes de que afecte la calidad del recall semántico.

**Casos borde y gotchas**:

- **`schema_shadows` reporta `"warn"` en TODO deploy sano** — no es una alarma real. `docker/Dockerfile.migrate` corre dos streams de migración en paralelo (el legacy/`public` de `@mnemo-ai/core` y el v3/`mnemosyne` de `@mnemo-ai/adapter-postgres`), y ambos crean tablas con el mismo nombre (`mnemo_fact`, `mnemo_entity`, `mnemo_relation`, ...) en schemas distintos por diseño ("dual-core hybrid"). El check no puede distinguir ese overlap esperado de una colisión accidental real — trata `"warn"` aquí como normal salvo que `shadowCount` cambie entre corridas.
- **`workspace_id_valid`'s branch `"error"` es inalcanzable en producción real** — verificado: tanto el lookup de API key (`packages/core/src/api-key-lookup.ts`) como el gate `isWorkspaceId()` de `auth.ts` rechazan un `workspace_id` malformado con 400 **antes** de que cualquier route handler (incluido este) llegue a ejecutarse. El check se mantiene por defensa en profundidad, pero nunca vas a verlo disparar contra la API real.
- El check 8 (`mcp_tools`) fue corregido de una tautología real (DOCTOR-1): antes comparaba un valor contra sí mismo y nunca podía fallar; ahora mide en vivo cuántos registrars corrieron y falla con `"error"` si alguno tiró excepción durante el boot (no solo `"warn"` por mismatch de conteo).
- Si el server no es alcanzable, los checks 1–6 colapsan en un único check sintético `{ name: "server", status: "error" }` — no vas a ver el detalle de cuál de los 6 falló, solo que no se pudo conectar.
- El status global (`worst`) sigue la jerarquía `error > warn > unknown > ok` sobre todos los checks combinados (server + env + mcp_tools).

**Ejemplos**:

```json
{}
```

Respuesta esperada en un deploy sano típico (resumen): `status: "warn"` (por `schema_shadows`), con el resto de los checks en `"ok"`.

---

## `memory_stats`

**Qué hace**: Snapshot agregado de estadísticas del espacio de trabajo autenticado, delegando a `GET /admin/stats`. Devuelve: `facts.{live, closed, pinned, archived, withZeroHits, byScopeRef}`, `decisions.active`, `relations.conflicts`, `embeddings.{indexed, pending}`, `recall.{hitRate30d, lastRecallAt}`, `lastWriteAt`, más `workspaceId` y `generatedAt`.

**Parámetros**: ninguno (`inputSchema: {}`).

**Cuándo usarla — casos de uso**:

1. Snapshot rápido de salud de memoria antes de una pasada grande de recall o consolidación.
2. Detectar hechos con `withZeroHits` para revisión o poda.
3. Monitorear backlog de embeddings pendientes.
4. Ver cuándo fue la última escritura o recall del espacio de trabajo, útil para debugging de "¿está realmente inactivo este espacio de trabajo?".

**Casos borde y gotchas**:

- **No todos los campos son en vivo**: `facts.live/closed/pinned`, `facts.byScopeRef`, `embeddings.indexed/pending`, `recall.lastRecallAt` y `lastWriteAt` se calculan en vivo en cada llamada (vía `deps.core.vitals()`). También `relations.conflicts` (los pares sin resolver dentro del techo de sensibilidad de quien llama). Pero `facts.archived`, `facts.withZeroHits`, `decisions.active` y `recall.hitRate30d` leen un snapshot periódico (`mnemo_health`, cron diario `mnemo.health.snapshot` a las 03:00 UTC, `packages/server/src/cron/jobs.ts`) y pueden estar desactualizados hasta 24 horas en un espacio de trabajo recién activo.
- **No existe forma MCP-callable de forzar el refresh de esos 4 campos** — verificado: `GET /admin/stats` llama a `getHealthSnapshot({ fresh: false })` sin excepción. El único endpoint que fuerza refresh real (`GET /governance/drift?fresh=true`, `packages/server/src/routes/governance.ts`) no tiene wrapper en `client-ts`, requiere el permiso `memory:governance` (que las API keys típicas de MCP no tienen), y tiene side-effects de escritura por-espacio de trabajo sin throttle — deliberadamente no se agregó un wrapper para no exponer eso desde una herramienta de solo lectura.
- Si `getHealthSnapshot()` falla o todavía no hay snapshot (cold start), la ruta captura el error y sirve `archived`, `withZeroHits`, `decisions.active` y `hitRate30d` como `null`, con `snapshot.available: false`, en vez de responder 500: `null` significa "no hay snapshot utilizable", no cero. `relations.conflicts` no depende del snapshot: siempre es el conteo en vivo (un número) y solo se lee `null` si ese conteo falla.
- Todos los números están scoped por RLS al espacio de trabajo autenticado — no hay forma de ver stats cross-espacio de trabajo con esta herramienta (para eso existe `memory_status`/admin/stats a nivel operador, distinta herramienta).

**Ejemplos**:

```json
{}
```

Ejemplo de shape de respuesta:

```json
{
  "workspaceId": "ws_01HZ...",
  "facts": {
    "live": 342,
    "closed": 58,
    "pinned": 12,
    "archived": 5,
    "withZeroHits": 27,
    "byScopeRef": { "chatbot-service": 120 }
  },
  "decisions": { "active": 14 },
  "relations": { "conflicts": 2 },
  "embeddings": { "indexed": 340, "pending": 2 },
  "recall": { "hitRate30d": 0.71, "lastRecallAt": "2026-08-09T10:02:11Z" },
  "lastWriteAt": "2026-08-09T09:58:03Z"
}
```

---

## `memory_purge`

**Qué hace**: Hard-delete físico de hechos — `DELETE FROM mnemo_fact` real, sin deletion-log, sin crypto-erasure de la DEK del actor, sin audit trail. Dos acciones: `fact` (borra un hecho por id vía `DELETE /facts/:id/hard`) y `closed` (bulk-delete de todos los hechos con `status='forgotten'` en el espacio de trabajo vía `DELETE /facts/purge`). Ambas requieren el permiso `memory:hard_delete` en el API key (403 si falta). No es GDPR-compliant: para borrado Artículo 17 real hay que usar `memory_forget` en modo hard (`packages/core/src/cognitive/forget.ts`), que sí genera deletion-log y destruye la DEK del actor.

**Parámetros** (schema Zod en `packages/mcp/src/tools/purge.ts`):

- `action`: `"fact" | "closed"` — requerido.
- `factId`: string, opcional — requerido cuando `action='fact'`.

**Cuándo usarla — casos de uso**:

1. Limpieza de espacios de trabajo de test/CI donde no importa retener audit trail.
2. Purga de un hecho puntual creado por error en un ambiente de prueba.
3. Reclamar espacio en bulk borrando todo lo ya marcado `forgotten` en un espacio de trabajo descartable.
4. **Nunca** para borrado GDPR real de datos de un usuario — para eso, `memory_forget` con el modo hard correspondiente.

**Casos borde y gotchas — verificación fresca del reporte "completamente no funcional"**:

- **El reporte histórico de que `memory_purge` es "completamente no funcional" está DESACTUALIZADO — el bug fue corregido y verificado en el código actual (2026-08-09):**
  - `deps.core.hardDeleteFact`/`purgeClosedFacts` **sí** están implementados en `packages/core/src/factory.ts` (líneas 762 y 779): ambos ejecutan un `DELETE FROM mnemo_fact ... RETURNING id` real dentro de `withMnemoTx` (RLS respetada).
  - `DELETE /facts/purge` **ya no** está tapado por `DELETE /facts/:id`: en `packages/server/src/routes/facts.ts`, la ruta `/facts/purge` está registrada en la línea 231, **antes** de `/facts/:id` (línea 264) y de `/facts/:id/hard` (línea 347). El propio código deja un comentario explícito documentando el bug histórico y por qué el orden de registro importa (Hono resuelve rutas por orden de registro; `/facts/:id` es un wildcard que capturaba `"purge"` como si fuera un `id` literal antes de que el handler dedicado corriera).
  - Existe un test de integración específico que prueba esto contra Postgres real: `packages/server/src/__tests__/integration/purge-facts-hard-delete.integration.test.ts`.
- Gotcha real que persiste (no es un bug, es una salvaguarda intencional): ambas queries de purge excluyen explícitamente hechos con `metadata ? '__mnemoConsolidationPending'` — un hecho que está en medio de un pase de consolidación no se puede purgar hasta que ese flag se limpie, para evitar borrar algo que el pipeline de consolidación todavía está usando.
- `action='fact'` con `factId` vacío o solo espacios devuelve error de validación de la herramienta antes de llamar al server.
- Es **irreversible** — a diferencia de `memory_forget` (soft), no hay `restore`. `DELETE /facts/:id/hard` y `DELETE /facts/purge` no tienen equivalente de undo.
- El permiso `memory:hard_delete` no suele estar en API keys estándar de agente — si la herramienta devuelve 403, no es un bug, es la política de permisos funcionando como se espera.

**Ejemplos**:

```json
{ "action": "fact", "factId": "fact_01HZXK..." }
```

```json
{ "action": "closed" }
```

---

## `memory_compare`

**Qué hace**: Compara dos `facts` por ID (`factIdA`, `factIdB`). **Actualizado (docs/archive/openspec/decompose-recall-and-compare, Slice 2, 2026-08-10)**: la herramienta ahora es un cliente HTTP delgado — llama a `client.compareFacts({ factIdA, factIdB })`, que pega contra `POST /facts/compare` del lado del servidor, y devuelve la respuesta tal cual (sin cómputo local). Toda la lógica de diff/heurística (antes en `packages/mcp/src/tools/compare.ts`) vive ahora en `packages/server/src/facts/compare.ts` (módulo puro, sin I/O), alcanzable por cualquier cliente HTTP, no solo por este proceso MCP. El contrato de la herramienta para quien la invoca — parámetros, forma de la respuesta, comportamiento — es idéntico a antes; solo cambió dónde corre el cómputo. Produce tres salidas: (1) una lista de diferencias legibles por campo (`content`, `pinned`, `validFrom`, `validTo` — sin tags, ver corrección B6 abajo), (2) un booleano `sameSubject`, y (3) un verbo de relación sugerido (`supersedes | conflicts_with | compatible | scoped`).

**Corregido (B6, 2026-08-10)**: se eliminó el código muerto que antes existía pero era estructuralmente inalcanzable. El diff de tags (`computeDifferences`) y el atajo de overlap de tags en `detectSameSubject` fueron **removidos** — `mnemo_fact` no tiene columna `tags`, así que ese código nunca podía dispararse en producción. El verbo `related` también fue **removido** de `SuggestableVerb` (ahora solo 4 valores) — su única precondición (`factA.workspaceId !== factB.workspaceId`) es inalcanzable desde un proceso MCP real, atado a un único `MnemosyneClient`/espacio de trabajo por vida del proceso; un intento cross-espacio de trabajo 404ea antes de llegar a `suggestVerb`. `sameSubject` ahora compara solo tokens de `content` (ya no hay overlap de tags que comprobar primero). La sugerencia de verbo sigue un árbol de decisión: si `sameSubject` es true, compara `createdAt` — si difieren por más de 60 segundos, sugiere `supersedes`; si están muy cerca en el tiempo, sugiere `conflicts_with` (asume que es una contradicción, no una actualización). Si `sameSubject` es false, revisa si exactamente uno de los dos hechos tiene `validTo` cerrado (`scoped`); si no, cae al default `compatible` (antes: comparaba `workspaceId` y podía devolver `related`).

**Parámetros**:

- `factIdA` (string, requerido, min 1 char) — ID del primer hecho (ej. `mfact_...`).
- `factIdB` (string, requerido, min 1 char) — ID del segundo hecho.

No hay más parámetros — la herramienta no acepta filtros, límites ni opciones de formato.

**Cuándo usarla — casos de uso**:

1. Detectar si una preferencia de usuario cambió ("¿el hecho nuevo reemplaza al viejo o los contradice?").
2. Antes de llamar `memory_relate`, usar `memory_compare` para obtener el verbo sugerido y no adivinarlo a mano.
3. Auditar duplicados: dos hechos casi idénticos con contenido levemente distinto — ver si son la misma cosa reformulada.
4. Debug de recall: cuando `memory_recall` devuelve dos hits que parecen redundantes, comparar para decidir si conviene un `forget()` o una relación `supersedes`.

**Casos borde y gotchas**:

- **`related` ya no existe como verbo posible (corregido, B6)** — un par de hechos genuinamente no relacionados ahora siempre cae en `compatible`, por diseño, no como efecto secundario de una precondición inalcanzable. Cubierto en `packages/mcp/src/__tests__/contracts/compare.test.ts`.
- **Los tags nunca aparecen en el diff (corregido, B6, código muerto removido)** — `mnemo_fact` no tiene columna `tags` en el schema baseline, y `rowToFact` (en `packages/core/src/factory-mappers.ts`) hardcodea `tags: []`, así que el diff de tags y el shortcut de overlap de tags en `detectSameSubject` fueron eliminados en vez de dejarse como código muerto disclosed. Toda comparación real corre solo el chequeo de overlap de tokens del contenido.
- No hay distinción de sensibilidad más allá de lo que ya aplica `POST /facts/compare` del lado del servidor (mismo guard de 3 pasos que `GET /facts/:id`, RLS-scoped) — si uno de los dos IDs pertenece a un hecho fuera del ceiling de sensibilidad de quien llama, o no existe, o está cerrado, el endpoint responde 404 (anti-probing, nunca 403) y toda la comparación se cancela con `isError: true`.
- Diferente de `memory_relate`: `memory_compare` **no crea ninguna relación** — solo sugiere. Hay que llamar `memory_relate` por separado con el verbo elegido.

**Ejemplos**:

```json
{ "factIdA": "mfact_01J...abc", "factIdB": "mfact_01J...xyz" }
```

```json
{ "factIdA": "mfact_pref_theme_dark", "factIdB": "mfact_pref_theme_light" }
```

---

## `memory_session`

**Qué hace**: Herramienta unificada de control de sesión (spec §24) que consolida 10 operaciones bajo un único discriminador `action`. Reemplaza (de forma aditiva — las herramientas legacy siguen funcionando) la superficie previamente fragmentada entre `memory_pin`, `memory_episode_start` y `memory_episode_end`, y agrega dos acciones (`get`/`list`) que cerraron un gap real: las rutas `GET /session/:id` y `GET /session/list` existían del lado del servidor pero no eran alcanzables desde ningún cliente porque `client-ts` no tenía métodos wrapper (bug de "orphan route" detectado en auditoría de fidelidad, 2026-07-31).

Cada `action` mapea a un método distinto de `client-ts` y a una ruta HTTP distinta: `start`→`POST /session/start`, `turn`→`POST /session/:id/turn`, `pin_turn`→`POST /session/:id/pin`, `pin`→`POST /facts/:id/pin`, `scratch`→`POST /session/:id/scratch`, `collapse`→`POST /session/:id/collapse`, `discard`→`POST /session/:id/discard`, `feedback`→`POST /session/:id/feedback`, `get`→`GET /session/:id`, `list`→`GET /session/list`.

`start` además dispara pre-inyección de anticipación (§30): si `deps.storage` y `deps.workingMemory` están wireados, calcula memorias anticipadas y las devuelve en el campo `anticipated` de la respuesta (falla silenciosamente — nunca bloquea la creación de sesión). `collapse` resuelve una `CollapsePolicy` por agente (umbrales de `maxTurns`/`maxTokens`/`inactivityTimeout`) y corre el pipeline completo de extracción de 8 pasos de forma asíncrona (202 Accepted); soporta reintentos idempotentes vía `idempotencyKey`, devolviendo `resumed: true` si una fase ya completada se saltea. `feedback` mapea `rating: "up"/"down"` a un `explicitSignal` que actualiza el worth de todos los hechos recuperados durante esa sesión. `discard` archiva sin colapsar — importante: NO ejecuta extracción de conocimiento (un bug previo llamaba `collapseSession` aquí por error).

**Parámetros**:

- `action` (enum, requerido): `start | turn | pin_turn | pin | scratch | collapse | discard | feedback | get | list`.
- `sessionId` (string, opcional) — requerido para `turn`, `pin_turn`, `collapse`, `scratch`, `discard`, `feedback`, `get`.
- `rating` (enum `up|down`, opcional) — requerido para `feedback`.
- `agentId` (string, opcional) — para `start`.
- `factId` (string, opcional) — requerido para `pin`.
- `turnIndex` (number int, opcional) — para `pin_turn`.
- `turnId` (string, opcional) — para `turn`/`pin_turn`.
- `unpin` (boolean, opcional, default false) — pasar `true` para despinear en vez de pinear (`pin`/`pin_turn`).
- `content` (string, max 20 000, opcional) — para `scratch` y `turn`.
- `role` (enum `user|assistant|system`, opcional) — default `assistant` en `scratch`, `user` en `turn`.
- `collapseHint` (string, opcional) — fuerza extracción `explicit` en lugar de heurística `auto`.
- `metadata` (record, opcional) — usado por `start`, `turn`, `scratch`.
- `idempotencyKey` (string, opcional, §34.9) — evita re-aplicar la operación en retries.

**Cuándo usarla — casos de uso**:

1. Abrir una sesión al inicio de una conversación multi-turno (`start`), agregar turnos (`turn`), y cerrarla con `collapse` para que el pipeline extraiga hechos/decisions/episodios.
2. Guardar una nota de trabajo efímera mientras el agente resuelve un problema (`scratch`) sin comprometerla a memoria durable todavía.
3. Pinear un turno crítico dentro de una sesión larga para que sobreviva la política de collapse (`pin_turn`), distinto de pinear un hecho ya persistido (`pin`).
4. Registrar feedback explícito del usuario al final de una tarea (`feedback`) para ajustar el worth de los hechos usados.

**Casos borde y gotchas**:

- `pin` (acción de esta herramienta) protege un hecho del olvido/fusión automáticos — **no** le da prioridad en recall; es un error común asumir que "pinned" implica "top of results".
- `scratch`: `content` se guarda bajo la clave `note` dentro del objeto scratch; cualquier `metadata` adicional se spreadea junto a `note`, así que puede pisar la clave `role` si se pasan ambos con nombres en conflicto.
- `discard` vs `collapse`: `discard` tira el buffer efímero sin extracción — irreversible, se pierde todo lo no colapsado. Es la diferencia clave entre "cerrar y aprender" vs "cerrar y olvidar".
- Si hay `sessionBuffer` (Redis) wireado, `turn` escribe con write-through (Redis + Postgres); si no, usa `core.appendTurn` directo a Postgres — el comportamiento de latencia difiere según configuración del server, invisible desde la herramienta.
- `SessionOut.lastRecallAt` se lee desde `metadata.lastRecallAt`, no es un campo de primera clase en la tabla — solo aparece si algún `POST /recall` pasó ese `sessionId`.

**Ejemplos**:

```json
{ "action": "start", "agentId": "support-bot", "metadata": { "channel": "slack" } }
```

```json
{ "action": "collapse", "sessionId": "sess_01J...", "collapseHint": "explicit" }
```

---

## `memory_task`

**Qué hace**: CRUD completo + verbos de dominio para tareas accionables con lifecycle. El estado se valida mediante una máquina de estados explícita (`packages/core/src/cognitive/tasks.ts`, `TASK_TRANSITIONS`), aplicada **solo** en el path `patch` (del lado del servidor, `PATCH /tasks/:id`), que rechaza transiciones ilegales con 409 vía `IllegalTaskTransitionError`. Las transiciones válidas son:

```
pending     → in_progress, cancelled
in_progress → blocked, completed, delegated, cancelled
blocked     → in_progress, cancelled
delegated   → completed, cancelled
completed   → (terminal, sin salida)
cancelled   → (terminal, sin salida)
```

`delegate` llama a la ruta dedicada `POST /tasks/:id/delegate`, que aplica la misma validación de transición (`assertValidTransition(status, "delegated")`), estampa `delegatedBy`/`delegatedAt`, y respeta una allow-list de política (`canDelegateTo`) — puede rechazar con 403 si la política del agente lo prohíbe. `complete` es azúcar sintáctica sobre `PATCH` con `status: "completed"`; el handler PATCH del server dispara `autoExtractOnCompletion` en la primera transición fresca a `completed` (no se re-ejecuta si ya estaba completada): si `lessonsLearned` está poblado, crea un `MnemoStrategy` + relación `derived_from`; si `outcome` está poblado, crea un `MnemoFact` (kind `"other"`, attribution `"inferred"`) + relación `derived_from`; siempre crea un `MnemoEpisode` narrando el cierre, y emite un `MnemoEvent` inmutable (`name: "task.completed"`, `source: "task_auto_extract"`) enlazando strategy/hecho/episode por id en su `metadata`.

**Parámetros**:

- `action` (enum, requerido): `create | get | list | patch | archive | delegate | complete`.
- `id` (string, opcional) — requerido para `get/patch/archive/delegate/complete`.
- `title` (string, 1–500, opcional) — requerido para `create`.
- `description` (string, max 20 000, opcional).
- `status` (enum, opcional): `pending | in_progress | blocked | delegated | completed | cancelled`.
- `priority` (enum, opcional): `critical | high | medium | low`.
- `assignedTo` (string, opcional) — requerido para `create` y `delegate`.
- `sessionId`, `parentTaskId` (string, opcional).
- `dueAt` (ISO datetime, opcional).
- `sensitivity` (enum `public|internal|confidential|restricted`, opcional, default `internal`).
- `outcome`, `lessonsLearned` (string, max 20 000, opcional).
- `metadata` (record, opcional).
- `parentTaskIdFilter` (string, opcional) — filtro de `list`.
- `limit` (int 1–500, opcional).
- `idempotencyKey` (string, opcional) — solo aplica a `create`.

**Cuándo usarla — casos de uso**:

1. Crear un ítem de trabajo con dueño (`assignedTo`) y fecha límite, con dependencias jerárquicas (`parentTaskId`).
2. Descomponer una tarea grande en subtareas y trackear su avance vía `status`.
3. Delegar una tarea a otro agente con `delegate`, respetando políticas de quién puede delegar a quién.
4. Cerrar una tarea con `complete`, incluyendo `outcome` y `lessonsLearned` para que el sistema extraiga conocimiento automáticamente sin esfuerzo manual.

**Casos borde y gotchas**:

- **`archive` ahora respeta el estado terminal (corregido, B7, 2026-08-10).** `DELETE /tasks/:id` sigue llamando a `storage.archiveTask()` sin pasar por `assertValidTransition` (una guardia ahí habría roto el archivado de tareas `completed`, ya que `TASK_TRANSITIONS.completed === []`), pero `archiveTask` mismo dejó de forzar `status: "cancelled"` incondicionalmente: ahora usa `SET valid_to = now(), status = CASE WHEN status IN ('completed','cancelled') THEN status ELSE 'cancelled' END` (mismo fix en `TaskRepository` e `InMemoryStorageAdapter`, exportado como `TERMINAL_TASK_STATUSES` desde `@mnemo-ai/types`). Efecto: una tarea `completed` archivada conserva `status: 'completed'` (con `validTo` cerrado); una tarea no terminal sigue cancelándose como antes. `action: "patch", status: "cancelled"` sobre una tarea `completed` sigue rechazando con 409, sin cambios — la asimetría real entre los dos caminos de cierre quedó cerrada.
- `sensitivity` default es `"internal"`, no `"public"` — quien omite el campo no obtiene la tarea más visible, obtiene la intermedia.
- Distinta de `memory_event`: las tareas tienen estado mutable y lifecycle; los eventos son inmutables. Para "algo que ya pasó" usar `memory_event`; para "algo que hay que hacer" usar `memory_task`.
- El auto-extract en `complete` es best-effort — si falla, el status ya quedó comprometido (`completed`) y el error se traga silenciosamente (catch vacío en el server), así que no hay garantía de que exista un hecho/strategy derivado incluso si `outcome`/`lessonsLearned` estaban poblados.
- La política `taskScopes.canCreate`/`canDelegate`/`canDelegateTo` se busca por el `actorId` crudo de la credencial, no por el `ActorRef` namespaced — coherente con `rbac-policy.ts`/`ratelimit.ts`, pero hay que tenerlo presente si se está debugueando por qué una policy no aplica.

**Ejemplos**:

```json
{
  "action": "create",
  "title": "Migrar tabla mnemo_task a partición mensual",
  "assignedTo": "agent:db-migrator",
  "priority": "high",
  "dueAt": "2026-08-15T00:00:00Z"
}
```

```json
{
  "action": "complete",
  "id": "mtask_01J...",
  "outcome": "Migración aplicada sin downtime.",
  "lessonsLearned": "Usar CREATE INDEX CONCURRENTLY antes del ALTER, no después."
}
```

---

## `memory_event`

**Qué hace**: Registra un evento inmutable en el log del espacio de trabajo (`mnemo_event`, append-only por diseño — sin `updatedAt`). Soporta 6 acciones: `create`, `get`, `list`, `archive` (NO-OP declarado), `annotate` (append-only), `sensitivity` (raise-only). En `POST /events`, el server además dispara una automatización oculta pero documentada (T14): crea un `MnemoFact` a partir de `event.description` de forma fire-and-forget (`tags: ["auto:event"]`, `attribution: { source: "event", eventId, eventName }`), fusionando evento→memoria sin esfuerzo manual de quien llama.

`archive` es el caso más notable: `mnemo_event` **no tiene columna de estado** en el schema, así que `DELETE /events/:id` responde `204` pero no toca la fila en absoluto. La herramienta está diseñada para no mentir sobre esto — devuelve explícitamente `{ id, archived: false, immutable: true }` en vez de `{ archived: true }`, para que quien llama pueda distinguir un archivado real de un no-op. `sensitivity` es raise-only: el server compara con `sensitivityAtLeast(nuevo, existente)` y responde `422` si se intenta bajar el tier — nunca se permite reducir la sensibilidad de un evento ya escrito, coherente con el principio append-only.

**Parámetros**:

- `action` (enum, requerido): `create | get | list | archive | annotate | sensitivity`.
- `id` (string, opcional).
- `type` (enum, opcional): `system | external | user | agent | scheduled` — requerido para `create`.
- `name` (string, 1–500, opcional) — requerido para `create`.
- `description` (string, max 20 000, opcional) — requerido para `create`.
- `occurredAt` (ISO datetime, opcional) — requerido para `create`.
- `durationS` (int no-negativo, opcional).
- `source` (string, 1–200, opcional) — requerido para `create`.
- `relatedEntities` (array de strings, opcional).
- `metadata` (record, opcional).
- `sourceFilter`, `after`, `before` (opcional) — filtros de `list`.
- `limit` (int 1–500, opcional).
- `sensitivity` (enum, opcional) — tier inicial en `create` (default `internal`); nuevo tier requerido en la acción `sensitivity` (debe ser ≥ al actual).
- `idempotencyKey` (string, opcional) — solo aplica a `create`.
- `author` (string, 1–200, opcional) — requerido para `annotate`.
- `content` (string, 1–20 000, opcional) — requerido para `annotate`.
- `at` (ISO datetime, opcional) — timestamp opcional para `annotate`.

**Cuándo usarla — casos de uso**:

1. Registrar un webhook recibido de un sistema externo (`type: "external"`, `source: "github"`).
2. Registrar un deploy o migración concretada (`type: "system"`, `source: "ci"`), aprovechando la auto-creación de hecho para que el evento quede buscable semánticamente.
3. Agregar contexto post-hoc a un evento existente sin poder editarlo (`annotate`) — por ejemplo, notas de troubleshooting agregadas después.
4. Elevar la sensibilidad de un evento cuando se descubre que contenía datos más sensibles de lo que se pensó inicialmente (`sensitivity`, raise-only).

**Casos borde y gotchas**:

- `action: "archive"` es un no-op — si quien llama espera que el evento deje de aparecer en `list`, va a fallar: sigue apareciendo siempre. La herramienta documenta esto en su propia `description` y en el output (`immutable: true`), pero es fácil de pasar por alto.
- Si se necesita estado mutable (algo que se pueda cerrar/archivar de verdad), la herramienta misma recomienda usar `memory_remember` (`kind: 'fact'`) o `memory_task` en su lugar — no `memory_event`.
- `sensitivity` con acción `sensitivity` devuelve `422`, no `403`, si se intenta bajar el tier — no sigue el patrón "404 anti-probing" de violaciones de ceiling de lectura; es una validación de negocio distinta.
- La auto-creación de hecho (T14) es fire-and-forget (`.catch(() => {})`) — si falla, el evento se crea igual y no hay ningún indicio en la respuesta de que el hecho no se generó.
- Diferencia con `memory_task`: los eventos no tienen dueño ni lifecycle — son hechos puntuales ya ocurridos, no trabajo pendiente. No usar `memory_event` para trackear algo que hay que "resolver".

**Ejemplos**:

```json
{
  "action": "create",
  "type": "external",
  "name": "Webhook de pago recibido",
  "description": "Stripe confirmó el pago del invoice #4521.",
  "occurredAt": "2026-08-06T14:30:00Z",
  "source": "stripe",
  "sensitivity": "confidential"
}
```

```json
{
  "action": "annotate",
  "id": "mevt_01J...",
  "author": "user:pablo",
  "content": "Confirmado manualmente contra el dashboard de Stripe."
}
```

---

## `memory_reasoning`

**Qué hace**: Persiste y recupera cadenas de razonamiento (pregunta → pasos → conclusión) como una caché de chain-of-thought (spec §8). Ofrece CRUD estándar (`create/get/list/patch/archive`) más tres verbos de dominio que implementan el ciclo completo de la caché: `resolve` (¿existe un CoT reutilizable para esta pregunta?), `record` (grabar un CoT nuevo con deduplicación), `feedback` (reportar si un CoT cacheado funcionó, ajustando su lifecycle).

**`resolve`** tiene dos caminos: si se pasa `topicKey`, hace un lookup O(1) exacto y aplica `passesTopicKeyResolveGate` — el mismo gate que el camino vectorial, para evitar que un topic-key match sirva un CoT de baja evidencia. Si no hay `topicKey` o no matchea, cae al camino vectorial: embebe la query, busca los 5 candidatos más cercanos por coseno, y aplica `resolveDecision`, cuyo gate exige **las tres condiciones simultáneas**: `status` en (`active`,`golden`), coseno ≥ 0.88, `worth` > 0.5, Y el límite inferior de Wilson (`wilsonLowerBound(successCount+1, failureCount+1)`) > 0.3. Solo si las tres se cumplen es un "hit" — de lo contrario, "execute" (recomputar), devolviendo hasta 3 intentos similares.

**`record`** busca duplicados por coseno; si el top candidato tiene coseno ≥ 0.95 (`DEDUP_COSINE`), hace upsert de worth sobre el existente en vez de insertar uno nuevo. **`feedback`** actualiza `successCount`/`failureCount` (delta 0/1 según `outcome`) y luego evalúa `lifecycleTransition`: si `worth` cae debajo de 0.3 (`QUARANTINE_WORTH`), pasa a `quarantined` (salvo que ya lo esté); si `worth` > 0.8 (`GOLDEN_WORTH`) y `usageCount` ≥ 50 (`GOLDEN_MIN_USES`), promueve a `golden`; si estaba `quarantined` y el worth se recuperó ≥ 0.3, vuelve a `active`.

**Sobre "worth decay"**: `worth` es una columna `GENERATED ALWAYS AS worth_alpha / (worth_alpha + worth_beta)` en Postgres — el mismo modelo Beta-Bernoulli que `memory_strategy`, con prior Beta(2,2). **No decae por el mero paso del tiempo ni por falta de uso** — solo cambia cuando `record` o `feedback` mueven `successCount`/`failureCount` explícitamente. El comentario del tipo `MnemoReasoning` en `primitives.ts` dice "worth... decays with disuse", lo cual es impreciso: sin feedback explícito, el worth queda congelado en su valor actual indefinidamente.

**Parámetros**:

- `action` (enum, requerido): `create | get | list | patch | archive | resolve | record | feedback`.
- `id`, `agentId` (string, opcional).
- `question`, `conclusion` (string, max 20 000, opcional) — requeridos para `create`/`record`.
- `chain` (array de `{step: int, reasoning: string, conclusion?: string}`, max 200 pasos, opcional) — requerido y no-vacío para `create`/`record`.
- `topicKey` (string, max 200, opcional).
- `status` (enum, opcional): `active | archived | pruned | quarantined | golden`.
- `metadata` (record, opcional).
- `topicKeyFilter` (string, opcional), `limit` (int 1–500, opcional) — filtros de `list`.
- `query` (string, max 20 000, opcional) — requerido para `resolve`.
- `outcome` (enum `success|fail`, opcional) — requerido para `record` y `feedback`.
- `reasoningId` (string, opcional) — requerido para `feedback`.
- `sensitivity` (enum, opcional, default `internal`).

**Cuándo usarla — casos de uso**:

1. Cachear un razonamiento no obvio que costó varios pasos de LLM, para no recomputarlo la próxima vez que aparezca una pregunta similar (`record`).
2. Antes de razonar desde cero sobre un problema, comprobar si ya existe un CoT reutilizable (`resolve`) — ahorra tokens si hay hit.
3. Reportar que un CoT cacheado condujo a un resultado erróneo (`feedback` con `outcome: "fail"`), para que baje de worth y eventualmente se cuarentene.
4. Construir una librería de "cómo razoné sobre X" navegable por `topicKey` para un dominio recurrente (ej. debugging de RLS).

**Casos borde y gotchas**:

- Un CoT recién creado arranca en Beta(2,2) — worth 0.5, Wilson lower-bound ≈0.15 — por lo tanto **nunca puede ser un hit** en `resolve` hasta acumular al menos algo de feedback positivo explícito (el gate exige Wilson > 0.3). No hay bootstrapping automático como en el gate de hechos (`passesWorthGate`, que exime hechos nunca observados) — aquí el gate aplica siempre, sin excepción para CoTs nuevos.
- `resolve` sin LLM wireado (`deps.llm` ausente) siempre devuelve `{ action: "execute", similar_attempts: [] }` si no hay `topicKey` — degrada silenciosamente sin error.
- `resolve` con `topicKey`: si el candidato existe pero no pasa el gate, cae al camino vectorial en vez de fallar — comportamiento de fallback, no de error.
- Diferente de `memory_strategy`: reasoning cachea _procesos de pensamiento_ reutilizables para una pregunta puntual; strategy cachea _heurísticas condicionales_ (trigger→action) aplicables recurrentemente. No usar reasoning para "cuando pase X, haz Y" — eso es `memory_strategy`.

**Ejemplos**:

```json
{
  "action": "record",
  "question": "¿Por qué falla el RLS al insertar en mnemo_task desde un job cron?",
  "chain": [
    { "step": 1, "reasoning": "El job usa el rol superuser de conexión, no app_user." },
    { "step": 2, "reasoning": "withMnemoTx no se está llamando en el path del cron." }
  ],
  "conclusion": "Envolver la escritura del cron en withMnemoTx.",
  "topicKey": "rls-cron-jobs",
  "outcome": "success"
}
```

```json
{
  "action": "resolve",
  "query": "por qué el cron no respeta RLS al escribir tareas",
  "topicKey": "rls-cron-jobs"
}
```

---

## `memory_strategy`

**Qué hace**: CRUD + verbos de dominio para heurísticas trigger→action (`mnemo_strategy`) — "cuando ocurre X, hacer Y". Usa `op` como discriminador (no `action`, porque el campo `action` de la estrategia ya está ocupado por la respuesta a ejecutar). `store`/`create` son alias verdaderos a nivel de código (mismo handler); `recall`/`list` también son alias, con la diferencia de que `recall` por defecto filtra `status: "active"` (filtrado real, no cosmético) salvo que se pase un `statusFilter` explícito, mientras que `list` sin filtro devuelve todo. `rate` registra un resultado (`success`/`failure`) contra `POST /strategies/:id/rate`, que recalcula `successCount`/`failureCount` y — en el servidor — computa `newWorth = alpha/(alpha+beta)` con `alpha = 2 + successCount`, `beta = 2 + failureCount` y lo pasa a `updateStrategy`.

**Detalle interno verificado**: `worth` en `mnemo_strategy` es una columna `GENERATED ALWAYS AS worth_alpha / NULLIF(worth_alpha + worth_beta, 0)`. El repositorio (`KnowledgeRepository.updateStrategy`) **ignora silenciosamente** cualquier `worth` explícito que llegue en el input — solo deriva `worthAlpha`/`worthBeta` a partir de `successCount`/`failureCount` (mismo prior Beta(2,2) que reasoning) cuando esos dos campos cambian. El `newWorth` calculado en la ruta HTTP `/strategies/:id/rate` es, en la práctica, código muerto/redundante: el valor real que termina en la fila lo recalcula Postgres con la misma fórmula, así que el resultado observable coincide, pero la responsabilidad de cálculo vive en dos lugares a la vez.

**Parámetros**:

- `op` (enum, requerido): `create | get | list | patch | archive | store | recall | rate`.
- `outcome` (enum `success|failure`, opcional) — requerido para `rate`.
- `id` (string, opcional) — requerido para `get/patch/archive`.
- `trigger`, `action` (string, max 20 000, opcional) — ambos requeridos para `create`/`store`.
- `context` (string, max 20 000, opcional).
- `agentId`, `supersedesId` (string, opcional).
- `status` (enum, opcional): `active | superseded | archived`.
- `validFrom`, `validTo` (ISO datetime, opcional).
- `metadata` (record, opcional).
- `statusFilter` (enum `active|superseded|archived`, opcional) — filtro explícito de `list`/`recall`.
- `validAt` (ISO datetime, opcional) — filtro temporal.
- `limit` (int 1–500, opcional).
- `sensitivity` (enum, opcional, default `internal`).
- `scopeRef` (string, opcional) — escopa la estrategia a un proyecto/contexto específico (ej. `"project-x"`).
- `idempotencyKey` (string, opcional) — solo para `create`/`store`.

**Cuándo usarla — casos de uso**:

1. Guardar una heurística aprendida ("si el usuario pregunta por precios, muéstrale el plan enterprise primero") con `store`.
2. Recuperar las estrategias activas relevantes para el contexto actual antes de decidir cómo actuar (`recall`).
3. Reportar si aplicar una estrategia funcionó o no (`rate`), para que su worth converja hacia su tasa real de éxito.
4. Superseder una estrategia obsoleta por una nueva (`supersedesId` en `create`, luego `patch` de la vieja a `status: "superseded"`).

**Casos borde y gotchas**:

- `recall` con `statusFilter` explícito respeta ese filtro por completo — el default `"active"` solo aplica si el filtro se omite. Si quien llama pasa `statusFilter: "archived"` bajo `op: "recall"`, obtiene estrategias archivadas, no un error.
- Diferencia con `memory_reasoning`/`memory_task`: strategy es para heurísticas recurrentes generales ("cuando X, Y"), no para planes de tarea puntuales (`memory_task`) ni para cachear un proceso de razonamiento específico (`memory_reasoning`).
- `scopeRef` no es lo mismo que `workspaceId` — permite acotar una estrategia a un proyecto/entidad dentro del mismo espacio de trabajo; una estrategia sin `scopeRef` es visible en todo el espacio de trabajo (según cómo se filtre en `list`).
- Auditoría previa (2026-07-28, ver `docs/STATUS.md`) verificó esta herramienta como limpia — sin discrepancias entre lo documentado y el código, a diferencia de otras herramientas del set.

**Ejemplos**:

```json
{
  "op": "store",
  "trigger": "El usuario reporta un error 500 en producción",
  "action": "Pedir el traceId y consultar mnemo_audit_log antes de escalar.",
  "scopeRef": "chatbot-service"
}
```

```json
{ "op": "rate", "id": "mstrat_01J...", "outcome": "success" }
```

---

## `memory_hyperedge`

**Qué hace**: CRUD para hyperedges — relaciones n-arias que conectan **3 o más** primitivas que co-activan bajo un contexto compartido. A diferencia de `memory_relate` (siempre binaria, 9 verbos fijos: `related`, `compatible`, `scoped`, `conflicts_with`, `supersedes`, `not_conflict`, `derived_from`, `part_of`, `member_of`), una hyperedge no tiene verbo — es un grupo no dirigido de `memberIds` con un `label`/`description`/`contextQuery` opcionales. `create`, `get`, `list`, `patch`, `archive` son las únicas 5 acciones — no hay verbos de dominio adicionales como en task/reasoning/strategy.

**Hallazgo sobre `worth`, ahora corregido (B8, 2026-08-10)**: `docs/STATUS.md` y el docstring de `MnemoHyperedge` en `primitives.ts` siempre afirmaron que "worth decays via TD(λ) 0.1-step updates" — el mecanismo (`StorageAdapter.updateWorth("hyperedge", ...)`, ±0.1 clamped a [0,1]) siempre existió, pero hasta este fix **no tenía ningún punto de llamada real**: ni `memory_self_edit` strengthen/weaken (solo apuntan a hecho/strategy) ni `PATCH /hyperedges/:id` (solo `label`/`description`/`contextQuery`) lo alcanzaban, así que `worth` quedaba congelado en 0.5 desde la creación. **Fix**: `POST /recall` ahora dispara `recordHyperedgeCoActivation(storage, workspaceId, hitIds)` vía `setImmediate` (best-effort, fire-and-forget, igual patrón que el helper Hebbiano `recordCoRecallStdpForHits` ya existente) cuando la llamada devuelve ≥2 hits: para cada hyperedge relevante a esos hits (`getRecallStructures`), si ≥2 de sus miembros están en el set servido, es un refuerzo real (`updateWorth(..., {success:1, failure:0})`); si es exactamente 1, es un debilitamiento (`{success:0, failure:1}`). Errores se tragan silenciosamente — nunca rompe el recall. `bumpHyperedgeActivation` (invocado por `OutboxWorker` en eventos `hyperedge_bump`) sigue sin tocar `worth`, solo `activationCount` — sigue siendo la única señal separada de "actividad".

`recall-cold.ts` sí _usa_ `hyperedge.worth` para scoring: en la expansión de co-miembros (spec §15), inyecta co-miembros de hyperedges con `worth > 0.5` como `RecallHit`s adicionales con `score = parentScore × hyperedge.worth`. Antes del fix, `worth` nunca se movía del 0.5 default y esa expansión de co-miembros nunca se disparaba en la práctica salvo seteo manual en DB (el schema de creación tampoco expone ese campo); ahora, co-activación real en recall mueve `worth` con el tiempo, activando la expansión orgánicamente para hyperedges genuinamente relevantes.

**Parámetros**:

- `action` (enum, requerido): `create | get | list | patch | archive`.
- `id` (string, opcional) — requerido para `get/patch/archive`.
- `memberIds` (array de strings, min 3, max 50, opcional) — requerido para `create`, al menos 3 IDs de primitivas.
- `label` (string, 1–200, opcional).
- `description` (string, max 20 000, opcional).
- `contextQuery` (string, max 20 000, opcional).
- `memberIdFilter`, `labelFilter` (string, opcional) — filtros de `list`.
- `limit` (int 1–500, opcional).
- `idempotencyKey` (string, opcional) — solo para `create`.

**Cuándo usarla — casos de uso**:

1. Agrupar 3+ hechos/decisions que sistemáticamente aparecen juntos en el contexto de un mismo problema recurrente.
2. Modelar un cluster temático (ej. "todo lo relacionado a la migración de RLS de agosto") sin forzar relaciones binarias artificiales entre cada par.
3. Consultar qué hyperedges incluyen a una primitiva dada (`memberIdFilter`) para entender su vecindario semántico completo.
4. Etiquetar y documentar un grupo con `label`/`description` para hacerlo descubrible en `list`.

**Casos borde y gotchas**:

- No usar para relaciones de a dos — `memberIds` exige mínimo 3; para binarias usar `memory_relate`.
- El worth de una hyperedge ahora sí se mueve orgánicamente (B8): cada `POST /recall` con ≥2 hits que toquen una hyperedge relevante ajusta su `worth` best-effort vía co-activación. Sigue sin haber un endpoint explícito para forzar el ajuste manualmente — el único punto de llamada es el recall automático.
- `activationCount` sí se incrementa de forma real (Hebbian) cada vez que sus miembros se recuperan juntos en un recall — es la única señal de "actividad" genuinamente viva en esta primitiva.
- La tabla `mnemo_hyperedge` no tiene columna `metadata` (a diferencia de las otras 9 primitivas) ni `contextEmbeddingModel` — cualquier intento de guardar metadata arbitraria en una hyperedge no tiene dónde persistir.
- `archive` sí es un archivado real (soft-delete con `validTo`), a diferencia del no-op de `memory_event` — no confundir los dos comportamientos entre primitivas.

**Ejemplos**:

```json
{
  "action": "create",
  "memberIds": ["mfact_01J...a", "mdec_01J...b", "mepi_01J...c"],
  "label": "incidente-rls-agosto",
  "description": "Facts, decisión y episodio del incidente de RLS bypass en cron jobs."
}
```

```json
{ "action": "list", "memberIdFilter": "mfact_01J...a", "limit": 20 }
```

---

## `memory_introspect`

**Qué hace**

`memory_introspect` expone el **SelfModel** del espacio de trabajo: un resumen agregado de qué tan bien "conoce" el agente cada tema/entidad, qué temas son fuertes, cuáles son huecos de conocimiento (gaps) y cómo evolucionó esa salud cognitiva en el tiempo. No devuelve contenido de hechos individuales — solo agregados por entidad/tópico (comentario en el código: "intentionally espacio de trabajo-aggregate-only... no per-hecho content is exposed", `packages/core/src/cognitive/metacognition.ts`).

El handler MCP (`packages/mcp/src/tools/introspect.ts`) llama a `client.getSelfModel()` → `GET /metacognition` (`packages/server/src/routes/metacognition.ts`) → `buildSelfModel()` en `packages/core/src/cognitive/metacognition.ts`. Esta función lee tres fuentes vía el puerto `StorageAdapter`, en paralelo:

- **`getConfidenceMap`** — lee la vista materializada `mv_confidence_map` (una fila por entidad, `LEFT JOIN` con `mnemo_fact` activos). Calcula `coverage_level` (`expert`: ≥10 hechos y avgWorth>0.7; `familiar`: ≥5 y avgWorth>0.5; `aware`: ≥2; `minimal`: ≥1; `blind`: 0 hechos) y `freshness` (`current`: hecho más nuevo <7 días; `recent`: <30 días; `aging`: <90 días; `stale`: resto), basado en `f.created_at`.
- **`getKnowledgeGaps`** — lee `mv_knowledge_gaps`, agrupada por `topic_key`. `gap_score = recall_hits_30d × (1 − avg_worth) / GREATEST(evidence_volume, 1)` — prioriza temas que se recuerdan seguido pero con baja confianza y poca evidencia acumulada.
- **`getMetacognitionTrends`** — invoca la función SQL `mnemo_metacognition_trends(workspace_id)`, que devuelve 4 pares `{current, previous, delta}` comparando los últimos 7 días contra los 7 anteriores: `recallHitRate`, `avgRecallLatency` (proxy: promedio de `activation_score`), `sessionCollapseQuality` (promedio de `outcome_rating`: success=1, neutral=0.5, failure=0), `strategySuccessRate` (promedio de `worth` en `mnemo_strategy`).

Sobre `confidence` (filtrado por `entity` si se pasó), `buildSelfModel` deriva `strongTopics`/`strengths` (avgWorth ≥ 0.7, evidenceVolume ≥ 5, factCount ≥ 3, top 25 ordenados por `avgWorth × evidenceVolume`) y calcula `summary` (totalTopics, strongTopicsCount, gapsCount, blindCount, avgWorthAcrossWorkspace) **siempre sobre el set completo de entidades**, sin importar el `aspect` pedido. Cada gap recibe un `suggestedAction` vía `recommendAction`: `recallHits30d ≥5 && avgWorth<0.2` → `search_codebase`; `recallHits30d <5` → `wait_for_data`; en cualquier otro caso → `ask_user`.

Importante: las dos vistas materializadas (`mv_confidence_map`, `mv_knowledge_gaps`) se refrescan una vez al día vía cron (`mnemo.metacognition.refresh`, 07:00 UTC, `packages/server/src/cron/jobs.ts`) — **no son datos en tiempo real**, pueden tener hasta ~24h de latencia.

**Parámetros** (schema Zod en `introspect.ts`):

| Parámetro | Tipo   | Requerido | Default | Descripción                                                                                                                                                                                                                                                                                                               |
| --------- | ------ | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aspect`  | enum   | No        | `"all"` | Acepta **dos vocabularios** que el handler mapea a los aspectos reales del backend: `coverage`, `trends`, `gaps`, `strengths`, `all` (nativos) y `health`, `worth`, `drift`, `types`, `recent_changes` (alias legacy). Mapeo: `health→all`, `worth→strengths`, `drift→trends`, `types→coverage`, `recent_changes→trends`. |
| `entity`  | string | No        | —       | Filtro substring case-insensitive contra `canonicalName` (confidenceMap) y `topicKey` (gaps). Se aplica sobre las filas ya traídas de la DB, no en el `WHERE` SQL.                                                                                                                                                        |
| `limit`   | number | No        | `10`    | 1–200. Recorta (post-fetch, en la ruta HTTP) las 4 listas `confidenceMap`, `strongTopics`, `strengths`, `gaps` — no aplica a `summary` ni a `trends`.                                                                                                                                                                     |

**Cuándo usarla — casos de uso**

1. Antes de afirmar algo con seguridad sobre un tema ("¿qué tan bien conozco X?"), llamar con `aspect: "coverage", entity: "X"` para comprobar si el nivel es `expert`/`familiar` o apenas `aware`/`minimal`/`blind`.
2. Detectar temas que el agente consulta seguido pero nunca termina de aprender bien (`aspect: "gaps"`) para decidir si conviene preguntarle al usuario, buscar en el código fuente, o simplemente esperar más evidencia.
3. Monitoreo de salud del pipeline de memoria a lo largo de una semana (`aspect: "trends"` o su alias `"drift"`) — ver si la tasa de aciertos de recall o el éxito de las estrategias está subiendo o bajando.
4. Al iniciar una sesión larga, pedir `aspect: "strengths"` para saber qué áreas puede citar con confianza sin necesidad de recall explícito adicional.

**Casos borde y gotchas**

- **Frescura**: los datos vienen de MVs con refresh diario (07:00 UTC) — un hecho recién guardado no aparece en el SelfModel hasta el próximo refresh.
- **`summary` no respeta `aspect`**: siempre refleja el espacio de trabajo completo (aunque se pida solo `gaps`, `summary.totalTopics`/`avgWorthAcrossWorkspace` cuentan todas las entidades).
- Si no hay datos de sesiones/recalls todavía, `trends` devuelve ceros en los 4 pares, no `null` ni error.
- No hay `withMnemoTx` de por medio: la ruta lee `deps.storage` directamente; el aislamiento por espacio de trabajo lo da el `WHERE workspace_id = ...` explícito en cada query sobre la MV (las MVs no heredan RLS).
- `docs/architecture/API.md` está desactualizado: documenta un schema distinto e inexistente (`required: ["aspect"]` limitado a 5 valores, respuesta plana `{status, factCount, avgWorth, staleCount, driftScore, recallMode}`) que no corresponde al código real. No usarlo como referencia.
- Diferente de `memory_recall`: `memory_introspect` no devuelve memorias individuales recuperables, solo estadísticas agregadas — es autoevaluación, no búsqueda.

**Ejemplos**

```json
{ "aspect": "gaps", "entity": "autenticación", "limit": 5 }
```

```json
{ "aspect": "trends" }
```

---

## `memory_anticipate`

**Qué hace**

`memory_anticipate` predice qué memorias van a ser útiles en los próximos minutos, combinando **4 señales estadísticas con pesos fijos que suman 1.0**, calculadas puramente sobre lecturas de storage (sin LLM ni índice vectorial) en `packages/core/src/cognitive/anticipation.ts::buildAnticipationFeed`:

1. **Secuencial (peso 0.35)** — requiere `recentlyRecalledId`. Lee `mv_sequential_patterns` (pares de hechos recordados uno tras otro dentro de una ventana de 5 minutos, sobre los últimos 30 días de `mnemo_recall_log`), filtrando `confidence ≥ 0.3`. Score aportado = `confidence × 0.35`.
2. **Periódica (peso 0.25)** — **no requiere ningún parámetro, siempre corre**. Lee `mv_periodic_patterns`: para cada `(day_of_week, hour_bucket de 3h)` en **UTC**, calcula qué fracción de los recalls de un hecho caen en ese slot (`slot_share`), exigiendo ≥3 semanas distintas de evidencia y `slot_share ≥ 0.20`. El slot consultado es `now + lookAhead minutos`, no el actual. Score = `slotShare × 0.25`.
3. **Condicional (peso 0.25)** — requiere `context`, no depende de `recentlyRecalledId`. Lee `mv_conditional_patterns`: coincidencias exactas (`lower(btrim(...))`, no búsqueda difusa) entre el `context` recibido y `query_key` histórico de `mnemo_recall_log`, con al menos 4 co-ocurrencias y `confidence ≥ 0.5`. Score = `confidence × 0.25`.
4. **Co-ocurrencia / Hebbiana (peso 0.15)** — requiere `recentlyRecalledId`. Lee `mnemo_relation` buscando pares relacionados por `co_recall_count`/`hebbian_weight` (exige `co_recall_count ≥ 2`, relación vigente `valid_to IS NULL`). El conteo se satura dividiendo por 10 (10+ co-recalls = señal máxima). Score = `min(1, coRecallCount/10) × 0.15`.

Si un mismo id es alcanzado por más de una señal, sus scores ponderados se **suman** y su `source` pasa a `"blended"`, concatenando el `rationale` de cada señal. El resultado final se ordena por score descendente y se recorta a `limit`.

Las vistas materializadas `mv_sequential_patterns`, `mv_periodic_patterns` y `mv_conditional_patterns` se refrescan diariamente vía cron (`mnemo.anticipate.mine`, 06:30 UTC) — la señal de co-ocurrencia, en cambio, lee `mnemo_relation` directamente (dato vivo, no MV).

**5ª señal — enriquecimiento vía LLM (corregido en la descripción de la herramienta, D7, 2026-08-10)**: cuando se pasa `context` y hay un adaptador LLM configurado (espacio de trabajo o boot), la ruta HTTP (`packages/server/src/routes/anticipation.ts::enrichWithLlmContext`) pide al LLM 2-3 queries de búsqueda relacionadas, corre `core.recall()` con cada una, y mergea los hits nuevos (score fijo `0.1 × hit.score`, `source: "conditional"`) deduplicando por id. Es aditivo y falla silenciosamente (log + feed sin cambios) si el LLM no está disponible o responde mal. Esta señal ahora está listada explícitamente en la `description` de `memory_anticipate` (`packages/mcp/src/tools/anticipate.ts`), junto a las 4 estadísticas — antes del fix solo estaba documentada aquí.

**Parámetros** (schema Zod en `anticipate.ts`):

| Parámetro            | Tipo                 | Requerido | Default     | Descripción                                                                                                               |
| -------------------- | -------------------- | --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `recentlyRecalledId` | string               | No        | —           | Id de la última memoria recordada. Dispara las señales secuencial y co-ocurrencia.                                        |
| `context`            | string (max 500)     | No        | —           | Texto libre de la query actual. Dispara la señal condicional y (si hay LLM) el enriquecimiento adicional.                 |
| `lookAhead`          | number int (0–10080) | No        | 30 (server) | Minutos hacia adelante a anticipar; desplaza el slot dow/hora consultado por la señal periódica. Máx. 10080 = una semana. |
| `limit`              | number int (1–100)   | No        | 20 (server) | Cantidad máxima de items devueltos tras el blend/merge.                                                                   |

**Cuándo usarla — casos de uso**

1. Justo después de un `memory_recall` exitoso, llamar con `recentlyRecalledId` para precalentar qué otras memorias probablemente se necesiten a continuación (secuencial + Hebbiana).
2. Al arrancar una tarea nueva, pasar `context` con la descripción de la tarea para activar la señal condicional y detectar hechos que históricamente aparecen cuando se menciona ese tema.
3. Rutinas que corren siempre a la misma hora/día (standup, deploy semanal): sin pasar ningún parámetro, la señal periódica solita ya devuelve lo que suele recuperarse en ese slot horario UTC.
4. Planificar con antelación (`lookAhead: 120`) qué memorias se van a necesitar en 2 horas, para precargarlas antes de una reunión agendada.

**Casos borde y gotchas**

- Sin `recentlyRecalledId` no queda solo la señal periódica: si se manda `context`, la condicional también corre.
- El matching de `context` contra `query_key` es **exacto** tras `lower(btrim())`, no full-text ni semántico — un contexto que no calce carácter por carácter con una query histórica no dispara la señal condicional (salvo por el enriquecimiento LLM adicional, si hay adaptador disponible).
- Llamar sin ningún parámetro es válido: solo la señal periódica corre, y puede devolver 0 items si no hay ≥3 semanas de historial para ningún slot.
- Datos de las 3 MVs con hasta ~24h de latencia (refresh diario 06:30 UTC); la señal de co-ocurrencia es la única con lectura en vivo.
- Diferente de `memory_recall`: esto no es búsqueda por similitud semántica de una query — es predicción basada en patrones históricos de qué se recuerda junto/después/en qué momento, sin tocar el índice vectorial.
- `docs/architecture/API.md` describe una herramienta completamente distinto (`taskDescription`, `prefetchCount`, `types`, respuesta `{prefetched, cacheWarmed, topicsDetected, estimatedRecallSpeedupMs}`) que no existe en el código actual — desactualizado, no usar como referencia.

**Ejemplos**

```json
{ "recentlyRecalledId": "fact_8f2a1c", "lookAhead": 15 }
```

```json
{ "context": "revisando el módulo de autenticación", "limit": 10 }
```

---

## `memory_compose`

**Qué hace**

`memory_compose` es la interfaz MCP para el Compositionality / Inference Engine — un motor de forward-chaining (encadenamiento hacia adelante) puro que corre sobre los resultados de `memory_recall`, sin ninguna dependencia de infraestructura (vive en `packages/core/src/cognitive/compositionality.ts`, cumple la regla de pureza hexagonal). El motor aplica **reglas de composición** (pares `conditionDsl`/`actionDsl` almacenados en `mnemo_composition_rule_template` / `mnemo_composition_rule`) contra los hits que devuelve recall, y cuando las condiciones matchean, deriva nuevas afirmaciones (hechos) o advertencias (warnings).

El ciclo real de evaluación (`evaluateRule`):

1. Parsea `conditionDsl` y `actionDsl` con Zod (`ConditionDslSchema`/`ActionDslSchema` en `packages/types/src/compositionality.ts`); una regla con DSL inválido se descarta silenciosamente con un warning de log, no rompe la ejecución.
2. `matchClauses` hace backtracking sobre las cláusulas de `condition.all` (hasta 8 cláusulas) contra los hits, generando _bindings_ de variables (`$a`, `$b`, ...). Las cláusulas soportadas son 5: `fact_kind` (matchea por `factKind`/`primitive`), `topic_key_in` (matchea por tags), `text_contains` (substring case-insensitive), `relation{from,to,verb}` (recorre `hit.relations`, usa los 9 verbos bloqueados del sistema) y `fact_value{subject,predicate,valueType,compare}` (extrae un número o duración del texto del hecho y lo compara con `lt/gt/lte/gte`).
3. Por cada combinación de bindings, expande `action.statementTemplate` (reemplazando `$a`, `$ws`, etc.) para producir el `derivedStatement`.
4. Calcula `confidence = baseConfidence × premiseAvgWorth` (promedio de `worth`/`score` de las premisas), acotado a `[0,1]`.
5. **Filtro de confianza**: si `confidence <= minConfidence` (default `0.5` en el pipeline de recall, `0` en dry-run) la inferencia se descarta antes de cualquier side-effect.
6. **Techo de sensibilidad**: la sensibilidad de la inferencia derivada nunca puede superar la mínima de sus premisas (clamp hacia abajo).
7. Si `action.op === "derive_fact"`, se materializa un nuevo `MnemoFact` (`kind: "other"`, `attribution: "inferred"`) vía transacción atómica (insert + outbox de embeddings + log de inferencia + bump de `executionCount`). Si es `"derive_warning"`, solo se loguea, nunca se persiste como hecho.

`composeInferences` (el orquestador que se llama automáticamente después de cada `memory_recall`, tanto en `recall-cold.ts` como `recall-hot.ts`) itera todas las reglas activas del espacio de trabajo, ordenadas por `priority` DESC, y corre hasta 4 "hops" de fixpoint (`MAX_HOP_DEPTH=4`): en cada hop, los hechos derivados en el hop anterior se re-inyectan como premisas sintéticas para que puedan disparar reglas downstream. Está acotado a 50 disparos por llamada (`MAX_FIRINGS_PER_CALL`) y corta antes si un hop no deriva nada nuevo. Al final corre `resolveConflicts`: agrupa statements por firma y, si un grupo tiene ambas polaridades, se queda solo con el ganador por `(priority, confidence)` DESC.

El repo trae 3 reglas builtin sembradas por espacio de trabajo vía `mnemo_seed_builtin_rules()` (`source: 'imported'`): `builtin_transitive_part_of`, `builtin_conflict_propagation` y `builtin_scope_inheritance`.

**Parámetros** (schema Zod, `packages/mcp/src/tools/compose.ts`):

| Parámetro          | Tipo                                                                 | Requerido             | Aplica a                     | Descripción                                                             |
| ------------------ | -------------------------------------------------------------------- | --------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `action`           | `enum("list","create","get","patch","dry_run")`                      | Sí                    | todas                        | Operación a ejecutar.                                                   |
| `isActive`         | boolean                                                              | No                    | `list`                       | Filtra reglas por estado activo.                                        |
| `offset`           | number int ≥0                                                        | No                    | `list`                       | Paginación.                                                             |
| `limit`            | number int 1–200                                                     | No                    | `list`, `dry_run`            | Tamaño de página / máx. hits a evaluar.                                 |
| `ruleId`           | string                                                               | Condicional           | `get`, `patch`, `dry_run`    | ID de la regla objetivo.                                                |
| `name`             | string                                                               | Requerido en `create` | `create`, `patch`            | Nombre de la regla.                                                     |
| `description`      | string                                                               | No                    | `create`, `patch`            | Descripción libre.                                                      |
| `conditionDsl`     | objeto (validado contra `ConditionDslSchema`)                        | Requerido en `create` | `create`, `patch`, `dry_run` | `{ all: [...] }` con cláusulas de condición.                            |
| `actionDsl`        | objeto (validado contra `ActionDslSchema`)                           | Requerido en `create` | `create`, `patch`, `dry_run` | `{ op: "derive_fact"\|"derive_warning", statementTemplate, ... }`.      |
| `priority`         | number int 0–10000                                                   | No                    | `create`, `patch`            | Orden de evaluación (mayor = primero); desempate en `resolveConflicts`. |
| `isActiveOnCreate` | boolean                                                              | No (default `true`)   | `create`                     | Si la regla queda activa inmediatamente.                                |
| `hits`             | array de `{id, primitive, content, score, factKind?, worth?, tags?}` | No (default `[]`)     | `dry_run`                    | Hits simulados contra los que se evalúa la regla.                       |

Para `dry_run` hace falta `ruleId` **o** `conditionDsl`+`actionDsl` inline.

**Cuándo usarla — casos de uso**

1. Un agente detecta un patrón recurrente en la memoria (p. ej. "cuando un hecho tiene topicKey X y otro lo supersede, avisar") y quiere codificarlo como regla permanente con `action='create'` en vez de repetir el razonamiento manualmente cada vez.
2. Antes de activar una regla nueva en producción, probarla con `action='dry_run'` contra un set de hits de ejemplo para ver exactamente qué inferencias generaría, sin escribir nada en la base.
3. Auditar qué reglas están activas en el espacio de trabajo (`action='list'`, filtrando por `isActive`) antes de una limpieza o antes de diagnosticar por qué apareció una inferencia inesperada en un `recall`.
4. Desactivar temporalmente una regla que está generando demasiado ruido (falsos positivos) con `action='patch'` y `isActive: false`, sin borrarla.

**Casos borde y gotchas**

- Las reglas de tipo `relation` en `conditionDsl` solo pueden usar los 9 verbos bloqueados del sistema — el server valida esto con `ConditionDslSchema` y rechaza con 400 cualquier verbo fuera de ese set.
- El motor no pasa por `withMnemoTx` en el propio `evaluateRule`/`composeInferences` (es núcleo puro sin I/O directo); materializar un hecho sí es una transacción atómica en el adapter.
- Las rutas HTTP de composición (`composition.ts`) no aplican `filterBySensitivity`/`assertCanReadFact` como sí hacen las de workflows — no hay techo de sensibilidad explícito a nivel de listado/lectura de reglas.
- `dry_run` nunca persiste nada (usa un `ctx.storage` fake con no-ops) — es seguro de invocar repetidamente. Además usa `minConfidence: 0`, así que en dry-run se ven inferencias que jamás aparecerían en un recall real (donde el gate es `>0.5`).
- Si dos hits generan el mismo `derivedStatement` para la misma regla, se deduplica (`${ruleId}::${statement}`), incluso entre distintos hops.
- El límite de 4 hops y 50 disparos por llamada significa que reglas muy productivas o cadenas muy largas se cortan silenciosamente sin error.

**Ejemplos**

```json
{
  "action": "create",
  "name": "conflict-warns-on-supersede-chain",
  "description": "Advierte si A conflicts_with B y B fue reemplazado por C",
  "conditionDsl": {
    "all": [
      { "op": "relation", "from": "$a", "to": "$b", "verb": "conflicts_with" },
      { "op": "relation", "from": "$b", "to": "$c", "verb": "supersedes" }
    ]
  },
  "actionDsl": {
    "op": "derive_warning",
    "statementTemplate": "A puede seguir en conflicto con C (via B)",
    "baseConfidence": 0.6,
    "sensitivity": "internal"
  },
  "priority": 90
}
```

```json
{
  "action": "dry_run",
  "conditionDsl": { "all": [{ "op": "fact_kind", "kind": "preference", "bind": "$p" }] },
  "actionDsl": {
    "op": "derive_fact",
    "statementTemplate": "Preferencia detectada: $p",
    "baseConfidence": 0.7
  },
  "hits": [
    {
      "id": "f1",
      "primitive": "fact",
      "content": "prefiere TypeScript strict",
      "score": 0.9,
      "factKind": "preference",
      "worth": 0.8
    }
  ]
}
```

---

## `memory_workflow`

**Qué hace**

`memory_workflow` gestiona `MnemoWorkflow` — una de las 10 primitivas cognitivas, definida en `packages/types/src/primitives.ts` como un template de proceso multi-paso reusable, con pasos ordenados, condiciones y tiempos. A diferencia de `memory_compose`, no es un motor de ejecución ni de inferencia: es CRUD sobre la tabla `mnemo_workflow`. La herramienta (`packages/mcp/src/tools/workflow.ts`) expone solo 3 acciones — no hay `update`, `archive`, `run` ni `execute`, aunque el puerto `StoragePort` sí define `updateWorkflow`/`archiveWorkflow` internamente (no cableados a esta herramienta).

El flujo real:

- `create` → `POST /workflows` (`packages/server/src/routes/workflows.ts`) → `storage.createWorkflow(input)`. El body se arma con `resolveProvenance(c)` (actorId/userId/actorType namespaced) más `name` y `steps`. Cada `WorkflowStep` tiene `order`, `action` (texto libre, hasta 20.000 caracteres), `condition` opcional (hasta 20.000), `expectedDurationMs` (entero ≥0, default `0`) y `tools` opcional. Importante: el array `steps` se guarda tal cual llega, sin re-ordenar por `order`.
- `get` → `GET /workflows/:id`, aplica `assertCanReadFact` con el techo de sensibilidad de quien llama (S6: 404 si no tiene acceso, no 403).
- `list` → `GET /workflows`, filtra opcionalmente por `status`/`scopeRef` y aplica `filterBySensitivity` sobre el resultado paginado.

Un workflow nuevo nace con `avgDurationMs: 0`, `successRate: 0`, `worth: 0.5`, `executionCount: 0`, `version: 1`, y `sensitivity: "internal"` si no se especifica.

**Parámetros** (schema Zod, `packages/mcp/src/tools/workflow.ts`):

| Parámetro          | Tipo                                                    | Requerido                        | Aplica a                  | Descripción                                                 |
| ------------------ | ------------------------------------------------------- | -------------------------------- | ------------------------- | ----------------------------------------------------------- |
| `action`           | `enum("create","get","list")`                           | Sí                               | todas                     | Operación a realizar.                                       |
| `id`               | string                                                  | Requerido en `get`               | `get`                     | ID del workflow.                                            |
| `name`             | string 1–500                                            | Requerido en `create`            | `create`                  | Nombre del workflow.                                        |
| `description`      | string ≤20000                                           | No                               | `create`                  | Descripción libre.                                          |
| `steps`            | array de `WorkflowStep`                                 | Requerido en `create` (no vacío) | `create`                  | Lista ordenada de pasos.                                    |
| `sensitivity`      | `enum("public","internal","confidential","restricted")` | No (default `"internal"`)        | `create`                  | Techo de sensibilidad del workflow.                         |
| `metadata`         | `record(string, unknown)`                               | No                               | `create`                  | Metadata libre.                                             |
| `scopeRef`         | string                                                  | No                               | `create`, `list` (filtro) | Referencia de proyecto/entidad.                             |
| `status`           | `enum("active","deprecated","draft")`                   | No                               | `list` (filtro)           | No se puede establecer en `create`, solo filtrar en `list`. |
| `limit` / `offset` | number int                                              | No                               | `list`                    | Paginación.                                                 |

`WorkflowStep`: `order` (int ≥0, requerido), `action` (string 1–20000, requerido), `condition` (string ≤20000, opcional), `expectedDurationMs` (int ≥0, default 0), `tools` (array de strings, opcional).

**Cuándo usarla — casos de uso**

1. Documentar un procedimiento que el agente repite seguido (p. ej. "cómo hacer un deploy a `agents.example.com`": pasos ordenados con las herramientas/comandos de cada uno) para no reconstruirlo de memoria cada sesión.
2. Antes de ejecutar un proceso complejo, recuperarlo con `action='get'` para releer los pasos exactos y sus condiciones antes de actuar.
3. Listar los workflows disponibles de un proyecto específico con `scopeRef` para saber qué procesos ya están documentados antes de crear uno duplicado.
4. Versionar un checklist operativo: cuando cambia el proceso, crear un nuevo workflow y relacionarlo manualmente con `memory_relate(verb: "supersedes")` al anterior.

**Casos borde y gotchas**

- No hay acción `update` ni `patch`: para corregir un workflow existente hay que crear uno nuevo.
- No hay acción de "ejecutar" el workflow. Según `docs/architecture/API.md`, la realidad actual es que skills y workflows se devuelven como resultados estructurados de recall — el agente lee los pasos y actúa directamente, el motor no corre nada.
- `create` exige `name` y `steps` no vacío — si falta cualquiera, la herramienta responde `isError: true` sin llamar al server.
- `status` no se puede fijar en `create`; solo sirve como filtro en `list`.
- El array `steps` no se reordena — si se mandan los pasos en desorden respecto a su campo `order`, se guardan y devuelven en el orden de inserción, no en el orden lógico de `order`.
- `list` sí filtra por sensibilidad y `get` sí aplica el techo S6 — a diferencia de `memory_compose`, que no tiene ese filtrado en sus rutas.
- Es distinto de `memory_task` (trabajo puntual con lifecycle pending→completed) y de `memory_skill` (template de prompt).

**Ejemplos**

```json
{
  "action": "create",
  "name": "Deploy chatbot-service a producción",
  "description": "Checklist de deploy vía GitLab CI para agents.example.com",
  "scopeRef": "support-bot",
  "sensitivity": "internal",
  "steps": [
    {
      "order": 0,
      "action": "Correr pnpm test e2e localmente",
      "expectedDurationMs": 120000,
      "tools": ["bash"]
    },
    {
      "order": 1,
      "action": "Abrir MR y esperar pipeline de GitLab CI",
      "condition": "solo si tests pasan",
      "expectedDurationMs": 600000
    },
    {
      "order": 2,
      "action": "Verificar healthcheck en agents.example.com post-deploy",
      "expectedDurationMs": 30000,
      "tools": ["curl"]
    }
  ]
}
```

```json
{ "action": "list", "scopeRef": "support-bot", "status": "active", "limit": 20 }
```

---

## `memory_skill`

**Qué hace**

Gestiona el primitivo `MnemoSkill` — memoria procedimental que almacena plantillas de prompt reutilizables ("sé cómo hacer X") — a través de las rutas HTTP `/skills` y `/forget/skill/:id`. La herramienta es un wrapper delgado sobre `MnemosyneClient` (`packages/mcp/src/tools/skill.ts`); no contiene lógica de negocio propia, solo enruta cada `action` a un método del cliente. El almacenamiento real ocurre en `KnowledgeRepository` (adapter-postgres), sobre la tabla `mnemo_skill`, con soporte bitemporal (`validFrom`/`validTo`) y campos de scoring (`qualityScore`, `worth`, `usageCount`).

Las cuatro acciones y su ruta HTTP real:

- `create` → `POST /skills`
- `get` → `GET /skills/:id`
- `list` → `GET /skills`
- `forget` → `DELETE /forget/skill/:id` (`client.forgetPrimitive("skill", id)`) — archiva bitemporalmente (`validTo = now()`, nunca se borra la fila) y excluye la skill de `list` a partir de ese momento, porque `GET /skills` pasa `validAt: new Date()` por defecto.

**Parámetros** (schema Zod, `packages/mcp/src/tools/skill.ts`):

| Parámetro        | Tipo                                | Requerido   | Notas                                                                                      |
| ---------------- | ----------------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `action`         | `"create"\|"get"\|"list"\|"forget"` | Sí          | Operación a realizar.                                                                      |
| `id`             | string                              | Condicional | Requerido para `get`/`forget`.                                                             |
| `name`           | string (1–500)                      | Condicional | Requerido para `create` (o usar `content`).                                                |
| `promptTemplate` | string (1–50000)                    | Condicional | Requerido para `create` (o usar `content`).                                                |
| `content`        | string (1–20000)                    | Opcional    | Alias fallback: si `name`/`promptTemplate` no se proveen, se usa `content` para ambos.     |
| `tags`           | string[]                            | Opcional    | Se envía como `metadata: { tags }` al crear.                                               |
| `limit`          | number (1–200)                      | Opcional    | Tamaño de página para `list`.                                                              |
| `cursor`         | string                              | Opcional    | Declarado como cursor de paginación — no se usa en ningún punto del handler (ver gotchas). |

Nota: aunque el puerto `CreateSkillInput` (`packages/types/src/ports.ts`) acepta `variables`, `requiredContext` y `sensitivity`, la herramienta MCP no expone esos campos — solo `name`/`promptTemplate`/`tags` llegan a `client.createSkill()`.

**Cuándo usarla — casos de uso**

1. Guardar una plantilla de prompt que un agente aprendió a ejecutar bien (ej. "cómo generar un changelog desde commits convencionales") para reusarla en sesiones futuras.
2. Listar las skills disponibles en el espacio de trabajo antes de decidir si conviene crear una nueva o reusar una existente.
3. Recuperar el `promptTemplate` exacto de una skill por `id` antes de inyectarlo en un prompt.
4. Archivar (`forget`) una skill obsoleta o reemplazada, preservando el registro histórico para auditoría.

**Casos borde y gotchas**

- `cursor` está declarado en el schema Zod pero el handler nunca lo lee ni lo pasa al cliente; `client.listSkills()` solo soporta `offset`/`limit` — pasar `cursor` es un no-op silencioso.
- Historial de bugs ya corregidos (comentario de cabecera del archivo, 2026-07-31): (1) `forget` llamaba antes a `client.forgetFact(id)` → siempre 404 porque un id de skill nunca existe en `mnemo_fact`; (2) la ruta genérica de forget fallaba con 500 bajo el rol `mnemo_app_role` real porque el append de auditoría ejecutaba `SELECT ... FOR UPDATE` contra `mnemo_audit_log`, tabla append-only con `UPDATE` revocado (S3); (3) `GET /skills` no excluía skills archivadas; (4) un bug latente descubierto al arreglar (3): la condición `validTo` insertaba un `Date` crudo en un template `sql`, evitando el mapeo de Drizzle y provocando otro 500. Los cuatro están corregidos.
- `forgetPrimitive` es distinto de `forgetFact` — es la ruta agnóstica de primitivo.
- No hay acción `update`/`patch` en la herramienta MCP, aunque el puerto define `UpdateSkillInput`.

**Ejemplos**

```json
{
  "action": "create",
  "name": "Generar changelog convencional",
  "promptTemplate": "A partir de estos commits, genera un changelog agrupado por tipo (feat/fix/docs)...",
  "tags": ["git", "changelog"]
}
```

```json
{ "action": "forget", "id": "skill_01HXYZ..." }
```

---

## `memory_workspace`

**Qué hace**

Consulta y gestiona espacios de trabajo y su membership dentro del modelo multi-tenant. Es la única herramienta que expone a qué espacios de trabajo/tenants pertenece la key actual, junto con el rol de cada membership. Implementada en `packages/mcp/src/tools/workspace.ts`, delega en `MnemosyneClient` sobre las rutas montadas en `packages/server/src/routes/tenants.ts`, las cuales usan un helper análogo a `withMnemoTenantTx`: abre una transacción, setea los GUCs `mnemosyne.actor_user_id`/`mnemosyne.actor_tenant_id` con `set_config(..., true)` y solo entonces instancia `TenantRepository`, activando RLS de `mnemo_tenant`, `mnemo_user`, `mnemo_workspace` y `mnemo_workspace_member`. **Ninguna acción cambia el espacio de trabajo activo de la sesión** — eso lo fija la API key/token al arrancar el proceso.

El modelo de roles (`WorkspaceRole` en `packages/types/src/security.ts`) restringe los permisos estáticos de la key: `read` → lectura de memoria/sesión/entidad/federación; `write` → todo lo de `read` + remember/decide/task/event/reasoning/procedural/self_edit; `admin` → todo lo de `write` + hard_delete/purge/export/governance/federation/keys/membership; `owner` tiene el **mismo conjunto efectivo de permisos que `admin`**. Un rol nunca puede agregar permisos que la key no tenía — solo puede restarlos.

**Parámetros** (schema Zod, `packages/mcp/src/tools/workspace.ts`):

| Parámetro     | Tipo                                                                                 | Requerido             | Notas                                                                             |
| ------------- | ------------------------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------- |
| `action`      | `"list"\|"describe"\|"members"\|"current"\|"create"\|"invite"\|"set_role"\|"remove"` | No (default `"list"`) | 8 acciones.                                                                       |
| `workspaceId` | string                                                                               | Condicional           | Requerido para `describe`, `members`, `invite`, `set_role`, `remove`.             |
| `userId`      | string                                                                               | Condicional           | Requerido para `invite`, `set_role`, `remove`.                                    |
| `role`        | `"owner"\|"admin"\|"write"\|"read"`                                                  | Condicional           | Requerido para `set_role`; default servidor `"read"` para `invite`.               |
| `name`        | string                                                                               | Condicional           | Requerido para `create`.                                                          |
| `slug`        | string                                                                               | Opcional              | Para `create`.                                                                    |
| `visibility`  | `"private"\|"public"`                                                                | Opcional              | Para `create`; default `"private"`.                                               |
| `ownerUserId` | string                                                                               | Opcional              | Owner inicial del espacio de trabajo, para `create`.                              |
| `tenantId`    | string                                                                               | Opcional              | Tenant donde crear el espacio de trabajo; si se omite, se resuelve vía `GET /me`. |

Detalle por acción: `list` (default) llama primero `listMyWorkspaces()`; si viene vacío, cae al listado por tenant. `describe` requiere membership, devuelve 404 (no 403) si quien llama no es miembro (anti-probing). `current` devuelve workspaceId/name/keyId/actorType/scopes/plan/userId/personalWorkspaceId/tenantId/rol. `create` resuelve `tenantId` vía `GET /me` si no se pasa. `invite`/`set_role`/`remove` requieren rol `owner`/`admin` — el servidor devuelve 403 a quien llama con rol `read`/`write`.

**Cuándo usarla — casos de uso**

1. Un agente quiere saber en qué espacio de trabajo está operando y con qué rol (`action:"current"`) antes de intentar una escritura.
2. Listar todos los espacios de trabajo a los que pertenece el usuario detrás de la key, para mostrarle un selector.
3. Un administrador invita a un nuevo colaborador a un espacio de trabajo con rol `write`.
4. Auditar quién tiene acceso a un espacio de trabajo y con qué rol (`action:"members"`).

**Casos borde y gotchas**

- Bug real ya corregido (auditoría 2026-07-29, fix 2026-07-31): `action:"list"` y `action:"members"` devolvían 500 sin control por una recursión infinita en la política RLS de `mnemo_workspace_member` (self-referential `EXISTS`); corregido reemplazando las subqueries por funciones `SECURITY DEFINER`. El fallback tenant-wide de `list` era además código muerto porque `GET /me` nunca devolvía `tenantId` pese a estar ya resuelto del lado del servidor — corregido junto con lo anterior.
- Quien llama nunca puede cambiar el espacio de trabajo activo desde esta herramienta — es una limitación de diseño, no un bug.
- Las acciones mutantes (`create`/`invite`/`set_role`/`remove`) están registradas incondicionalmente porque la restricción de permisos en el servidor ya bloquea a quien llama con rol `read`/`write` — la herramienta no oculta estas acciones ni replica esa autorización client-side.

**Ejemplos**

```json
{ "action": "current" }
```

```json
{ "action": "invite", "workspaceId": "ws_01HXYZ...", "userId": "user_01HABC...", "role": "write" }
```

---

## `memory_suggest_topic_key`

**Qué hace**

Deriva un `topicKey` determinístico e idempotente a partir de un par `subject`/`body`, sin escribir nada ni hacer llamadas a LLM/embeddings. Es la herramienta #35, la más nueva del registro (agregada 2026-08-04). Es un proxy puro: `packages/mcp/src/tools/suggest_topic_key.ts` llama `client.suggestTopicKey()`, que hace `POST /topic-key/suggest` (`packages/server/src/routes/topicKey.ts`), cuyo handler no toca `withMnemoTx` ni ningún adaptador — solo invoca `suggestTopicKey()` de `@mnemo-ai/core` (`packages/core/src/cognitive/topic-key.ts`), la única fuente de verdad del algoritmo.

Algoritmo real:

1. **Short-circuit de idempotencia**: si `body` está vacío/ausente y `subject` ya cumple la gramática canónica (`^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$`, ≤80 chars), se devuelve tal cual con `source: "identity"`. Esto garantiza `suggest({subject: suggest(x).topicKey}).topicKey === x`.
2. Si no, ambos strings se normalizan (NFKD, sin diacríticos, minúsculas, todo lo que no sea `[a-z0-9]` colapsa a espacio) y se tokenizan, filtrando un stopword set bilingüe EN/ES, tokens de menos de 3 caracteres (excepto tokens de 2 chars con dígito) y duplicados.
3. Ensamblado de niveles: con `subject`+`body`, nivel 1 = hasta 2 tokens de `subject`, nivel 2 = hasta 3 tokens de `body` (`source: "subject+body"`). Solo `body`: nivel 1 = primeros 2 tokens, nivel 2 = siguientes 3 (`source: "body"`). Solo `subject`: nivel único de hasta 2 tokens (`source: "subject"`).
4. Si ningún token sobrevive el filtrado, cae a fallback: `"general"` si ambos inputs están vacíos, o `"general/<hash-sha256-8-chars>"` si hay contenido pero ningún token útil (`source: "fallback"`).
5. Clamp de longitud: cada nivel se recorta a ≤40 chars y la key completa a ≤80 chars (se dropea primero el nivel 2, luego se recortan tokens finales del nivel 1, siempre dejando ≥1 token).

**Parámetros** (schema Zod, `packages/mcp/src/tools/suggest_topic_key.ts`):

| Parámetro | Tipo   | Requerido | Notas                                      |
| --------- | ------ | --------- | ------------------------------------------ |
| `subject` | string | Opcional  | Subject del hecho o title de la decision.  |
| `body`    | string | Opcional  | Statement del hecho o body de la decision. |

Ambos son opcionales — `{}` resuelve al fallback `"general"`.

**Cuándo usarla — casos de uso**

1. Antes de `memory_remember(kind:"fact", topicKey:...)` o `memory_decide(topicKey:...)`, para obtener una clave estable en vez de inventar una a mano y arriesgarse a colisionar con `uniq_mnemo_decision_topic`.
2. Verificar si una `topicKey` ya usada sigue siendo la misma al re-derivarla con el mismo `subject`/`body` (idempotencia).
3. Normalizar una `topicKey` "cruda" pasándola como `subject` sin `body` — si ya es canónica, vuelve sin cambios.
4. Sistemas externos que necesitan generar `topicKey`s consistentes con las que usa Mnemosyne (por ejemplo, un plugin de memoria persistente como Engram) pueden llamar a esta herramienta en vez de reimplementar el algoritmo.

**Casos borde y gotchas**

- No usa `withMnemoTx` ni RLS: el handler HTTP es explícitamente sin adaptador, sin DB round-trip.
- El set de stopwords es deliberadamente independiente del usado en recall — un comentario en el código advierte que compartirlos acoplaría el tuning de ambos sistemas.
- El fallback con hash SHA-256 es determinístico pero no semánticamente significativo — dos inputs muy distintos que colapsan a "solo stopwords" producen prefijos `general/` con hashes distintos, no colisiones legibles.
- `source` en la respuesta tiene 5 valores posibles (`identity`, `subject+body`, `subject`, `body`, `fallback`) — útil para decidir si conviene revisar manualmente la key sugerida.

**Ejemplos**

```json
{ "subject": "infra/pg", "body": "Migramos a Postgres 16 con pgvector para el índice HNSW" }
```

```json
{ "subject": "auth/oauth-google" }
```

Como `"auth/oauth-google"` ya cumple la gramática canónica y no hay `body`, devuelve `{ "topicKey": "auth/oauth-google", "source": "identity" }` sin transformación.

---

## Hallazgos críticos verificados (resumen)

Checklist rápido de discrepancias reales entre lo que promete cada herramienta (nombre, descripción, o `docs/architecture/API.md`) y lo que hace el código verificado al 2026-08-10 (re-verificado contra código real post-`docs/archive/openspec/complete-mcp-tools`). Corregidos y vigentes, mezclados — cada ítem lo aclara.

### Bugs corregidos (ya no aplican, incluidos por si quedó memoria vieja del hallazgo)

- **`memory_remind_when`**: el mismatch AND/OR reportado antes está **corregido** — `evaluator.ts` implementa `fires = timeMatch && semanticMatch` (fix REMIND-1, 2026-07-27).
- **`memory_purge`**: el reporte de que era "completamente no funcional" está **desactualizado** — `hardDeleteFact`/`purgeClosedFacts` están implementados y `DELETE /facts/purge` ya está registrado antes que `DELETE /facts/:id`, con test de integración real probándolo.
- **`memory_workspace`**: sufrió un bug real de recursión infinita en la policy RLS de `mnemo_workspace_member` que devolvía 500 en `list`/`members` — **corregido** el 2026-07-31 con funciones `SECURITY DEFINER`.
- **`memory_skill`**: tenía 4 bugs encadenados en `forget` (llamaba a la ruta de hechos, luego 500 por `UPDATE` revocado en audit log, luego no excluía skills archivadas, luego un `Date` crudo rompía el mapeo de Drizzle) — los 4 están **corregidos**.
- **`memory_recall`/`memory_search`**: el bug histórico donde `mode`/`vectorWeight` se descartaban antes de llegar a `RecallQuery` (toda llamada resolvía `mode:"auto"` sin importar lo pedido) está **corregido**.
- **`memory_context`**: el bug donde el listado de "otros espacios de trabajo" usaba como fuente primaria los espacios de trabajo del tenant (mostrando espacios de trabajo ajenos como propios) está **corregido** — ahora usa `GET /workspaces/mine` primero.
- **`memory_status`**: el bug de recursión RLS que rompía silenciosamente el bloque `personal` (espacio de trabajo personal del usuario) está **corregido** vía la misma migración `0012_workspace_member_rls_recursion.sql`.
- **`memory_recall` / `memory_search`** (B1, 2026-08-10): `scope: 'personal'` antes no filtraba nada — el código lo excluía explícitamente del filtro. Ahora `recall.ts` rutea a `multiLevelRecall(..., { only: 'personal' })`, restringiendo de verdad al espacio de trabajo personal de quien llama (peso 1.0), con 400 explícito si la key no es user-bound o no hay espacio de trabajo personal.
- **`memory_forget`** (B2, 2026-08-10): `idempotencyKey` antes solo tenía efecto real cuando `kind='fact'` — para cualquier otro kind se descartaba silenciosamente. `forgetPrimitive()` ahora reenvía la key como header `Idempotency-Key` para todos los kinds, igual que `forgetFact`.
- **`memory_timeline`** (B3, 2026-08-10): antes nunca reportaba `kind: "created"` para un evento, aunque el schema lo declaraba como valor válido — un hecho nuevo aparecía como `"updated"`. Ahora `GET /timeline` mergea un segundo stream derivado de `FactFilter.createdSince` que sí emite `"created"`, sin tocar `factory.ts`/`CoreLike` (constraint de `flatten-legacy-dual-core`).
- **`memory_self_edit` con `action:'forget'`** (B4, 2026-08-10): antes quedaba atascado permanentemente en `202 { approvalRequired: true }` sin ningún flujo de aprobación real que completar. La acción `forget` fue **eliminada** del enum de la herramienta; si igual se intenta, el server responde `422 self_edit_forget_unsupported` — usar `memory_forget` (`kind: 'fact' | 'strategy'`) en su lugar.
- **`memory_compare`** (B6, 2026-08-10): antes nunca sugería el verbo `related` en producción real ni mostraba diffs de tags — ambos eran código muerto disclosed. Ahora ambos fueron **eliminados** del código: `SuggestableVerb` tiene 4 valores (sin `related`), y `computeDifferences`/`detectSameSubject` ya no tocan tags en absoluto.
- **`memory_task`** (B7, 2026-08-10): `action:'archive'` antes forzaba `status:'cancelled'` sin pasar por la máquina de estados, pudiendo archivar una tarea `completed` (terminal) a `cancelled` — algo que `patch` rechazaba con 409. `archiveTask` ahora es terminal-aware (`TERMINAL_TASK_STATUSES`): una tarea `completed` archivada conserva `status: 'completed'`; el resto sigue cancelándose como antes.
- **`memory_hyperedge`** (B8, 2026-08-10): el `worth` documentado como "decae vía TD(λ)" no tenía ningún punto de llamada real — quedaba congelado en 0.5. `POST /recall` ahora dispara co-activación best-effort (`recordHyperedgeCoActivation`, vía `setImmediate`) que mueve `worth` con `updateWorth("hyperedge", ...)` cuando ≥2 miembros de una hyperedge aparecen en los hits servidos.

### Gotchas vigentes — no son bugs, son comportamiento real a tener en cuenta

- **`memory_pin` / `memory_session(action:'pin')`**: proteger un hecho con pin **no** le da prioridad en `memory_recall`/`memory_search` — el campo `pinned` nunca llega al scoring. Solo protege de fusión/olvido automático por consolidación.
- **`memory_decide`**: las decisiones creadas hoy **no** guardan atribución de autor real (`actorId`/`userId`/`actorType`) — gap conocido en `@mnemo-ai/core/factory.ts`.
- **`memory_episode_end`**: el HTTP 202 es engañoso — el pipeline de colapso de 8 pasos ya terminó de correr de forma síncrona antes de esa respuesta, no es procesamiento asíncrono real.
- **`memory_consolidate`**: solo puede correr `mode: "fast"` manualmente — `mode: "deep"` (clasificación LLM con memoización) corre exclusivamente vía el scheduler de fondo, pedirlo manualmente da 422.
- **`memory_remind_when`**: el poller de 30s de background **solo** dispara recordatorios sin `condition` — cualquier recordatorio compuesto o semántico depende exclusivamente de una futura llamada real a `memory_recall`.
- **`memory_judge`**: el gate `confidence > 0.7` hace que solo la regla trust-anchor (0.9) auto-resuelva conflictos; recency (exactamente 0.7) siempre cae a revisión manual. La resolución `merge` no es atómica (6 transacciones separadas).
- **`memory_event`**: `action:'archive'` es un **no-op declarado** — `mnemo_event` no tiene columna de estado, la fila nunca cambia pese al 204. Usar `memory_remember`/`memory_task` si se necesita algo mutable.
- **`memory_anticipate`** (D7, 2026-08-10): ya no es un gap de documentación — la 5ª señal de enriquecimiento vía LLM (cuando hay `context` y un adaptador configurado) ahora está listada explícitamente en la `description` de la herramienta junto a las 4 estadísticas, no solo en este documento.
- **`memory_workflow`**: no ejecuta nada — es CRUD parcial (sin `update`/`archive`/`run`); el agente lee los pasos y actúa manualmente.
- **`memory_skill`**: el parámetro `cursor` existe en el schema pero el handler lo ignora — la paginación real es solo por `offset`.
- **`docs/architecture/API.md`**: desactualizado o directamente inventado para `memory_introspect`, `memory_anticipate` y `memory_status` (schemas de respuesta que no corresponden al código real) — no usarlo como referencia para esas tres herramientas, confiar en este documento o en el código fuente directamente.

---

_Generado a partir de lectura directa del código fuente de este repositorio (schemas Zod en `packages/mcp/src/tools/`, handlers en `packages/server/src/routes/`, lógica de negocio en `packages/core/src/cognitive/`). Si el código cambia, este documento puede quedar desactualizado — ante duda, el código es la fuente de verdad, no este archivo._
