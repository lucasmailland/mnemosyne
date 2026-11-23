# @mnemo-ai/mcp

[English](README.md) · **Español**

> El servidor MCP de [Mnemosyne](https://github.com/lucasmailland/mnemosyne), memoria cognitiva para agentes de IA. Corre por stdio, habla con un servidor de Mnemosyne mediante `@mnemo-ai/client-ts` y le da a Claude Desktop, Cursor y cualquier cliente MCP las 37 herramientas activas que se listan abajo por defecto, o las 9 herramientas núcleo con `MNEMO_MCP_TOOLS=core`.
>
> [Repositorio](https://github.com/lucasmailland/mnemosyne) · [Guía de MCP](https://github.com/lucasmailland/mnemosyne/blob/main/docs/guides/MCP_GUIDE.es.md) · [Estado](https://github.com/lucasmailland/mnemosyne/blob/main/docs/STATUS.md)

Servidor **Model Context Protocol** independiente para [Mnemosyne](https://github.com/lucasmailland/mnemosyne), el sistema de memoria cognitiva multi-tenant.

Conéctalo a cualquier cliente MCP (Claude Desktop, Claude Code, Cursor, …) y tu asistente obtiene una memoria duradera y acotada al espacio de trabajo: recuerda lo que prefieren los usuarios, guarda decisiones entre sesiones, fija el conocimiento crítico y audita lo que se aprendió con el tiempo.

> Este paquete es un **adaptador delgado**. Habla MCP por stdio y reenvía cada llamada a [`@mnemo-ai/client-ts`](https://github.com/lucasmailland/mnemosyne/tree/main/packages/client-ts), que a su vez se comunica con un servidor HTTP de Mnemosyne que tú controlas.

> **Necesita un servidor de Mnemosyne en marcha y una clave de API.** El [inicio rápido](https://github.com/lucasmailland/mnemosyne/blob/main/README.es.md#inicio-rápido) levanta uno con Docker en unos minutos.

## Instalación

No necesitas instalar nada de forma global. Basta con apuntar tu cliente MCP a él mediante `npx`.

## Configuración

### Claude Desktop

Agrega esto a `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["-y", "@mnemo-ai/mcp"],
      "env": {
        "MNEMO_URL": "https://memory.acme.com",
        "MNEMO_KEY": "mns_live_..."
      }
    }
  }
}
```

Las herramientas y sus mensajes están en inglés. Para usarlas en español, consulta [Idioma](#idioma).

Reinicia Claude Desktop. Deberías ver aparecer «mnemosyne» en el menú de herramientas MCP.

### Cursor

En `~/.cursor/mcp.json` (o el equivalente por proyecto):

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["-y", "@mnemo-ai/mcp"],
      "env": {
        "MNEMO_URL": "https://memory.acme.com",
        "MNEMO_KEY": "mns_live_..."
      }
    }
  }
}
```

### Continue o cualquier otro cliente MCP

Mismo patrón: `command: npx`, `args: ["-y", "@mnemo-ai/mcp"]`, y define `MNEMO_URL` y `MNEMO_KEY` en `env`.

## Variables de entorno

| Var                  | Obligatoria | Descripción                                                                                                                                                                                                    |
| -------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_URL`          | sí          | URL base de tu servidor de Mnemosyne, p. ej. `https://memory.acme.com`.                                                                                                                                        |
| `MNEMO_KEY`          | sí          | Clave de API del espacio de trabajo (`mns_live_...` o `mk_live_...`). Sus permisos determinan qué herramientas están disponibles: las claves de solo lectura no pueden llamar a `remember`, `pin` ni `forget`. |
| `MNEMO_WORKSPACE_ID` | no          | Espacio de trabajo para un token de usuario. Tiene prioridad sobre el vínculo `.mnemo.json` más cercano del proyecto.                                                                                          |
| `MNEMO_MCP_TOOLS`    | no          | `full` (por defecto, las 37) o `core` (9 herramientas). Consulta [Perfil de herramientas](#perfil-de-herramientas).                                                                                            |
| `MNEMO_LOCALE`       | no          | `en-US` (por defecto) o `es-419`. Consulta [Idioma](#idioma).                                                                                                                                                  |

Cuando falta `MNEMO_WORKSPACE_ID`, el MCP lee `workspaceId` del `.mnemo.json` más cercano entre el directorio del proceso y la raíz de su repositorio Git. El espacio de trabajo elegido queda fijo durante todo el proceso del MCP.

Si falta cualquiera de las dos obligatorias, el servidor termina con el código 1 e imprime un mensaje de ayuda en stderr (que la mayoría de los clientes MCP muestran en su interfaz).

## Perfil de herramientas

**El valor por defecto es `full`.** `MNEMO_MCP_TOOLS` elige cuántas herramientas lista el servidor:

- `full` (por defecto): las 37, incluidas las de episodios, sesiones, grafo y administración que un cliente MCP puro necesita para abrir los episodios por su cuenta (`memory_episode_start`, `memory_session`, `memory_episode_end`).
- `core`: `memory_recall`, `memory_fact`, `memory_remember`, `memory_decide`, `memory_update`, `memory_forget`, `memory_search`, `memory_status`, `memory_context`. Un cliente que no difiere las herramientas carga todos los esquemas en cada solicitud; define `core` ahí para que ese costo sea chico.

Cualquier otro valor sirve las 9 herramientas core (nunca amplía la superficie) e imprime un aviso en stderr. `memory_doctor` (perfil `full`) informa el perfil activo y su cantidad de herramientas. Lo que el servidor anuncia también está compactado: sin `$schema`, sin las expresiones regulares repetidas de fecha-hora y UUID (lo dice `format`), sin los límites enteros de ±2⁵³. Los argumentos se validan exactamente igual que antes. `src/__tests__/tool-surface-budget.test.ts` falla cuando `tools/list` supera 16.000 bytes (core) o 45.000 bytes (full).

## Idioma

El servidor usa por defecto el inglés estadounidense (`en-US`). El español es opcional: define `MNEMO_LOCALE` como `es-419` (cualquier etiqueta `es*` se asigna a ese valor) en el bloque `env` del cliente, junto a `MNEMO_URL` y `MNEMO_KEY`:

```json
"env": {
  "MNEMO_URL": "https://memory.acme.com",
  "MNEMO_KEY": "mns_live_...",
  "MNEMO_LOCALE": "es-419"
}
```

El MCP lee solo `MNEMO_LOCALE`; ignora `LANG` y las demás variables POSIX, porque el bloque `env` del cliente es el canal propio de cada servidor. Un valor sin definir o no reconocido significa inglés.

Con `MNEMO_LOCALE=es-419`, las descripciones de las herramientas y de sus campos, y el texto que las herramientas devuelven (errores, notas, resúmenes), salen en español, y el MCP envía `Accept-Language` al servidor de Mnemosyne, de modo que el mensaje del servidor dentro de un error del MCP vuelve en español (cuando el servidor tiene traducción para él; si no, en inglés). Sin `MNEMO_LOCALE`, el MCP no envía `Accept-Language` y todo queda en inglés. Lo que sigue en inglés: el texto del protocolo MCP y las instrucciones del servidor, los nombres de las herramientas y de los argumentos, y los datos dentro de los resultados (claves JSON, códigos, ids).

La CLI `mnemo` también lee `MNEMO_LOCALE`. Igual que `MNEMO_URL` y `MNEMO_KEY`, si la exportas en un shell, un servidor MCP iniciado desde ese shell la hereda y también cambia a español.

## Herramientas expuestas

Leyenda de estado: una herramienta Activa está registrada y funciona. Las 37 herramientas están activas.

| Herramienta                | Estado    | Permiso             | Propósito                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | --------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory_recall`            | ✅ Activa | read                | Los K hechos más relevantes para una consulta (semántica + ponderada por worth).                                                                                                                                                                                                                                                     |
| `memory_remember`          | ✅ Activa | write               | Guarda un hecho duradero nuevo (idempotente mediante hash del contenido).                                                                                                                                                                                                                                                            |
| `memory_pin`               | ✅ Activa | write               | Protege un hecho de las fusiones de consolidación (no lo sube en la recuperación).                                                                                                                                                                                                                                                   |
| `memory_forget`            | ✅ Activa | write               | Archiva un hecho de forma lógica (cierra validTo, auditable, restaurable).                                                                                                                                                                                                                                                           |
| `memory_timeline`          | ✅ Activa | read                | Cambios en los hechos durante una ventana de tiempo («¿qué aprendió mi IA esta semana?»).                                                                                                                                                                                                                                            |
| `memory_search`            | ✅ Activa | read                | Búsqueda de texto completo + semántica con filtros (tipo, sensibilidad, fecha).                                                                                                                                                                                                                                                      |
| `memory_relate`            | ✅ Activa | write               | Crea una relación entre dos primitivas (9 verbos bloqueados).                                                                                                                                                                                                                                                                        |
| `memory_decide`            | ✅ Activa | write               | Registra una decisión de arquitectura o de política con su justificación completa.                                                                                                                                                                                                                                                   |
| `memory_entity`            | ✅ Activa | write               | Crea o actualiza (upsert) una entidad con nombre (persona, organización, proyecto, concepto).                                                                                                                                                                                                                                        |
| `memory_status`            | ✅ Activa | read                | Verificación de estado: versión del servidor, estados de los adaptadores.                                                                                                                                                                                                                                                            |
| `memory_remind_when`       | ✅ Activa | write               | Programa un disparador de memoria prospectiva según una condición o una hora.                                                                                                                                                                                                                                                        |
| `memory_consolidate`       | ✅ Activa | write               | Dispara una pasada de consolidación (fusiona o retira hechos duplicados).                                                                                                                                                                                                                                                            |
| `memory_session`           | ✅ Activa | write               | Control unificado de sesiones (§24): `pin` de un hecho, agregar un turno `scratch`, `collapse` o `discard`. Las 4 acciones están completamente conectadas.                                                                                                                                                                           |
| `memory_episode_start`     | ✅ Activa | write               | Abre el contexto de un episodio con nombre (sesión).                                                                                                                                                                                                                                                                                 |
| `memory_episode_end`       | ✅ Activa | write               | Cierra y colapsa un episodio, extrayendo hechos de la transcripción.                                                                                                                                                                                                                                                                 |
| `memory_task`              | ✅ Activa | write               | Gestiona tareas accionables: crear, leer, listar, actualizar o archivar, con responsable, estado y dependencias.                                                                                                                                                                                                                     |
| `memory_event`             | ✅ Activa | write               | Registra eventos inmutables en el registro del espacio de trabajo: create, get, list, archive.                                                                                                                                                                                                                                       |
| `memory_reasoning`         | ✅ Activa | write               | Guarda cadenas de pensamiento estructuradas (pregunta → pasos → conclusión) para reutilizarlas.                                                                                                                                                                                                                                      |
| `memory_strategy`          | ✅ Activa | write               | Gestiona estrategias reutilizables disparador→acción. Usa `op` como discriminador (no `action`).                                                                                                                                                                                                                                     |
| `memory_self_edit`         | ✅ Activa | write               | Edita tu propia memoria con `append`, `replace`, `strengthen`, `weaken`, `reflect` o `link`. El motivo es un contexto obligatorio de política; todavía no se audita de forma durable.                                                                                                                                                |
| `memory_hyperedge`         | ✅ Activa | write               | Crea o relaciona una hiperarista de N miembros entre ≥3 hechos (asociaciones de hipergrafo más allá de las relaciones binarias).                                                                                                                                                                                                     |
| `memory_introspect`        | ✅ Activa | read                | Automodelo / metacognición: cobertura de conocimiento, brechas y tendencias de confianza por entidad.                                                                                                                                                                                                                                |
| `memory_anticipate`        | ✅ Activa | read                | Sugerencias predictivas de la siguiente recuperación a partir de patrones temporales y de coocurrencia (motor de anticipación).                                                                                                                                                                                                      |
| `memory_compose`           | ✅ Activa | read                | Compone inferencias nuevas sobre los hechos recuperados mediante el motor de inferencia declarativo.                                                                                                                                                                                                                                 |
| `memory_workflow`          | ✅ Activa | write               | Gestiona definiciones de flujos de trabajo reutilizables: create, get, list, patch, archive.                                                                                                                                                                                                                                         |
| `memory_skill`             | ✅ Activa | write               | Gestiona definiciones de skills reutilizables: create, get, list, patch, archive.                                                                                                                                                                                                                                                    |
| `memory_doctor`            | ✅ Activa | read                | Ejecuta 8 diagnósticos operativos (conectividad con Postgres, permisos de app_user, esquemas sombra, versión de migración, atraso de embeddings, validez de workspace_id, configuración de entorno del MCP, cantidad de herramientas registradas). Sin entrada. Úsala antes de abrir un reporte de error.                            |
| `memory_update`            | ✅ Activa | write               | Corrige la afirmación de un hecho existente mediante reemplazo bitemporal: cierra el hecho original y crea uno nuevo con el mismo linaje. El `id` del hecho cambia.                                                                                                                                                                  |
| `memory_judge`             | ✅ Activa | write               | Resuelve conflictos entre hechos contradictorios. `action='list'` muestra los pares en conflicto; `action='resolve'` aplica `supersede_a` \| `supersede_b` \| `keep_both` \| `merge`.                                                                                                                                                |
| `memory_stats`             | ✅ Activa | read                | Estadísticas agregadas del espacio de trabajo: hechos vigentes/cerrados/fijados/archivados, decisiones activas, conflictos, cobertura de embeddings, tasa de aciertos de recuperación a 30 días. Sin entrada.                                                                                                                        |
| `memory_compare`           | ✅ Activa | read                | Compara dos hechos por ID: contenido completo, diferencias de campos, verbo de relación sugerido (supersedes \| conflicts_with \| compatible \| scoped \| related) y si tratan del mismo subject.                                                                                                                                    |
| `memory_purge`             | ✅ Activa | write (hard_delete) | Borrado permanente e irreversible. Requiere el permiso `memory:hard_delete`. `action='fact'` borra un hecho por ID; `action='closed'` borra en bloque todos los hechos `forgotten` del espacio de trabajo. Solo para espacios de trabajo de prueba; no es un borrado conforme al GDPR (para el olvido habitual usa `memory_forget`). |
| `memory_context`           | ✅ Activa | read                | Contexto completo de la sesión: espacio de trabajo activo, usuario, tenant, estadísticas y otros espacios de trabajo disponibles. Llámala al inicio de la sesión: es el equivalente MCP de `GET /health` + `GET /me` combinados.                                                                                                     |
| `memory_suggest_topic_key` | ✅ Activa | read                | Sugiere una clave determinista a partir del subject y el cuerpo; reutiliza una clave existente cuando cambia el valor.                                                                                                                                                                                                               |
| `memory_fact`              | ✅ Activa | read                | Obtiene completo por ID un hecho, una decisión u otro registro recuperado (`kind` se infiere para un hecho o una decisión).                                                                                                                                                                                                          |
| `memory_relocate`          | ✅ Activa | write               | Mueve un hecho a otro espacio de trabajo: se cierra aquí y se crea un sucesor allá, con un ID nuevo.                                                                                                                                                                                                                                 |
| `memory_workspace`         | ✅ Activa | write               | Lista espacios de trabajo y membresías, o crea, invita, cambia un rol y quita (propietario o administrador).                                                                                                                                                                                                                         |

Los esquemas JSON y las descripciones exactos se trasladan tal cual del servidor MCP en proceso de Orchester, de modo que los prompts de agentes existentes siguen funcionando.

## Desarrollo local

```bash
pnpm install
pnpm --filter @mnemo-ai/mcp build
MNEMO_URL=http://localhost:3939 MNEMO_KEY=mns_live_yourkey node packages/mcp/dist/index.js
```

Para depurar una llamada a una herramienta a mano, pega un frame JSON-RPC en stdin: el servidor habla el protocolo estándar de MCP.

## Referencia de esquemas de herramientas

Una subsección por herramienta documentada. Los esquemas de entrada se generan a partir de lo que sirve el servidor: el esquema JSON sale de [`contracts/*.json`](https://github.com/lucasmailland/mnemosyne/tree/main/packages/mcp/contracts) y las descripciones de los campos, de los diccionarios del MCP ([`src/i18n/es.ts`](https://github.com/lucasmailland/mnemosyne/blob/main/packages/mcp/src/i18n/es.ts); inglés en [`src/i18n/en.ts`](https://github.com/lucasmailland/mnemosyne/blob/main/packages/mcp/src/i18n/en.ts)). Después de cambiar una herramienta, ejecuta `pnpm --filter @mnemo-ai/mcp readme:schemas`; una prueba falla si esta sección queda desactualizada.

> **Nota de cobertura:** esta sección documenta 20 de las 37 herramientas. `memory_fact`, `memory_relocate`, `memory_hyperedge`, `memory_introspect`, `memory_anticipate`, `memory_compose`, `memory_workflow`, `memory_skill`, `memory_doctor`, `memory_update`, `memory_judge`, `memory_stats`, `memory_compare`, `memory_purge`, `memory_context`, `memory_workspace` y `memory_suggest_topic_key` no están desarrolladas más abajo; sus esquemas están en `contracts/<name>.json`.

---

### memory_recall

Pasa `kinds` (opcional) para acotar los tipos de primitiva devueltos. Omítelo para usar los valores por defecto del servidor. Cada resultado conserva, cuando el servidor los proporciona, los campos opcionales `kind`, `topicKey`, `subject`, `scopeRef`, `status`, `similarity` y los metadatos de disputa. `nothingRelevant` se transmite cuando está disponible. El texto envuelve cada resultado como datos no confiables; `structuredContent` conserva la respuesta completa.

**Esquema de entrada:**

<!-- input-schema:memory_recall -->

```json
{
  "properties": {
    "actorId": {
      "type": "string"
    },
    "asOf": {
      "format": "date-time",
      "type": "string"
    },
    "includeGraph": {
      "type": "boolean"
    },
    "kinds": {
      "items": {
        "enum": [
          "fact",
          "decision",
          "strategy",
          "workflow",
          "skill",
          "episode",
          "task",
          "event",
          "reasoning",
          "entity"
        ],
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "limit": {
      "maximum": 25,
      "minimum": 1,
      "type": "integer"
    },
    "minSimilarity": {
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "mode": {
      "enum": ["lexical", "semantic", "hybrid", "auto"],
      "type": "string"
    },
    "projection": {
      "enum": ["full", "compact"],
      "type": "string"
    },
    "query": {
      "minLength": 1,
      "type": "string"
    },
    "requestId": {
      "maxLength": 128,
      "minLength": 1,
      "type": "string"
    },
    "scope": {
      "enum": ["global", "conversation", "personal"],
      "type": "string"
    },
    "scopeRef": {
      "type": "string"
    },
    "sessionId": {
      "type": "string"
    },
    "vectorWeight": {
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    }
  },
  "required": ["query"],
  "type": "object"
}
```

| Campo           | Descripción                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `actorId`       | actorId exacto guardado (por ejemplo, "key:<id>"; no es un userId).                                                                       |
| `asOf`          | Instante ISO 8601 pasado: la memoria como era entonces (los hechos reemplazados después vuelven como 'superseded').                       |
| `includeGraph`  | Lista también las relaciones de cada resultado y los ids de co-miembros de sus grupos (no se agregan como resultados). Por defecto false. |
| `kinds`         | Por defecto: fact, decision, strategy, workflow, skill, episode, entidades. task, event, reasoning solo si se listan.                     |
| `limit`         | Por defecto 5, máximo 25.                                                                                                                 |
| `minSimilarity` | Coseno mínimo (0 a 1) para resultados semánticos; los solo léxicos siguen elegibles.                                                      |
| `mode`          | 'lexical', 'semantic', 'hybrid' o 'auto' (por defecto).                                                                                   |
| `projection`    | Por defecto `compact`: 300 caracteres por resultado, `truncated: true` si se recortó (texto completo: memory_fact). `full`: todo.         |
| `query`         | Qué recordar, en texto libre (por ejemplo, 'preferencias de correo del cliente').                                                         |
| `requestId`     | Id opcional para correlacionar un reintento deliberado.                                                                                   |
| `scope`         | Omítelo para todos los ámbitos; 'personal' = hechos del espacio de trabajo personal.                                                      |
| `scopeRef`      | Filtra por proyecto; también encuentra los alias de una entidad kind='project'.                                                           |
| `sessionId`     | Id de la sesión activa; marca lastRecallAt (ver memory_session). Los ids desconocidos se ignoran.                                         |
| `vectorWeight`  | Obsoleto: usa mode. 0 = léxico, 1 = vectorial. Por defecto 0.5.                                                                           |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{ "query": "user email preferences", "limit": 10 }
```

**Devuelve:**

```json
{
  "memories": [
    {
      "id": "mfact_...",
      "content": "...",
      "score": 0.93,
      "subject": "user:lucas",
      "kind": "preference"
    }
  ],
  "_mnemo_label": "untrusted_external_content",
  "_mnemo_version": "3.0"
}
```

> Nota: `_mnemo_label: "untrusted_external_content"` es una señal al estilo CaMeL. Los orquestadores compatibles con CaMeL no deben ejecutar el contenido recuperado como instrucciones.

Para cualquier resultado truncado, llama a `memory_fact` con `{ "factId": "<id>", "kind": "<el kind del resultado>" }` para obtener su cuerpo completo; la pista bajo el resultado escribe la llamada. `memory_fact` está en los dos perfiles, así que también funciona con `MNEMO_MCP_TOOLS=core`. Las llamadas a hechos y decisiones pueden omitir `kind`.

---

### memory_remember

**Esquema de entrada:**

<!-- input-schema:memory_remember -->

```json
{
  "properties": {
    "agentId": {
      "type": "string"
    },
    "confidence": {
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "conversationId": {
      "type": "string"
    },
    "episodeId": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "kind": {
      "type": "string"
    },
    "scope": {
      "enum": ["global", "conversation", "personal"],
      "type": "string"
    },
    "scopeOwner": {
      "type": "string"
    },
    "scopeRef": {
      "type": "string"
    },
    "sessionId": {
      "type": "string"
    },
    "statement": {
      "maxLength": 1000,
      "minLength": 1,
      "type": "string"
    },
    "subject": {
      "type": "string"
    },
    "subtype": {
      "type": "string"
    },
    "targetWorkspaceId": {
      "type": "string"
    },
    "topicKey": {
      "type": "string"
    }
  },
  "required": ["statement"],
  "type": "object"
}
```

| Campo               | Descripción                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentId`           | Opcional: el agente o la conversación de origen.                                                                                                                                                                                                                                                                                                                 |
| `confidence`        | [0, 1]. Omítelo para usar el valor por defecto del servidor.                                                                                                                                                                                                                                                                                                     |
| `conversationId`    | Opcional: id de la conversación, para citar el origen.                                                                                                                                                                                                                                                                                                           |
| `episodeId`         | Solo para un episodio existente (corrección, importación); nunca lo adivines. Lo normal es enviar sessionId.                                                                                                                                                                                                                                                     |
| `idempotencyKey`    | Clave de reintento: un reenvío devuelve el primer resultado.                                                                                                                                                                                                                                                                                                     |
| `kind`              | 'fact' (por defecto), 'decision', 'episode', 'entity', 'strategy', 'workflow', 'skill', 'task', 'event' o 'reasoning'; uno desconocido devuelve 400. La categoría va en subtype.                                                                                                                                                                                 |
| `scope`             | Por defecto 'global'. 'personal' = tu espacio de trabajo personal, en todos los proyectos; requiere una clave ligada a un usuario (las claves mns_live_ fallan: 'scope personal requires a user-bound key').                                                                                                                                                     |
| `scopeOwner`        | 'workspace:<id>' (por defecto), 'user:<userId>' o 'tenant:<tenantId>'; IDs: memory_context.                                                                                                                                                                                                                                                                      |
| `scopeRef`          | Referencia de proyecto (por ejemplo, 'mnemosyne'), filtrable al recordar; los nombres y alias de entidades se canonicalizan (avisos scope_ref_canonicalized, scope_ref_unrecognized).                                                                                                                                                                            |
| `sessionId`         | El id de sesión que devuelve memory_episode_start (o 'Episode: open'). Pásalo siempre: memory_episode_end enlaza sus hechos al episodio; sin él, nunca tendrán contexto de origen.                                                                                                                                                                               |
| `statement`         | Una afirmación autocontenida (por ejemplo, 'El cliente Acme prefiere comunicarse en español.').                                                                                                                                                                                                                                                                  |
| `subject`           | De qué trata el hecho (por ejemplo, 'acme', 'user:dana@example.com'). Por defecto 'workspace'.                                                                                                                                                                                                                                                                   |
| `subtype`           | fact: 'preference' \| 'trait' \| 'event' \| 'relationship' \| 'skill' \| 'concern' \| 'architecture' \| 'bugfix' \| 'config' \| 'discovery' \| 'policy' \| 'process' \| 'other' (por defecto). Una elección con justificación es una decisión: usa memory_decide. Otros kind: ver memory_decide, memory_entity. Un valor desconocido se reemplaza, con un aviso. |
| `targetWorkspaceId` | Escribe en este UUID de espacio de trabajo (requiere write/admin; IDs: memory_context).                                                                                                                                                                                                                                                                          |
| `topicKey`          | Un hecho o decisión activo con esta clave se actualiza en vez de duplicarse (por ejemplo, 'auth-strategy'). Ver memory_suggest_topic_key.                                                                                                                                                                                                                        |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{
  "statement": "User prefers TypeScript over JavaScript",
  "subject": "user:lucas@example.com",
  "kind": "preference",
  "confidence": 0.9
}
```

**Devuelve:** el objeto del hecho creado por el servidor (la forma refleja la respuesta de POST /remember: `V3Fact`, `statement` y no `content`):

```json
{
  "id": "mfact_...",
  "statement": "User prefers TypeScript over JavaScript",
  "createdAt": "2026-06-13T10:00:00Z"
}
```

---

### memory_pin

**Esquema de entrada:**

<!-- input-schema:memory_pin -->

```json
{
  "properties": {
    "factId": {
      "minLength": 1,
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "unpin": {
      "type": "boolean"
    }
  },
  "required": ["factId"],
  "type": "object"
}
```

| Campo            | Descripción                                                  |
| ---------------- | ------------------------------------------------------------ |
| `factId`         | ID del hecho que se va a fijar.                              |
| `idempotencyKey` | Clave de reintento: un reenvío devuelve el primer resultado. |
| `unpin`          | true quita el pin. Por defecto false.                        |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{ "factId": "mfact_01j..." }
```

**Llamada de ejemplo para quitar la fijación:**

```json
{ "factId": "mfact_01j...", "unpin": true }
```

**Devuelve:** el objeto del hecho actualizado por el servidor (la forma refleja la respuesta de POST /facts/:id/pin).

---

### memory_forget

**Esquema de entrada:**

<!-- input-schema:memory_forget -->

```json
{
  "properties": {
    "factId": {
      "minLength": 1,
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "kind": {
      "default": "fact",
      "enum": [
        "fact",
        "decision",
        "episode",
        "entity",
        "strategy",
        "workflow",
        "skill",
        "task",
        "event",
        "reasoning",
        "hyperedge"
      ],
      "type": "string"
    },
    "primitiveId": {
      "minLength": 1,
      "type": "string"
    },
    "reason": {
      "type": "string"
    }
  },
  "type": "object"
}
```

| Campo            | Descripción                                                  |
| ---------------- | ------------------------------------------------------------ |
| `factId`         | Hecho a archivar (alias de primitiveId con kind='fact').     |
| `idempotencyKey` | Clave de reintento: un reenvío devuelve el primer resultado. |
| `kind`           | Tipo de primitivo que se va a archivar. Por defecto: 'fact'. |
| `primitiveId`    | Obligatorio si kind no es 'fact'.                            |
| `reason`         | Motivo opcional (queda en el registro de auditoría).         |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{ "factId": "mfact_01j...", "reason": "Information was incorrect" }
```

**Devuelve:**

```json
{ "id": "mfact_01j...", "forgotten": true, "reason": "Information was incorrect" }
```

> Nota: es un **borrado lógico**. El hecho pasa a `mnemo_fact_archive` y se puede recuperar para auditoría. La cadena `reason` se devuelve en la respuesta del MCP, pero el servidor no la persiste en esta ruta.

---

### memory_timeline

**Esquema de entrada:**

<!-- input-schema:memory_timeline -->

```json
{
  "properties": {
    "limit": {
      "maximum": 100,
      "minimum": 1,
      "type": "integer"
    },
    "sinceIso": {
      "type": "string"
    }
  },
  "type": "object"
}
```

| Campo      | Descripción                                    |
| ---------- | ---------------------------------------------- |
| `limit`    | Por defecto 20, máximo 100.                    |
| `sinceIso` | Solo los eventos posteriores a esta fecha ISO. |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{ "limit": 50, "sinceIso": "2026-06-06T00:00:00Z" }
```

**Devuelve:** un arreglo de eventos de memoria recientes del servidor (la forma refleja la respuesta de GET /timeline: eventos ordenados del más reciente al más antiguo, con campos como `updatedAt`, `pinned` y `status`).

> Paginación: pasa `sinceIso = <lastSeenEventTime>` para avanzar de página: el servidor devuelve los eventos del más reciente al más antiguo, así que esto da una paginación limpia basada en cursor, sin desplazamientos.

---

### memory_search

`memory_search` también acepta `kinds` (opcional) y muestra cada resultado en el texto. Su `score` es una puntuación de ordenamiento, no la similitud de coseno cruda.

**Esquema de entrada:**

<!-- input-schema:memory_search -->

```json
{
  "properties": {
    "actorId": {
      "type": "string"
    },
    "kinds": {
      "items": {
        "enum": [
          "fact",
          "decision",
          "strategy",
          "workflow",
          "skill",
          "episode",
          "task",
          "event",
          "reasoning",
          "entity"
        ],
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "limit": {
      "maximum": 20,
      "minimum": 1,
      "type": "integer"
    },
    "query": {
      "minLength": 1,
      "type": "string"
    },
    "scope": {
      "enum": ["global", "conversation", "personal"],
      "type": "string"
    },
    "scopeRef": {
      "type": "string"
    }
  },
  "required": ["query"],
  "type": "object"
}
```

| Campo      | Descripción                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `actorId`  | actorId exacto guardado (por ejemplo, "key:<id>"; no es un userId).                                                   |
| `kinds`    | Por defecto: fact, decision, strategy, workflow, skill, episode, entidades. task, event, reasoning solo si se listan. |
| `limit`    | Por defecto 5, máximo 20.                                                                                             |
| `query`    | Texto libre: qué quieres buscar por significado.                                                                      |
| `scope`    | Omítelo para todos los ámbitos; 'personal' = hechos del espacio de trabajo personal.                                  |
| `scopeRef` | Filtra por proyecto (por ejemplo, 'mnemosyne').                                                                       |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{ "query": "database architecture decisions", "limit": 5 }
```

**Devuelve:**

```json
{
  "memories": [
    { "id": "mfact_...", "content": "We chose PostgreSQL for ACID compliance", "score": 0.97 }
  ],
  "_mnemo_label": "untrusted_external_content",
  "_mnemo_version": "3.0"
}
```

> `memory_search` usa el modo automático del servidor para poder recurrir a la búsqueda por palabras clave cuando los embeddings no están disponibles. Revisa `debug.searchMode` para saber qué ruta se usó.

---

### memory_relate

**Esquema de entrada:**

<!-- input-schema:memory_relate -->

```json
{
  "properties": {
    "action": {
      "default": "create",
      "enum": ["create", "list", "history", "retract"],
      "type": "string"
    },
    "confidence": {
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "from": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "judgmentStatus": {
      "enum": ["pending", "judged", "dismissed"],
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "maxDepth": {
      "maximum": 5,
      "minimum": 1,
      "type": "integer"
    },
    "reason": {
      "type": "string"
    },
    "relationId": {
      "type": "string"
    },
    "sourceKind": {
      "enum": ["fact", "decision", "entity", "episode"],
      "type": "string"
    },
    "targetKind": {
      "enum": ["fact", "decision", "entity", "episode"],
      "type": "string"
    },
    "to": {
      "type": "string"
    },
    "verb": {
      "enum": [
        "related",
        "compatible",
        "scoped",
        "conflicts_with",
        "supersedes",
        "not_conflict",
        "derived_from",
        "part_of",
        "member_of"
      ],
      "type": "string"
    }
  },
  "type": "object"
}
```

| Campo            | Descripción                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `action`         | 'create', 'list', 'history' (linaje supersedes/derived_from) o 'retract' (cierre bitemporal por id de relación). |
| `confidence`     | [0, 1]. El servidor fija el valor por defecto.                                                                   |
| `from`           | action='create'/'history'. Id de origen (episodios: mepi_...).                                                   |
| `idempotencyKey` | Clave de reintento: un reenvío devuelve el primer resultado.                                                     |
| `judgmentStatus` | action='list'. Filtra por estado del juicio.                                                                     |
| `limit`          | action='list'. Límite de relaciones que se devuelven.                                                            |
| `maxDepth`       | action='history'. Profundidad del linaje. Por defecto y como máximo 5.                                           |
| `reason`         | Opcional: por qué existe esta relación.                                                                          |
| `relationId`     | action='retract'. ID de la relación misma, no de sus extremos.                                                   |
| `sourceKind`     | action='create'/'history'. Tipo del primitivo de origen.                                                         |
| `targetKind`     | action='create'. Tipo del primitivo de destino.                                                                  |
| `to`             | action='create'. ID del primitivo de destino.                                                                    |
| `verb`           | action='create'. Uno de los 9 verbos fijos.                                                                      |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{
  "sourceKind": "decision",
  "from": "mdec_01j...",
  "targetKind": "fact",
  "to": "mfact_01j...",
  "verb": "derived_from",
  "reason": "The architecture decision was informed by this benchmark fact",
  "confidence": 0.85
}
```

**Devuelve:** el objeto de relación creado por el servidor.

> Los 9 verbos bloqueados están definidos en la spec v3 §4.2. El servidor rechaza con un error 400 cualquier verbo fuera de este conjunto; la capa MCP valida primero para que el LLM reciba un error descriptivo antes del viaje de red.

---

### memory_decide

**Esquema de entrada:**

<!-- input-schema:memory_decide -->

```json
{
  "properties": {
    "body": {
      "minLength": 1,
      "type": "string"
    },
    "conversationId": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "kind": {
      "enum": [
        "decision",
        "architecture",
        "policy",
        "process",
        "bugfix",
        "learning",
        "discovery",
        "config"
      ],
      "type": "string"
    },
    "scopeRef": {
      "type": "string"
    },
    "sensitivity": {
      "enum": ["public", "internal", "confidential", "restricted"],
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "title": {
      "maxLength": 500,
      "minLength": 1,
      "type": "string"
    },
    "topicKey": {
      "type": "string"
    }
  },
  "required": ["body", "kind", "title"],
  "type": "object"
}
```

| Campo               | Descripción                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `body`              | La justificación: razonamiento, alternativas consideradas, factores decisivos.                                                        |
| `conversationId`    | Procedencia: pasa aquí el sessionId del episodio; decide no tiene un parámetro sessionId propio.                                      |
| `idempotencyKey`    | Clave de reintento: un reenvío devuelve el primer resultado.                                                                          |
| `kind`              | Categoría de la decisión. Una de: decision \| architecture \| policy \| process \| bugfix \| learning \| discovery \| config.         |
| `scopeRef`          | Proyecto al que pertenece la decisión (por ejemplo, 'project-x').                                                                     |
| `sensitivity`       | Por defecto 'internal'.                                                                                                               |
| `targetWorkspaceId` | Escribe en este UUID de espacio de trabajo (requiere write/admin; IDs: memory_context).                                               |
| `title`             | La decisión en una oración (por ejemplo, 'Usar PostgreSQL como base de datos principal.').                                            |
| `topicKey`          | Clave de deduplicación ('Auth-Strategy' = 'auth-strategy'): la misma clave actualiza la decisión; sin topicKey cada llamada crea una. |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{
  "kind": "architecture",
  "title": "Use PostgreSQL as the primary database",
  "body": "We chose PostgreSQL over MySQL for its JSONB support, full ACID compliance, and better support for complex queries. MySQL was considered but ruled out due to weaker partial-index support.",
  "conversationId": "conv_01j..."
}
```

**Devuelve:** el objeto de decisión creado o actualizado por el servidor (guardado en `mnemo_decision`, no en `mnemo_fact`).

> Idempotente por `topic_key` normalizado. Volver a enviar el mismo título (normalizado) hace un upsert y devuelve la fila existente. Pasa un `topicKey` explícito para controlar la clave de deduplicación.

---

### memory_entity

**Esquema de entrada:**

<!-- input-schema:memory_entity -->

```json
{
  "properties": {
    "action": {
      "default": "create",
      "enum": ["create", "get", "list", "update", "linked_facts", "link_user", "unlink_user"],
      "type": "string"
    },
    "aliases": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "id": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "kind": {
      "enum": ["person", "organization", "project", "concept", "place", "other"],
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "metadata": {
      "type": "object"
    },
    "name": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "q": {
      "type": "string"
    },
    "sensitivity": {
      "enum": ["public", "internal", "confidential", "restricted"],
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "userId": {
      "type": "string"
    }
  },
  "type": "object"
}
```

| Campo               | Descripción                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `action`            | La operación que se va a realizar.                                                                            |
| `aliases`           | Nombres alternativos o apodos.                                                                                |
| `description`       | Breve: rol, contexto, detalles.                                                                               |
| `id`                | Obligatorio para get, update, linked_facts, link_user, unlink_user.                                           |
| `idempotencyKey`    | Clave de reintento: un reenvío devuelve el primer resultado.                                                  |
| `kind`              | Categoría de la entidad. Obligatorio para create.                                                             |
| `limit`             | Límite de resultados para list y linked_facts.                                                                |
| `metadata`          | Metadatos arbitrarios.                                                                                        |
| `name`              | Nombre canónico. Obligatorio para create.                                                                     |
| `q`                 | Subcadena de búsqueda para list.                                                                              |
| `sensitivity`       | Solo al crear con create (update lo rechaza). Por defecto 'internal'.                                         |
| `targetWorkspaceId` | Escribe en este UUID de espacio de trabajo (requiere write/admin; IDs: memory_context). Solo action='create'. |
| `userId`            | Id de cuenta (mnemo_user.id) para link_user; debe ser miembro del espacio de trabajo.                         |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{
  "name": "Acme Corp",
  "kind": "organization",
  "description": "Enterprise customer using the ATS product",
  "aliases": ["Acme", "acme-corp"],
  "metadata": { "plan": "enterprise", "region": "us-east" }
}
```

**Devuelve:** el objeto de entidad creado u obtenido del servidor (upsert por nombre normalizado dentro del espacio de trabajo).

**Identidad: acciones `link_user` / `unlink_user`.** Además de `create`/`get`/`list`/`update`/`linked_facts`, `memory_entity` admite dos acciones para vincular una entidad `kind: "person"` con una cuenta real de la plataforma (`linkedUserId`, un `mnemo_user.id`, distinto de la _procedencia_, que registra quién escribió la fila, no de quién trata):

```json
{ "action": "link_user", "id": "d0522e17-bd87-4ced-bc38-2b9a499beea7", "userId": "usr_..." }
{ "action": "unlink_user", "id": "d0522e17-bd87-4ced-bc38-2b9a499beea7" }
```

Vincularse a uno mismo (tu propio `userId`) siempre está permitido. Vincular a un usuario _distinto_, o reasignar una entidad que ya está vinculada a otra persona, exige que quien llama tenga el permiso `memory:admin` **y** un rol de propietario/administrador en el espacio de trabajo; la verificación se hace contra el vínculo _actual_ de la entidad, no solo contra el destino solicitado, de modo que un simple autovínculo no pueda secuestrar en silencio el vínculo existente de otra persona. `unlink_user` es bitemporal (cierra la fila anterior y crea un sucesor sin vínculo) en lugar de vaciar `linkedUserId` en el mismo lugar. `linkedUserId` nunca se puede definir con `create`/`update`: solo con estas dos acciones.

---

### memory_status

**Esquema de entrada:**

<!-- input-schema:memory_status -->

```json
{
  "properties": {},
  "type": "object"
}
```

| Campo | Descripción |
| ----- | ----------- |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{}
```

**Devuelve:** una instantánea de estado de GET /health, con el estado de los subcomponentes para degradar con elegancia:

```json
{
  "status": "ok",
  "db": "ok",
  "embedder": "ok",
  "queue": "ok",
  "version": "3.6.1",
  "recallLatencyP50Ms": 42
}
```

> Los estados de los subcomponentes permiten a los orquestadores degradar con elegancia: por ejemplo, si `embedder` está caído pero `db` está `"ok"`, la recuperación de un hecho por ID puede seguir funcionando mientras la recuperación semántica no está disponible.

---

### memory_remind_when

**Descripción:** programa un disparador de memoria prospectiva. El servidor evalúa la condición
contra los hechos nuevos que llegan y dispara el recordatorio cuando coincide.

**Esquema de entrada:**

<!-- input-schema:memory_remind_when -->

```json
{
  "properties": {
    "action": {
      "default": "create",
      "enum": ["create", "list", "dismiss"],
      "type": "string"
    },
    "condition": {
      "minLength": 1,
      "type": "string"
    },
    "content": {
      "minLength": 1,
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "status": {
      "enum": ["pending", "triggered", "dismissed", "all"],
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "triggerAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "type": "object"
}
```

| Campo               | Descripción                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `action`            | Operación que se va a realizar: 'create', 'list' o 'dismiss'.                                                                                                                  |
| `condition`         | action='create'. Condición semántica evaluada en cada memory_recall; obligatoria sin triggerAt.                                                                                |
| `content`           | action='create'. Texto que se muestra al dispararse.                                                                                                                           |
| `id`                | action='dismiss'. Id del recordatorio.                                                                                                                                         |
| `idempotencyKey`    | Clave de reintento: un reenvío devuelve el primer resultado.                                                                                                                   |
| `limit`             | Con action='list'.                                                                                                                                                             |
| `status`            | action='list'. Por defecto 'pending'; 'triggered' = disparados sin revisar (el content se conserva).                                                                           |
| `targetWorkspaceId` | Escribe en este UUID de espacio de trabajo (requiere write/admin; IDs: memory_context). Solo action='create'.                                                                  |
| `triggerAt`         | action='create'. Momento ISO 8601 desde el que puede dispararse (se revisa cada 30s); obligatorio sin condition. Con ambos, un memory_recall posterior debe cumplir condition. |

<!-- /input-schema -->

**Esquema de salida:**

```json
{
  "content": [{ "type": "text", "text": "Reminder scheduled: {label} (id: {id})" }]
}
```

**Llamada de ejemplo:**

```json
{
  "name": "memory_remind_when",
  "arguments": {
    "condition": "user mentions they want to switch to TypeScript",
    "label": "TS migration intent",
    "triggerAt": "2026-07-01T09:00:00Z"
  }
}
```

---

### memory_consolidate

**Descripción:** dispara una pasada rápida de consolidación para el espacio de trabajo activo. El motor
selecciona un conjunto acotado de hechos candidatos de bajo worth, fusiona los grupos de casi duplicados que cumplen los requisitos y
informa los conteos de candidatos, fusiones y omisiones. Por ahora solo se admite `mode: "fast"` con `dryRun: false`.
El modo profundo manual devuelve HTTP 422 `deep_mode_not_supported`, y
`dryRun: true` devuelve HTTP 422 `dry_run_not_supported` sin ejecutar la consolidación.

**Esquema de entrada:**

<!-- input-schema:memory_consolidate -->

```json
{
  "properties": {
    "dryRun": {
      "default": false,
      "type": "boolean"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "mode": {
      "default": "fast",
      "enum": ["fast", "deep"],
      "type": "string"
    }
  },
  "type": "object"
}
```

| Campo            | Descripción                                                       |
| ---------------- | ----------------------------------------------------------------- |
| `dryRun`         | Debe ser false: `dryRun: true` devuelve HTTP 422.                 |
| `idempotencyKey` | Clave de reintento: un reenvío devuelve el primer resultado.      |
| `mode`           | `fast` (por defecto) o `deep` (un deep manual devuelve HTTP 422). |

<!-- /input-schema -->

**Esquema de salida:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Consolidation complete. candidates=N merged=M skipped=K"
    }
  ]
}
```

**Llamada de ejemplo:**

```json
{
  "name": "memory_consolidate",
  "arguments": { "mode": "fast", "dryRun": false }
}
```

---

### memory_session

**Descripción:** herramienta unificada de control de sesiones (spec §24). Despacha según `action`:
`pin`/quitar la fijación de un hecho, agregar un turno `scratch` a una sesión, `collapse` de una sesión
(que activa el pipeline de extracción) o `discard` de una sesión. La capa MCP es un adaptador
delgado: la lógica es del servidor. Correspondencia de acción → transporte:

- `pin` → `client.pinFact` / `client.unpinFact` (`POST /facts/:id/pin`) — **activa**
- `collapse` → `client.collapseSession` (`POST /session/:id/collapse`) — **activa**
- `scratch` → `client.updateSessionScratch` (`POST /session/:id/scratch`) — **activa**
- `discard` → `client.discardSession` (`POST /session/:id/discard`) — **activa**

**Esquema de entrada:**

<!-- input-schema:memory_session -->

```json
{
  "properties": {
    "action": {
      "enum": [
        "start",
        "turn",
        "pin_turn",
        "pin",
        "scratch",
        "collapse",
        "discard",
        "feedback",
        "get",
        "list"
      ],
      "type": "string"
    },
    "agentId": {
      "type": "string"
    },
    "collapseHint": {
      "type": "string"
    },
    "content": {
      "maxLength": 20000,
      "type": "string"
    },
    "factId": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "metadata": {
      "type": "object"
    },
    "rating": {
      "enum": ["up", "down"],
      "type": "string"
    },
    "role": {
      "enum": ["user", "assistant", "system"],
      "type": "string"
    },
    "sessionId": {
      "type": "string"
    },
    "turnId": {
      "type": "string"
    },
    "turnIndex": {
      "type": "integer"
    },
    "unpin": {
      "type": "boolean"
    }
  },
  "required": ["action"],
  "type": "object"
}
```

| Campo            | Descripción                                                                          |
| ---------------- | ------------------------------------------------------------------------------------ |
| `action`         | La operación de sesión que se va a realizar.                                         |
| `agentId`        | Para start: el agente de la nueva sesión.                                            |
| `collapseHint`   | Para collapse: 'explicit' = extracción completa, 'auto' = heurística de recurrencia. |
| `content`        | Para scratch y turn: el texto de la nota o del turno.                                |
| `factId`         | Hecho a fijar o desfijar. Obligatorio para pin.                                      |
| `idempotencyKey` | Clave de reintento: un reenvío devuelve el primer resultado.                         |
| `metadata`       | Metadatos para start o scratch.                                                      |
| `rating`         | Para feedback: 'up' (éxito) o 'down' (fracaso).                                      |
| `role`           | Para scratch y turn. Por defecto assistant (scratch), user (turn).                   |
| `sessionId`      | Obligatorio para turn, pin_turn, collapse, scratch, discard, feedback, get.          |
| `turnId`         | Para pin_turn: el id del turno (uuid).                                               |
| `turnIndex`      | Para pin_turn: el índice del turno.                                                  |
| `unpin`          | Para pin/pin_turn: true quita el pin. Por defecto false.                             |

<!-- /input-schema -->

**Esquema de salida:**

```json
{
  "content": [{ "type": "text", "text": "<result summary>" }],
  "structuredContent": { "<action-specific result>" }
}
```

Todas las acciones devuelven una respuesta exitosa con contenido estructurado específico de la acción (p. ej., `{ "scratched": true, "sessionId": "..." }` para scratch, `{ "discarded": true, "sessionId": "..." }` para discard).

**Llamada de ejemplo:**

```json
{
  "name": "memory_session",
  "arguments": { "action": "pin", "factId": "fct_01hwz..." }
}
```

---

### memory_episode_start

> **Nota (herramientas MCP de la spec §24):** la herramienta unificada `memory_session` (arriba) expone el
> contrato `action: pin | scratch | collapse | discard` de la spec, y las cuatro acciones están
> completamente conectadas. `memory_pin`, `memory_episode_start` y `memory_episode_end` siguen
> existiendo como alias específicos de las rutas de fijar / abrir sesión / colapsar y siguen funcionando.

**Descripción:** abre un episodio con nombre (sesión). Devuelve un `sessionId` que se debe
pasar a las llamadas posteriores a `memory_remember` para agrupar los hechos bajo el contexto del episodio.
Ciérralo con `memory_episode_end` para activar la extracción de la transcripción.

**Esquema de entrada:**

<!-- input-schema:memory_episode_start -->

```json
{
  "properties": {
    "agentId": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "label": {
      "type": "string"
    },
    "metadata": {
      "type": "object"
    }
  },
  "type": "object"
}
```

| Campo            | Descripción                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| `agentId`        | Agente que inicia el episodio. Por defecto: el agente del espacio de trabajo. |
| `idempotencyKey` | Clave de reintento: un reenvío devuelve el primer resultado.                  |
| `label`          | Etiqueta legible (por ejemplo, 'Reunión con cliente 2026-06-12').             |
| `metadata`       | Metadatos del episodio (por ejemplo, { projectId, ticketUrl }).               |

<!-- /input-schema -->

**Esquema de salida:**

```json
{
  "content": [{ "type": "text", "text": "Episode started. sessionId: {id}" }]
}
```

**Llamada de ejemplo:**

```json
{
  "name": "memory_episode_start",
  "arguments": { "agentId": "claude-sonnet", "actorId": "user-42" }
}
```

---

### memory_episode_end

**Descripción:** cierra un episodio y activa el pipeline de colapso de 8 pasos: la transcripción
de la sesión se envía al LLM para extraer hechos, lo que crea hechos nuevos etiquetados con
el contexto del episodio. El estado de la sesión cambia a `collapsed`.

**Esquema de entrada:**

<!-- input-schema:memory_episode_end -->

```json
{
  "properties": {
    "collapseHint": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "sessionId": {
      "minLength": 1,
      "type": "string"
    }
  },
  "required": ["sessionId"],
  "type": "object"
}
```

| Campo            | Descripción                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collapseHint`   | Pista opcional de extracción (por ejemplo, 'priorizar las decisiones del usuario').                                                                                                 |
| `idempotencyKey` | Clave de reintento: un reenvío devuelve el primer resultado.                                                                                                                        |
| `sessionId`      | ID del episodio o sesión a cerrar. Lo devuelve `memory_episode_start`. Solo en MCP puro: con 'Episode: open' o 'mnemo-managed-v1:' lo cierra el host; la compactación no lo cierra. |

<!-- /input-schema -->

**Esquema de salida:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Episode collapsed. sessionId: {id} status: collapsed"
    }
  ]
}
```

**Llamada de ejemplo:**

```json
{
  "name": "memory_episode_end",
  "arguments": {
    "sessionId": "ses_01hwz...",
    "collapseHint": "Focus on architecture decisions"
  }
}
```

---

### memory_task

**Descripción:** gestiona las tareas accionables del espacio de trabajo. Las tareas son trabajos puntuales con responsable, estado y dependencias. Verbos de dominio §24: `delegate` reasigna la tarea a otro agente (requiere `assignedTo`; aplica `status → delegated`); `complete` la marca como terminada (acepta `outcome` y `lessonsLearned`).

**Esquema de entrada:**

<!-- input-schema:memory_task -->

```json
{
  "properties": {
    "action": {
      "enum": ["create", "get", "list", "patch", "archive", "delegate", "complete"],
      "type": "string"
    },
    "assignedTo": {
      "type": "string"
    },
    "dueAt": {
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "lessonsLearned": {
      "maxLength": 20000,
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "metadata": {
      "type": "object"
    },
    "outcome": {
      "maxLength": 20000,
      "type": "string"
    },
    "parentTaskId": {
      "type": "string"
    },
    "parentTaskIdFilter": {
      "type": "string"
    },
    "priority": {
      "enum": ["critical", "high", "medium", "low"],
      "type": "string"
    },
    "sensitivity": {
      "enum": ["public", "internal", "confidential", "restricted"],
      "type": "string"
    },
    "sessionId": {
      "type": "string"
    },
    "status": {
      "enum": ["pending", "in_progress", "blocked", "delegated", "completed", "cancelled"],
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "title": {
      "maxLength": 500,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": ["action"],
  "type": "object"
}
```

| Campo                | Descripción                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `action`             | create → title, assignedTo; get, patch, archive, complete → id; delegate → id, assignedTo (campos obligatorios). |
| `assignedTo`         | Obligatorio para create y delegate.                                                                              |
| `description`        | Detalles de la tarea. Para create y patch.                                                                       |
| `dueAt`              | Cuándo vence la tarea, en ISO 8601. Para create.                                                                 |
| `id`                 | Obligatorio para get/patch/archive/delegate/complete.                                                            |
| `idempotencyKey`     | Clave de reintento: un reenvío devuelve el primer resultado.                                                     |
| `lessonsLearned`     | Qué recordar de ella. Para patch y complete.                                                                     |
| `limit`              | Para list.                                                                                                       |
| `metadata`           | JSON libre. Para create y patch.                                                                                 |
| `outcome`            | Qué resultó de la tarea. Para patch y complete.                                                                  |
| `parentTaskId`       | Id de la tarea padre; esta queda como subtarea. Para create.                                                     |
| `parentTaskIdFilter` | Para list: solo las subtareas de esta tarea.                                                                     |
| `priority`           | critical, high, medium o low. Para create y patch.                                                               |
| `sensitivity`        | Solo al crear con create (patch lo rechaza). Por defecto 'internal'.                                             |
| `sessionId`          | La sesión a la que pertenece la tarea. Para create.                                                              |
| `status`             | Para patch: el estado nuevo. Para list: un filtro.                                                               |
| `targetWorkspaceId`  | Escribe en este UUID de espacio de trabajo (requiere write/admin; IDs: memory_context). Solo action='create'.    |
| `title`              | Obligatorio para create.                                                                                         |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{
  "name": "memory_task",
  "arguments": {
    "action": "create",
    "title": "Migrate auth to Better Auth",
    "assignedTo": "agent-claude",
    "priority": "high"
  }
}
```

---

### memory_event

**Descripción:** registra eventos inmutables en el registro del espacio de trabajo. Los eventos son de solo anexado; usa `memory_fact` para el estado mutable.

**Esquema de entrada:**

<!-- input-schema:memory_event -->

```json
{
  "properties": {
    "action": {
      "enum": ["create", "get", "list", "archive", "annotate", "sensitivity"],
      "type": "string"
    },
    "after": {
      "format": "date-time",
      "type": "string"
    },
    "at": {
      "format": "date-time",
      "type": "string"
    },
    "author": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "before": {
      "format": "date-time",
      "type": "string"
    },
    "content": {
      "maxLength": 20000,
      "minLength": 1,
      "type": "string"
    },
    "durationS": {
      "minimum": 0,
      "type": "integer"
    },
    "id": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "metadata": {
      "type": "object"
    },
    "name": {
      "maxLength": 500,
      "minLength": 1,
      "type": "string"
    },
    "occurredAt": {
      "format": "date-time",
      "type": "string"
    },
    "relatedEntities": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "sensitivity": {
      "enum": ["public", "internal", "confidential", "restricted"],
      "type": "string"
    },
    "source": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "sourceFilter": {
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "type": {
      "enum": ["system", "external", "user", "agent", "scheduled"],
      "type": "string"
    }
  },
  "required": ["action"],
  "type": "object"
}
```

| Campo               | Descripción                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`            | create (type, name, description, occurredAt, source) \| get \| list \| archive = NO-OP {archived:false, immutable:true} \| annotate \| sensitivity (solo sube; bajarlo da 422). |
| `after`             | Para list: solo eventos posteriores a este instante.                                                                                                                            |
| `at`                | Marca de tiempo opcional para annotate.                                                                                                                                         |
| `author`            | Obligatorio para annotate.                                                                                                                                                      |
| `before`            | Para list: solo eventos anteriores a este instante.                                                                                                                             |
| `content`           | Contenido de la anotación. Obligatorio para annotate.                                                                                                                           |
| `description`       | Obligatorio para create.                                                                                                                                                        |
| `durationS`         | Duración en segundos. Para create.                                                                                                                                              |
| `id`                | Obligatorio para get/archive/annotate/sensitivity.                                                                                                                              |
| `idempotencyKey`    | Clave de reintento: un reenvío devuelve el primer resultado.                                                                                                                    |
| `limit`             | Para list.                                                                                                                                                                      |
| `metadata`          | JSON libre. Para create.                                                                                                                                                        |
| `name`              | Obligatorio para create.                                                                                                                                                        |
| `occurredAt`        | Cuándo ocurrió. Obligatorio para create.                                                                                                                                        |
| `relatedEntities`   | Ids de las entidades involucradas. Para create.                                                                                                                                 |
| `sensitivity`       | create: nivel inicial (por defecto 'internal'); sensitivity: el nivel nuevo, nunca menor.                                                                                       |
| `source`            | De dónde provino el evento. Obligatorio para create.                                                                                                                            |
| `sourceFilter`      | Para list: solo los eventos de esta fuente.                                                                                                                                     |
| `targetWorkspaceId` | Escribe en este UUID de espacio de trabajo (requiere write/admin; IDs: memory_context). Solo action='create'.                                                                   |
| `type`              | Obligatorio para create.                                                                                                                                                        |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{
  "name": "memory_event",
  "arguments": {
    "action": "create",
    "type": "agent",
    "name": "wave-b-deployed",
    "description": "Wave B MCP tools deployed successfully",
    "occurredAt": "2026-06-15T01:00:00.000Z",
    "source": "mcp-agent"
  }
}
```

---

### memory_reasoning

**Descripción:** almacena cadenas de pensamiento estructuradas (pregunta → pasos → conclusión) para reutilizarlas en situaciones similares.

**Esquema de entrada:**

<!-- input-schema:memory_reasoning -->

```json
{
  "properties": {
    "action": {
      "enum": ["create", "get", "list", "patch", "archive", "resolve", "record", "feedback"],
      "type": "string"
    },
    "agentId": {
      "type": "string"
    },
    "chain": {
      "items": {
        "properties": {
          "conclusion": {
            "maxLength": 20000,
            "type": "string"
          },
          "reasoning": {
            "maxLength": 20000,
            "minLength": 1,
            "type": "string"
          },
          "step": {
            "minimum": 0,
            "type": "integer"
          }
        },
        "required": ["reasoning", "step"],
        "type": "object"
      },
      "maxItems": 200,
      "type": "array"
    },
    "conclusion": {
      "maxLength": 20000,
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "metadata": {
      "type": "object"
    },
    "outcome": {
      "enum": ["success", "fail"],
      "type": "string"
    },
    "query": {
      "maxLength": 20000,
      "type": "string"
    },
    "question": {
      "maxLength": 20000,
      "type": "string"
    },
    "reasoningId": {
      "type": "string"
    },
    "sensitivity": {
      "enum": ["public", "internal", "confidential", "restricted"],
      "type": "string"
    },
    "status": {
      "enum": ["active", "archived", "pruned", "quarantined", "golden"],
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "topicKey": {
      "maxLength": 200,
      "type": "string"
    },
    "topicKeyFilter": {
      "type": "string"
    }
  },
  "required": ["action"],
  "type": "object"
}
```

| Campo               | Descripción                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `action`            | resolve = busca en la caché de razonamientos; record = guarda una cadena con su resultado; feedback = califica una. |
| `agentId`           | Agente que razonó. Para create y record.                                                                            |
| `chain`             | Lista ordenada de {step, reasoning, conclusion?}. Obligatoria en create/record; patch la reemplaza.                 |
| `conclusion`        | Dónde terminó. Obligatorio para create y record; también patch.                                                     |
| `id`                | Obligatorio para get, patch y archive.                                                                              |
| `limit`             | Para list.                                                                                                          |
| `metadata`          | JSON libre. Para create y patch.                                                                                    |
| `outcome`           | success o fail. Para record y feedback (obligatorio).                                                               |
| `query`             | La pregunta que se busca. Obligatoria para resolve.                                                                 |
| `question`          | Obligatoria para create y record.                                                                                   |
| `reasoningId`       | Registro a calificar. Obligatorio para feedback.                                                                    |
| `sensitivity`       | En create y record (patch lo rechaza).                                                                              |
| `status`            | Para patch: el estado nuevo. Para list: un filtro.                                                                  |
| `targetWorkspaceId` | Escribe en este UUID de espacio de trabajo (requiere write/admin; IDs: memory_context). Solo action='create'.       |
| `topicKey`          | Agrupa registros de una misma pregunta. Para create, record, resolve.                                               |
| `topicKeyFilter`    | Para list: solo los registros con este topicKey.                                                                    |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{
  "name": "memory_reasoning",
  "arguments": {
    "action": "create",
    "question": "Should we use PostgreSQL or MongoDB for this use case?",
    "chain": [
      { "step": 1, "reasoning": "Need ACID transactions and relational joins" },
      { "step": 2, "reasoning": "Schema is stable and well-defined" }
    ],
    "conclusion": "PostgreSQL is the right choice"
  }
}
```

---

### memory_strategy

**Descripción:** gestiona estrategias reutilizables: heurísticas disparador→acción que el agente aplica cuando ocurre una condición disparadora. Usa `op` como discriminador (no `action`, que es un campo de contenido). Verbos de dominio §24: `store` guarda una estrategia nueva (alias de `create`); `recall` recupera estrategias relevantes o activas (alias de `list`); `rate` registra el resultado (éxito o fallo) de una estrategia para ajustar su worth.

**Esquema de entrada:**

<!-- input-schema:memory_strategy -->

```json
{
  "properties": {
    "action": {
      "maxLength": 20000,
      "type": "string"
    },
    "agentId": {
      "type": "string"
    },
    "context": {
      "maxLength": 20000,
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "limit": {
      "maximum": 200,
      "minimum": 1,
      "type": "integer"
    },
    "metadata": {
      "type": "object"
    },
    "op": {
      "enum": ["create", "get", "list", "patch", "archive", "store", "recall", "rate"],
      "type": "string"
    },
    "outcome": {
      "enum": ["success", "failure"],
      "type": "string"
    },
    "scopeRef": {
      "type": "string"
    },
    "sensitivity": {
      "enum": ["public", "internal", "confidential", "restricted"],
      "type": "string"
    },
    "status": {
      "enum": ["active", "superseded", "archived"],
      "type": "string"
    },
    "statusFilter": {
      "enum": ["active", "superseded", "archived"],
      "type": "string"
    },
    "supersedesId": {
      "type": "string"
    },
    "targetWorkspaceId": {
      "format": "uuid",
      "type": "string"
    },
    "trigger": {
      "maxLength": 20000,
      "type": "string"
    },
    "validAt": {
      "format": "date-time",
      "type": "string"
    },
    "validFrom": {
      "format": "date-time",
      "type": "string"
    },
    "validTo": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": ["op"],
  "type": "object"
}
```

| Campo               | Descripción                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `action`            | Obligatorio para create: la respuesta a ejecutar.                                                                 |
| `agentId`           | Agente dueño. Para create y store.                                                                                |
| `context`           | Cuándo aplica, en texto libre. Para create, store y patch.                                                        |
| `id`                | Obligatorio para get/patch/archive.                                                                               |
| `idempotencyKey`    | Clave de reintento: un reenvío devuelve el primer resultado.                                                      |
| `limit`             | Para list.                                                                                                        |
| `metadata`          | JSON libre. Para create, store y patch.                                                                           |
| `op`                | La operación que se va a realizar.                                                                                |
| `outcome`           | Para rate: success o failure.                                                                                     |
| `scopeRef`          | Proyecto, en create/store (patch lo rechaza); filtra list/recall.                                                 |
| `sensitivity`       | Solo en create/store (patch lo rechaza). Por defecto 'internal'.                                                  |
| `status`            | Para patch: el estado nuevo.                                                                                      |
| `statusFilter`      | Para list: solo las estrategias en este estado.                                                                   |
| `supersedesId`      | Estrategia que esta reemplaza (se cierra). Para create/store.                                                     |
| `targetWorkspaceId` | Escribe en este UUID de espacio de trabajo (requiere write/admin; IDs: memory_context). Solo op='create'/'store'. |
| `trigger`           | Obligatorio para create.                                                                                          |
| `validAt`           | Para list: solo estrategias vigentes en este instante.                                                            |
| `validFrom`         | Desde cuándo aplica. Para create y store.                                                                         |
| `validTo`           | Hasta cuándo aplica. Para patch.                                                                                  |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{
  "name": "memory_strategy",
  "arguments": {
    "op": "create",
    "trigger": "API returns 5xx three times in a row",
    "action": "Switch to exponential backoff with jitter; alert after 5 minutes",
    "context": "execution"
  }
}
```

---

### memory_self_edit

**Descripción:** edita tu propia memoria con `append`, `replace`, `strengthen`, `weaken`, `reflect` o `link`. Cuando `replace` apunta a un hecho, el servidor cierra la versión histórica, crea un sucesor con un ID nuevo y devuelve `replacementId`. El motivo es un contexto obligatorio de política, pero todavía no se persiste como una auditoría durable. `forget` no es una acción admitida aquí (el servidor la rechaza con 422); para invalidar un hecho o una estrategia usa `memory_forget`.

**Esquema de entrada:**

<!-- input-schema:memory_self_edit -->

```json
{
  "properties": {
    "action": {
      "enum": ["append", "replace", "strengthen", "weaken", "reflect", "link"],
      "type": "string"
    },
    "content": {
      "maxLength": 20000,
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string"
    },
    "reason": {
      "maxLength": 2000,
      "minLength": 1,
      "type": "string"
    },
    "sessionId": {
      "type": "string"
    },
    "target": {
      "minLength": 1,
      "type": "string"
    }
  },
  "required": ["action", "reason", "target"],
  "type": "object"
}
```

| Campo            | Descripción                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `action`         | append/replace el texto, strengthen/weaken el valor, reflect o link (hiperarista con los ids separados por comas en content). |
| `content`        | Texto nuevo (para append/replace).                                                                                            |
| `idempotencyKey` | Clave de reintento: un reenvío devuelve el primer resultado.                                                                  |
| `reason`         | Motivo obligatorio para evaluar la política de edición.                                                                       |
| `sessionId`      | De memory_session/episode_start: usa su presupuesto; si no, 5 ediciones/día.                                                  |
| `target`         | fact_id, "profile" o "strategy:{id}".                                                                                         |

<!-- /input-schema -->

**Llamada de ejemplo:**

```json
{
  "name": "memory_self_edit",
  "arguments": {
    "action": "replace",
    "target": "mfact_01j...",
    "content": "The user prefers dark mode in all applications",
    "reason": "Previous statement only mentioned VS Code; confirmed applies globally"
  }
}
```

**Devuelve:** un resultado estructurado de autoedición. Los reemplazos de hechos aplicados incluyen `targetKind: "fact"` y el nuevo `replacementId`, que es obligatorio. Los resultados que requieren aprobación no incluyen un ID de reemplazo. Devuelve `isError: true` con un mensaje descriptivo si falla.

---

## Licencia

Apache-2.0 © Lucas Mailland
