# Local Dev Setup (Postgres only, server process)

**English** · [Español](LOCAL_DEV_SETUP.es.md)

Use this guide when `pnpm docker:up` fails or you want a faster dev loop without
building Docker images. You run Postgres + Redis in containers and the server as
a local Node process.

---

## When to use this guide

`pnpm docker:up` builds the `server` and `migrate` images from scratch. On
resource-constrained machines (< 4 GB RAM available to Docker), the TypeScript
compilation inside the container hits the Node heap limit and fails with:

```
Error [ERR_WORKER_OUT_OF_MEMORY]: Worker terminated due to reaching memory limit
```

The workaround is to skip the Docker build for those services and run them
natively — the binaries are already compiled in your local `packages/*/dist/`.

---

## Prerequisites

- Docker Desktop running (for Postgres + Redis)
- `pnpm install` already run at repo root
- `pnpm build` already run at least once (produces `packages/*/dist/`)

### macOS — Docker socket path

Docker Desktop on macOS uses a non-standard socket location. If you get:

```
Cannot connect to the Docker daemon at unix:///var/run/docker.sock
```

Set the socket explicitly in your shell (or add to `~/.zshrc`):

```bash
export DOCKER_HOST=unix://$HOME/.docker/run/docker.sock
```

All `docker` and `docker compose` commands in this guide assume that is already
set if you are on macOS with Docker Desktop.

---

## Step 1 — Start Postgres and Redis

The server needs both Postgres and Redis. Start them together:

```bash
docker compose -f docker/docker-compose.yml up -d postgres redis
```

Verify:

```bash
docker exec mnemosyne-postgres pg_isready -U mnemo -d mnemo
# mnemosyne-postgres:5432 - accepting connections

docker exec mnemosyne-redis redis-cli ping
# PONG
```

> **Why not `up -d postgres` only?** The server's session pipeline, rate-limiter,
> and cache require Redis. Without it the server starts but some operations fail.

---

## Step 2 — Apply migrations

```bash
DATABASE_URL=postgres://mnemo:mnemo@localhost:5432/mnemo \
  pnpm --filter @mnemo-ai/adapter-postgres migrate
```

This runs the v3 migration stream and creates the `mnemosyne` schema.
The command is idempotent — safe to re-run.

---

## Step 3 — Start the server

Two required env flags that the guide previously omitted:

- **`MNEMO_ALLOW_UNSAFE_DB_ROLE=true`** — the bundled Postgres image uses the
  `mnemo` user with `rolsuper=true`. The server blocks superuser connections by
  default to protect RLS. This flag suppresses that check for local dev; never
  set it in production.
- **`MNEMO_EMBED_STUB=true`** — without an LLM API key, semantic recall returns 501. This flag makes the server boot cleanly and use stub embeddings instead.
  Full vector recall won't work but everything else does.

```bash
DATABASE_URL=postgres://mnemo:mnemo@localhost:5432/mnemo \
  MNEMO_REDIS_URL=redis://localhost:6379 \
  MNEMO_ALLOW_UNSAFE_DB_ROLE=true \
  MNEMO_EMBED_STUB=true \
  PORT=3939 \
  LOG_LEVEL=info \
  node packages/server/dist/index.js >> /tmp/mnemosyne-server.log 2>&1 &
```

If you have an LLM API key, add it and drop `MNEMO_EMBED_STUB`:

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

Verify it is up:

```bash
curl http://localhost:3939/health/ready
# {"status":"ready","degraded":false,"checks":{"postgres":"ok","vector":"ok","cache":"ok"}}
```

> **Note on `PORT`:** the local server defaults to `3939`. The full Docker stack
> uses `3000`. The MCP client config must match whichever port you use.

---

## Provider configuration

The server supports five optional environment variables for splitting the LLM
completion provider from the embedding provider, and for routing vector traffic
to a dedicated database.

