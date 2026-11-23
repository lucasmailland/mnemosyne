# Mnemosyne: Service Deployment Reference

**English** · [Español](SERVICES.es.md)

> What runs, how it is wired and what each deployment file sets. Every statement here comes
> from the files it names: the compose files in `docker/`, `docker/Dockerfile.server`,
> `fly.toml`, `deploy/railway.json`, `.github/workflows/deploy-canary.yml` and the server code
> in `packages/server/src`. Step-by-step guides: `docs/guides/PRODUCTION_DEPLOY.md` and
> `docker/README.md`.

---

## 1. The Server Process

The server is one Node process, `node /app/dist/index.js`, built by `docker/Dockerfile.server`
(Node 22 Alpine, runs as user `node`). It opens an HTTP/1.1 listener on `PORT` and serves
everything on it (`packages/server/src/index.ts`):

- The REST API (Hono), including the probes and `/metrics` (section 7).
- ConnectRPC: a request whose path starts with `/mnemosyne.v1.MnemosyneService/` goes to the
  Connect handler (`packages/server/src/grpc.ts`).
- WebSocket subscriptions: the upgrade on `GET /memory/ws` (`packages/server/src/ws.ts`).

HTTP/1.1 carries Connect and gRPC-Web, but not a bidirectional stream: a `Session` or
`FederationSync` call on `PORT` fails with HTTP 505. With `MNEMO_GRPC_PORT` set, the server also
opens a cleartext HTTP/2 (h2c) listener on that port that serves only the Connect handler, with
the same interceptors and authentication: every RPC there, the two bidirectional ones included,
in the gRPC, gRPC-Web and Connect protocols. It has no TLS of its own; put a proxy that
terminates TLS and forwards HTTP/2 in front of it, as with `PORT`. Unset (the default), only
`PORT` listens. A value that is not a port, or equals `PORT`, makes the server refuse to start. On this port the client-IP headers (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`) that
the per-key IP allowlist reads count only on a connection from `MNEMO_TRUSTED_PROXY_IP`; from any
other connection the server replaces them with the socket's address.

MCP is not served by this process. `@mnemo-ai/mcp` is a separate stdio process that each MCP
client starts; it calls the REST API at `MNEMO_URL` with `MNEMO_KEY`.

`PORT` depends on where the server runs:

| Where                      | `PORT`                                                          |
| -------------------------- | --------------------------------------------------------------- |
| Code default               | `3939`                                                          |
| `docker/Dockerfile.server` | `3000` (`ENV PORT=3000`, `EXPOSE 3000`)                         |
| `docker-compose.yml`       | `${PORT:-3939}`, published on the same host port                |
| `docker-compose.prod.yml`  | `3000` in the container, published on host port `${PORT:-3000}` |
| `fly.toml`                 | `3000` (`internal_port = 3000`)                                 |

`MNEMO_GRPC_PORT` has no default anywhere. The compose files pass it to the container and carry
a commented-out `ports` line to publish it.

What it needs:

- **PostgreSQL with pgvector** (`DATABASE_URL`). Without it the server logs
  `DATABASE_URL is not set. Refusing to start.` and exits.
- **Redis** (`MNEMO_REDIS_URL`). Optional in development. With `NODE_ENV=production` the
  server does not start without it: the per-agent RBAC limits count on Redis and would
  otherwise fail open.
- **A completion and embedding provider** (`MNEMO_LLM_*`, `MNEMO_EMBED_*`, section 4).

The server does not run migrations. `docker/scripts/run-migrations.mjs` applies the v2 and v3
streams and then creates the `mnemo_app` login role. It reads only
`MNEMO_MIGRATION_DATABASE_URL` (never `DATABASE_URL`) and is the command of the
`docker/Dockerfile.migrate` image; the server image carries it too, at
`/app/scripts/run-migrations.mjs`.

---

## 2. Deployment Targets

### 2.1 Docker Compose: `docker-compose.yml`

The base stack, from `docker/`:

```bash
docker compose up -d
```

| Service    | Image / build               | Host port                | Notes                                                                |
| ---------- | --------------------------- | ------------------------ | -------------------------------------------------------------------- |
| `redis`    | `redis:7-alpine`            | `${REDIS_PORT:-6379}`    | No password                                                          |
| `postgres` | `pgvector/pgvector:pg17`    | `${POSTGRES_PORT:-5432}` | Named volume `mnemosyne-pgdata`; tuning flags in section 3.3         |
| `migrate`  | `docker/Dockerfile.migrate` | —                        | Runs once after `postgres` is healthy; `restart: "no"`               |
| `server`   | `docker/Dockerfile.server`  | `${PORT:-3939}`          | Starts after `migrate` exits 0; healthcheck `wget` on `/health/live` |
| `ollama`   | `ollama/ollama:latest`      | `${OLLAMA_PORT:-11434}`  | Named volume `mnemosyne-ollama-data`; GPU block commented out        |

The defaults (`mnemo`/`mnemo`/`mnemo`, `MNEMO_LLM_PROVIDER=openai`,
`MNEMO_LLM_MODEL=gpt-4o-mini`, `MNEMO_EMBED_MODEL=text-embedding-3-small`) come from the file;
`docker/.env.example` lists every variable the `server` service passes through.

### 2.2 Local Overrides: `docker-compose.override.yml`

Compose merges this file automatically when you run it from `docker/`. It is for a local
single-workspace stack and must not reach production: it sets `NODE_ENV=development`,
`MNEMO_ALLOW_UNSAFE_DB_ROLE=true`, `MNEMO_REQUIRE_RBAC_LIMITS=false`,
`MNEMO_ALLOW_LEGACY_FULL_SCOPE=true` and `MNEMO_DASHBOARD_INSECURE_COOKIE=true`. It chooses no
model: the provider comes from `docker/.env`, and the `ollama` service runs only with
`--profile local`.

### 2.3 Production Overlay: `docker-compose.prod.yml`

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

What it changes or adds:

- **`migrate`** needs `MNEMO_MIGRATION_DATABASE_URL` (direct to Postgres) and
  `MNEMO_APP_DB_PASSWORD`, and creates the `MNEMO_APP_DB_USER` role (`mnemo_app` by default)
  with the `MNEMO_PG_*_TIMEOUT_MS` session limits.
- **`postgres`**, **`redis`** and **`ollama`** are published on `127.0.0.1` only; `postgres`
  needs `POSTGRES_PASSWORD` and `redis` needs `REDIS_PASSWORD`.
- **`pgbouncer`** (`edoburu/pgbouncer:v1.26.1-p0`, port `5435` on loopback) pools the app role
  in transaction mode (section 3.3).
- **`redis-master`** plus **`redis-replica-1`** and **`redis-replica-2`** (`redis:7.4-alpine`).
  The server uses the master only. There is no Sentinel: the server's Redis client connects to
  one URL, so a failover is manual (promote a replica with `REPLICAOF NO ONE` and point
  `MNEMO_REDIS_URL_PROD` at it).
- **`server`** listens on `3000`, uses `DATABASE_URL_PROD` (through pgBouncer) and
  `MNEMO_REDIS_URL_PROD`, and needs `MNEMO_MASTER_KEY`, `MNEMO_KEY_PEPPER` and
  `MNEMO_DASHBOARD_SECRET`. `MNEMO_SERVER_REPLICAS` sets the replica count (1 by default); with
  plain `docker compose` each replica needs its own host port, so set `PORT` to a range.
  `stop_grace_period` is 60 s.
- **`dashboard`** (`docker/Dockerfile.dashboard`, loopback port `${MNEMO_DASHBOARD_PORT:-3300}`)
  talks to `http://server:3000`.
- **`otel-collector`** (`otel/opentelemetry-collector-contrib:0.127.0`) on loopback ports
  `4317`, `4318` and `8888`; the server exports to `http://otel-collector:4318`.

The `deploy.resources` limits in this file apply only under Docker Swarm (`docker stack`); plain
`docker compose` treats them as advisory.

### 2.4 Observability Overlay: `docker-compose.observability.yml`

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

| Service          | Image                                              | Host port                  |
| ---------------- | -------------------------------------------------- | -------------------------- |
| `prometheus`     | `prom/prometheus:v3.4.1` (30 d retention)          | `${PROMETHEUS_PORT:-9090}` |
| `tempo`          | `grafana/tempo:2.7.2`                              | `${TEMPO_PORT:-3200}`      |
| `loki`           | `grafana/loki:3.5.0`                               | `${LOKI_PORT:-3100}`       |
| `promtail`       | `grafana/promtail:3.5.0` (reads the Docker socket) | —                          |
| `grafana`        | `grafana/grafana:11.6.1`                           | `${GRAFANA_PORT:-3001}`    |
| `otel-collector` | `otel/opentelemetry-collector-contrib:0.127.0`     | `4317`, `4318`, `8888`     |

Their configuration lives in `docker/scripts/` (`prometheus.yml`, `prometheus-rules.yml`,
`tempo.yml`, `loki.yml`, `promtail.yml`, `otel-collector.yml`, the Grafana datasources and
dashboards). The services join the external network `mnemosyne_default`. None of them is
hardened for the public internet; Grafana's login defaults to `admin`/`admin`.

### 2.5 Fly.io: `fly.toml`

The same `docker/Dockerfile.server` image, deployed with `fly deploy`:

- `PORT=3000`, `NODE_ENV=production`, `LOG_LEVEL=info`.
- `[http_service]`: `internal_port = 3000`, `force_https`, `auto_stop_machines = false`,
  `auto_start_machines = true`, `min_machines_running = 2`, request concurrency 500 soft / 1000
  hard.
- Checks: `GET /health/live` every 10 s and `GET /health/ready` every 30 s.
- VM: `shared-cpu-2x` with 1 GB.
- `[deploy]`: rolling strategy, `kill_timeout = "60s"`, and
  `release_command = "node /app/scripts/run-migrations.mjs"`, which runs once per deploy
  before any machine is updated.
- No `[metrics]` section: scrape `/metrics/prometheus` from your own Prometheus with
  `MNEMO_METRICS_TOKEN`.

The secrets to set before the first deploy are listed at the top of `fly.toml`.

### 2.6 Railway: `deploy/railway.json`

Builds `docker/Dockerfile.server`, runs `node /app/scripts/run-migrations.mjs` as
`preDeployCommand`, starts `node /app/dist/index.js`, and checks `/health/ready` (30 s
timeout, restart on failure up to 5 times).

### 2.7 Kubernetes

The repository has no Helm chart, Kustomize overlay or Kubernetes manifest.

---

## 3. Postgres and the Connection Pools

### 3.1 Main Pool

The storage adapter's pool comes from `makePoolConfigFromEnv`
(`packages/adapter-postgres/src/pool-config.ts`), on postgres.js:

| Variable                   | Default                         | Description                                                                          |
| -------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `MNEMO_PG_POOL_MAX`        | from `MNEMO_DEPLOY_MODE`, or 10 | Maximum connections                                                                  |
| `MNEMO_DEPLOY_MODE`        | —                               | Only sets the `MNEMO_PG_POOL_MAX` default: `embedded` 5, `standalone` 10, `ha` 20    |
| `MNEMO_PG_IDLE_TIMEOUT`    | `20`                            | Close a connection idle this many seconds                                            |
| `MNEMO_PG_MAX_LIFETIME`    | `1800`                          | Recycle a connection after this many seconds                                         |
| `MNEMO_PG_CONNECT_TIMEOUT` | `10`                            | Give up connecting after this many seconds                                           |
| `DATABASE_REPLICA_URL`     | —                               | Read replica. Set, the storage repositories read from it and write to `DATABASE_URL` |

Every connection also carries `search_path=mnemosyne,public` and three session limits
(`packages/types/src/pg-session.ts`), in milliseconds, where `0` leaves the limit to the role or
the server:

| Variable                                  | Default |
| ----------------------------------------- | ------- |
| `MNEMO_PG_STATEMENT_TIMEOUT_MS`           | `60000` |
| `MNEMO_PG_LOCK_TIMEOUT_MS`                | `15000` |
| `MNEMO_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `60000` |

A value that is not a whole number, or a lock timeout not shorter than the statement timeout,
stops the boot.

### 3.2 Secondary Pools

The API key store, the RBAC store, the idempotency store, the outbox worker, federation and
consolidation each open their own pool through `createDrizzleClient`
(`packages/adapter-postgres/src/DrizzleStorageAdapter.ts`). Those pools read:

| Variable                     | Default | Description                      |
| ---------------------------- | ------- | -------------------------------- |
| `DATABASE_POOL_MAX`          | `10`    | Maximum connections, per pool    |
| `DATABASE_POOL_IDLE_TIMEOUT` | `30000` | Idle timeout, in milliseconds    |
| `DATABASE_CONNECT_TIMEOUT`   | `5000`  | Connect timeout, in milliseconds |

Size `max_connections` (or pgBouncer's pool) for the main pool plus these, per replica.

### 3.3 Postgres Settings in the Compose Files

`docker-compose.yml` starts Postgres with settings sized for about 2 GB of RAM:
`shared_buffers=256MB`, `effective_cache_size=768MB`, `maintenance_work_mem=64MB`,
`work_mem=4MB`, `checkpoint_completion_target=0.9`, `wal_buffers=16MB`,
`default_statistics_target=100`, `max_connections=100`, `effective_io_concurrency=200`,
`max_worker_processes=4`, `max_parallel_workers_per_gather=2`, `max_parallel_workers=4`,
`random_page_cost=1.1`.

pgBouncer in `docker-compose.prod.yml` runs `POOL_MODE: transaction`,
`MAX_CLIENT_CONN: 1000`, `DEFAULT_POOL_SIZE: 20`, `SERVER_IDLE_TIMEOUT: 600` and
`MAX_PREPARED_STATEMENTS: 200`. It drops the `search_path` and `MNEMO_PG_*_TIMEOUT_MS` startup
parameters (`IGNORE_STARTUP_PARAMETERS`), so the migrate step sets the same values on the app
role with `ALTER ROLE ... IN DATABASE` (`docker/scripts/provision-app-role.mjs`).

---

## 4. Environment Variables

`docker/.env.example` lists every variable with an example. These tables cover what a
deployment usually sets; the pool variables are in section 3. All are optional unless marked
**required**.

### Storage

| Variable           | Default        | Description                                                                                                                                                                                                           |
| ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`     | —              | **Required.** Primary PostgreSQL connection string. `MNEMO_DATABASE_URL` is read when it is unset                                                                                                                     |
| `MNEMO_VECTOR_URL` | `DATABASE_URL` | pgvector connection string for the vector adapter, for a split database. Migrations never use it                                                                                                                      |
| `MNEMO_REDIS_URL`  | —              | Redis connection string. Setting it enables the Redis hot-tier cache, the policy pub/sub and the shared federation replay store; unset, recall uses the cold cascade. Required with `NODE_ENV=production` (section 1) |

### Server and Security

| Variable                 | Default | Description                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | `3939`  | The HTTP/1.1 listen port (section 1). The image sets `3000`                                                                                                                                                                                                                                       |
| `MNEMO_GRPC_PORT`        | —       | Opens an h2c listener with only the gRPC service, for the bidirectional RPCs (section 1). Must differ from `PORT`                                                                                                                                                                                 |
| `NODE_ENV`               | —       | `production` (the image's value) makes `MNEMO_MASTER_KEY`, `MNEMO_KEY_PEPPER` and Redis mandatory, refuses to start with an unsafe switch on (`MNEMO_DASHBOARD_INSECURE_COOKIE`, `MNEMO_ALLOW_UNSAFE_DB_ROLE`, `MNEMO_FED_INSECURE_TRANSPORT` set to `true`) and hides `/metrics` without a token |
| `MNEMO_MASTER_KEY`       | —       | Field encryption master key, 64 hex characters (`openssl rand -hex 32`). Required with `NODE_ENV=production`                                                                                                                                                                                      |
| `MNEMO_KEY_PEPPER`       | —       | Pepper for API token blinding, at least 32 characters. Required with `NODE_ENV=production`; shorter or unset elsewhere logs a warning                                                                                                                                                             |
| `MNEMO_DASHBOARD_SECRET` | —       | Signs the dashboard session cookie, at least 32 bytes. Unset, the dashboard sign-in routes are not mounted; shorter, the server does not start                                                                                                                                                    |
| `MNEMO_PUBLIC_BASE_URL`  | —       | Public origin of the dashboard, for the links in Members and in invitations (a value saved in Installation > Settings wins)                                                                                                                                                                       |
| `MNEMO_CORS_ORIGINS`     | —       | Comma-separated allowed origins                                                                                                                                                                                                                                                                   |
| `MNEMO_PLUGINS`          | —       | Comma-separated in-process plugins: npm package names or `builtin:<id>`. Each reads its config from `MNEMO_PLUGIN_<ID>__<KEY>`                                                                                                                                                                    |
| `MNEMO_REGION`           | —       | Region this instance serves. Set, a request for a workspace pinned to another region gets `403 wrong_region`; unset, there is no region check                                                                                                                                                     |

### Auth

| Variable                    | Default    | Description                                                                                                                                                                                                                                                      |
| --------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_TRUSTED_PROXY_IP`    | —          | Address the TLS-terminating proxy connects from. When set, the federation gate trusts `x-mnemo-tls-protocol` and `x-mnemo-client-cert` only on connections whose socket address is this one (never `X-Forwarded-For`). See `docs/architecture/MTLS_BOUNDARY.md`. |
| `MNEMO_FED_TLS_PROXY`       | `false`    | `true` when a TLS-terminating proxy sits in front of the server and overwrites `x-mnemo-tls-protocol` and `x-mnemo-client-cert` on every request. See `docs/architecture/MTLS_BOUNDARY.md`.                                                                      |
| `MNEMO_SENSITIVITY_CEILING` | `internal` | Process-wide read ceiling: `public` \| `internal` \| `confidential` \| `restricted`. A key with its own `maxSensitivity` grant can lower it, never raise it.                                                                                                     |

### Providers

Provider names: `openai`, `anthropic`, `google` (or `gemini`), `cohere`, `mistral`, `voyage`,
`ollama`, `bedrock`, `nvidia` (`packages/llm-providers/src/factory.ts`).

| Variable                                                                                   | Default | Description                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_LLM_PROVIDER`                                                                       | —       | Completion provider                                                                                                                                                                                                              |
| `MNEMO_LLM_MODEL`                                                                          | —       | Model ID for extraction/collapse, unless a workspace sets `/config/llm`                                                                                                                                                          |
| `MNEMO_LLM_API_KEY`                                                                        | —       | API key for the LLM provider (not needed for `ollama`)                                                                                                                                                                           |
| `MNEMO_LLM_BASE_URL`                                                                       | —       | Custom base URL                                                                                                                                                                                                                  |
| `MNEMO_LLM_JUDGE_PROVIDER`, `MNEMO_LLM_JUDGE_MODEL`, `MNEMO_LLM_JUDGE_API_KEY`             | —       | Provider for the `judge` task: conflict classification, recall rerank, reminder conditions. Unset, the task runs on `MNEMO_LLM_PROVIDER`. Setting any of them requires `MNEMO_LLM_PROVIDER`                                      |
| `MNEMO_LLM_SUMMARY_PROVIDER`, `MNEMO_LLM_SUMMARY_MODEL`, `MNEMO_LLM_SUMMARY_API_KEY`       | —       | Provider for the `summary` task: session collapse, capture extraction, compression. Same fallback as `judge`                                                                                                                     |
| `MNEMO_LLM_PREFILTER_PROVIDER`, `MNEMO_LLM_PREFILTER_MODEL`, `MNEMO_LLM_PREFILTER_API_KEY` | —       | Provider for the `prefilter` task: HyDE and anticipation queries. Same fallback as `judge`                                                                                                                                       |
| `MNEMO_LLM_DAILY_BUDGET_USD`                                                               | —       | Daily cap, in US dollars, on what the server's completions may spend. Embeddings are not capped                                                                                                                                  |
| `MNEMO_EMBED_PROVIDER`                                                                     | —       | Embedding provider (`anthropic` has no embeddings). Unset, the LLM provider embeds                                                                                                                                               |
| `MNEMO_EMBED_MODEL`                                                                        | —       | Model ID for embedding (e.g. `text-embedding-3-small`)                                                                                                                                                                           |
| `MNEMO_EMBED_API_KEY`                                                                      | —       | API key for the embedding provider (not needed for `ollama`). With `MNEMO_EMBED_PROVIDER` set and no key, the server warns and embeds with the LLM provider                                                                      |
| `MNEMO_EMBED_BASE_URL`                                                                     | —       | Base URL for a self-hosted embedding endpoint                                                                                                                                                                                    |
| `MNEMO_EMBED_DIMENSIONS`                                                                   | —       | Override embedding dimension                                                                                                                                                                                                     |
| `MNEMO_WRITE_CONFLICT_CLASSIFICATION`                                                      | `false` | `true` classifies each fact write against its 3 closest facts with the LLM (up to 3 calls per write, 8 s cap) and reports a contradiction in the `remember` response. Off, contradictions surface later through the scoped check |
| `MNEMO_SENSITIVE_TEXT_TO_PROVIDERS`                                                        | `embed` | Which external providers get the plaintext of confidential and restricted facts: `none`, `embed` (the embedder only) or `all`. Local providers get it under any value. See below                                                 |

**`MNEMO_SENSITIVE_TEXT_TO_PROVIDERS`** (SECURITY.md §7). `none`: neither provider; such facts
get no vector and recall finds them only by exact repeat. `embed` (default): the embedder
only; contradictions with them are not detected and a recall page holding one is not
reranked. `all`: the completion provider too. A local provider gets that text under any
value: Ollama with no base URL, or a base URL whose host is `localhost` or an IP literal in
loopback or a private range (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `::1`, `fc00::/7`).
A host name, a compose service such as `http://ollama:11434` included, counts as external
because DNS decides where it goes; when every provider is your own, set `all`. Providers a
workspace configures through `/config/llm` are always external. Any other value refuses to
start. How it was tested: recording fake providers for each value
(`packages/core/src/cognitive/__tests__/sensitive-egress.test.ts`, the scoped check's unit
test, and `scoped-conflict-check-boot.integration.test.ts` against real Postgres), and the
local rule in `packages/server/src/__tests__/sensitive-egress.test.ts`.

### Recall Tuning

| Variable                            | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_RECALL_EVALUATE_REMINDERS`   | `true`  | REMIND-1 kill switch, resolved once at server boot (`packages/server/src/routes/recall.ts`). Every `POST /recall` call also evaluates pending prospective-memory reminders (an extra `listPendingReminders` SELECT) so a triggered reminder can ride along in the response's `reminders` field. Set to `0` to skip that extra query on latency-critical deployments: recall itself is unaffected, only reminder evaluation is dropped.            |
| `MNEMO_RECALL_DEFAULT_TOKEN_BUDGET` | —       | CALMem token-budget ladder default (§17), resolved once at boot. Precedence: request body's `tokenBudget` > this env var > `undefined` (full pipeline, backward compatible). Controls which recall tiers run: `<500` skip, `<2000` hot-only (3 hits), `<8000` hot+pointer (5 hits), `≥8000` full pipeline. Setting this below `500` makes every budget-less recall call return empty results: leave unset unless you've verified caller behavior. |

### Observability

| Variable                        | Default                                 | Description                                                                                                                    |
| ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT`   | —                                       | OTLP endpoint (e.g. `http://otel-collector:4318`). Unset, telemetry is a no-op                                                 |
| `LOG_LEVEL`                     | `info` in production, `debug` otherwise | pino log level (`debug` \| `info` \| `warn` \| `error`)                                                                        |
| `MNEMO_METRICS_TOKEN`           | —                                       | Bearer token for `/metrics` and `/metrics/prometheus` (section 7)                                                              |
| `MNEMO_HEALTH_PROBE_TIMEOUT_MS` | `3000`                                  | A dependency probe that does not answer in time counts as down                                                                 |
| `MNEMO_LIVENESS_POOL_STALL_MS`  | `60000`                                 | `/health/live` answers 503 after the pool fails `SELECT 1` this long while a fresh connection works. `0` disables the watchdog |
| `MNEMO_CRON_DISABLE`            | —                                       | Comma-separated job keys the cron registry skips (section 5)                                                                   |
| `MNEMO_SHUTDOWN_GRACE_MS`       | `45000`                                 | Milliseconds the server drains after `SIGTERM`/`SIGINT` before it force-exits (section 6)                                      |

### Federation

| Variable                       | Default | Description                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_FED_PEER_ID`            | —       | This server's federation id: the id other servers register it under, the `iss` of every service JWT it signs and the `aud` it accepts (unless `MNEMO_FED_AUDIENCE` overrides it)                                                                                                                                                    |
| `MNEMO_FEDERATION_PRIVATE_KEY` | —       | Ed25519 private key (PEM) that signs the service JWTs. This server pulls only when both this and `MNEMO_FED_PEER_ID` are set                                                                                                                                                                                                        |
| `MNEMO_FED_CLIENT_CERT_FILE`   | —       | PEM client certificate this server presents when it pulls from https peers (a peer behind a proxy with `ssl_verify_client on` requires one). Issued for this server's federation key. Set together with `MNEMO_FED_CLIENT_KEY_FILE`; a missing pair or an unreadable file stops the boot. See `docs/architecture/MTLS_BOUNDARY.md`. |
| `MNEMO_FED_CLIENT_KEY_FILE`    | —       | PEM private key of that certificate (it can be the same key as `MNEMO_FEDERATION_PRIVATE_KEY`).                                                                                                                                                                                                                                     |
| `MNEMO_FED_CA_FILE`            | —       | PEM CA bundle that verifies peers' TLS certificates on pulls, instead of the system roots. Optional.                                                                                                                                                                                                                                |

---

## 5. Background Jobs

There are no external CronJobs. The server starts an in-process cron registry at boot
(`packages/server/src/boot/crons.ts`, jobs in `packages/server/src/cron/jobs.ts`). Every server
process runs its own registry, but each tick of a job that works on the shared database or Redis
runs on one replica only: the replicas fire at the same wall-clock moment (interval jobs on
multiples of their period) and the first to take a Postgres advisory lock for that job
(`pg_try_advisory_xact_lock`, in a transaction held while the job runs and at least 10 s, or half
the period for shorter intervals, so it holds through pgBouncer's transaction pooling) runs it; the others log `cron.lock_skipped`. A run that outlasts
its period also keeps the next tick off the other replicas. Only `mnemo.meter.persist` runs on
every replica, since it drains that process's own meter queue (`cronScope` in
`packages/server/src/cron/registry.ts`). A failing tick is logged
(`cron.tick_error`) and counted in `mnemo_cron_runs_total`; it never stops the schedule. Under
load, the shedding gate skips lower-priority jobs (`cron.shed_skipped`).
`MNEMO_CRON_DISABLE=mnemo.hot.decay,mnemo.plugin.sync` turns jobs off by key; `mnemo.plugin.sync`
turns off every per-plugin `mnemo.plugin.sync:<id>`, whose default interval is
`MNEMO_PLUGIN_SYNC_INTERVAL_MS` and never less than 1 minute.

Outside the registry, every replica polls the agent policy change log (migration 0067) each
second, so a policy write reaches every replica's cache within about a second even without
Redis and through pgBouncer in transaction mode (`pollPolicyChanges` in
`packages/server/src/middleware/rbac-policy.ts`).

Schedules are in UTC.

| Job                           | Schedule                                       | Condition                                                      |
| ----------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `mnemo.webhook.deliver`       | Every minute                                   | —                                                              |
| `mnemo.session.collapse`      | Every 5 minutes                                | Also runs the managed-session worker                           |
| `mnemo.meter.persist`         | Every 5 minutes                                | —                                                              |
| `mnemo.querycache.evict`      | Every hour                                     | —                                                              |
| `mnemo.hot.decay`             | Every hour                                     | —                                                              |
| `mnemo.audit.merkle.publish`  | Every hour                                     | —                                                              |
| `mnemo.policy.change.purge`   | Every hour                                     | Agent policy change rows older than an hour (migration 0067)   |
| `mnemo.plugin.sync:<id>`      | The plugin's `syncInterval`, by default 1 hour | One per plugin; needs `MNEMO_PLUGIN_<ID>__WORKSPACE_ID`        |
| `mnemo.governance.propagate`  | Daily 02:00                                    | —                                                              |
| `mnemo.retention.purge`       | Daily 02:30                                    | —                                                              |
| `mnemo.reasoning.decay`       | Daily 03:00                                    | —                                                              |
| `mnemo.health.snapshot`       | Daily 03:00                                    | —                                                              |
| `mnemo.semantic.decay`        | Daily 03:15                                    | —                                                              |
| `mnemo.procedural.decay`      | Daily 03:30                                    | —                                                              |
| `mnemo.session.retention`     | Daily 03:30                                    | Only when a retention config resolver is wired                 |
| `mnemo.hot.rebuild`           | Daily 04:00                                    | Needs Redis                                                    |
| `mnemo.idempotency.reap`      | Daily 04:00                                    | —                                                              |
| `mnemo.workspace.graduate`    | Daily 04:00                                    | —                                                              |
| `mnemo.verify.codebase`       | Daily 05:30                                    | —                                                              |
| `mnemo.outbox.purge`          | Daily 05:30                                    | —                                                              |
| `mnemo.plugin.verify`         | Daily 05:45                                    | Plugins with `verify()` and `MNEMO_PLUGIN_<ID>__WORKSPACE_ID`  |
| `mnemo.type.schedule`         | Daily 06:00                                    | —                                                              |
| `mnemo.anticipate.mine`       | Daily 06:30                                    | —                                                              |
| `mnemo.embed.migration`       | Daily 06:45                                    | Does nothing without an embedding provider                     |
| `mnemo.metacognition.refresh` | Daily 07:00                                    | —                                                              |
| `mnemo.task.stale`            | Daily 08:00                                    | —                                                              |
| `mnemo.audit.partition`       | Sundays 01:00                                  | Drops old partitions only with `MNEMO_AUDIT_DROP_ENABLED=true` |
| `mnemo.kek.rotate`            | Sundays 03:00                                  | Does nothing unless `MNEMO_KEK_ROTATE_ENABLED=true`            |
| `mnemo.reasoning.prune`       | Sundays 03:30                                  | —                                                              |
| `mnemo.hebbian.normalize`     | Sundays 04:30                                  | —                                                              |
| `mnemo.composition.validate`  | Sundays 05:00                                  | —                                                              |
| `mnemo.procedural.evaluate`   | Mondays 03:00                                  | —                                                              |
| `mnemo.audit.merkle`          | Tuesdays 02:30                                 | —                                                              |

---

## 6. Graceful Shutdown

On `SIGTERM` or `SIGINT` the server (`packages/server/src/index.ts`):

1. Flushes telemetry (best effort; logs `server.telemetry_flush_timeout` after 5 s).
2. Runs the plugins' shutdown hooks.
3. Stops the reminder poller, the cron registry, the pool-utilization timer, the pool-stall
   watchdog and the outbox worker.
4. Closes the core database pool.
5. Dumps the Redis hot tier into `mnemo_hot_tier_snapshot` (best effort); the next boot loads it
   back into Redis.
6. Closes the Redis connection and stops the consolidation scheduler.
7. Stops the h2c listener from accepting connections (with `MNEMO_GRPC_PORT`) and closes the
   HTTP server: it stops accepting connections and exits `0` once the open ones finish, or `1`
   on a close error.

Steps 1, 2, 4, 5 and 6 start without waiting for each other. If the process is still alive
`MNEMO_SHUTDOWN_GRACE_MS` after the signal (45000 ms by default; a value that is not a positive
whole number makes the server refuse to start), it logs `server.shutdown_force_exit` and exits
`1`. The platforms give it 60 s before killing it, so keep the grace below that:
`kill_timeout = "60s"` in `fly.toml` and `stop_grace_period: "60s"` in
`docker-compose.prod.yml`.

---

## 7. Health Checks and Metrics

All of these are mounted before the API authentication (`packages/server/src/routes/health.ts`,
`packages/server/src/routes/metrics.ts`). Each dependency probe gives up after
`MNEMO_HEALTH_PROBE_TIMEOUT_MS` (3 s).

| Endpoint                                  | Auth                           | Answers                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`                        | None                           | `200 {"status":"alive","pid":...}` without touching dependencies. `503 {"status":"stalled","reason":"db_pool_stalled"}` only when the pool-stall watchdog trips (`MNEMO_LIVENESS_POOL_STALL_MS`)                                                            |
| `GET /healthz`                            | None                           | `200 {"status":"ok"}`                                                                                                                                                                                                                                       |
| `GET /readyz`                             | None                           | Older readiness check: `200` when Postgres answers, `503` otherwise                                                                                                                                                                                         |
| `GET /health/ready`                       | None                           | `503 {"status":"not_ready","reason":"postgres_unavailable"}` with `Retry-After: 5` when Postgres is down. Otherwise `200` with `degraded` and the status of `postgres`, `vector`, `cache` and `embed`; any of the last three not `ok` sets `degraded: true` |
| `GET /health/deep`                        | Bearer key with `memory:admin` | `401` without a valid key, `403` without the scope. Postgres, vector and cache status with latencies, version, uptime and diagnostic blocks (`mode`, `slos`, `hot_tier`, `federation`, `plugins`). Cached 30 s; `503` when Postgres is down                 |
| `GET /canary/slo-gate`                    | None                           | `200 {"allow":true}` or `409 {"allow":false}` from the request error rate and recall p99                                                                                                                                                                    |
| `GET /metrics/prometheus`, `GET /metrics` | `MNEMO_METRICS_TOKEN`          | Prometheus text. With the token set, only `Authorization: Bearer <token>` (anything else `401`). Without it: `404` when `NODE_ENV=production`, open otherwise                                                                                               |

---

## 8. Canary Deployment

`.github/workflows/deploy-canary.yml` is a manual workflow (`workflow_dispatch`) for the Fly
app `mnemosyne`. Inputs: `image_tag` (required) and `slo_observe_seconds` (default `600`).
Secrets: `FLY_API_TOKEN` and `PROMETHEUS_URL`. Without `PROMETHEUS_URL` it stops before
touching any machine.

Fly's proxy spreads requests across the app's started machines with no weighted routing, so the
canary moves machines, not percentages: the share of traffic on the new image is the share of
machines running it (with the two machines `fly.toml` keeps running, one machine is already
half). Before moving anything it records the rollback target: the image most started machines
run other than the new one (it stops if there is none, and later stages refuse a target that is
the new image). Three jobs run in sequence, each one stage of `scripts/canary-rollout.mjs`
(`one`, `half`, `full`), which holds all the logic; the workflow only installs, builds
`@mnemo-ai/core` with its dependencies and calls it:

| Job                       | What it runs                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Canary: 1 machine         | `fly machine update <id> --image registry.fly.io/mnemosyne:<image_tag>` on one machine |
| Canary: half the machines | The same on more machines until half run the new image (none if they already do)       |
| Full rollout              | `fly deploy --strategy rolling` with the new image                                     |

After moving machines each stage waits `slo_observe_seconds` and judges them with
`scripts/canary-slo-check.mjs`. Each
server process publishes `mnemo_build_info{image}` (its `FLY_IMAGE_REF`), and the check joins it
on `instance` to split the 5xx ratio of `mnemo_requests_total` and the p99 of
`mnemo_recall_duration_seconds` between the machines on the new image and the others: at the
same time in the two canary jobs, against the others one hour earlier after the full rollout.
`evaluateCanary` (`packages/core/src/cognitive/canary.ts`) returns `rollback` when the error
ratio is more than 1 percentage point higher or the p99 more than 100 ms higher, and `hold` when
either side has no data. The split needs Prometheus to scrape each machine as its own target;
scraped through the load balancer, or with an image ref that does not carry the tag, the
candidate series is missing and the check holds.

Only `promote` lets the next job run. `rollback`, `hold` or any error after the first machine
moves (a `fly` call that fails, a Prometheus that does not answer) puts every machine back on the
recorded image (`fly deploy --image <previous> --strategy rolling`) and stops; on `hold` the log
says how to retry. Everything that can stop a stage (no `PROMETHEUS_URL`, an image tag PromQL
cannot match safely, no rollback target or one equal to the new image) is checked before the
first `fly` call that changes anything.

**How it is tested.** The workflow has never run against the real Fly app. Its logic runs end to
end in `scripts/__tests__/canary-rollout.test.mjs` (part of `pnpm test:scripts`, which CI runs
after the build): the test puts a fake `fly` on `PATH` (`scripts/__tests__/fake-fly.mjs`, which
keeps machines in a JSON file and answers `fly machine list --json`, `fly machine update` and
`fly deploy`) and serves a fake Prometheus on localhost, then runs the stages in the order and
with the `if:` gates of the workflow, with the real `evaluateCanary`. It covers a full promotion,
a rollback for the SLO at half the machines and at the full rollout, a `hold` that rolls back, a
Prometheus that does not answer, a missing `PROMETHEUS_URL` that stops before any `fly` call, and
a previous image equal to the new one that is refused before any machine moves.
`packages/server/src/__tests__/unit/canaryStages.test.ts` checks that the workflow chains the
stages and passes them the recorded image. The run found that the jobs built `@mnemo-ai/core`
without `@mnemo-ai/types`, whose `dist` the core `dist` imports; they now build through turbo.

---

## 9. Backup and Restore

The repository ships no backup job: back up Postgres with your provider's tools or `pg_dump`.
What the deployment files and the code do keep:

- **Redis.** `redis-master` in `docker-compose.prod.yml` snapshots to its volume
  (`--save 60 1`). The hot tier also survives a graceful restart through
  `mnemo_hot_tier_snapshot` (section 6), and `mnemo.hot.rebuild` reseeds it daily from the
  facts with the highest worth.
- **One workspace, through the API.** `mnemo export` writes the workspace of the API key as
  JSONL (`GET /export/jsonl`); when the export needs approval it prints the approval request id
  and exits `2`. `mnemo import` sends a file to `POST /import`.

```bash
mnemo export > backup.jsonl
mnemo export --approval-request-id <id> > backup.jsonl

mnemo import backup.jsonl --conflict-resolution newest
```

`--conflict-resolution` takes `skip` (the default), `overwrite` or `newest`; `--from <vendor>`
imports another tool's export format.
