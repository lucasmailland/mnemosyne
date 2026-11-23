# Mnemosyne — stack de Docker

[English](README.md) · **Español**

> **Alcance:** Dockerfiles + Compose para desarrollo local y producción autoalojada.
> Para las configuraciones específicas de cada plataforma (Railway, Fly.io, etc.), consulta [`deploy/`](../deploy/README.es.md).
> Para los runbooks del día 2 (monitoreo, copias de seguridad, actualizaciones), consulta [`docs/deploy/`](../docs/deploy/OPERATIONS.es.md).
> Punto de entrada: [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.es.md).

Un despliegue autoalojable de Mnemosyne con un solo comando: Postgres + pgvector + `@mnemo-ai/server`. Sirve para el desarrollo local y para despliegues pequeños en producción.

> Si solo quieres probar Mnemosyne, sigue el [Inicio rápido](#inicio-rápido).
> Si quieres entender las piezas, ve directo a la [Arquitectura](#arquitectura).

---

## Desarrollo local

Compose v2 fusiona automáticamente el archivo `docker-compose.override.yml` incluido en el repositorio
cuando ejecutas `docker compose up` desde el directorio `docker/`. Define las
banderas de modo desarrollo para que el servidor arranque sin clave maestra y sin un rol de
base de datos que no sea superusuario. No elige una API de modelos: el servidor funciona con el
proveedor que pongas en `.env` (consulta [Elige una API de modelos](#elige-una-api-de-modelos)).

`.env` NO se incluye en el repositorio (el `.gitignore` del repositorio lo excluye). Créalo a partir de
`.env.example`; es el que define `PORT=3939`, de modo que el servidor se asigna a
`http://localhost:3939` (así evitas conflictos con otros servicios en `:3000`).

No hacen falta banderas `-f`: Compose v2 toma `docker-compose.override.yml`
automáticamente.

Si en tu máquina ya están ocupados `5432` o `6379`, define `POSTGRES_PORT` /
`REDIS_PORT` en `.env` en lugar de editar el archivo de compose.

---

## Inicio rápido

```bash
cd docker
cp .env.example .env
$EDITOR .env    # uncomment one model block and paste its key
docker compose up -d --build
```

### Elige una API de modelos

Mnemosyne no trae un modelo por defecto. `.env.example` tiene bloques listos; descomenta uno:

| Bloque | Completados                                   | Embeddings                      | Claves                       |
| ------ | --------------------------------------------- | ------------------------------- | ---------------------------- |
| A      | OpenAI `gpt-4o-mini`                          | OpenAI `text-embedding-3-small` | una clave de OpenAI          |
| B      | Google `gemini-2.5-flash`                     | `bge-m3` local (bloque D)       | una clave de Gemini          |
| C      | Anthropic `claude-haiku-4-5`                  | Voyage `voyage-3.5`             | claves de Anthropic y Voyage |
| D      | Ollama local, el modelo que elijas (opcional) | `bge-m3` local                  | ninguna                      |

Anthropic no tiene API de embeddings; por eso el bloque C usa Voyage. Los modelos de
embeddings de Gemini devuelven 768 o 3072 dimensiones, anchos para los que el esquema no tiene
tabla; por eso el bloque B usa `bge-m3`. Cohere, Mistral y Bedrock funcionan igual con
`MNEMO_LLM_PROVIDER` / `MNEMO_LLM_API_KEY` / `MNEMO_LLM_MODEL`; define el modelo
siempre, porque si no el archivo de compose pasa `gpt-4o-mini` sea cual sea el proveedor.

**Sin ningún proveedor** el servidor arranca igual. Su registro dice qué falta
(`llm.no_completion_provider`, `embed.no_provider`), `/health/ready` informa
`"embed":"degraded"`, el recall cae a la búsqueda de texto completo y una escritura sin un
`vector` precalculado responde 501 hasta que configures un proveedor de embeddings. Los
completados son opcionales: con embeddings y sin modelo de completados, las escrituras y el
recall semántico funcionan, mientras que el colapso de sesión, la detección de conflictos y el
rerank quedan apagados.

### Modelos locales (opcionales)

El servicio Ollama incluido arranca solo con el perfil `local`, y no se descarga ni se elige
nada por ti:

```bash
docker compose --profile local up -d --build
docker exec mnemosyne-ollama ollama pull bge-m3    # embeddings, 1024 dims, MIT licence
```

Después descomenta el bloque D en `.env` y vuelve a correr `docker compose --profile local up -d`.
`bge-m3` es el modelo de embeddings local sugerido: tiene licencia MIT y, en un corpus bilingüe,
encontró hechos en inglés desde consultas en español donde `mxbai-embed-large` no lo logró. El
bloque D también trae su ajuste: 1024 dimensiones, `MNEMO_REMINDER_SEMANTIC_THRESHOLD=0.55`, un
tiempo límite de 10 segundos por embedding, 4 hilos de Ollama (con más, cada embedding era más
lento dentro de Docker) y precarga al arrancar.

Un modelo de completados local es decisión tuya, y su licencia también: revisa que se ajuste a
tu uso antes de descargarlo. `qwen2.5:3b`, el modelo que este stack elegía antes, tiene la Qwen
Research License, que no permite el uso comercial.

> **No elijas el modelo de completados solo por su tamaño.** No solo
> responde preguntas: el colapso de sesión le entrega una conversación y
> escribe lo que devuelva en `mnemo_fact` / `mnemo_decision`, donde se
> vectoriza, se indexa y se sirve a futuras recuperaciones como conocimiento.
> `qwen2.5:0.5b` devolvió dos decisiones con el mismo título a partir de una
> sola sesión, cuerpos sin contenido y, en una ejecución, un enunciado que afirmaba lo
> contrario de la conversación de la que provenía. Un modelo demasiado pequeño para extraer
> no falla de forma ruidosa: escribe en silencio cosas incorrectas y duraderas. Además, el
> colapso tiene que terminar dentro del circuit breaker de 30 segundos de `llm.generate`.

El servidor ya está en marcha en `http://localhost:3939`. Comprobación de estado:

```bash
curl http://localhost:3939/health/live
# -> {"status":"alive","pid":1}

curl http://localhost:3939/health/ready
# -> {"status":"ready","degraded":false,
#     "checks":{"postgres":"ok","vector":"ok","cache":"ok","embed":"ok"}}
```

### Genera tu primera clave de API

La primera clave tiene que salir del terminal: la API HTTP no puede generarla,
porque todas las rutas que podrían hacerlo están a su vez autenticadas:

```bash
docker compose exec server node scripts/create-api-key.cjs --label "my laptop"
# -> mns_live_a3f9k2x...    (this is printed exactly once — copy it now)
```

`--workspace` es opcional; si lo omites, se genera un UUID nuevo de espacio de trabajo. Si
lo pasas, debe ser un **UUID**: el runtime v3 convierte `workspace_id` a
`::uuid`, así que un nombre como `ws_default` lo rechaza el script en lugar de
producir errores HTTP 500 más adelante.

> La página del navegador en `http://localhost:3939/setup` NO es una vía de arranque en una
> instancia virgen: `POST /setup` requiere un token bearer, y `POST /bootstrap`
> adopta una clave que ya tienes en lugar de emitir una. Genera primero
> la clave anterior; `GET /bootstrap/status` informa `{"bootstrapped":false}` hasta que lo hagas.
>
> `POST /bootstrap` (y la página de primer uso del dashboard, que lo llama) necesita
> el **token de configuración**: el servidor lo imprime en su registro cuando arranca sin
> claves (`docker compose logs server | grep setup`) y vale 15
> minutos. Nunca se sirve por la red: `GET /setup/token` responde solo
> al loopback del propio servidor
> (`docker compose exec server wget -qO- http://localhost:3939/setup/token`).
> Para un aprovisionamiento desatendido define `MNEMO_SETUP_TOKEN` (16 caracteres o más)
> y envía ese valor; deja de importar cuando existe la primera clave.

Úsala con cURL. Las escrituras van a `/remember` (no existe `POST /facts`: `/facts`
es la ruta de lectura y listado), y el campo es `statement`, no `content`:

```bash
curl -X POST http://localhost:3939/remember \
  -H "Authorization: Bearer mns_live_a3f9k2x..." \
  -H "Content-Type: application/json" \
  -d '{"statement": "The team prefers Postgres over MongoDB.", "kind": "fact"}'

curl -X POST http://localhost:3939/recall \
  -H "Authorization: Bearer mns_live_a3f9k2x..." \
  -H "Content-Type: application/json" \
  -d '{"query": "which database does the team prefer", "topK": 5}'
```

La lista completa de rutas se sirve en `GET /openapi.json` (autenticado).

### Accede al panel web

Abre `http://localhost:3939/dashboard` en tu navegador. Pega tu clave de API (`mns_live_...`) en la puerta de API Key para iniciar sesión y supervisar el estado, las métricas y la configuración del LLM, y para gestionar las claves de API. Esta es la página de operación mínima que sirve el propio servidor.

El dashboard completo en Next.js (memorias, sesiones, grafo, miembros) inicia sesión a través del servidor, que solo monta esas rutas cuando `MNEMO_DASHBOARD_SECRET` está definido (al menos 32 bytes; `openssl rand -hex 32`). Agrégalo a `.env`, vuelve a correr `docker compose up -d --build` (reconstruye las imágenes después de un `git pull`) y levanta el dashboard como muestra el [README principal](../README.es.md#abrir-el-dashboard). El override local ya permite que su cookie viaje por `http://localhost` sin HTTPS.

Con el bloque D, después de descargar `bge-m3` espera a que `/health/ready` informe `"embed":"ok"` antes del primer recall.

---

## Arquitectura

Cinco servicios orquestados por `docker-compose.yml`:

| Servicio   | Imagen                                | Propósito                                                                                            |
| ---------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `postgres` | `pgvector/pgvector:pg17`              | Almacenamiento + búsqueda vectorial. El volumen `mnemosyne-pgdata` conserva los datos.               |
| `redis`    | `redis:7-alpine`                      | Operaciones de sesión y episodio, y la capa caliente ACT-R. El servidor espera a que esté saludable. |
| `migrate`  | construida desde `Dockerfile.migrate` | Ejecuta ambos flujos de migración una vez y termina. El servidor espera el código de salida 0.       |
| `server`   | construida desde `Dockerfile.server`  | La API HTTP de `@mnemo-ai/server`. Expone `PORT` (por defecto `:3939`).                              |
| `ollama`   | `ollama/ollama:latest`                | Modelos locales opcionales (`--profile local`). Viven en `mnemosyne-ollama-data`.                    |

¿Por qué separar `migrate` de `server`? Consulta los comentarios al inicio de
`docker-compose.yml`. La versión corta: las migraciones fallidas deben verse en
`docker compose ps`, no quedar ocultas dentro de un servidor que se reinicia en bucle.

### ¿Por qué `pgvector/pgvector:pg17` y no `postgres:17`?

Mnemosyne guarda los embeddings como columnas `vector(N)`. La imagen de pgvector incluye
la extensión preinstalada; con Postgres estándar habría que crear un Dockerfile propio.

---

## Aprovisionamiento de roles (producción)

El contenedor `migrate` crea automáticamente un rol de inicio de sesión de PostgreSQL
NOSUPERUSER/NOBYPASSRLS cuando terminan las migraciones. Con este rol se conecta el servidor en
producción: no puede omitir las políticas de seguridad a nivel de fila, de modo que el aislamiento
entre espacios de trabajo se aplica en la capa de la base de datos.

**Secreto obligatorio:**

```bash
# Set before first deploy:
export MNEMO_APP_DB_PASSWORD="$(openssl rand -base64 32)"
export MNEMO_MIGRATION_DATABASE_URL="postgres://admin:<password>@postgres:5432/mnemo"
```

`MNEMO_MIGRATION_DATABASE_URL` debe apuntar directamente a PostgreSQL o a un
pool en modo de sesión. El pooling en modo de transacción es incompatible con el bloqueo
asesor de sesión del ejecutor de migraciones. El entrypoint de producción nunca recurre a
la `DATABASE_URL` del servidor y rechaza el nombre de host conocido del servicio `pgbouncer`.
Una URL no puede demostrar el modo de pool de un proveedor, así que los despliegues que usen otro pooler
deben seguir seleccionando de forma explícita su endpoint directo o de pool en modo de sesión.

El servicio `migrate` lee `MNEMO_APP_DB_PASSWORD` y crea el rol `mnemo_app` (o
`$MNEMO_APP_DB_USER` si se sobrescribe) con permisos sobre `mnemo_app_role`, `app_user`
y `app_org_user`. Entonces, la `DATABASE_URL_PROD` del servidor debe apuntar a este rol:

```
DATABASE_URL_PROD=postgres://mnemo_app:<MNEMO_APP_DB_PASSWORD>@pgbouncer:5435/mnemo
```

También define los valores de sesión del rol en esa base (`search_path` y los límites
`MNEMO_PG_*_TIMEOUT_MS`, 60 s / 15 s / 60 s salvo que se definan en `.env`, que el overlay de
producción pasa al servicio `migrate` y al servidor).
El servidor envía esos mismos valores como parámetros de inicio; el pgBouncer del overlay de
producción los descarta (no puede llevarlos a las sesiones del pool), así que detrás de él la
sesión los toma del rol.

El servidor rechaza las conexiones de superusuario al arrancar (`assertSafeDbRole` en
`packages/core/src/factory.ts`). Si el rol está mal configurado, el servidor termina
con un mensaje de error claro.

**Desarrollo local:** define `MNEMO_ALLOW_UNSAFE_DB_ROLE=true` (el
`docker-compose.override.yml` incluido ya lo hace). El contenedor `migrate` omite el aprovisionamiento
del rol cuando `MNEMO_APP_DB_PASSWORD` no está definida, así que el servidor se conecta como el
superusuario `mnemo` con la protección suprimida. El override también define
`NODE_ENV=development`: con `NODE_ENV=production` (el valor por defecto de la imagen) el servidor
se niega a arrancar mientras `MNEMO_ALLOW_UNSAFE_DB_ROLE` o `MNEMO_DASHBOARD_INSECURE_COOKIE`
valga `true`.

---

## Configuración

Todos los ajustes están en `.env`. Consulta `.env.example` para ver la lista completa con comentarios.
Los que de verdad vas a cambiar:

| Variable                            | Valor por defecto                            | Notas                                                                                                                |
| ----------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_LLM_PROVIDER`                | _(sin definir)_                              | `openai` \| `anthropic` \| `google` \| `cohere` \| `mistral` \| `voyage` \| `bedrock` \| `ollama`                    |
| `MNEMO_LLM_API_KEY`                 | _(sin definir)_                              | Todo proveedor salvo `ollama`. Sin definir, el servidor arranca y registra qué falta.                                |
| `MNEMO_EMBED_PROVIDER`              | _(sin definir → `MNEMO_LLM_PROVIDER`)_       | Un segundo proveedor para los embeddings (Voyage, Ollama, ...), con `MNEMO_EMBED_API_KEY`.                           |
| `MNEMO_EMBED_MODEL`                 | `text-embedding-3-small`                     | Cambiarlo exige volver a vectorizar los recuerdos existentes y volver a revisar los umbrales de abajo.               |
| `MNEMO_EMBED_DIMENSIONS`            | _(sin definir → 1536, 1024 en Bedrock)_      | El ancho real del modelo: 1024, 1536, 2048 o 4096.                                                                   |
| `MNEMO_REMINDER_SEMANTIC_THRESHOLD` | _(sin definir → 0.7)_                        | Umbral de coseno del disparador semántico de un recordatorio. Pertenece al MODELO DE EMBEDDINGS; consulta más abajo. |
| `DATABASE_URL`                      | `postgres://mnemo:mnemo@postgres:5432/mnemo` | Apunta a un Postgres externo si no quieres el incluido (debe tener pgvector).                                        |
| `PORT`                              | `3939`                                       | El servidor escucha aquí; compose lo reenvía al host.                                                                |

### Cambiar el modelo de embeddings cambia más que los vectores

Con el modelo viajan dos cosas, y solo la primera es evidente.

**La dimensión** debe ser una de las que declara el esquema: 1024, 1536, 2048 o 4096.
`mnemo_fact.embedding` es un `halfvec` sin restricciones, así que cualquier ancho se acepta al
escribir, mientras que `DELETE /facts/:id` devuelve 500 para siempre. nomic-embed-text (768) hizo
exactamente eso; consulta P117.

**La escala del coseno** es específica de cada modelo, y todo umbral de similitud fijo en el código
está calibrado con una escala. bge-m3 queda ~0.16 por debajo de mxbai-embed-large con los
mismos pares, lo que basta para dejar un recordatorio que debería dispararse (0.6334) por debajo del
umbral por defecto de 0.7. Nada lanza un error cuando eso ocurre: el recordatorio simplemente deja de
dispararse, y un recordatorio que nunca se dispara es indistinguible de uno sin
nada con lo que coincidir. `MNEMO_REMINDER_SEMANTIC_THRESHOLD` existe para que el umbral pueda
definirse junto con el modelo: el bloque D de `.env.example` combina `bge-m3` con `0.55`.

La nueva vectorización es automática: `listStaleEmbeddings` selecciona las filas cuyo
`embedding_model` difiere del configurado, y el cron `mnemo.embed.migration`
(06:45 UTC) las procesa. Mientras haya filas con el modelo anterior, la recuperación
reasigna el peso hacia el texto completo (0.7 FTS / 0.3 vectorial) en lugar de comparar vectores
entre modelos.

---

## Operaciones comunes

```bash
# Tail logs
docker compose logs -f server

# Re-run migrations (e.g. after upgrading the server image)
docker compose run --rm migrate

# Rebuild after pulling new source
docker compose build --no-cache server

# Open a psql shell
docker compose exec postgres psql -U mnemo -d mnemo

# Stop everything (preserves data)
docker compose down

# Stop and wipe data (DESTRUCTIVE)
docker compose down -v
```

---

## Uso de un Postgres externo

Omite el servicio `postgres` incluido y apunta `DATABASE_URL` a tu propia
instancia, pero asegúrate de que la extensión `vector` esté instalada:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Después puedes ejecutar solo el servidor + migrate:

```bash
docker compose up -d --build migrate server
```

---

## Notas de producción

- **La terminación de TLS** no la gestiona este stack. Pon un proxy inverso
  (Caddy, nginx, Traefik) delante de `:3939` (o del valor que tenga `PORT`).
- **Exposición de Postgres**: el `docker-compose.yml` por defecto publica
  `5432:5432` por comodidad. El overlay de producción publica Postgres, Redis, pgBouncer,
  Ollama (solo con `--profile local`) y el colector solo en `127.0.0.1` y exige `POSTGRES_PASSWORD`.
- **Copias de seguridad**: el volumen con nombre `mnemosyne-pgdata` es tu fuente de verdad.
  Usa `pg_dump` de forma programada.
- **Varias instancias**: el servidor no guarda estado; puedes escalarlo horizontalmente
  detrás de un balanceador de carga siempre que todas las réplicas apunten al mismo Postgres.
- **Panel web**: `docker-compose.prod.yml` también compila y ejecuta el panel de
  Next.js. Necesita `MNEMO_DASHBOARD_SECRET` en el servidor, HTTPS y un proxy de
  borde que le envíe `/dashboard/*`; consulta
  [`docs/guides/PRODUCTION_DEPLOY.md`](../docs/guides/PRODUCTION_DEPLOY.es.md).

---

## Solución de problemas

**`migrate` termina con `relation "vector" does not exist`** → Estás apuntando
a un Postgres sin pgvector. Instala la extensión o usa la imagen incluida.

**Falla la comprobación de estado de `server`** → `docker compose logs server`. Que falte la
API de modelos no detiene el servidor (registra `llm.no_completion_provider` /
`embed.no_provider` y sigue en marcha); un ajuste mal escrito sí, y el registro lo nombra
(por ejemplo, `MNEMO_EMBED_DIMENSIONS` fuera de 1024/1536/2048/4096).

**`/health/ready` dice `"embed":"down"` o las escrituras responden `embeddingDeferred`**
→ el proveedor de embeddings está configurado pero no responde: una clave incorrecta, un modelo
que Ollama no descargó o el bloque D sin `--profile local`.

**El puerto 5432 ya está en uso** → Detén el Postgres de tu host o define
`POSTGRES_PORT=5433` en `.env`.
