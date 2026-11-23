# Configuración de desarrollo local (solo Postgres, servidor como proceso)

[English](LOCAL_DEV_SETUP.md) · **Español**

Usa esta guía cuando `pnpm docker:up` falle o quieras un ciclo de desarrollo más
rápido sin construir imágenes de Docker. Ejecutas Postgres + Redis en contenedores
y el servidor como un proceso de Node local.

---

## Cuándo usar esta guía

`pnpm docker:up` construye desde cero las imágenes `server` y `migrate`. En
máquinas con pocos recursos (< 4 GB de RAM disponibles para Docker), la
compilación de TypeScript dentro del contenedor alcanza el límite del heap de Node
y falla con:

```
Error [ERR_WORKER_OUT_OF_MEMORY]: Worker terminated due to reaching memory limit
```

La solución alternativa es omitir la construcción con Docker para esos servicios y
ejecutarlos de forma nativa: los binarios ya están compilados en tus
`packages/*/dist/` locales.

---

## Requisitos previos

- Docker Desktop en ejecución (para Postgres + Redis)
- `pnpm install` ya ejecutado en la raíz del repositorio
- `pnpm build` ya ejecutado al menos una vez (genera `packages/*/dist/`)

### macOS — ruta del socket de Docker

Docker Desktop en macOS usa una ubicación de socket no estándar. Si obtienes:

```
Cannot connect to the Docker daemon at unix:///var/run/docker.sock
```

Establece el socket explícitamente en tu shell (o añádelo a `~/.zshrc`):

```bash
export DOCKER_HOST=unix://$HOME/.docker/run/docker.sock
```

Todos los comandos `docker` y `docker compose` de esta guía dan por hecho que eso
ya está establecido si usas macOS con Docker Desktop.

---

## Paso 1 — Inicia Postgres y Redis

El servidor necesita tanto Postgres como Redis. Inícialos juntos:

```bash
docker compose -f docker/docker-compose.yml up -d postgres redis
```

Verifica:

```bash
docker exec mnemosyne-postgres pg_isready -U mnemo -d mnemo
# mnemosyne-postgres:5432 - accepting connections

docker exec mnemosyne-redis redis-cli ping
# PONG
```

> **¿Por qué no solo `up -d postgres`?** El pipeline de sesiones, el limitador de
> tasa y la caché del servidor requieren Redis. Sin él, el servidor arranca pero
> algunas operaciones fallan.

---

## Paso 2 — Aplica las migraciones

```bash
DATABASE_URL=postgres://mnemo:mnemo@localhost:5432/mnemo \
  pnpm --filter @mnemo-ai/adapter-postgres migrate
```

Esto ejecuta el flujo de migraciones v3 y crea el esquema `mnemosyne`.
El comando es idempotente: es seguro volver a ejecutarlo.

---

## Paso 3 — Inicia el servidor

Dos flags de entorno obligatorios que la guía omitía anteriormente:

- **`MNEMO_ALLOW_UNSAFE_DB_ROLE=true`** — la imagen de Postgres incluida usa el
  usuario `mnemo` con `rolsuper=true`. El servidor bloquea por defecto las
  conexiones de superusuario para proteger RLS. Este flag suprime esa comprobación
  en desarrollo local; nunca lo establezcas en producción.
- **`MNEMO_EMBED_STUB=true`** — sin una clave de API de LLM, la recuperación
  semántica devuelve 501. Este flag hace que el servidor arranque limpiamente y
  use embeddings simulados. La recuperación vectorial completa no funcionará, pero
  todo lo demás sí.

```bash
DATABASE_URL=postgres://mnemo:mnemo@localhost:5432/mnemo \
  MNEMO_REDIS_URL=redis://localhost:6379 \
  MNEMO_ALLOW_UNSAFE_DB_ROLE=true \
  MNEMO_EMBED_STUB=true \
  PORT=3939 \
  LOG_LEVEL=info \
  node packages/server/dist/index.js >> /tmp/mnemosyne-server.log 2>&1 &
```

Si tienes una clave de API de LLM, añádela y quita `MNEMO_EMBED_STUB`:

```bash
DATABASE_URL=postgres://mnemo:mnemo@localhost:5432/mnemo \
  MNEMO_REDIS_URL=redis://localhost:6379 \
  MNEMO_ALLOW_UNSAFE_DB_ROLE=true \
  MNEMO_LLM_PROVIDER=openai \
  MNEMO_LLM_API_KEY=sk-... \
  PORT=3939 \
  LOG_LEVEL=info \
  node packages/server/dist/index.js >> /tmp/mnemosyne-server.log 2>&1 &
```