| Variable               | Purpose                                                                                | Fallback                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_EMBED_PROVIDER` | Embedding provider name (`voyage`, `nvidia`, `openai`, etc.)                           | Falls back to `MNEMO_LLM_PROVIDER`                                                                                  |
| `MNEMO_EMBED_API_KEY`  | API key for the embed provider                                                         | Required when `MNEMO_EMBED_PROVIDER` is set; logged as a warning and falls back to `MNEMO_LLM_PROVIDER` when absent |
| `MNEMO_EMBED_BASE_URL` | Base URL for self-hosted embed endpoints (e.g. a local Voyage or NVIDIA NIM instance)  | No default; uses the provider's standard endpoint                                                                   |
| `MNEMO_LLM_BASE_URL`   | Base URL override for LLM completions (e.g. Azure OpenAI, NVIDIA NIM, a local proxy)   | No default; uses the provider's standard endpoint                                                                   |
| `MNEMO_VECTOR_URL`     | Separate pgvector connection string for deployments with a dedicated vector DB replica | Falls back to `DATABASE_URL`                                                                                        |

All five variables are optional. Removing them after deployment restores pre-change
behavior — there are no schema changes and no data transformations.

### Examples

Use Voyage AI for embeddings and OpenAI for completions:

```bash
MNEMO_LLM_PROVIDER=openai \
MNEMO_LLM_API_KEY=sk-... \
MNEMO_EMBED_PROVIDER=voyage \
MNEMO_EMBED_API_KEY=pa-... \
```

Use an NVIDIA NIM endpoint for embeddings (nvidia alias maps to OpenAI-compatible API):

```bash
MNEMO_EMBED_PROVIDER=nvidia \
MNEMO_EMBED_API_KEY=nvapi-... \
```

Override the LLM endpoint (e.g. Azure OpenAI):

```bash
MNEMO_LLM_PROVIDER=openai \
MNEMO_LLM_API_KEY=<azure-key> \
MNEMO_LLM_BASE_URL=https://<your-resource>.openai.azure.com/openai/deployments/<deployment> \
```

Route vector traffic to a dedicated replica:

```bash
MNEMO_VECTOR_URL=postgres://vector-user:pass@vector-host:5432/vectors \
```

> **Warning — embedding dimension mismatch**: If you change `MNEMO_EMBED_PROVIDER`
> on an existing database, the new model may produce vectors of a different dimension
> than the ones already stored (e.g. switching from OpenAI 1536-dim to Voyage 1024-dim).
> The pgvector column is sized at creation time. Mismatched dimensions cause insert
> errors. This is operator responsibility — re-index all vectors after switching
> providers if dimensions differ.

### Completion provider per task

Every completion the engine makes declares one of four tasks. Three of them can
run on their own provider:

| Task        | Engine calls                                                | Variables                                                                      |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `judge`     | conflict classification, recall rerank, reminder conditions | `MNEMO_LLM_JUDGE_PROVIDER`, `MNEMO_LLM_JUDGE_MODEL`, `MNEMO_LLM_JUDGE_API_KEY` |
| `summary`   | session collapse, `POST /capture` extraction, compression   | `MNEMO_LLM_SUMMARY_PROVIDER`, `_MODEL`, `_API_KEY`                             |
| `prefilter` | HyDE and anticipation queries, before retrieval             | `MNEMO_LLM_PREFILTER_PROVIDER`, `_MODEL`, `_API_KEY`                           |
| `default`   | replay query generation, warm-up, health checks             | `MNEMO_LLM_PROVIDER`, `MNEMO_LLM_MODEL`, `MNEMO_LLM_API_KEY`                   |

A task without its own variables runs on `MNEMO_LLM_PROVIDER`; with none of them
set the server behaves as before. `_PROVIDER` unset means the default vendor,
whose key, `MNEMO_LLM_BASE_URL` and `MNEMO_LLM_MODEL` the task inherits unless
it sets its own. Another vendor inherits nothing and needs its `_API_KEY`
(except Ollama); the server refuses to start without it, and also when a task is
set without `MNEMO_LLM_PROVIDER`. `_MODEL` unset on another vendor means that
vendor's default model. `MNEMO_LLM_DAILY_BUDGET_USD` counts every task's
provider. Embeddings keep their own `MNEMO_EMBED_*`. A workspace with its own
LLM configuration (`PUT /config/llm`) uses that provider for every task.

```bash
MNEMO_LLM_PROVIDER=openai \
MNEMO_LLM_API_KEY=sk-... \
MNEMO_LLM_JUDGE_PROVIDER=anthropic \
MNEMO_LLM_JUDGE_API_KEY=sk-ant-... \
MNEMO_LLM_PREFILTER_MODEL=gpt-4o-mini \
```

---

## Step 4 — Create a dev API key

API keys are stored bcrypt-hashed in `mnemosyne.mnemo_api_keys`. The key format is:

```
mns_live_<20-64 lowercase alphanumeric chars, no underscores>
```

With the Docker stack, `docker compose exec server node scripts/create-api-key.cjs --label dev` mints one
(see [`docker/README.md`](../../docker/README.md)). For a server you run from source, this Node snippet
does the same:

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

The bcrypt import resolves from the pnpm store — run the snippet from the repo
root where `node_modules/.pnpm/bcrypt*/` is present, or `pnpm add -D bcrypt`
temporarily if it fails to resolve.

Insert the printed SQL:

```bash
docker exec mnemosyne-postgres psql -U mnemo -d mnemo -c "<paste SQL here>"
```

### Important: `workspace_id` must be a UUID

The `mnemo_set_workspace` Postgres function casts the value to `uuid`. String
labels like `"personal"` or `"ws_default"` will cause a 500 error on every
authenticated request:

```
invalid input syntax for type uuid: "personal"
```

Always use `randomUUID()` or a proper UUID string as `workspace_id`.

---

## Step 5 — Configure the MCP client

### Claude Code CLI

```bash
claude mcp add mnemosyne \
  --scope user \
  -- node /path/to/mnemosyne/packages/mcp/dist/index.js
