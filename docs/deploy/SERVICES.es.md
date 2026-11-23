# Mnemosyne: referencia de despliegue de servicios

[English](SERVICES.md) · **Español**

> Qué se ejecuta, cómo se conecta y qué define cada archivo de despliegue. Cada afirmación sale
> de los archivos que nombra: los compose de `docker/`, `docker/Dockerfile.server`, `fly.toml`,
> `deploy/railway.json`, `.github/workflows/deploy-canary.yml` y el código del servidor en
> `packages/server/src`. Guías paso a paso: `docs/guides/PRODUCTION_DEPLOY.es.md` y
> `docker/README.es.md`.

---

## 1. El proceso del servidor

El servidor es un único proceso de Node, `node /app/dist/index.js`, construido por
`docker/Dockerfile.server` (Node 22 Alpine, se ejecuta como el usuario `node`). Abre un
listener HTTP/1.1 en `PORT` y sirve todo en él (`packages/server/src/index.ts`):

- La API REST (Hono), incluidas las sondas y `/metrics` (sección 7).
- ConnectRPC: una petición cuya ruta empieza por `/mnemosyne.v1.MnemosyneService/` va al
  handler de Connect (`packages/server/src/grpc.ts`).
- Suscripciones por WebSocket: el upgrade en `GET /memory/ws` (`packages/server/src/ws.ts`).

HTTP/1.1 transporta Connect y gRPC-Web, pero no un stream bidireccional: una llamada a `Session`
o `FederationSync` en `PORT` falla con HTTP 505. Con `MNEMO_GRPC_PORT` definida, el servidor abre
además un listener HTTP/2 en claro (h2c) en ese puerto que sirve solo el handler de Connect, con
los mismos interceptores y la misma autenticación: todos los RPC, incluidos los dos
bidireccionales, en los protocolos gRPC, gRPC-Web y Connect. No tiene TLS propio; pon delante un
proxy que termine TLS y reenvíe HTTP/2, como con `PORT`. Sin definir (por defecto), solo escucha
`PORT`. Un valor que no sea un puerto, o que sea igual a `PORT`, hace que el servidor no arranque. En este puerto, las cabeceras de IP del cliente (`X-Forwarded-For`, `X-Real-IP`,
`CF-Connecting-IP`) que lee la lista de IPs permitidas de cada clave solo cuentan en una conexión
que viene de `MNEMO_TRUSTED_PROXY_IP`; en cualquier otra, el servidor las reemplaza por la
dirección del socket.

Este proceso no sirve MCP. `@mnemo-ai/mcp` es un proceso stdio aparte que arranca cada cliente
MCP; llama a la API REST en `MNEMO_URL` con `MNEMO_KEY`.

`PORT` depende de dónde se ejecute el servidor:

| Dónde                        | `PORT`                                                                   |
| ---------------------------- | ------------------------------------------------------------------------ |
| Valor por defecto del código | `3939`                                                                   |
| `docker/Dockerfile.server`   | `3000` (`ENV PORT=3000`, `EXPOSE 3000`)                                  |
| `docker-compose.yml`         | `${PORT:-3939}`, publicado en el mismo puerto del host                   |
| `docker-compose.prod.yml`    | `3000` en el contenedor, publicado en el puerto del host `${PORT:-3000}` |
| `fly.toml`                   | `3000` (`internal_port = 3000`)                                          |

`MNEMO_GRPC_PORT` no tiene valor por defecto en ningún sitio. Los archivos de compose se la pasan
al contenedor y traen comentada una línea de `ports` para publicarla.

Qué necesita:

- **PostgreSQL con pgvector** (`DATABASE_URL`). Sin él, el servidor registra
  `DATABASE_URL is not set. Refusing to start.` y termina.
- **Redis** (`MNEMO_REDIS_URL`). Opcional en desarrollo. Con `NODE_ENV=production` el servidor
  no arranca sin él: los límites RBAC por agente cuentan con Redis y, si no, quedarían
  abiertos.
- **Un proveedor de completado y de embeddings** (`MNEMO_LLM_*`, `MNEMO_EMBED_*`, sección 4).

El servidor no ejecuta migraciones. `docker/scripts/run-migrations.mjs` aplica los flujos v2 y
v3 y después crea el rol de inicio de sesión `mnemo_app`. Solo lee
`MNEMO_MIGRATION_DATABASE_URL` (nunca `DATABASE_URL`) y es el comando de la imagen
`docker/Dockerfile.migrate`; la imagen del servidor también lo incluye, en
`/app/scripts/run-migrations.mjs`.

---

## 2. Destinos de despliegue

### 2.1 Docker Compose: `docker-compose.yml`

El stack base, desde `docker/`:

```bash
docker compose up -d
```

| Servicio   | Imagen / build              | Puerto del host          | Notas                                                                               |
| ---------- | --------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `redis`    | `redis:7-alpine`            | `${REDIS_PORT:-6379}`    | Sin contraseña                                                                      |
| `postgres` | `pgvector/pgvector:pg17`    | `${POSTGRES_PORT:-5432}` | Volumen con nombre `mnemosyne-pgdata`; parámetros de ajuste en la sección 3.3       |
| `migrate`  | `docker/Dockerfile.migrate` | —                        | Se ejecuta una vez cuando `postgres` está sano; `restart: "no"`                     |
| `server`   | `docker/Dockerfile.server`  | `${PORT:-3939}`          | Arranca cuando `migrate` termina con 0; healthcheck con `wget` sobre `/health/live` |
| `ollama`   | `ollama/ollama:latest`      | `${OLLAMA_PORT:-11434}`  | Volumen con nombre `mnemosyne-ollama-data`; bloque de GPU comentado                 |

