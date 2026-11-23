# Mnemosyne load-test harness (VER-2)

Measures throughput and latency of the recall (read) and write paths under sustained load.  
**Not wired to CI** — requires a real Postgres + Redis stack.

---

## Spec targets

| Scenario                | RPS target | p99 target |
| ----------------------- | ---------- | ---------- |
| Recall (read, hot-tier) | 1 000 RPS  | ≤ 10 ms    |
| Write (create fact)     | 100 RPS    | ≤ 100 ms   |

---

## Quick start (Docker Compose)

```bash
# 1. Start Postgres + Redis
docker compose -f docker/docker-compose.yml up -d postgres redis

# 2. Run migrations
pnpm --filter @mnemo-ai/core migrate

# 3. Create a test workspace and API key (requires a running server briefly)
#    Or insert one directly with psql for speed.

# 4. In terminal A — start the load-test server
DATABASE_URL=postgres://mnemo:mnemo@localhost:55432/mnemosyne \
MNEMO_ALLOW_UNSAFE_DB_ROLE=true \
pnpm --filter @mnemo-ai/server loadtest:server

# 5. In terminal B — run the load test
MNEMO_API_KEY=mk_dev_... pnpm --filter @mnemo-ai/server loadtest:run
```

---

## Environment variables

### `loadtest:server`

| Variable                     | Required | Default              | Description                                 |
| ---------------------------- | -------- | -------------------- | ------------------------------------------- |
| `DATABASE_URL`               | yes      | —                    | Postgres DSN                                |
| `LOADTEST_PORT`              | no       | `3939`               | Listen port                                 |
| `MNEMO_LLM_PROVIDER`         | no       | —                    | `openai` / `anthropic` — enables auto-embed |
| `MNEMO_LLM_API_KEY`          | no       | —                    | Required if `MNEMO_LLM_PROVIDER` is set     |
| `MNEMO_ALLOW_UNSAFE_DB_ROLE` | no       | `true` (in loadtest) | Suppress superuser check                    |

### `loadtest:run`

| Variable         | Required | Default     | Description                           |
| ---------------- | -------- | ----------- | ------------------------------------- |
| `MNEMO_API_KEY`  | yes      | —           | Bearer token with `read+write` scopes |
| `LOADTEST_PORT`  | no       | `3939`      | Port to target                        |
| `LOADTEST_HOST`  | no       | `127.0.0.1` | Host to target                        |
| `LT_DURATION`    | no       | `30`        | Seconds per scenario                  |
| `LT_CONNECTIONS` | no       | `50`        | Concurrent connections                |

---

## How recall works without an LLM

The runner pre-embeds a zero-vector (`[0, 0, ..., 0]` with 1536 dimensions) and passes
it directly in the `vector` field of the `/recall` body. This bypasses the LLM embed
call entirely and exercises only the hot-tier Redis lookup + Postgres fallback path —
exactly the scenario that must hit ≤ 10 ms p99.

To test LLM-integrated recall, set `MNEMO_LLM_PROVIDER` and `MNEMO_LLM_API_KEY` and
remove the `vector` field from the request body in `run.ts`.

---

## Interpreting results

```
Recall results:
  RPS:    1 247  ✓
  p50:    3 ms
  p99:    8 ms   ✓
  errors: 0 / 37 400 requests
  status: PASS ✓
```

A `FAIL` on RPS means the server is CPU-bound or the connection pool is saturated.  
A `FAIL` on p99 means the hot-tier path has a latency regression (cache miss, slow query, or GC pause).

---

## Adding load-test coverage to CI (future)

Wire via a dedicated GitHub Actions job with `services:` (Postgres) + `services:` (Redis).
The job would:

1. Start the load-test server in the background
2. Run `loadtest:run` with `LT_DURATION=10` and lower connection count
3. Assert exit code 0