```

Then set the env vars:

```bash
claude mcp update mnemosyne \
  --env MNEMO_URL=http://localhost:3939 \
  --env MNEMO_KEY=mns_live_<your key>
```

Verify:

```bash
claude mcp get mnemosyne
# Status: ✔ Connected
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Restart Claude Desktop after editing.

---

## Verifying end-to-end

Once the server is up and the key is created:

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

Or invoke the `memory_status` MCP tool from your AI client — it should return:

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

## Stopping

```bash
# Kill the server process
kill $(lsof -ti :3939)

# Stop Postgres + Redis (preserves data)
docker compose -f docker/docker-compose.yml stop postgres redis

# Stop and wipe data
docker compose -f docker/docker-compose.yml down -v
```

---

## Troubleshooting

**`DATABASE_URL environment variable is required`**
The migrate command needs the env var set inline or in a `.env` file at the repo
root. See Step 2.

**`[SECURITY] The database role has rolsuper=true — all RLS policies are bypassed`**
Add `MNEMO_ALLOW_UNSAFE_DB_ROLE=true` to your server launch command. The bundled
`mnemo` Postgres user is a superuser; this flag is required for local dev. See
Step 3.

**`invalid input syntax for type uuid: "personal"` (500 on all requests)**
Your `workspace_id` is not a UUID. See the note in Step 4.

**`API key scope insufficient: requires 'memory:read'` (403)**
The key was inserted without that scope. Update it:

```bash
docker exec mnemosyne-postgres psql -U mnemo -d mnemo -c \
  "UPDATE mnemosyne.mnemo_api_keys SET scopes = scopes || ARRAY['memory:read','memory:write'] WHERE id = 'key_dev_local';"
```

**Auth resolves the old (pre-update) result for ~60 seconds**
The auth middleware caches `{token → workspace}` for 60 s in an LRU. After
updating a key's `workspace_id` or `scopes`, wait 60 s or restart the server
before testing.

**`Cannot connect to the Docker daemon` on macOS**
Docker Desktop uses a non-standard socket. Export
`DOCKER_HOST=unix://$HOME/.docker/run/docker.sock` and retry. See Prerequisites.

**MCP says `Internal server error` even though the server is healthy**
Check that `MNEMO_KEY` is non-empty and matches the format
`mns_live_<20+ alphanum, no underscores>`. An empty `MNEMO_KEY` makes the MCP
process exit before connecting, which surfaces as `Internal server error` in the
client.