Los valores por defecto (`mnemo`/`mnemo`/`mnemo`, `MNEMO_LLM_PROVIDER=openai`,
`MNEMO_LLM_MODEL=gpt-4o-mini`, `MNEMO_EMBED_MODEL=text-embedding-3-small`) salen del archivo;
`docker/.env.example` lista todas las variables que el servicio `server` deja pasar.

### 2.2 Ajustes locales: `docker-compose.override.yml`

Compose combina este archivo de forma automática cuando lo ejecutas desde `docker/`. Es para un
stack local de un solo espacio de trabajo y no debe llegar a producción: define
`NODE_ENV=development`, `MNEMO_ALLOW_UNSAFE_DB_ROLE=true`, `MNEMO_REQUIRE_RBAC_LIMITS=false`,
`MNEMO_ALLOW_LEGACY_FULL_SCOPE=true` y `MNEMO_DASHBOARD_INSECURE_COOKIE=true`. No elige modelo:
el proveedor sale de `docker/.env`, y el servicio `ollama` corre solo con `--profile local`.

### 2.3 Capa de producción: `docker-compose.prod.yml`

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Qué cambia o agrega:

- **`migrate`** necesita `MNEMO_MIGRATION_DATABASE_URL` (directo a Postgres) y
  `MNEMO_APP_DB_PASSWORD`, y crea el rol `MNEMO_APP_DB_USER` (`mnemo_app` por defecto) con los
  límites de sesión `MNEMO_PG_*_TIMEOUT_MS`.
- **`postgres`**, **`redis`** y **`ollama`** se publican solo en `127.0.0.1`; `postgres`
  necesita `POSTGRES_PASSWORD` y `redis` necesita `REDIS_PASSWORD`.
- **`pgbouncer`** (`edoburu/pgbouncer:v1.26.1-p0`, puerto `5435` en loopback) agrupa las
  conexiones del rol de la aplicación en modo transacción (sección 3.3).
- **`redis-master`** más **`redis-replica-1`** y **`redis-replica-2`** (`redis:7.4-alpine`).
  El servidor solo usa el maestro. No hay Sentinel: el cliente de Redis del servidor se conecta
  a una sola URL, así que la conmutación es manual (promueve una réplica con
  `REPLICAOF NO ONE` y apunta `MNEMO_REDIS_URL_PROD` a ella).
- **`server`** escucha en `3000`, usa `DATABASE_URL_PROD` (a través de pgBouncer) y
  `MNEMO_REDIS_URL_PROD`, y necesita `MNEMO_MASTER_KEY`, `MNEMO_KEY_PEPPER` y
  `MNEMO_DASHBOARD_SECRET`. `MNEMO_SERVER_REPLICAS` fija la cantidad de réplicas (1 por
  defecto); con `docker compose` a secas cada réplica necesita su propio puerto del host, así
  que define `PORT` como un rango. `stop_grace_period` es de 60 s.
- **`dashboard`** (`docker/Dockerfile.dashboard`, puerto de loopback
  `${MNEMO_DASHBOARD_PORT:-3300}`) habla con `http://server:3000`.
- **`otel-collector`** (`otel/opentelemetry-collector-contrib:0.127.0`) en los puertos de
  loopback `4317`, `4318` y `8888`; el servidor exporta a `http://otel-collector:4318`.

Los límites de `deploy.resources` de este archivo solo se aplican con Docker Swarm
(`docker stack`); `docker compose` a secas los trata como orientativos.

### 2.4 Capa de observabilidad: `docker-compose.observability.yml`

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

| Servicio         | Imagen                                             | Puerto del host            |
| ---------------- | -------------------------------------------------- | -------------------------- |
| `prometheus`     | `prom/prometheus:v3.4.1` (retención de 30 d)       | `${PROMETHEUS_PORT:-9090}` |
| `tempo`          | `grafana/tempo:2.7.2`                              | `${TEMPO_PORT:-3200}`      |
| `loki`           | `grafana/loki:3.5.0`                               | `${LOKI_PORT:-3100}`       |
| `promtail`       | `grafana/promtail:3.5.0` (lee el socket de Docker) | —                          |
| `grafana`        | `grafana/grafana:11.6.1`                           | `${GRAFANA_PORT:-3001}`    |
| `otel-collector` | `otel/opentelemetry-collector-contrib:0.127.0`     | `4317`, `4318`, `8888`     |

Su configuración vive en `docker/scripts/` (`prometheus.yml`, `prometheus-rules.yml`,
`tempo.yml`, `loki.yml`, `promtail.yml`, `otel-collector.yml`, las fuentes de datos y los
paneles de Grafana). Los servicios se unen a la red externa `mnemosyne_default`. Ninguno está
endurecido para internet; el inicio de sesión de Grafana es `admin`/`admin` por defecto.

### 2.5 Fly.io: `fly.toml`

La misma imagen `docker/Dockerfile.server`, desplegada con `fly deploy`:

- `PORT=3000`, `NODE_ENV=production`, `LOG_LEVEL=info`.
- `[http_service]`: `internal_port = 3000`, `force_https`, `auto_stop_machines = false`,
  `auto_start_machines = true`, `min_machines_running = 2`, concurrencia de peticiones 500
  blanda / 1000 dura.
- Comprobaciones: `GET /health/live` cada 10 s y `GET /health/ready` cada 30 s.
- VM: `shared-cpu-2x` con 1 GB.
- `[deploy]`: estrategia rolling, `kill_timeout = "60s"` y
  `release_command = "node /app/scripts/run-migrations.mjs"`, que se ejecuta una vez por
  despliegue antes de actualizar cualquier máquina.
- Sin sección `[metrics]`: recoge `/metrics/prometheus` desde tu propio Prometheus con
  `MNEMO_METRICS_TOKEN`.

Los secretos que hay que definir antes del primer despliegue están al principio de `fly.toml`.