Verifica que esté en marcha:

```bash
curl http://localhost:3939/health/ready
# {"status":"ready","degraded":false,"checks":{"postgres":"ok","vector":"ok","cache":"ok"}}
```

> **Nota sobre `PORT`:** el servidor local usa por defecto `3939`. La pila
> completa de Docker usa `3000`. La configuración del cliente MCP debe coincidir
> con el puerto que uses.

---

## Configuración de proveedores

El servidor admite cinco variables de entorno opcionales para separar el proveedor
de completions del LLM del proveedor de embeddings, y para dirigir el tráfico
vectorial a una base de datos dedicada.

| Variable               | Propósito                                                                                                         | Valor alternativo                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_EMBED_PROVIDER` | Nombre del proveedor de embeddings (`voyage`, `nvidia`, `openai`, etc.)                                           | Recurre a `MNEMO_LLM_PROVIDER`                                                                                                    |
| `MNEMO_EMBED_API_KEY`  | Clave de API del proveedor de embeddings                                                                          | Obligatoria cuando se establece `MNEMO_EMBED_PROVIDER`; si falta, se registra una advertencia y se recurre a `MNEMO_LLM_PROVIDER` |
| `MNEMO_EMBED_BASE_URL` | URL base para endpoints de embeddings autoalojados (p. ej., una instancia local de Voyage o NVIDIA NIM)           | Sin valor por defecto; usa el endpoint estándar del proveedor                                                                     |
| `MNEMO_LLM_BASE_URL`   | URL base que sustituye la del LLM para completions (p. ej., Azure OpenAI, NVIDIA NIM, un proxy local)             | Sin valor por defecto; usa el endpoint estándar del proveedor                                                                     |
| `MNEMO_VECTOR_URL`     | Cadena de conexión de pgvector independiente para despliegues con una réplica de base de datos vectorial dedicada | Recurre a `DATABASE_URL`                                                                                                          |

Las cinco variables son opcionales. Quitarlas tras el despliegue restaura el
comportamiento anterior al cambio: no hay cambios de esquema ni transformaciones
de datos.

### Ejemplos

Usa Voyage AI para embeddings y OpenAI para completions:

```bash
MNEMO_LLM_PROVIDER=openai \
MNEMO_LLM_API_KEY=sk-... \
MNEMO_EMBED_PROVIDER=voyage \
MNEMO_EMBED_API_KEY=pa-... \
```

Usa un endpoint de NVIDIA NIM para embeddings (el alias nvidia corresponde a la API compatible con OpenAI):

```bash
MNEMO_EMBED_PROVIDER=nvidia \
MNEMO_EMBED_API_KEY=nvapi-... \
```

Sustituye el endpoint del LLM (p. ej., Azure OpenAI):

```bash
MNEMO_LLM_PROVIDER=openai \
MNEMO_LLM_API_KEY=<azure-key> \
MNEMO_LLM_BASE_URL=https://<your-resource>.openai.azure.com/openai/deployments/<deployment> \
```

Dirige el tráfico vectorial a una réplica dedicada:

```bash
MNEMO_VECTOR_URL=postgres://vector-user:pass@vector-host:5432/vectors \
```

> **Advertencia — desajuste de dimensión de los embeddings**: si cambias
> `MNEMO_EMBED_PROVIDER` en una base de datos existente, el modelo nuevo puede
> producir vectores de una dimensión distinta a la de los ya almacenados (p. ej.,
> al pasar de OpenAI con 1536 dimensiones a Voyage con 1024). La columna de
> pgvector se dimensiona al crearse. Las dimensiones que no coinciden provocan
> errores de inserción. Es responsabilidad del operador: reindexa todos los
> vectores tras cambiar de proveedor si las dimensiones difieren.

### Proveedor de completions por tarea

Cada completion del motor declara una de cuatro tareas. Tres de ellas pueden
usar su propio proveedor:

| Tarea       | Llamados del motor                                                          | Variables                                                                      |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `judge`     | clasificación de conflictos, rerank de recall, condiciones de recordatorios | `MNEMO_LLM_JUDGE_PROVIDER`, `MNEMO_LLM_JUDGE_MODEL`, `MNEMO_LLM_JUDGE_API_KEY` |
| `summary`   | colapso de sesiones, extracción de `POST /capture`, compresión              | `MNEMO_LLM_SUMMARY_PROVIDER`, `_MODEL`, `_API_KEY`                             |
| `prefilter` | consultas de HyDE y de anticipación, antes de recuperar                     | `MNEMO_LLM_PREFILTER_PROVIDER`, `_MODEL`, `_API_KEY`                           |
| `default`   | generación de consultas de replay, precalentamiento, chequeos de salud      | `MNEMO_LLM_PROVIDER`, `MNEMO_LLM_MODEL`, `MNEMO_LLM_API_KEY`                   |

Una tarea sin variables propias usa `MNEMO_LLM_PROVIDER`; sin ninguna de ellas
el servidor se comporta como antes. Sin `_PROVIDER`, la tarea usa el proveedor
por defecto y hereda su clave, `MNEMO_LLM_BASE_URL` y `MNEMO_LLM_MODEL`, salvo
que defina los suyos. Otro proveedor no hereda nada y necesita su `_API_KEY`
(salvo Ollama); sin ella el servidor no arranca, y tampoco cuando defines una
tarea sin `MNEMO_LLM_PROVIDER`. Sin `_MODEL`, otro proveedor usa su modelo por
defecto. `MNEMO_LLM_DAILY_BUDGET_USD` cuenta lo que gasta el proveedor de cada
tarea. Los embeddings siguen con su propio `MNEMO_EMBED_*`. Un workspace con su
propia configuración de LLM (`PUT /config/llm`) usa ese proveedor para todas
las tareas.

```bash
MNEMO_LLM_PROVIDER=openai \
MNEMO_LLM_API_KEY=sk-... \
MNEMO_LLM_JUDGE_PROVIDER=anthropic \
MNEMO_LLM_JUDGE_API_KEY=sk-ant-... \
MNEMO_LLM_PREFILTER_MODEL=gpt-4o-mini \
```

---

## Paso 4 — Crea una clave de API de desarrollo

Las claves de API se guardan con hash bcrypt en `mnemosyne.mnemo_api_keys`. El formato de la clave es:

```
mns_live_<20-64 lowercase alphanumeric chars, no underscores>
```

Con el stack de Docker, `docker compose exec server node scripts/create-api-key.cjs --label dev` genera una
(consulta [`docker/README.es.md`](../../docker/README.es.md)). Para un servidor que corres desde el código, este
fragmento de Node hace lo mismo:

```js
// generate-dev-key.mjs  (run once with: node generate-dev-key.mjs)
import bcrypt from "bcrypt";
import { createHmac, randomUUID } from "crypto";

