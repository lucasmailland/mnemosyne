# Mnemosyne — Docker stack

**English** · [Español](README.es.md)

> **Scope:** Dockerfiles + Compose for local development and self-hosted production.
> For platform-specific configs (Railway, Fly.io, etc.) see [`deploy/`](../deploy/README.md).
> For day-2 runbooks (monitoring, backup, upgrades) see [`docs/deploy/`](../docs/deploy/OPERATIONS.md).
> Entry point: [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).

A one-command, self-hostable deployment of Mnemosyne: Postgres + pgvector +
`@mnemo-ai/server`. Works for local development and small production
deployments.

> If you just want to try Mnemosyne, follow [Quickstart](#quickstart).
> If you want to understand the moving parts, jump to [Architecture](#architecture).

---

## Local Development

The committed `docker-compose.override.yml` is auto-merged by Compose v2 when
you run `docker compose up` from the `docker/` directory. It sets the
dev-posture flags so the server starts without a master key or a non-superuser
DB role. It does not choose a model API: the server runs on whichever provider
you put in `.env` (see [Choose a model API](#choose-a-model-api)).

`.env` is NOT committed (the repo's `.gitignore` excludes it). Create it from
`.env.example`; it is what sets `PORT=3939`, so the server maps to
`http://localhost:3939` (avoiding conflicts with other services on `:3000`).

No `-f` flags needed — Compose v2 picks up `docker-compose.override.yml`
automatically.

If `5432` or `6379` are already taken on your machine, set `POSTGRES_PORT` /
`REDIS_PORT` in `.env` rather than editing the compose file.

---

## Quickstart

```bash
cd docker
cp .env.example .env
$EDITOR .env    # uncomment one model block and paste its key
docker compose up -d --build
```

### Choose a model API

Mnemosyne has no default model. `.env.example` has ready blocks; uncomment one:

| Block | Completions                                   | Embeddings                      | Keys                    |
| ----- | --------------------------------------------- | ------------------------------- | ----------------------- |
| A     | OpenAI `gpt-4o-mini`                          | OpenAI `text-embedding-3-small` | one OpenAI key          |
| B     | Google `gemini-2.5-flash`                     | local `bge-m3` (block D)        | one Gemini key          |
| C     | Anthropic `claude-haiku-4-5`                  | Voyage `voyage-3.5`             | Anthropic + Voyage keys |
| D     | local Ollama, model of your choice (optional) | local `bge-m3`                  | none                    |

Anthropic has no embeddings API, hence Voyage in block C. Gemini's embedding
models return 768 or 3072 dimensions, widths the schema has no table for, hence
`bge-m3` in block B. Cohere, Mistral and Bedrock work the same way through
`MNEMO_LLM_PROVIDER` / `MNEMO_LLM_API_KEY` / `MNEMO_LLM_MODEL`; set the model
every time, since the compose file otherwise passes `gpt-4o-mini` whatever the
provider.

**With no provider at all** the server still starts. Its log says what is
missing (`llm.no_completion_provider`, `embed.no_provider`), `/health/ready`
reports `"embed":"degraded"`, recall falls back to full-text search, and a
write without a precomputed `vector` answers 501 until you configure an
embedder. Completions alone are optional: with an embedder and no completion
model, writes and semantic recall work, while session collapse, conflict checks
and rerank stay off.

### Local models (opt-in)

The bundled Ollama service starts only with the `local` profile, and nothing is
pulled or chosen for you:

```bash
docker compose --profile local up -d --build
docker exec mnemosyne-ollama ollama pull bge-m3    # embeddings, 1024 dims, MIT licence
```

Then uncomment block D in `.env` and run `docker compose --profile local up -d`
again. `bge-m3` is the suggested local embedder: it is MIT-licensed and, on a
bilingual corpus, found English facts from Spanish queries where
`mxbai-embed-large` did not. Block D also carries its tuning: 1024 dimensions,
`MNEMO_REMINDER_SEMANTIC_THRESHOLD=0.55`, a 10-second embed timeout, 4 Ollama
threads (more made each embedding slower inside Docker) and warm-up at boot.

A local completion model is your choice, and so is its licence: check that it
fits your use before you pull it. `qwen2.5:3b`, the model this stack used to
pick, is under the Qwen Research License, which does not allow commercial use.

> **Don't pick the completion model for its size alone.** It is not only
> answering questions — session collapse hands it a conversation and writes
> whatever it returns into `mnemo_fact` / `mnemo_decision`, where it is
> embedded, indexed, and served to future recalls as knowledge. `qwen2.5:0.5b`
> returned two decisions with the same title from one session, bodies with no
> content, and on one run a statement that asserted the opposite of the
> conversation it came from. A model too small for extraction does not fail
> loudly — it quietly writes things that are wrong and durable. Collapse must
> also finish inside the 30-second `llm.generate` circuit breaker.

The server is now live on `http://localhost:3939`. Health check:

```bash
curl http://localhost:3939/health/live
# -> {"status":"alive","pid":1}

curl http://localhost:3939/health/ready
# -> {"status":"ready","degraded":false,
#     "checks":{"postgres":"ok","vector":"ok","cache":"ok","embed":"ok"}}
```

### Generate your first API key

The first key has to come from the terminal — the HTTP API cannot mint it,
because every route that could is itself authenticated:

```bash
docker compose exec server node scripts/create-api-key.cjs --label "my laptop"
# -> mns_live_a3f9k2x...    (this is printed exactly once — copy it now)
```

`--workspace` is optional; omit it and a fresh workspace UUID is generated. If
you do pass it, it must be a **UUID** — the v3 runtime casts `workspace_id` to
`::uuid`, so a name like `ws_default` is rejected by the script rather than
producing HTTP 500s later.

> The browser page at `http://localhost:3939/setup` is NOT a bootstrap path on a
> virgin instance: `POST /setup` requires a bearer token, and `POST /bootstrap`
> adopts a key you already hold rather than issuing one. Mint the key above
> first; `GET /bootstrap/status` reports `{"bootstrapped":false}` until you do.
>
> `POST /bootstrap` (and the dashboard's first-run page, which calls it) needs
> the **setup token**: the server prints it in its log when it starts with no
> keys (`docker compose logs server | grep setup`), and it is valid for 15
> minutes. It is never served over the network: `GET /setup/token` answers only
> to the server's own loopback
> (`docker compose exec server wget -qO- http://localhost:3939/setup/token`).
> For unattended provisioning set `MNEMO_SETUP_TOKEN` (16 characters or more)
> and send that value instead; it stops mattering once the first key exists.

Use it via cURL. Writes go to `/remember` (there is no `POST /facts` — `/facts`
is the read/list route), and the field is `statement`, not `content`:

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

The full route list is served at `GET /openapi.json` (authenticated).

### Access the Web Dashboard

Open `http://localhost:3939/dashboard` in your browser. Paste your API key (`mns_live_...`) into the API Key gate to log in and monitor health, metrics, LLM config, and manage API keys. This is the small operator page the server itself serves.

The full Next.js dashboard (memories, sessions, graph, members) signs in through the server, which only mounts those routes when `MNEMO_DASHBOARD_SECRET` is set (at least 32 bytes; `openssl rand -hex 32`). Add it to `.env`, run `docker compose up -d --build` again (it rebuilds images after a `git pull`), and start the dashboard as the [root README](../README.md#open-the-dashboard) shows. The local override already lets its cookie travel over plain `http://localhost`.

With block D, wait until `/health/ready` reports `"embed":"ok"` after pulling `bge-m3`, before the first recall.

---

## Architecture

Five services orchestrated by `docker-compose.yml`:

| Service    | Image                           | Purpose                                                                        |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------ |
| `postgres` | `pgvector/pgvector:pg17`        | Storage + vector search. Volume `mnemosyne-pgdata` persists data.              |
| `redis`    | `redis:7-alpine`                | Session/episode operations and the ACT-R hot tier. Server waits for healthy.   |
| `migrate`  | built from `Dockerfile.migrate` | Runs both migration streams once and exits. Server waits for exit 0.           |
| `server`   | built from `Dockerfile.server`  | The `@mnemo-ai/server` HTTP API. Exposes `PORT` (default `:3939`).             |
| `ollama`   | `ollama/ollama:latest`          | Opt-in (`--profile local`) local models. They live in `mnemosyne-ollama-data`. |

Why separate `migrate` from `server`? See the comments at the top of
`docker-compose.yml` — short version: failed migrations should be visible in
`docker compose ps`, not hidden inside a crash-looping server.

### Why `pgvector/pgvector:pg17` and not `postgres:17`?

Mnemosyne stores embeddings as `vector(N)` columns. The pgvector image ships
the extension preinstalled; vanilla Postgres would force a custom Dockerfile.

---

## Role provisioning (production)

The migrate container automatically creates a NOSUPERUSER/NOBYPASSRLS PostgreSQL
login role after migrations complete. This role is what the server connects as in
production — it cannot bypass row-level security policies, so workspace isolation
is enforced at the DB layer.

**Required secret:**

```bash
# Set before first deploy:
export MNEMO_APP_DB_PASSWORD="$(openssl rand -base64 32)"
export MNEMO_MIGRATION_DATABASE_URL="postgres://admin:<password>@postgres:5432/mnemo"
```

`MNEMO_MIGRATION_DATABASE_URL` must point directly to PostgreSQL or to a
session-mode pool. Transaction-mode pooling is incompatible with the migration
runner's session advisory lock. The production entrypoint never falls back to
the server's `DATABASE_URL` and rejects the known `pgbouncer` service hostname.
A URL cannot prove a provider's pool mode, so deployments using another pooler
must still select its direct or session-pooled endpoint explicitly.

The migrate service reads `MNEMO_APP_DB_PASSWORD` and creates role `mnemo_app` (or
`$MNEMO_APP_DB_USER` if overridden) with grants into `mnemo_app_role`, `app_user`,
and `app_org_user`. The server's `DATABASE_URL_PROD` must then point to this role:

```
DATABASE_URL_PROD=postgres://mnemo_app:<MNEMO_APP_DB_PASSWORD>@pgbouncer:5435/mnemo
```

It also sets the role's session defaults in that database (`search_path` and the
`MNEMO_PG_*_TIMEOUT_MS` limits, 60 s / 15 s / 60 s unless set in `.env`, which the production
overlay passes to the migrate service and the server).
The server sends the same values as startup parameters; the production overlay's
pgBouncer drops those (it cannot carry them to pooled sessions), so behind it the
session takes them from the role.

The server rejects superuser connections at boot (`assertSafeDbRole` in
`packages/core/src/factory.ts`). If the role is misconfigured the server exits
with a clear error message.

**Local development:** Set `MNEMO_ALLOW_UNSAFE_DB_ROLE=true` (the committed
`docker-compose.override.yml` already does this). The migrate container skips role
provisioning when `MNEMO_APP_DB_PASSWORD` is unset, so the server connects as the
`mnemo` superuser with the guard suppressed. The override also sets
`NODE_ENV=development`: with `NODE_ENV=production` (the image default) the server refuses to
start while `MNEMO_ALLOW_UNSAFE_DB_ROLE` or `MNEMO_DASHBOARD_INSECURE_COOKIE` is `true`.

---

## Configuration

All knobs are in `.env`. See `.env.example` for the full list with comments.
The ones you'll actually change:

| Variable                            | Default                                      | Notes                                                                                             |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `MNEMO_LLM_PROVIDER`                | _(unset)_                                    | `openai` \| `anthropic` \| `google` \| `cohere` \| `mistral` \| `voyage` \| `bedrock` \| `ollama` |
| `MNEMO_LLM_API_KEY`                 | _(unset)_                                    | Every provider but `ollama`. Unset, the server starts and logs what is missing.                   |
| `MNEMO_EMBED_PROVIDER`              | _(unset → `MNEMO_LLM_PROVIDER`)_             | A second provider for embeddings (Voyage, Ollama, ...), with `MNEMO_EMBED_API_KEY`.               |
| `MNEMO_EMBED_MODEL`                 | `text-embedding-3-small`                     | Changing this requires re-embedding existing memories, and re-checking the floors below.          |
| `MNEMO_EMBED_DIMENSIONS`            | _(unset → 1536, 1024 on Bedrock)_            | The model's real width: 1024, 1536, 2048 or 4096.                                                 |
| `MNEMO_REMINDER_SEMANTIC_THRESHOLD` | _(unset → 0.7)_                              | Cosine floor for a reminder's semantic trigger. Belongs to the EMBEDDING MODEL — see below.       |
| `DATABASE_URL`                      | `postgres://mnemo:mnemo@postgres:5432/mnemo` | Point at an external Postgres if you don't want the bundled one (must have pgvector).             |
| `PORT`                              | `3939`                                       | Server listens here; compose forwards to host.                                                    |

### Changing the embedding model changes more than the vectors

Two things travel with the model, and only the first is obvious.

**Dimension** must be one the schema declares — 1024, 1536, 2048 or 4096.
`mnemo_fact.embedding` is an unconstrained `halfvec`, so any width is accepted on
write while `DELETE /facts/:id` then 500s forever. nomic-embed-text (768) did
exactly that; see P117.

**Cosine scale** is model-specific, and every hardcoded similarity floor is
calibrated against one scale. bge-m3 sits ~0.16 below mxbai-embed-large on the
same pairs, which is enough to push a should-fire reminder (0.6334) under the
default 0.7 floor. Nothing throws when that happens: the reminder simply stops
triggering, and a reminder that never fires is indistinguishable from one with
nothing to match. `MNEMO_REMINDER_SEMANTIC_THRESHOLD` exists so the floor can be
set alongside the model — block D of `.env.example` pairs `bge-m3` with `0.55`.

Re-embedding itself is automatic: `listStaleEmbeddings` selects rows whose
`embedding_model` differs from the configured one, and the `mnemo.embed.migration`
cron (06:45 UTC) drains them. While rows are still on the old model, recall
reweights toward full-text (0.7 FTS / 0.3 vector) rather than comparing vectors
across models.

---

## Common operations

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

## Using an external Postgres

Skip the bundled `postgres` service and point `DATABASE_URL` at your own
instance — but ensure the `vector` extension is installed:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

You can then run just the server + migrate:

```bash
docker compose up -d --build migrate server
```

---

## Production notes

- **TLS termination** is not handled in this stack. Put a reverse proxy
  (Caddy, nginx, Traefik) in front of `:3939` (or whatever `PORT` is set to).
- **Postgres exposure**: the default `docker-compose.yml` publishes
  `5432:5432` for convenience. The production overlay publishes Postgres, Redis,
  pgBouncer, Ollama (only with `--profile local`) and the collector on `127.0.0.1` only and
  requires `POSTGRES_PASSWORD`.
- **Backups**: the `mnemosyne-pgdata` named volume is your source of truth.
  Use `pg_dump` on a schedule.
- **Multi-instance**: the server is stateless; you can scale it horizontally
  behind a load balancer as long as all replicas point at the same Postgres.
- **Web dashboard**: `docker-compose.prod.yml` also builds and runs the Next.js
  dashboard. It needs `MNEMO_DASHBOARD_SECRET` on the server, HTTPS, and an edge
  proxy that sends `/dashboard/*` to it; see
  [`docs/guides/PRODUCTION_DEPLOY.md`](../docs/guides/PRODUCTION_DEPLOY.md).

---

## Troubleshooting

**`migrate` exits with `relation "vector" does not exist`** → You're pointing
at a Postgres without pgvector. Install the extension or use the bundled image.

**`server` health check fails** → `docker compose logs server`. A missing
model API does not stop the server (it logs `llm.no_completion_provider` /
`embed.no_provider` and keeps running); a malformed setting does, and the log
names it (for example `MNEMO_EMBED_DIMENSIONS` outside 1024/1536/2048/4096).

**`/health/ready` says `"embed":"down"` or writes answer `embeddingDeferred`**
→ the embedder is configured but not answering: a wrong key, a model Ollama
has not pulled, or block D without `--profile local`.

**Port 5432 already in use** → Either stop your host Postgres or set
`POSTGRES_PORT=5433` in `.env`.