### 2.6 Railway: `deploy/railway.json`

Construye `docker/Dockerfile.server`, ejecuta `node /app/scripts/run-migrations.mjs` como
`preDeployCommand`, arranca `node /app/dist/index.js` y comprueba `/health/ready` (30 s de
tiempo de espera, reinicio ante fallo hasta 5 veces).

### 2.7 Kubernetes

El repositorio no tiene chart de Helm, overlay de Kustomize ni manifiestos de Kubernetes.

---

## 3. Postgres y los pools de conexiones

### 3.1 Pool principal

El pool del adaptador de almacenamiento sale de `makePoolConfigFromEnv`
(`packages/adapter-postgres/src/pool-config.ts`), sobre postgres.js:

| Variable                   | Por defecto                     | Descripción                                                                                                    |
| -------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `MNEMO_PG_POOL_MAX`        | según `MNEMO_DEPLOY_MODE`, o 10 | Máximo de conexiones                                                                                           |
| `MNEMO_DEPLOY_MODE`        | —                               | Solo fija el valor por defecto de `MNEMO_PG_POOL_MAX`: `embedded` 5, `standalone` 10, `ha` 20                  |
| `MNEMO_PG_IDLE_TIMEOUT`    | `20`                            | Cierra una conexión inactiva durante esta cantidad de segundos                                                 |
| `MNEMO_PG_MAX_LIFETIME`    | `1800`                          | Recicla una conexión después de esta cantidad de segundos                                                      |
| `MNEMO_PG_CONNECT_TIMEOUT` | `10`                            | Deja de intentar conectar después de esta cantidad de segundos                                                 |
| `DATABASE_REPLICA_URL`     | —                               | Réplica de lectura. Si se define, los repositorios de almacenamiento leen de ella y escriben en `DATABASE_URL` |

Cada conexión lleva además `search_path=mnemosyne,public` y tres límites de sesión
(`packages/types/src/pg-session.ts`), en milisegundos, donde `0` deja el límite al rol o al
servidor:

| Variable                                  | Por defecto |
| ----------------------------------------- | ----------- |
| `MNEMO_PG_STATEMENT_TIMEOUT_MS`           | `60000`     |
| `MNEMO_PG_LOCK_TIMEOUT_MS`                | `15000`     |
| `MNEMO_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `60000`     |

Un valor que no sea un número entero, o un tiempo de espera de bloqueo que no sea menor que el
de la sentencia, detiene el arranque.

### 3.2 Pools secundarios

El almacén de claves de API, el almacén de RBAC, el almacén de idempotencia, el worker del
outbox, la federación y la consolidación abren cada uno su propio pool mediante
`createDrizzleClient` (`packages/adapter-postgres/src/DrizzleStorageAdapter.ts`). Esos pools
leen:

| Variable                     | Por defecto | Descripción                                      |
| ---------------------------- | ----------- | ------------------------------------------------ |
| `DATABASE_POOL_MAX`          | `10`        | Máximo de conexiones, por pool                   |
| `DATABASE_POOL_IDLE_TIMEOUT` | `30000`     | Tiempo de espera de inactividad, en milisegundos |
| `DATABASE_CONNECT_TIMEOUT`   | `5000`      | Tiempo de espera de conexión, en milisegundos    |

Dimensiona `max_connections` (o el pool de pgBouncer) para el pool principal más estos, por
réplica.

### 3.3 Parámetros de Postgres en los archivos compose

`docker-compose.yml` arranca Postgres con parámetros pensados para unos 2 GB de RAM:
`shared_buffers=256MB`, `effective_cache_size=768MB`, `maintenance_work_mem=64MB`,
`work_mem=4MB`, `checkpoint_completion_target=0.9`, `wal_buffers=16MB`,
`default_statistics_target=100`, `max_connections=100`, `effective_io_concurrency=200`,
`max_worker_processes=4`, `max_parallel_workers_per_gather=2`, `max_parallel_workers=4`,
`random_page_cost=1.1`.

pgBouncer en `docker-compose.prod.yml` usa `POOL_MODE: transaction`, `MAX_CLIENT_CONN: 1000`,
`DEFAULT_POOL_SIZE: 20`, `SERVER_IDLE_TIMEOUT: 600` y `MAX_PREPARED_STATEMENTS: 200`. Descarta
los parámetros de inicio `search_path` y `MNEMO_PG_*_TIMEOUT_MS` (`IGNORE_STARTUP_PARAMETERS`),
así que el paso de migración fija los mismos valores en el rol de la aplicación con
`ALTER ROLE ... IN DATABASE` (`docker/scripts/provision-app-role.mjs`).

---

## 4. Variables de entorno

`docker/.env.example` lista todas las variables con un ejemplo. Estas tablas cubren lo que un
despliegue suele definir; las variables de los pools están en la sección 3. Todas son
opcionales, salvo las marcadas como **obligatorias**.

### Almacenamiento

| Variable           | Por defecto    | Descripción                                                                                                                                                                                                                                                                    |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`     | —              | **Obligatoria.** Cadena de conexión de PostgreSQL principal. Si no está definida, se lee `MNEMO_DATABASE_URL`                                                                                                                                                                  |
| `MNEMO_VECTOR_URL` | `DATABASE_URL` | Cadena de conexión de pgvector para el adaptador vectorial, para una base de datos separada. Las migraciones nunca la usan                                                                                                                                                     |
| `MNEMO_REDIS_URL`  | —              | Cadena de conexión de Redis. Al definirla se activan la caché de nivel caliente en Redis, el pub/sub de políticas y el almacén compartido contra repetición de la federación; sin ella, la recuperación usa la cascada fría. Obligatoria con `NODE_ENV=production` (sección 1) |

### Servidor y seguridad