const key = "mns_live_" + randomUUID().replace(/-/g, "").slice(0, 24);
const workspaceId = randomUUID();
const keyHash = bcrypt.hashSync(key, 10);
const lookupHash = createHmac("sha256", process.env.MNEMO_KEY_PEPPER ?? "")
  .update(key)
  .digest("hex");

console.log("KEY:         ", key);
console.log("WORKSPACE_ID:", workspaceId);
console.log(`
INSERT INTO mnemosyne.mnemo_api_keys
  (id, key_hash, workspace_id, name, lookup_hash, scopes, plan)
VALUES (
  'key_dev_local',
  '${keyHash}',
  '${workspaceId}',
  'dev-local',
  '${lookupHash}',
  ARRAY[
    'memory:read','memory:write','memory:delete','memory:admin',
    'memory:hard_delete','memory:session','memory:task','memory:event',
    'memory:self_edit','memory:procedural','memory:reasoning','memory:export',
    'memory:governance','memory:subscribe','memory:federation'
  ],
  'pro'
) ON CONFLICT DO NOTHING;
`);
```

La importación de bcrypt se resuelve desde el almacén de pnpm: ejecuta el
fragmento desde la raíz del repositorio, donde existe `node_modules/.pnpm/bcrypt*/`,
o ejecuta `pnpm add -D bcrypt` temporalmente si no se resuelve.

Inserta el SQL impreso:

```bash
docker exec mnemosyne-postgres psql -U mnemo -d mnemo -c "<paste SQL here>"
```

### Importante: `workspace_id` debe ser un UUID

La función de Postgres `mnemo_set_workspace` convierte el valor a `uuid`. Las
etiquetas de texto como `"personal"` o `"ws_default"` provocarán un error 500 en
cada solicitud autenticada:

```
invalid input syntax for type uuid: "personal"
```

Usa siempre `randomUUID()` o una cadena UUID válida como `workspace_id`.

---

## Paso 5 — Configura el cliente MCP

### CLI de Claude Code

```bash
claude mcp add mnemosyne \
  --scope user \
  -- node /path/to/mnemosyne/packages/mcp/dist/index.js
