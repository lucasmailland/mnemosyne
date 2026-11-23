# @mnemo-ai/server

**English** · [Español](README.es.md)

> **AI pointer:** Hono HTTP server exposing the Mnemosyne API on port 3939. Stateless and horizontally scalable.
>
> **Depends on:** @mnemo-ai/core, @mnemo-ai/types, all adapters (injected), hono
>
> **Exposes:** HTTP API on :3939, /healthz, /recall, /remember, /facts, /entities, etc.
>
> **Status:** MOSTLY STABLE — some routes return 501 when a required provider/adapter isn't configured (e.g. recall without a `vector` and no LLM provider for server-side embedding)
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/architecture/API.md](../../docs/architecture/API.md)

Hono-based HTTP API server for [Mnemosyne](https://github.com/lucasmailland/mnemosyne) — a multi-tenant cognitive memory system for AI applications.

Stateless. Horizontally scalable. Single bearer-token auth scheme. OpenAPI 3.1 spec generated from the same Zod schemas the server uses for runtime validation.

## Install

```bash
pnpm add @mnemo-ai/server @mnemo-ai/core @mnemo-ai/llm-providers
```

`@mnemo-ai/core` and `@mnemo-ai/llm-providers` are **peer dependencies** — pin them yourself.

## Run

```bash
# Required
export MNEMO_DATABASE_URL=postgres://user:pass@host:5432/mnemosyne

# Optional — needed only if you want POST /recall to embed queries server-side
export MNEMO_LLM_PROVIDER=openai     # openai | anthropic | google | cohere | mistral | voyage | local
export MNEMO_LLM_API_KEY=sk-...
export MNEMO_EMBED_MODEL=text-embedding-3-small  # default

# Optional infra
export PORT=3939                      # default
export MNEMO_GRPC_PORT=50051          # off by default; h2c listener for the bidirectional gRPC RPCs
export LOG_LEVEL=info                 # default info in prod, debug in dev
export OTEL_EXPORTER_OTLP_ENDPOINT=https://...   # enables tracing if @opentelemetry/sdk-node is installed
export MNEMO_REDIS_URL=redis://...    # When set, activates the Redis-backed ACT-R hot tier for recall. When unset, recall uses the cold cascade only.

mnemosyne-server
```

## Migrations

The server's tables — API keys included — are created by the `@mnemo-ai/core` migration
stream (e.g. `0063_server_api_keys.sql`, `0064`–`0067` for lookup-hash / expiry / scopes / plan).
There is **no** separate server migration file. Apply every migration with the core migrator
(`mnemo-migrate`, which reads `DATABASE_URL`) before starting the server:

```bash
# Applies every @mnemo-ai/core migration, including the API-key tables.
DATABASE_URL="$MNEMO_DATABASE_URL" npx mnemo-migrate
```

## Endpoints

All authenticated endpoints require `Authorization: Bearer mns_live_<key>`.

| Method | Path                  | Description                                  |
| ------ | --------------------- | -------------------------------------------- |
| POST   | `/recall`             | Blended lexical + vector recall              |
| POST   | `/remember`           | Create a fact                                |
| GET    | `/facts/:id`          | Fetch a fact                                 |
| POST   | `/facts/:id/pin`      | Pin / unpin                                  |
| DELETE | `/facts/:id`          | Soft-delete (closes the bitemporal interval) |
| GET    | `/timeline?since=...` | Recent fact-lifecycle events                 |
| GET    | `/health`             | Workspace cognitive vitals                   |
| GET    | `/openapi.json`       | OpenAPI 3.1 spec                             |
| GET    | `/docs`               | Human-readable docs (Scalar)                 |
| GET    | `/healthz`            | Liveness probe (no auth)                     |
| GET    | `/readyz`             | Readiness probe (no auth, pings DB)          |

### POST /recall

```jsonc
// request
{
  "query": "What did we decide about pricing tiers?",
  "vector": [0.01, -0.02, ...],   // optional; server embeds if absent
  "topK": 10,
  "vectorWeight": 0.5,             // 0 = lexical, 1 = vector
  "asOf": "2026-06-04T12:00:00Z"   // optional; bitemporal as-of
}

// response
{
  "hits": [{ "id": "fact_...", "content": "...", "score": 0.91, ... }],
  "debug": { "embedded": false, "latencyMs": 12 }
}
```

If no `vector` is supplied **and** no LLM provider is configured, recall returns **501 Not Implemented** with an actionable error message.

## Auth flow

1. Operator issues a key via your admin pipeline (CLI / dashboard / SQL). Key format: `mns_live_<32-char-cuid>`.
2. Server stores **only** `bcrypt(key)` in `mnemo_api_keys.key_hash`.
3. On each request, the bearer middleware:
   - Validates the prefix shape (fail fast, no bcrypt cost).
   - Checks an in-process LRU cache (60s TTL) keyed by plaintext token.
   - On miss, walks active hashes and `bcrypt.compare`s.
   - Caches the `{token -> workspace_id}` mapping.

The 60 s TTL is a deliberate cap on revocation latency. If you raise it, build pub/sub invalidation too.

## Embedding the server in your own Hono tree

```ts
import { createApp } from "@mnemo-ai/server";

const app = createApp({
  deps: { core, apiKeys, llm, embedModel: "text-embedding-3-small" },
  version: "0.1.0",
});

export default app; // works with serve, Vercel, Cloudflare Workers (Node compat), etc.
```

## Observability

- **Logs**: pino, JSON in prod, optionally pretty in dev (`PINO_PRETTY=1`). Every request logs `{ method, path, status, latency_ms, request_id, workspace_id }`. Authorization headers are redacted by default.
- **Tracing**: opt-in. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and install `@opentelemetry/sdk-node` in your image.
- **Request id**: echoed back in `X-Request-Id`. Honoured from the incoming header if the caller set it (good citizenship in tracing pipelines).

## Docker

```bash
docker build -f docker/Dockerfile.server -t mnemosyne-server:0.1.0 .
docker run --rm -p 3939:3939 \
  -e MNEMO_DATABASE_URL=postgres://... \
  mnemosyne-server:0.1.0
```

Non-root user, multi-stage build, `HEALTHCHECK` against `/healthz`. For a full
local stack (Postgres + migrate + server) use `docker/docker-compose.yml`.

## License

Apache-2.0 — see `LICENSE` at the monorepo root.