| Variable                 | Por defecto | Descripción                                                                                                                                                                                                                                                                                           |
| ------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | `3939`      | El puerto de escucha HTTP/1.1 (sección 1). La imagen define `3000`                                                                                                                                                                                                                                    |
| `MNEMO_GRPC_PORT`        | —           | Abre un listener h2c solo con el servicio gRPC, para los RPC bidireccionales (sección 1). Debe ser distinto de `PORT`                                                                                                                                                                                 |
| `NODE_ENV`               | —           | `production` (el valor de la imagen) vuelve obligatorios `MNEMO_MASTER_KEY`, `MNEMO_KEY_PEPPER` y Redis, impide arrancar con un interruptor inseguro activo (`MNEMO_DASHBOARD_INSECURE_COOKIE`, `MNEMO_ALLOW_UNSAFE_DB_ROLE`, `MNEMO_FED_INSECURE_TRANSPORT` en `true`) y oculta `/metrics` sin token |
| `MNEMO_MASTER_KEY`       | —           | Clave maestra del cifrado de campos, 64 caracteres hexadecimales (`openssl rand -hex 32`). Obligatoria con `NODE_ENV=production`                                                                                                                                                                      |
| `MNEMO_KEY_PEPPER`       | —           | Pepper para el cegado de los tokens de API, de al menos 32 caracteres. Obligatorio con `NODE_ENV=production`; en otros entornos, más corto o sin definir solo registra una advertencia                                                                                                                |
| `MNEMO_DASHBOARD_SECRET` | —           | Firma la cookie de sesión del panel, de al menos 32 bytes. Sin definir, las rutas de inicio de sesión del panel no se montan; más corto, el servidor no arranca                                                                                                                                       |
| `MNEMO_PUBLIC_BASE_URL`  | —           | Origen público del panel, para los enlaces de Miembros y de las invitaciones (gana un valor guardado en Instalación > Ajustes)                                                                                                                                                                        |
| `MNEMO_CORS_ORIGINS`     | —           | Orígenes permitidos, separados por comas                                                                                                                                                                                                                                                              |
| `MNEMO_PLUGINS`          | —           | Plugins dentro del proceso, separados por comas: nombres de paquetes npm o `builtin:<id>`. Cada uno lee su configuración de `MNEMO_PLUGIN_<ID>__<KEY>`                                                                                                                                                |
| `MNEMO_REGION`           | —           | Región que atiende esta instancia. Si se define, una petición para un espacio de trabajo fijado a otra región recibe `403 wrong_region`; sin definir, no hay comprobación de región                                                                                                                   |

### Autenticación

| Variable                    | Por defecto | Descripción                                                                                                                                                                                                                                                                                   |
| --------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_TRUSTED_PROXY_IP`    | —           | Dirección desde la que se conecta el proxy que termina TLS. Si se define, la puerta de federación solo confía en `x-mnemo-tls-protocol` y `x-mnemo-client-cert` en conexiones cuyo socket viene de esa dirección (nunca de `X-Forwarded-For`). Consulta `docs/architecture/MTLS_BOUNDARY.md`. |
| `MNEMO_FED_TLS_PROXY`       | `false`     | `true` cuando delante del servidor hay un proxy que termina TLS y sobrescribe `x-mnemo-tls-protocol` y `x-mnemo-client-cert` en cada petición. Consulta `docs/architecture/MTLS_BOUNDARY.md`.                                                                                                 |
| `MNEMO_SENSITIVITY_CEILING` | `internal`  | Techo de lectura para todo el proceso: `public` \| `internal` \| `confidential` \| `restricted`. Una clave con su propio permiso `maxSensitivity` puede bajarlo, nunca subirlo.                                                                                                               |

### Proveedores

Nombres de proveedor: `openai`, `anthropic`, `google` (o `gemini`), `cohere`, `mistral`,
`voyage`, `ollama`, `bedrock`, `nvidia` (`packages/llm-providers/src/factory.ts`).

| Variable                                                                                   | Por defecto | Descripción                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MNEMO_LLM_PROVIDER`                                                                       | —           | Proveedor de completados                                                                                                                                                                                                                                                                   |
| `MNEMO_LLM_MODEL`                                                                          | —           | ID del modelo para extracción/colapso, salvo que un espacio de trabajo defina `/config/llm`                                                                                                                                                                                                |
| `MNEMO_LLM_API_KEY`                                                                        | —           | Clave de API del proveedor de LLM (no hace falta con `ollama`)                                                                                                                                                                                                                             |
| `MNEMO_LLM_BASE_URL`                                                                       | —           | URL base personalizada                                                                                                                                                                                                                                                                     |
| `MNEMO_LLM_JUDGE_PROVIDER`, `MNEMO_LLM_JUDGE_MODEL`, `MNEMO_LLM_JUDGE_API_KEY`             | —           | Proveedor de la tarea `judge`: clasificación de conflictos, reordenamiento de la recuperación, condiciones de los recordatorios. Sin definir, la tarea usa `MNEMO_LLM_PROVIDER`. Definir cualquiera de ellas exige `MNEMO_LLM_PROVIDER`                                                    |
| `MNEMO_LLM_SUMMARY_PROVIDER`, `MNEMO_LLM_SUMMARY_MODEL`, `MNEMO_LLM_SUMMARY_API_KEY`       | —           | Proveedor de la tarea `summary`: colapso de sesiones, extracción de capturas, compresión. Mismo respaldo que `judge`                                                                                                                                                                       |
| `MNEMO_LLM_PREFILTER_PROVIDER`, `MNEMO_LLM_PREFILTER_MODEL`, `MNEMO_LLM_PREFILTER_API_KEY` | —           | Proveedor de la tarea `prefilter`: consultas HyDE y de anticipación. Mismo respaldo que `judge`                                                                                                                                                                                            |
| `MNEMO_LLM_DAILY_BUDGET_USD`                                                               | —           | Tope diario, en dólares estadounidenses, de lo que pueden gastar los completados del servidor. Los embeddings no tienen tope                                                                                                                                                               |
| `MNEMO_EMBED_PROVIDER`                                                                     | —           | Proveedor de embeddings (`anthropic` no tiene embeddings). Sin definir, embebe el proveedor de LLM                                                                                                                                                                                         |
| `MNEMO_EMBED_MODEL`                                                                        | —           | ID del modelo de embeddings (p. ej. `text-embedding-3-small`)                                                                                                                                                                                                                              |
| `MNEMO_EMBED_API_KEY`                                                                      | —           | Clave de API del proveedor de embeddings (no hace falta con `ollama`). Con `MNEMO_EMBED_PROVIDER` definido y sin clave, el servidor avisa y embebe con el proveedor de LLM                                                                                                                 |
| `MNEMO_EMBED_BASE_URL`                                                                     | —           | URL base de un endpoint de embeddings autoalojado                                                                                                                                                                                                                                          |
| `MNEMO_EMBED_DIMENSIONS`                                                                   | —           | Reemplaza la dimensión del embedding                                                                                                                                                                                                                                                       |
| `MNEMO_WRITE_CONFLICT_CLASSIFICATION`                                                      | `false`     | `true` clasifica con el LLM cada escritura de un hecho frente a sus 3 hechos más cercanos (hasta 3 llamadas por escritura, tope de 8 s) e informa de una contradicción en la respuesta de `remember`. Desactivado, las contradicciones aparecen más tarde mediante la comprobación acotada |
| `MNEMO_SENSITIVE_TEXT_TO_PROVIDERS`                                                        | `embed`     | Qué proveedores externos reciben el texto plano de los hechos confidenciales y restringidos: `none`, `embed` (solo el de embeddings) o `all`. Los proveedores locales lo reciben con cualquier valor. Ver abajo                                                                            |

