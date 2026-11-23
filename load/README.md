# Mnemosyne Load Tests

k6 load tests for the three primary Mnemosyne hot paths.

## Prerequisites

- [k6](https://k6.io/docs/getting-started/installation/) installed
- Mnemosyne server running (see `docker/docker-compose.yml`)
- A valid API key

## Quick start

```bash
# 1. Start the stack
docker compose -f docker/docker-compose.yml up -d

# 2. Wait for server to be healthy
curl -s http://localhost:3939/healthz | jq .

# 3. Seed a test dataset
MNEMO_TEST_API_KEY=<your_key> node load/scripts/seed.mjs --count 10000

# 4. Run recall smoke (30 s)
MNEMO_TEST_API_KEY=<your_key> k6 run --duration 30s --vus 5 load/k6/recall.js

# 5. Run full mixed baseline (2 min, 20 rps)
MNEMO_TEST_API_KEY=<your_key> MNEMO_TARGET_RPS=20 MNEMO_DURATION=2m k6 run load/k6/mixed.js
```

## Scripts

| Script   | Path                    | Description                              |
| -------- | ----------------------- | ---------------------------------------- |
| Recall   | `load/k6/recall.js`     | `POST /recall` — hot read path           |
| Remember | `load/k6/remember.js`   | `POST /remember` — write path            |
| Collapse | `load/k6/collapse.js`   | Full session lifecycle + collapse        |
| Mixed    | `load/k6/mixed.js`      | 70% recall / 20% remember / 10% collapse |
| Seed     | `load/scripts/seed.mjs` | Pre-populate DB with N facts             |

## Environment variables

| Variable             | Default                 | Description                  |
| -------------------- | ----------------------- | ---------------------------- |
| `MNEMO_BASE_URL`     | `http://localhost:3939` | Server URL                   |
| `MNEMO_TEST_API_KEY` | `mk_test_localdev`      | API key                      |
| `MNEMO_TARGET_RPS`   | `20`                    | Target RPS for mixed profile |
| `MNEMO_DURATION`     | `2m`                    | Test duration                |
| `MNEMO_RECALL_RPS`   | `10`                    | RPS for recall scenario      |
| `MNEMO_REMEMBER_RPS` | `5`                     | RPS for remember scenario    |
| `MNEMO_COLLAPSE_RPS` | `1`                     | RPS for collapse scenario    |

## SLO targets

| Path                | p50      | p95      | p99      |
| ------------------- | -------- | -------- | -------- |
| recall (cache hit)  | < 5 ms   | < 20 ms  | < 50 ms  |
| recall (cache miss) | < 40 ms  | < 150 ms | < 300 ms |
| remember            | < 100 ms | < 400 ms | < 800 ms |
| collapse (no LLM)   | < 200 ms | < 500 ms | < 1 s    |
| collapse (with LLM) | < 3 s    | < 8 s    | < 15 s   |

## CI smoke

The `load-smoke` CI job runs on every push to `main`:

- 30 s duration, 5 rps, 200 seeded facts
- Threshold: p99 < 2 s, error rate < 1%
- Results uploaded as artifact `k6-smoke-results`
