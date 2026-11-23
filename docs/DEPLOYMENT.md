# Deployment — Choose Your Path

**English** · [Español](DEPLOYMENT.es.md)

This is the single entry point for all deployment documentation.

## Three directories, three roles

```
docker/          ← Reference stack: Dockerfiles + Compose for local dev and self-hosting
deploy/          ← Platform-specific configs (Railway, Fly.io, Render, etc.)
docs/deploy/     ← Runbooks: day-2 operations, monitoring, backup/restore
```

Each directory has a README that explains exactly what it owns and what it does NOT. Use the table below to navigate.

| I want to…                                             | Go to                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| **Try Mnemosyne locally**                              | [`docker/README.md`](../docker/README.md) — Quickstart section          |
| **Deploy to a VPS with Docker Compose**                | [`docker/README.md`](../docker/README.md) — Production section          |
| **Run the server and the web dashboard in production** | [`docs/guides/PRODUCTION_DEPLOY.md`](guides/PRODUCTION_DEPLOY.md)       |
| **Deploy to Railway**                                  | [`deploy/README.md`](../deploy/README.md) — Railway section             |
| **Prebuilt Docker images (none published today)**      | [`deploy/README.md`](../deploy/README.md) — Prebuilt images section     |
| **Monitor a running instance**                         | [`docs/deploy/OPERATIONS.md`](deploy/OPERATIONS.md)                     |
| **Understand the service architecture**                | [`docs/deploy/SERVICES.md`](deploy/SERVICES.md)                         |
| **Run database migrations**                            | [`docker/README.md`](../docker/README.md) — Migrations section          |
| **Add a new deployment target**                        | [`deploy/README.md`](../deploy/README.md) — Adding more targets section |

## What ships

The deployment surface is two Docker images:

| Image               | Built from                  | Purpose                   |
| ------------------- | --------------------------- | ------------------------- |
| `mnemosyne-server`  | `docker/Dockerfile.server`  | The HTTP API server       |
| `mnemosyne-migrate` | `docker/Dockerfile.migrate` | One-shot migration runner |

No images are published today: GitHub Actions is off for this repository, so the old
`docker-publish.yml` workflow does not run (see [RELEASING.md](RELEASING.md), step 7). Build
them yourself from the commit you deploy, from the repository root:

```bash
docker build -f docker/Dockerfile.server -t mnemosyne-server .
docker build -f docker/Dockerfile.migrate -t mnemosyne-migrate .
# or every image the compose stack uses:
pnpm docker:build
```

The web dashboard has its own image, built from `docker/Dockerfile.dashboard`; see
[PRODUCTION_DEPLOY.md](guides/PRODUCTION_DEPLOY.md).

### Ports

The server listens on `PORT`. The image defaults to `3000`. The base compose file
(`docker/docker-compose.yml`) sets `PORT=3939` and publishes `3939`; the production overlay
(`docker/docker-compose.prod.yml`) runs the server on `3000` and publishes host `PORT` (default
`3000`) to it.

The local stack publishes every port on `127.0.0.1` only: the server, Postgres, Redis and,
with `--profile local`, Ollama. `MNEMO_BIND=0.0.0.0` publishes the server to the network; do that only behind TLS, with
the production overlay. `OLLAMA_PORT` moves the published Ollama port off `11434` when one
already runs on the host (the server reaches Ollama on the compose network either way).

### Security-relevant settings