**`MNEMO_SENSITIVE_TEXT_TO_PROVIDERS`** (SECURITY.md §7). `none`: ningún proveedor; esos
hechos no tienen vector y la recuperación solo los encuentra por repetición exacta. `embed`
(por defecto): solo el de embeddings; las contradicciones con ellos no se detectan y una
página de recuperación que tenga uno no se reordena. `all`: también el de completados. Un
proveedor local recibe ese texto con cualquier valor: Ollama sin URL base, o una URL base
cuyo host es `localhost` o una IP literal de loopback o de red privada (`127/8`, `10/8`,
`172.16/12`, `192.168/16`, `::1`, `fc00::/7`). Un nombre de host, también un servicio de
compose como `http://ollama:11434`, cuenta como externo porque el DNS decide adónde va;
si todos los proveedores son tuyos, usa `all`. Los proveedores que un espacio de trabajo
configura con `/config/llm` siempre son externos. Cualquier otro valor impide el arranque.
Cómo se probó: proveedores falsos que registran lo que reciben, para cada valor
(`packages/core/src/cognitive/__tests__/sensitive-egress.test.ts`, la prueba unitaria de la
comprobación acotada y `scoped-conflict-check-boot.integration.test.ts` contra Postgres
real), y la regla de lo local en `packages/server/src/__tests__/sensitive-egress.test.ts`.

### Ajuste de la recuperación

| Variable                            | Por defecto | Descripción                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_RECALL_EVALUATE_REMINDERS`   | `true`      | Interruptor de apagado de REMIND-1, que se resuelve una sola vez al arrancar el servidor (`packages/server/src/routes/recall.ts`). Cada llamada a `POST /recall` evalúa además los recordatorios de memoria prospectiva pendientes (un `SELECT` adicional de `listPendingReminders`), de modo que un recordatorio disparado puede viajar en el campo `reminders` de la respuesta. Defínelo en `0` para omitir esa consulta extra en despliegues sensibles a la latencia: la recuperación en sí no se ve afectada, solo se omite la evaluación de recordatorios.                                                                                          |
| `MNEMO_RECALL_DEFAULT_TOKEN_BUDGET` | —           | Valor por defecto de la escalera de presupuesto de tokens de CALMem (§17), que se resuelve una sola vez al arrancar. Precedencia: `tokenBudget` del cuerpo de la solicitud > esta variable de entorno > `undefined` (pipeline completo, compatible hacia atrás). Controla qué niveles de recuperación se ejecutan: `<500` se omite, `<2000` solo nivel caliente (3 resultados), `<8000` caliente + puntero (5 resultados), `≥8000` pipeline completo. Definirla por debajo de `500` hace que toda llamada de recuperación sin presupuesto devuelva resultados vacíos: déjala sin definir salvo que hayas verificado el comportamiento de los llamadores. |

### Observabilidad

| Variable                        | Por defecto                               | Descripción                                                                                                                                                 |
| ------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`   | —                                         | Endpoint OTLP (p. ej. `http://otel-collector:4318`). Sin definir, la telemetría no hace nada                                                                |
| `LOG_LEVEL`                     | `info` en producción, `debug` en el resto | Nivel de log de pino (`debug` \| `info` \| `warn` \| `error`)                                                                                               |
| `MNEMO_METRICS_TOKEN`           | —                                         | Token bearer para `/metrics` y `/metrics/prometheus` (sección 7)                                                                                            |
| `MNEMO_HEALTH_PROBE_TIMEOUT_MS` | `3000`                                    | Una sonda de dependencia que no responde a tiempo cuenta como caída                                                                                         |
| `MNEMO_LIVENESS_POOL_STALL_MS`  | `60000`                                   | `/health/live` responde 503 cuando el pool lleva este tiempo sin poder ejecutar `SELECT 1` mientras una conexión nueva sí puede. `0` desactiva el vigilante |
| `MNEMO_CRON_DISABLE`            | —                                         | Claves de tareas, separadas por comas, que el registro de cron omite (sección 5)                                                                            |
| `MNEMO_SHUTDOWN_GRACE_MS`       | `45000`                                   | Milisegundos que el servidor drena tras `SIGTERM`/`SIGINT` antes de forzar la salida (sección 6)                                                            |