```

Luego establece las variables de entorno:

```bash
claude mcp update mnemosyne \
  --env MNEMO_URL=http://localhost:3939 \
  --env MNEMO_KEY=mns_live_<your key>
```

Verifica:

```bash
claude mcp get mnemosyne
# Status: ✔ Connected
```

### Claude Desktop

Edita `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "node",
      "args": ["/path/to/mnemosyne/packages/mcp/dist/index.js"],
      "env": {
        "MNEMO_URL": "http://localhost:3939",
        "MNEMO_KEY": "mns_live_<your key>"
      },
      "type": "stdio"
    }
  }
}
```

Reinicia Claude Desktop después de editar.

---

## Verificación de extremo a extremo

Cuando el servidor esté en marcha y la clave creada:

```bash
# Workspace health — scoped to the workspace_id that owns the key
curl -H "Authorization: Bearer mns_live_<your key>" \
  http://localhost:3939/health
# {"workspaceId":"<uuid>","factsLive":0,"factsClosed":0,...}

# Write a fact
curl -X POST http://localhost:3939/facts \
  -H "Authorization: Bearer mns_live_<your key>" \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"<uuid>","content":"test fact","kind":"other"}'

# Full-text search
curl -X POST http://localhost:3939/memory/search \
  -H "Authorization: Bearer mns_live_<your key>" \
  -H "Content-Type: application/json" \
  -d '{"query":"test","workspaceId":"<uuid>"}'
```

O invoca la herramienta MCP `memory_status` desde tu cliente de IA; debería devolver:

```json
{
  "workspaceId": "<your-uuid>",
  "factsLive": 0,
  "factsClosed": 0,
  "pinnedCount": 0,
  "lastRecallAt": null,
  "lastWriteAt": null,
  "embeddings": { "indexed": 0, "pending": 0 }
}
```

---

## Detención

```bash
# Kill the server process
kill $(lsof -ti :3939)

# Stop Postgres + Redis (preserves data)
docker compose -f docker/docker-compose.yml stop postgres redis

# Stop and wipe data
docker compose -f docker/docker-compose.yml down -v
```

---

## Solución de problemas

**`DATABASE_URL environment variable is required`**
El comando de migración necesita la variable de entorno establecida en línea o en
un archivo `.env` en la raíz del repositorio. Consulta el Paso 2.

**`[SECURITY] The database role has rolsuper=true — all RLS policies are bypassed`**
Añade `MNEMO_ALLOW_UNSAFE_DB_ROLE=true` al comando con el que lanzas el servidor.
El usuario `mnemo` de Postgres incluido es un superusuario; este flag es necesario
en desarrollo local. Consulta el Paso 3.

**`invalid input syntax for type uuid: "personal"` (500 en todas las solicitudes)**
Tu `workspace_id` no es un UUID. Consulta la nota del Paso 4.

**`API key scope insufficient: requires 'memory:read'` (403)**
La clave se insertó sin ese permiso. Actualízala:

```bash
docker exec mnemosyne-postgres psql -U mnemo -d mnemo -c \
  "UPDATE mnemosyne.mnemo_api_keys SET scopes = scopes || ARRAY['memory:read','memory:write'] WHERE id = 'key_dev_local';"
```

**La autenticación devuelve el resultado anterior (previo a la actualización) durante ~60 segundos**
El middleware de autenticación guarda en caché `{token → workspace}` durante 60 s
en un LRU. Tras actualizar el `workspace_id` o los `scopes` de una clave, espera
60 s o reinicia el servidor antes de probar.

**`Cannot connect to the Docker daemon` en macOS**
Docker Desktop usa un socket no estándar. Exporta
`DOCKER_HOST=unix://$HOME/.docker/run/docker.sock` y vuelve a intentarlo. Consulta
los Requisitos previos.

**MCP dice `Internal server error` aunque el servidor esté sano**
Comprueba que `MNEMO_KEY` no esté vacía y que coincida con el formato
`mns_live_<20+ alphanum, no underscores>`. Una `MNEMO_KEY` vacía hace que el
proceso MCP termine antes de conectarse, lo que en el cliente aparece como
`Internal server error`.