| Variable                              | Default               | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MNEMO_SETUP_TOKEN`                   | unset                 | Registering the first API key (`POST /bootstrap`, the dashboard's first-run page) needs a setup token. By default the server prints one in its log at startup, single use, valid 15 minutes. Set a fixed one (16+ characters) only for unattended provisioning; shorter values are ignored.                                                                                                                                                      |
| `MNEMO_WEBHOOK_ALLOW_HTTP`            | off                   | Webhooks are delivered over https only. `true` allows http.                                                                                                                                                                                                                                                                                                                                                                                      |
| `MNEMO_WEBHOOK_ALLOW_PRIVATE`         | off                   | Webhooks never go to a loopback, private, link-local, carrier-NAT, multicast or unspecified address, written literally or reached through DNS. Checked at registration and before every delivery. `true` allows internal receivers.                                                                                                                                                                                                              |
| `MNEMO_TRUSTED_PROXY_IP`              | unset                 | Comma list of proxy addresses whose `X-Forwarded-For` is believed for the client IP (IP allowlists, login limiter, audit log); the client is the rightmost hop that is not a proxy. Unset: any peer on a loopback, private or link-local address counts as a proxy, which is wrong behind a NAT that rewrites the source (Kubernetes `externalTrafficPolicy: Cluster`, Docker Desktop, rootless Docker); the server warns at boot in production. |
| `MNEMO_TRUSTED_PROXY_HEADER`          | unset                 | A single-address header your proxy sets and overwrites, such as `cf-connecting-ip` behind Cloudflare or `x-real-ip`. Read only from a trusted proxy, and only when named here: a proxy that does not set it passes the client's own copy through.                                                                                                                                                                                                |
| `MNEMO_IMPORT_MAX_DECOMPRESSED_BYTES` | `536870912` (512 MiB) | Most a `POST /import` body may inflate to. The import body itself is limited to 100 MiB; every other route to 1 MiB.                                                                                                                                                                                                                                                                                                                             |
| `MNEMO_EMBED_TIMEOUT_MS`              | `3000`                | How long one embedding may take before a write is stored without a vector and recall falls back to full-text. The local Ollama block in `docker/.env.example` uses `10000`.                                                                                                                                                                                                                                                                      |
| `MNEMO_SENSITIVITY_CEILING`           | `internal`            | Highest tier any key of this server may read or write. A key can only lower it. With the default, `confidential` and `restricted` memories cannot be used at all.                                                                                                                                                                                                                                                                                |
| `MNEMO_MASTER_KEY`                    | unset                 | 64 hex characters (`openssl rand -hex 32`). Needed to store `confidential` and `restricted` memories, which are encrypted; without it such a write is refused with 422 `encryption_not_configured`, never stored as plaintext. Required at boot when `NODE_ENV=production` or `MNEMO_REQUIRE_ENCRYPTION=true`.                                                                                                                                   |
| `MNEMO_KEY_PEPPER`                    | empty                 | Secret key of the HMAC that finds an API key in one lookup (`openssl rand -hex 32`); required in production. Stored lookups are keyed with the pepper they were written under: to change it, set the old value (empty if there was none) in `MNEMO_KEY_PEPPER_PREVIOUS` and keep it until every key has been used once, since each is re-keyed on its next use. Changing it without that locks every existing key out.                           |

## Minimum dependencies

Every deployment path requires:

- **Postgres** with the `pgvector` extension (or any Postgres-compatible host that has it)
- `DATABASE_URL` environment variable
- A model API of your choice. None is chosen by default: set `MNEMO_LLM_PROVIDER`, `MNEMO_LLM_API_KEY`
  and `MNEMO_LLM_MODEL` for completions, and `MNEMO_EMBED_PROVIDER` / `MNEMO_EMBED_API_KEY` /
  `MNEMO_EMBED_MODEL` / `MNEMO_EMBED_DIMENSIONS` when embeddings come from another provider
  (Anthropic has none). `docker/.env.example` has ready blocks for OpenAI, Gemini, Anthropic with
  Voyage, and a local Ollama (opt-in with `--profile local`; no completion model is chosen for
  you, so check the licence of the one you pick). A local Ollama needs no key.
  With no provider the server still starts and logs what is missing (`llm.no_completion_provider`,
  `embed.no_provider`). Without an embedder, recall falls back to full-text search
  (`debug.searchMode: "fts"`), an explicit `mode: "semantic"` answers 503
  `semantic_search_unavailable`, and a write without a precomputed `vector` answers 501.
  For tests without a key, `MNEMO_EMBED_STUB=true` embeds with a hash, which carries no meaning.

The migrate image must run successfully before the server boots.
The Docker Compose stack in `docker/` handles this ordering via `service_completed_successfully`.

## Schemas & migration streams

The server runs **two Postgres migration streams** into **two schemas**, but
every HTTP route and background task is served exclusively by the v3
`mnemosyne` schema (flatten-legacy-dual-core Phase 7 deleted the legacy
`CoreLike`/`factory.ts` client — there is no more dual-core hybrid runtime):

| Schema      | Provisioned by                                                                  | Used by                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `public`    | `packages/core/migrations/` (core's `mnemo-migrate` CLI)                        | Legacy auth table (`public.mnemo_api_keys`) only — kept for backward-compat with pre-v3 deployments, not read by any route |
| `mnemosyne` | `packages/adapter-postgres/migrations/baseline/` (adapter-postgres migrate CLI) | Everything — every HTTP route, `DrizzleStorageAdapter`, reminders, session collapse, consolidation background tasks        |

The `mnemosyne-migrate` image applies **both** streams in order (legacy first,
then v3), so a single run provisions every table the runtime touches. Both
streams are idempotent. Running the legacy stream remains required — the auth
bootstrap (`api-key-lookup.ts`) and RLS foundation roles it creates are still
load-bearing — but its `public`-schema tables are no longer a live data path.

### Upgrading an existing deployment

Older deployments only had the `public` schema (the migrate image previously ran
the legacy stream alone), which left the v3 background tasks broken at runtime.
To upgrade, just run the new migrate image against the existing database:

```bash
docker compose up migrate
# or:
docker run --rm \
  -e MNEMO_MIGRATION_DATABASE_URL=postgres://admin:password@postgres:5432/mnemo \
  mnemosyne-migrate
```

The migration URL must be a direct PostgreSQL or session-pooled endpoint.
Transaction-mode pooling is unsupported because the migration lock is owned by
one PostgreSQL backend session. The Docker entrypoint does not fall back to the
application `DATABASE_URL`; URL inspection can reject known PgBouncer hosts but
cannot prove an arbitrary provider's pool mode.

The legacy stream re-applies as a no-op (all migrations already recorded) and the
v3 stream adds the `mnemosyne` schema. **No data migration is required** — the v3
background-task tables start empty. (Migrating legacy v2 _fact_ data into the v3
primitives is a separate, optional concern handled by `@mnemo-ai/cup`'s
`mnemo-migrate` CLI; see `packages/cup/README.md`.)