### Federación

| Variable                       | Por defecto | Descripción                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_FED_PEER_ID`            | —           | Identificador de federación de este servidor: el id con el que otros servidores lo registran, el `iss` de cada JWT de servicio que firma y el `aud` que acepta (salvo que `MNEMO_FED_AUDIENCE` lo reemplace)                                                                                                                                                                       |
| `MNEMO_FEDERATION_PRIVATE_KEY` | —           | Clave privada Ed25519 (PEM) que firma los JWT de servicio. Este servidor solo hace pull cuando están definidas esta y `MNEMO_FED_PEER_ID`                                                                                                                                                                                                                                          |
| `MNEMO_FED_CLIENT_CERT_FILE`   | —           | Certificado de cliente PEM que este servidor presenta cuando extrae de pares https (un par detrás de un proxy con `ssl_verify_client on` lo exige). Se emite para la clave de federación de este servidor. Va junto con `MNEMO_FED_CLIENT_KEY_FILE`; si falta uno de los dos o un archivo no se puede leer, el servidor no arranca. Consulta `docs/architecture/MTLS_BOUNDARY.md`. |
| `MNEMO_FED_CLIENT_KEY_FILE`    | —           | Clave privada PEM de ese certificado (puede ser la misma clave que `MNEMO_FEDERATION_PRIVATE_KEY`).                                                                                                                                                                                                                                                                                |
| `MNEMO_FED_CA_FILE`            | —           | CA en PEM con la que se verifican los certificados TLS de los pares al extraer, en lugar de las raíces del sistema. Opcional.                                                                                                                                                                                                                                                      |

---

## 5. Tareas en segundo plano

No hay CronJobs externos. El servidor arranca un registro de cron dentro del proceso
(`packages/server/src/boot/crons.ts`, tareas en `packages/server/src/cron/jobs.ts`). Cada
proceso del servidor ejecuta su propio registro, pero cada ciclo de una tarea que trabaja sobre la
base o el Redis compartidos corre en una sola réplica: las réplicas disparan en el mismo instante
del reloj (las tareas por intervalo, en múltiplos de su período) y la primera que toma un advisory
lock de Postgres para esa tarea (`pg_try_advisory_xact_lock`, en una transacción abierta mientras
corre la tarea y al menos 10 s, o la mitad del período en intervalos más cortos, así se sostiene
aunque pgBouncer agrupe por transacción) la ejecuta; las
demás registran `cron.lock_skipped`. Una ejecución que dura más que su período también impide
que las otras réplicas tomen el ciclo siguiente. Solo `mnemo.meter.persist` corre en todas las
réplicas, porque vacía la cola de medición de su propio proceso (`cronScope` en
`packages/server/src/cron/registry.ts`). Un ciclo que falla
se registra (`cron.tick_error`) y se cuenta en `mnemo_cron_runs_total`; nunca detiene la
programación. Con carga alta, la compuerta de descarte omite las tareas de menor prioridad
(`cron.shed_skipped`). `MNEMO_CRON_DISABLE=mnemo.hot.decay,mnemo.plugin.sync` apaga tareas por
clave; `mnemo.plugin.sync` apaga todas las `mnemo.plugin.sync:<id>` de cada plugin, cuyo intervalo por defecto es
`MNEMO_PLUGIN_SYNC_INTERVAL_MS` y nunca menor a 1 minuto.

Fuera del registro, cada réplica consulta cada segundo el registro de cambios de políticas de
agentes (migración 0067), así una escritura de política llega a la caché de todas las réplicas en
alrededor de un segundo aun sin Redis y a través de pgBouncer en modo transacción
(`pollPolicyChanges` en `packages/server/src/middleware/rbac-policy.ts`).

Los horarios están en UTC.

| Tarea                         | Horario                                       | Condición                                                           |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `mnemo.webhook.deliver`       | Cada minuto                                   | —                                                                   |
| `mnemo.session.collapse`      | Cada 5 minutos                                | También ejecuta el worker de sesiones gestionadas                   |
| `mnemo.meter.persist`         | Cada 5 minutos                                | —                                                                   |
| `mnemo.querycache.evict`      | Cada hora                                     | —                                                                   |
| `mnemo.hot.decay`             | Cada hora                                     | —                                                                   |
| `mnemo.audit.merkle.publish`  | Cada hora                                     | —                                                                   |
| `mnemo.policy.change.purge`   | Cada hora                                     | Cambios de políticas de agentes de más de una hora (migración 0067) |
| `mnemo.plugin.sync:<id>`      | El `syncInterval` del plugin (por defecto 1h) | Una por plugin; requiere `MNEMO_PLUGIN_<ID>__WORKSPACE_ID`          |
| `mnemo.governance.propagate`  | Diaria 02:00                                  | —                                                                   |
| `mnemo.retention.purge`       | Diaria 02:30                                  | —                                                                   |
| `mnemo.reasoning.decay`       | Diaria 03:00                                  | —                                                                   |
| `mnemo.health.snapshot`       | Diaria 03:00                                  | —                                                                   |
| `mnemo.semantic.decay`        | Diaria 03:15                                  | —                                                                   |
| `mnemo.procedural.decay`      | Diaria 03:30                                  | —                                                                   |
| `mnemo.session.retention`     | Diaria 03:30                                  | Solo cuando hay un resolvedor de configuración de retención         |
| `mnemo.hot.rebuild`           | Diaria 04:00                                  | Necesita Redis                                                      |
| `mnemo.idempotency.reap`      | Diaria 04:00                                  | —                                                                   |
| `mnemo.workspace.graduate`    | Diaria 04:00                                  | —                                                                   |
| `mnemo.verify.codebase`       | Diaria 05:30                                  | —                                                                   |
| `mnemo.outbox.purge`          | Diaria 05:30                                  | —                                                                   |
| `mnemo.plugin.verify`         | Diaria 05:45                                  | Plugins con `verify()` y `MNEMO_PLUGIN_<ID>__WORKSPACE_ID`          |
| `mnemo.type.schedule`         | Diaria 06:00                                  | —                                                                   |
| `mnemo.anticipate.mine`       | Diaria 06:30                                  | —                                                                   |
| `mnemo.embed.migration`       | Diaria 06:45                                  | No hace nada sin proveedor de embeddings                            |
| `mnemo.metacognition.refresh` | Diaria 07:00                                  | —                                                                   |
| `mnemo.task.stale`            | Diaria 08:00                                  | —                                                                   |
| `mnemo.audit.partition`       | Domingos 01:00                                | Solo elimina particiones viejas con `MNEMO_AUDIT_DROP_ENABLED=true` |
| `mnemo.kek.rotate`            | Domingos 03:00                                | No hace nada salvo con `MNEMO_KEK_ROTATE_ENABLED=true`              |
| `mnemo.reasoning.prune`       | Domingos 03:30                                | —                                                                   |
| `mnemo.hebbian.normalize`     | Domingos 04:30                                | —                                                                   |
| `mnemo.composition.validate`  | Domingos 05:00                                | —                                                                   |
| `mnemo.procedural.evaluate`   | Lunes 03:00                                   | —                                                                   |
| `mnemo.audit.merkle`          | Martes 02:30                                  | —                                                                   |

---

## 6. Apagado ordenado

Ante `SIGTERM` o `SIGINT`, el servidor (`packages/server/src/index.ts`):

1. Vacía la telemetría (sin garantía; registra `server.telemetry_flush_timeout` pasados 5 s).
2. Ejecuta los hooks de apagado de los plugins.
3. Detiene el sondeo de recordatorios, el registro de cron, el temporizador de uso del pool, el
   vigilante de bloqueo del pool y el worker del outbox.
4. Cierra el pool de base de datos del núcleo.
5. Vuelca el nivel caliente de Redis en `mnemo_hot_tier_snapshot` (sin garantía); el siguiente
   arranque lo vuelve a cargar en Redis.
6. Cierra la conexión a Redis y detiene el planificador de consolidación.
7. Deja de aceptar conexiones en el listener h2c (con `MNEMO_GRPC_PORT`) y cierra el servidor
   HTTP: deja de aceptar conexiones y termina con `0` cuando acaban las abiertas, o con `1` ante
   un error de cierre.

Los pasos 1, 2, 4, 5 y 6 empiezan sin esperarse entre sí. Si el proceso sigue vivo
`MNEMO_SHUTDOWN_GRACE_MS` después de la señal (45000 ms por defecto; con un valor que no sea un
entero positivo el servidor no arranca), registra `server.shutdown_force_exit` y termina con `1`.
Las plataformas le dan 60 s antes de matarlo, así que mantén la espera por debajo:
`kill_timeout = "60s"` en `fly.toml` y `stop_grace_period: "60s"` en
`docker-compose.prod.yml`.

---

## 7. Comprobaciones de salud y métricas

Todas se montan antes de la autenticación de la API (`packages/server/src/routes/health.ts`,
`packages/server/src/routes/metrics.ts`). Cada sonda de dependencia se rinde pasado
`MNEMO_HEALTH_PROBE_TIMEOUT_MS` (3 s).

| Endpoint                                  | Autenticación                   | Responde                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`                        | Ninguna                         | `200 {"status":"alive","pid":...}` sin tocar las dependencias. `503 {"status":"stalled","reason":"db_pool_stalled"}` solo cuando salta el vigilante de bloqueo del pool (`MNEMO_LIVENESS_POOL_STALL_MS`)                                                                      |
| `GET /healthz`                            | Ninguna                         | `200 {"status":"ok"}`                                                                                                                                                                                                                                                         |
| `GET /readyz`                             | Ninguna                         | Comprobación de disponibilidad anterior: `200` cuando Postgres responde, `503` en otro caso                                                                                                                                                                                   |
| `GET /health/ready`                       | Ninguna                         | `503 {"status":"not_ready","reason":"postgres_unavailable"}` con `Retry-After: 5` cuando Postgres está caído. En otro caso `200` con `degraded` y el estado de `postgres`, `vector`, `cache` y `embed`; cualquiera de los tres últimos distinto de `ok` pone `degraded: true` |
| `GET /health/deep`                        | Clave bearer con `memory:admin` | `401` sin una clave válida, `403` sin el alcance. Estado de Postgres, vectores y caché con latencias, versión, tiempo activo y bloques de diagnóstico (`mode`, `slos`, `hot_tier`, `federation`, `plugins`). En caché 30 s; `503` cuando Postgres está caído                  |
| `GET /canary/slo-gate`                    | Ninguna                         | `200 {"allow":true}` o `409 {"allow":false}` según la tasa de error de las peticiones y el p99 de la recuperación                                                                                                                                                             |
| `GET /metrics/prometheus`, `GET /metrics` | `MNEMO_METRICS_TOKEN`           | Texto de Prometheus. Con el token definido, solo `Authorization: Bearer <token>` (cualquier otra cosa recibe `401`). Sin él: `404` con `NODE_ENV=production`, abierto en otro caso                                                                                            |

---

## 8. Despliegue canario

`.github/workflows/deploy-canary.yml` es un flujo manual (`workflow_dispatch`) para la app de
Fly `mnemosyne`. Entradas: `image_tag` (obligatoria) y `slo_observe_seconds` (`600` por
defecto). Secretos: `FLY_API_TOKEN` y `PROMETHEUS_URL`. Sin `PROMETHEUS_URL` se detiene antes de
tocar ninguna máquina.

El proxy de Fly reparte las peticiones entre las máquinas encendidas de la app sin enrutamiento
ponderado, así que el canario mueve máquinas, no porcentajes: la parte del tráfico que recibe la
imagen nueva es la parte de las máquinas que la ejecutan (con las dos máquinas que `fly.toml`
mantiene encendidas, una máquina ya es la mitad). Antes de mover nada anota el destino de la
reversión: la imagen distinta de la nueva que ejecuta la mayoría de las máquinas encendidas (se
detiene si no hay ninguna, y las etapas siguientes rechazan un destino igual a la imagen nueva).
Ejecuta tres jobs en secuencia, cada uno una etapa de `scripts/canary-rollout.mjs` (`one`,
`half`, `full`), que tiene toda la lógica; el flujo solo instala, compila `@mnemo-ai/core` con
sus dependencias y lo llama:

| Job                       | Qué ejecuta                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Canary: 1 machine         | `fly machine update <id> --image registry.fly.io/mnemosyne:<image_tag>` en una máquina     |
| Canary: half the machines | Lo mismo en más máquinas hasta que la mitad ejecuta la imagen nueva (ninguna si ya es así) |
| Full rollout              | `fly deploy --strategy rolling` con la imagen nueva                                        |

Después de mover máquinas cada etapa espera `slo_observe_seconds` y las juzga con
`scripts/canary-slo-check.mjs`. Cada
proceso del servidor publica `mnemo_build_info{image}` (su `FLY_IMAGE_REF`), y la comprobación lo
une por `instance` para separar la proporción de 5xx de `mnemo_requests_total` y el p99 de
`mnemo_recall_duration_seconds` entre las máquinas con la imagen nueva y las demás: en el mismo
momento en los dos jobs canarios, y contra las demás una hora antes después del despliegue
completo. `evaluateCanary` (`packages/core/src/cognitive/canary.ts`) devuelve `rollback` cuando
la proporción de error es más de 1 punto porcentual mayor o el p99 más de 100 ms mayor, y `hold`
cuando a cualquiera de los dos lados le faltan datos. La separación necesita que Prometheus
recoja cada máquina como un objetivo propio; si las recoge a través del balanceador, o si la
referencia de la imagen no lleva la etiqueta, falta la serie candidata y la comprobación da
`hold`.

Solo `promote` deja correr el job siguiente. `rollback`, `hold` o cualquier error después de
mover la primera máquina (una llamada a `fly` que falla, un Prometheus que no responde) devuelve
todas las máquinas a la imagen anotada (`fly deploy --image <anterior> --strategy rolling`) y se
detiene; con `hold` el registro explica cómo reintentar. Todo lo que puede detener una etapa (sin
`PROMETHEUS_URL`, una etiqueta de imagen que PromQL no puede comparar de forma segura, sin
destino de reversión o con uno igual a la imagen nueva) se comprueba antes de la primera llamada
a `fly` que cambia algo.

**Cómo se prueba.** El flujo nunca se ejecutó contra la app real de Fly. Su lógica se ejecuta de
punta a punta en `scripts/__tests__/canary-rollout.test.mjs` (parte de `pnpm test:scripts`, que
la CI ejecuta después de compilar): la prueba pone un `fly` falso en el `PATH`
(`scripts/__tests__/fake-fly.mjs`, que guarda las máquinas en un archivo JSON y responde a
`fly machine list --json`, `fly machine update` y `fly deploy`) y sirve un Prometheus falso en
localhost, y después ejecuta las etapas en el orden y con las condiciones `if:` del flujo, con el
`evaluateCanary` real. Cubre una promoción completa, una reversión por el SLO en la mitad de las
máquinas y en el despliegue completo, un `hold` que revierte, un Prometheus que no responde, la
falta de `PROMETHEUS_URL` que se detiene antes de cualquier llamada a `fly` y una imagen anterior
igual a la nueva que se rechaza antes de mover ninguna máquina.
`packages/server/src/__tests__/unit/canaryStages.test.ts` comprueba que el flujo encadena las
etapas y les pasa la imagen anotada. La ejecución encontró que los jobs compilaban
`@mnemo-ai/core` sin `@mnemo-ai/types`, cuyo `dist` importa el `dist` de core; ahora compilan con
turbo.

---

## 9. Copia de seguridad y restauración

El repositorio no incluye ninguna tarea de copia de seguridad: respalda Postgres con las
herramientas de tu proveedor o con `pg_dump`. Lo que sí conservan los archivos de despliegue y
el código:

- **Redis.** `redis-master` en `docker-compose.prod.yml` guarda instantáneas en su volumen
  (`--save 60 1`). El nivel caliente también sobrevive a un reinicio ordenado mediante
  `mnemo_hot_tier_snapshot` (sección 6), y `mnemo.hot.rebuild` lo vuelve a sembrar cada día con
  los hechos de mayor valor.
- **Un espacio de trabajo, a través de la API.** `mnemo export` escribe en JSONL el espacio de
  trabajo de la clave de API (`GET /export/jsonl`); cuando la exportación necesita aprobación,
  imprime el id de la solicitud de aprobación y termina con `2`. `mnemo import` envía un archivo
  a `POST /import`.

```bash
mnemo export > backup.jsonl
mnemo export --approval-request-id <id> > backup.jsonl

mnemo import backup.jsonl --conflict-resolution newest
```

`--conflict-resolution` acepta `skip` (por defecto), `overwrite` o `newest`; `--from <vendor>`
importa el formato de exportación de otra herramienta.
