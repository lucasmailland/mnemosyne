# Mnemosyne — Performance Architecture & System Design

> **Performance status:** SLO targets below are design-derived; the CI `load-smoke` job
> (added in W1) validates the recall path on every push to `main` (30 s · 5 rps ·
> p99 < 2 s). The full perf baseline (p50/p95/p99 at target RPS with a 100k-fact
> dataset) is run locally via `pnpm perf:baseline` — see `load/README.md`. Tinybench
> microbenchmarks cover unit operations; k6 scripts in `load/k6/` cover system-level paths.

---

## 0. Measurement Setup & Methodology

### k6 scripts (committed to `load/k6/`)

| Script                | Target                       | Scenario                |
| --------------------- | ---------------------------- | ----------------------- |
| `load/k6/recall.js`   | `POST /recall`               | `constant-arrival-rate` |
| `load/k6/remember.js` | `POST /remember`             | `constant-arrival-rate` |
| `load/k6/collapse.js` | Session lifecycle + collapse | `constant-arrival-rate` |
| `load/k6/mixed.js`    | Mixed 70/20/10 profile       | 3 concurrent scenarios  |

### CI smoke gate (runs on every push to `main`)

The `load-smoke` GitHub Actions job:

- 30 s duration, 5 rps, 200 seeded facts
- Threshold: p99 < 2 s, error rate < 1%
- Artifact: `k6-smoke-results` (JSON summary)

### Full baseline procedure

```bash
# 1. Start prod-like stack
docker compose -f docker/docker-compose.yml up -d

# 2. Seed 100k facts (~2 min)
MNEMO_TEST_API_KEY=<key> node load/scripts/seed.mjs --count 100000 --batch 50

# 3. Run full mixed baseline (5 min, 20 rps)
MNEMO_TEST_API_KEY=<key> MNEMO_TARGET_RPS=20 MNEMO_DURATION=5m k6 run load/k6/mixed.js
```

Or use the root pnpm scripts:

```bash
MNEMO_TEST_API_KEY=<key> pnpm perf:seed --count 100000
MNEMO_TEST_API_KEY=<key> pnpm perf:baseline
```

### SLO targets (design-derived — update with measured values after first full baseline run)

| Path                | p50 target | p95 target | p99 target  |
| ------------------- | ---------- | ---------- | ----------- |
| recall — cache hit  | < 5 ms     | < 20 ms    | < 50 ms     |
| recall — cache miss | < 40 ms    | < 150 ms   | < 300 ms    |
| remember            | < 100 ms   | < 400 ms   | < 800 ms    |
| collapse (no LLM)   | < 200 ms   | < 500 ms   | < 1 000 ms  |
| collapse (with LLM) | < 3 000 ms | < 8 000 ms | < 15 000 ms |

---

> How Mnemosyne is designed to achieve SOTA performance across all deployment modes:
> from a single developer's laptop to a multi-tenant cloud brain serving
> thousands of concurrent agents.

---

## 1. Hybrid Language Strategy

No single language is optimal for all components. Mnemosyne uses the right
tool for each job:

| Layer                                                  | Language                      | Runtime              | Justification                                                        |
| ------------------------------------------------------ | ----------------------------- | -------------------- | -------------------------------------------------------------------- |
| Core library                                           | TypeScript                    | Node.js 20+          | MCP SDK, LLM ecosystem, types-as-docs, rapid iteration               |
| REST API server                                        | TypeScript                    | Hono on Node.js      | Async I/O, streaming, OpenAPI codegen                                |
| MCP server                                             | TypeScript                    | Node.js (stdio/HTTP) | MCP SDK is JS-only                                                   |
| CLI + TUI                                              | **TypeScript/Node** (shipped) | `@mnemo-ai/cli`      | 13 commands, thin HTTP client, `mnemo` binary via Node               |
| CLI + TUI _(Go/Bubbletea — aspirational, not shipped)_ | Go                            | Compiled binary      | Instant startup (<50ms), Bubbletea TUI, single binary, cross-compile |
| Cache daemon (optional)                                | Go                            | Compiled binary      | Alternative to Redis for local mode, goroutines                      |
| Local embeddings (future)                              | Rust                          | Compiled + ONNX      | SIMD vectorization, zero-copy, <10ms inference                       |
| Cloud gateway (future)                                 | Go                            | Compiled binary      | 10k+ concurrent connections, minimal memory                          |
| Python SDK                                             | Python                        | pip package          | Generated from OpenAPI                                               |
| Go SDK                                                 | Go                            | Module               | Generated from proto/OpenAPI                                         |

### Why NOT rewrite everything in Rust/Go?

| Argument                        | Counter                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Rust is faster"                | For what? Mnemosyne's bottleneck is I/O (PG, Redis, LLM APIs), not CPU. V8 JIT handles business logic fine.                                                |
| "Go handles concurrency better" | Node event loop handles 10k concurrent I/O ops. Go wins at CPU-parallel work, which Mnemosyne doesn't do in the hot path.                                  |
| "Single binary is cleaner"      | For the shipped CLI (`@mnemo-ai/cli`) this is handled via Node packaging. A Go binary was designed but not built. The server is a Docker container anyway. |
| "Memory footprint"              | Node: 100-500MB. Go: 20-50MB. For a server, irrelevant. For a CLI, the shipped TypeScript CLI is sufficient; a Go binary was designed as a future option.  |

### When to use which

```
User types `mnemo recall "deploy process"` in terminal
  → @mnemo-ai/cli (TypeScript/Node binary via `mnemo`)
    → HTTP call to Mnemosyne server (or in-process if local mode)
  (A Go compiled binary was designed for <50ms cold start but has not been built)

User's agent calls memory_recall MCP tool
  → Node MCP server (already warm, event loop handles it)
    → Core library in-process (zero network hop)

Cloud receives 500 req/s from 50 tenant workspaces
  → Node Hono server (handles 15-30k rps for JSON APIs)
    → PG pool (50 connections) + Redis pool (20 connections)
    → If saturated: Go gateway for connection multiplexing (future)
```

---

## 2. Concurrency Model & Thread Architecture

### Node.js Event Loop (Server + Core)

```
┌──────────────────────────────────────────────────────────────────┐
│  MAIN THREAD (V8 Event Loop)                                      │
│                                                                    │
│  Handles: HTTP requests, MCP messages, Redis commands,            │
│           PG query dispatch, JSON serialization, Zod validation    │
│                                                                    │
│  DOES NOT: Compute embeddings, run ONNX models, hash passwords    │
│            (these go to worker threads or external services)       │
└──────────────────────────────────────────────────────────────────┘
          ↕                    ↕                    ↕
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  libuv I/O      │ │  Worker Threads │ │  Child Processes │
│  (PG, Redis,    │ │  (bcrypt hash,  │ │  (optional local │
│   HTTP, DNS)    │ │   heavy JSON)   │ │   embed server)  │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

### What happens with 200 concurrent agents

```
200 agents → each does ~3 recalls/minute = 600 req/min = 10 req/sec

Timeline of a single recall request:
  0ms   — Request arrives at Hono
  1ms   — Auth (bcrypt cache hit) + Zod validation
  2ms   — L1 cache check (Redis GET or in-memory LRU)
  ─── IF CACHE HIT (60% of calls with hot tier) ───
  3ms   — Return cached result. Total: 3ms.
  ─── IF CACHE MISS ───
  2ms   — Acquire PG connection from pool (usually instant)
  5ms   — FTS query (tsvector + ts_rank_cd)
  15ms  — Vector search (pgvector HNSW, if Mode B/C)
  5ms   — Hybrid fusion + scoring (CPU, event loop)
  10ms  — Graph expansion (1-hop SQL)
  3ms   — Render + serialize response
  ───
  ~40ms total (cache miss). Event loop blocked for ~8ms of CPU work.
```

**200 agents at 10 rps with 40ms/req:**

- Event loop utilization: 10 × 40ms = 400ms/sec = 40% utilization
- PG pool: 10 concurrent queries × 20ms avg = 50-conn pool at 40% utilization
- Redis: 10 GETs/sec = trivial
- **Verdict: Node handles this comfortably. No cluster mode needed.**

### When Node saturates (and what to do)

| Load                  | Symptom                      | Solution                        |
| --------------------- | ---------------------------- | ------------------------------- |
| 50 rps (500 agents)   | p99 starts climbing          | Enable cluster mode (4 workers) |
| 200 rps (2000 agents) | Event loop lag >100ms        | Go gateway + Node worker pool   |
| 1000 rps (cloud SaaS) | Connection pool exhaustion   | PgBouncer + read replicas       |
| 5000 rps (enterprise) | Single process can't keep up | Horizontal scaling (k8s HPA)    |

---

## 3. Connection Pooling & Resource Management

### PostgreSQL

```typescript
interface PgPoolConfig {
  // Self-hosted / Team
  team: {
    max: 20;
    idleTimeout: 30;
    connectTimeout: 5;
  };

  // Cloud / Multi-tenant
  cloud: {
    max: 50; // Behind PgBouncer
    idleTimeout: 30;
    connectTimeout: 3;
    readReplicaMax: 30; // Recall queries go to replica
    pgBouncerMode: "transaction"; // Connection reuse between txs
  };

  // Embedded (library mode)
  embedded: {
    max: 10; // Shared with host app's pool
    idleTimeout: 20;
    connectTimeout: 10;
  };
}
```

### Redis

```typescript
interface RedisPoolConfig {
  // Team
  team: {
    maxConnections: 10;
    connectTimeout: 3000;
    commandTimeout: 2000;
    lazyConnect: true; // Don't fail on boot if Redis is down
    retryStrategy: "exponential"; // 100ms, 200ms, 400ms, max 5s
  };

  // Cloud
  cloud: {
    sentinels: [{ host: "sentinel"; port: 26379 }];
    name: "mnemosyne-master";
    maxConnections: 50;
    pipelining: true; // Batch commands (reduce round-trips)
    enableReadyCheck: true;
    enableOfflineQueue: true; // Queue commands during reconnect
  };
}
```

### Graceful Degradation Matrix

```
┌─────────────────────────────────────────────────────────────────┐
│  DEPENDENCY STATUS → BEHAVIOR                                     │
│                                                                   │
│  PG healthy + Redis healthy    → Full stack (L0-L5)              │
│  PG healthy + Redis degraded   → L0/L1 → in-memory Map (10MB)   │
│                                  L2 (hot tier) → disabled        │
│                                  Recall works (L3+L4, ~100ms)    │
│  PG healthy + Redis gone       → Same as above + sessions 503    │
│  PG degraded (replica lag)     → Stale reads possible,           │
│                                  writes go to primary only       │
│  PG gone                       → 503 on everything (fatal)       │
│                                                                   │
│  Embedding provider timeout    → Mode C → Mode A (FTS-only)     │
│  LLM provider timeout          → Extraction queued for retry     │
│                                  Collapse pipeline deferred       │
│  Everything down except PG     → Mode A still works (FTS recall) │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Per-Deployment-Mode Performance Targets

### Mode: Team Brain (Self-hosted)

```yaml
runtime: Node server (Docker) + PG + optional Redis
concurrency: 5-50 users, 10-200 agents
resources: 512MB-2GB RAM, Docker Compose
targets:
  recall_p99: <100ms (hybrid vector+FTS)
  recall_hot_p99: <10ms (Redis, if enabled)
  write_p99: <30ms
  concurrent_connections: 100
redis: recommended (shared cache across pods)
embedding: Ollama (team server) or API (OpenAI/Voyage)
```

### Mode: Cloud Brain (Managed SaaS)

```yaml
runtime: Node server (k8s) + PG (managed) + Redis Sentinel + PgBouncer
concurrency: 100-10k workspaces, 1000-50k agents
resources: 3× 2-core/1GB pods + PG(16GB) + Redis(2GB)
targets:
  recall_hot_p99: <5ms
  recall_warm_p99: <15ms
  recall_cold_p99: <200ms
  write_p99: <50ms
  availability: 99.9%
  throughput: 1000 rps sustained
redis: required (session buffer, hot tier, rate limits, pub/sub)
embedding: provider pool with failover (Voyage → OpenAI → Cohere)
```

### Mode: Embedded (Library)

```yaml
runtime: In-process (consumer's Node.js app)
concurrency: whatever the host handles
resources: +50-100MB to host process
targets:
  recall_p99: <50ms (shares host's PG pool)
  write_p99: <20ms
redis: host provides (or in-memory fallback)
embedding: host provides (or disabled)
```

---

## 5. Bottleneck Analysis

### Where time goes in a recall (Mode C, cache miss)

```
Component            Time      % of total    Parallelizable?
─────────────────────────────────────────────────────────────
Auth + validation    2ms       5%            No (serial gate)
Embedding API call   30-100ms  50-70%        Yes (async)
PG vector search     10-20ms   15-25%        Yes (parallel with FTS)
PG FTS search        5-10ms    8-12%         Yes (parallel with vector)
Hybrid fusion        2-5ms     3-7%          No (needs both results)
Graph expansion      5-10ms    8-12%         No (sequential after fusion)
Serialization        1-2ms     1-3%          No
─────────────────────────────────────────────────────────────
Total (serial):      ~55-150ms
Total (parallel):    ~45-120ms (embedding ‖ vector ‖ FTS)
```

**The embedding API is the dominant bottleneck.** Solutions:

1. **Cache embeddings aggressively** (same query = same vector, hash key)
2. **Local embeddings** (Ollama/Rust ONNX: 5-15ms instead of 30-100ms)
3. **Skip embedding** when hot tier hits (Redis, <5ms total)
4. **Batch embedding** (multiple facts in one API call on write path)

### Where time goes in a write (create fact)

```
Component            Time      % of total
─────────────────────────────────────────
Auth + validation    2ms       8%
Conflict detection   5-10ms    25%         (cosine similarity check)
PG INSERT            3-5ms     15%
Embedding (async)    0ms       0%          (queued, not in hot path)
Cache invalidation   1ms       4%
Response             1ms       4%
─────────────────────────────────────────
Total:               ~12-20ms
```

Writes are fast because embedding is async (fire-and-forget to queue).

---

## 6. Scaling Strategy

### Horizontal (stateless compute)

```
            ┌─── LB (nginx/haproxy) ───┐
            │                           │
    ┌───────┴──┐  ┌───────┴──┐  ┌───────┴──┐
    │  Node #1 │  │  Node #2 │  │  Node #3 │
    │  (Hono)  │  │  (Hono)  │  │  (Hono)  │
    └────┬─────┘  └────┬─────┘  └────┬─────┘
         │              │              │
    ┌────┴──────────────┴──────────────┴────┐
    │          PgBouncer (transaction)       │
    └────┬──────────────┬───────────────────┘
         │              │
    ┌────┴────┐   ┌────┴────┐
    │ PG Pri  │   │ PG Rep  │  (writes → primary, reads → replica)
    └─────────┘   └─────────┘
```

- Each Node process is stateless (cache in Redis, state in PG)
- Scale by adding pods (k8s HPA on CPU/request rate)
- PgBouncer multiplexes 1000 app connections → 50 PG connections

### Vertical (single instance optimization)

For self-hosted teams that want ONE beefy machine instead of a cluster:

```
Node.js cluster mode:
  - Master process (accepts connections, distributes)
  - N worker processes (N = CPU cores - 1)
  - Each worker: own event loop, shared port via SO_REUSEPORT
  - Shared Redis for cross-worker cache coherence

PG tuning (4-core/16GB machine):
  - shared_buffers: 4GB
  - effective_cache_size: 12GB
  - work_mem: 64MB
  - max_connections: 200
  - Random page cost: 1.1 (SSD)
```

---

## 7. Memory Budget (Per Component)

### Node.js Server Process

```
Component               Memory    Notes
────────────────────────────────────────────────────
V8 heap (baseline)      50MB      Node runtime + loaded modules
Hono router + middleware 5MB      Minimal
LRU cache (L1)          10-50MB   5k entries × 10KB avg per hit
PG connection pool      20MB      50 connections × 400KB each
Redis connection pool   5MB       20 connections
Request buffers         10-50MB   Depends on concurrency
Zod schemas (cached)    5MB       Compiled validators
────────────────────────────────────────────────────
Total per process:      105-185MB (typical)
Max recommended:        512MB (leave headroom for GC)
```

### Redis Memory Budget

```
Component                   Memory    Notes
────────────────────────────────────────────────────
L1 recall cache             100-500MB  5k entries/workspace × N workspaces
Hot tier (ACT-R scores)     50-200MB   Sorted sets, 1000 facts/workspace
Session buffers (L1)        50-200MB   Active sessions × turns
Rate limit counters         10MB       Per-key token buckets
Idempotency keys            20MB       24h TTL, UUID → response
Working memory (L0)         20-100MB   Tool outputs, checkpoints
────────────────────────────────────────────────────
Total (team):               250MB-1GB
Total (cloud):              1-4GB
```

### PostgreSQL Storage

```
Component                   Size/1k facts    Notes
────────────────────────────────────────────────────
mnemo_fact rows             ~2MB             Statement + metadata JSON
mnemo_fact embeddings       ~4MB             1024 dims (bge-m3) × float32 × 1k
mnemo_relation edges        ~0.5MB           ~3 edges per fact avg
mnemo_entity nodes          ~0.2MB           ~1 entity per 5 facts
Indexes (HNSW + tsvector)   ~4MB             pgvector HNSW index
────────────────────────────────────────────────────
Total per 1k facts:         ~13MB
Total for 100k facts:       ~1.3GB
Total for 1M facts:         ~13GB
```

---

## 8. Latency Budgets (SLO Targets)

### Per Operation Class

| Operation                    | p50    | p95    | p99    | Budget breakdown                      |
| ---------------------------- | ------ | ------ | ------ | ------------------------------------- |
| recall (hot tier hit)        | 2ms    | 4ms    | 8ms    | Redis GET + deserialize               |
| recall (warm, pointer+FTS)   | 8ms    | 15ms   | 30ms   | PG FTS + entity drawer                |
| recall (cold, full pipeline) | 50ms   | 120ms  | 200ms  | Embed + vector + FTS + rerank + graph |
| write (fact)                 | 10ms   | 20ms   | 50ms   | Validate + conflict check + INSERT    |
| write (with embedding)       | 10ms   | 20ms   | 50ms   | Same (embedding is async)             |
| session.addTurn              | 1ms    | 3ms    | 5ms    | Redis RPUSH                           |
| session.collapse             | 1000ms | 2500ms | 5000ms | LLM call dominates                    |
| health check                 | 1ms    | 5ms    | 10ms   | PG SELECT 1 + Redis PING              |
| auth (cached)                | 0.5ms  | 1ms    | 2ms    | LRU bcrypt result lookup              |
| auth (cold)                  | 50ms   | 80ms   | 120ms  | bcrypt(12) comparison                 |

### Error Budget (SLO)

```
Target availability: 99.9% (43.2 min downtime/month)

Error budget per month: 43.2 minutes
  ├── Planned maintenance window: 15 min (deploys)
  ├── Unplanned incidents: 28.2 min remaining
  └── Burn rate alert: page if consuming >14.4× budget/hour

Excluded from SLO:
  - 429 rate-limit responses (expected behavior)
  - 503 during planned maintenance
  - /admin/* endpoints (internal tools)
```

---

## 9. CPU-Bound Operations & Worker Thread Strategy

Operations that block the event loop and need worker threads:

| Operation                        | CPU Time | Frequency           | Strategy                       |
| -------------------------------- | -------- | ------------------- | ------------------------------ |
| bcrypt(12) hash/verify           | 50-100ms | Every auth (cold)   | Worker thread pool (4 threads) |
| JSON parse large payloads (>1MB) | 5-20ms   | Rare (bulk import)  | Worker thread                  |
| Local similarity computation     | 10-50ms  | Only if no pgvector | Worker thread                  |
| Zod validation (large schemas)   | 1-5ms    | Every request       | Inline (fast enough)           |
| LRU eviction (large cache)       | 1-2ms    | Background          | Inline (non-blocking)          |

```typescript
// Worker thread pool for CPU-bound operations
import { Worker } from "node:worker_threads";

const WORKER_POOL_SIZE = Math.max(2, os.cpus().length - 2);

// Operations routed to workers:
// - bcrypt.hash / bcrypt.compare
// - Large JSON serialization
// - Local ONNX inference (if embedded model)
```

---

## 10. Go CLI/TUI Architecture

> ⚠️ **Aspirational / not shipped.** The shipped CLI is `@mnemo-ai/cli` (TypeScript/Node); the Go + Bubbletea TUI below is a considered-but-unbuilt design. Nothing in this section reflects the current codebase.

### Why Go (not Rust, not Node)

| Requirement                                 | Go         | Rust    | Node       |
| ------------------------------------------- | ---------- | ------- | ---------- |
| Startup <50ms                               | ~10ms      | ~5ms    | ~200ms     |
| Single binary (no runtime)                  | Yes        | Yes     | No         |
| Cross-compile (arm64, x86, Win, Linux, Mac) | Trivial    | Complex | N/A        |
| TUI framework (SOTA)                        | Bubbletea  | ratatui | Ink (slow) |
| HTTP client for API                         | stdlib     | reqwest | node-fetch |
| Concurrency (watch + poll + render)         | Goroutines | Tokio   | Awkward    |
| Dev speed                                   | Fast       | Slow    | Fast       |
| Already in ecosystem (Engram)               | Yes        | No      | N/A        |

### CLI Architecture

```
mnemo (Go binary)
├── cmd/
│   ├── recall.go       — mnemo recall "query"
│   ├── remember.go     — mnemo remember "fact" --type fact
│   ├── forget.go       — mnemo forget <id> --reason "..."
│   ├── health.go       — mnemo health
│   ├── export.go       — mnemo export --format jsonl
│   ├── import.go       — mnemo import < backup.jsonl
│   ├── providers.go    — mnemo providers list/set/test
│   ├── serve.go        — mnemo serve (starts Node server, or embedded)
│   └── tui.go          — mnemo tui (launches Bubbletea UI)
├── internal/
│   ├── client/         — HTTP client for Mnemosyne REST API
│   ├── config/         — Config file management (~/.mnemo/config.json)
│   ├── tui/            — Bubbletea views (health, facts, graph, sessions)
│   └── embedded/       — Optional: embedded PG-lite for local mode
└── main.go
```

### TUI Views

```
┌─ Mnemosyne Brain ─────────────────────────────────────┐
│                                                        │
│  [Health] [Facts] [Graph] [Sessions] [Providers]       │
│                                                        │
│  ┌─ Health ──────────────────────────────────────────┐ │
│  │  Status: ● Healthy                                │ │
│  │  Facts: 1,247 active  │  Worth avg: 0.72         │ │
│  │  Recall hit rate: 94% │  Hot tier: 834 entries   │ │
│  │  PG: 12ms p99        │  Redis: 2ms p99          │ │
│  │  Sessions: 3 active   │  Last collapse: 2m ago   │ │
│  └───────────────────────────────────────────────────┘ │
│                                                        │
│  Recent activity:                                      │
│  • fact_a3f9k — "Redis version is 7.2" (2min ago)     │
│  • recall — "deploy process" → 5 hits (5min ago)      │
│  • collapse — session_xyz → 3 facts extracted         │
│                                                        │
└────────────────────────────────────── q:quit h:help ──┘
```

---

## 11. Rust Performance Layer (Future — Phase 2+)

Reserved for operations where Node.js provably can't meet latency targets:

### Local Embedding Server

```rust
// mnemo-embed: ONNX Runtime + SIMD
// Replaces embedding API calls for offline/local mode
// Target: <15ms per embedding (vs 30-100ms API call)

// Supported models (ONNX format):
// - nomic-embed-text-v1.5 (768 dims)
// - all-MiniLM-L6-v2 (384 dims)
// - bge-small-en-v1.5 (384 dims)

// Interface: local HTTP server
// POST /embed { texts: string[] } → { embeddings: float[][] }
// Startup: <100ms (model pre-loaded in memory-mapped file)
// Memory: ~200MB for nomic-embed-text
```

---

## 12. Network Architecture (Cloud Mode)

```
┌─────────────────────────────────────────────────────────────────────┐
│  INTERNET                                                            │
│                                                                       │
│  Agent requests ──→ Cloudflare/CDN (TLS termination)                │
│                          │                                           │
│                          ▼                                           │
│                    ┌───────────┐                                     │
│                    │ LB (L7)   │  Rate limit (Layer 1)              │
│                    └─────┬─────┘                                     │
│                          │                                           │
│              ┌───────────┼───────────┐                              │
│              ▼           ▼           ▼                              │
│         ┌────────┐  ┌────────┐  ┌────────┐                         │
│         │ Node 1 │  │ Node 2 │  │ Node 3 │  (HPA: 3-20 pods)     │
│         └───┬────┘  └───┬────┘  └───┬────┘                         │
│             │            │            │                              │
│         ┌───┴────────────┴────────────┴───┐                        │
│         │         PgBouncer               │  (connection pool)      │
│         └───┬─────────────────────────┬───┘                        │
│             │                         │                              │
│        ┌────┴────┐             ┌─────┴─────┐                       │
│        │PG Primary│             │PG Replica │  (recall reads here)  │
│        │ (writes) │             │  (reads)  │                       │
│        └─────────┘             └───────────┘                        │
│                                                                       │
│         ┌─────────────────────────────────┐                         │
│         │  Redis Sentinel (3 nodes)       │                         │
│         │  ├── Master (writes + pub/sub)  │                         │
│         │  └── Replica (reads)            │                         │
│         └─────────────────────────────────┘                         │
│                                                                       │
│         ┌─────────────────────────────────┐                         │
│         │  OTel Collector → Prometheus    │                         │
│         │  → Grafana + Alertmanager       │                         │
│         └─────────────────────────────────┘                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 13. Benchmark Methodology

### Test Environment

```yaml
# Reproducible via Docker Compose
services:
  mnemosyne:
    image: mnemosyne/server:latest
    environment:
      DATABASE_URL: postgres://...
      REDIS_URL: redis://...
    deploy:
      resources:
        limits: { cpus: "2", memory: "1G" }

  postgres:
    image: pgvector/pgvector:0.8.0-pg17
    command: postgres -c shared_buffers=256MB -c max_connections=100

  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 256mb

  bench:
    image: grafana/k6:latest
    volumes:
      - ./benchmarks:/scripts
```

### k6 Load Test Scenarios

```javascript
// Scenario 1: Recall throughput (cache warm)
export const options = {
  scenarios: {
    recall_warm: {
      executor: "constant-arrival-rate",
      rate: 100, // 100 rps
      duration: "5m",
      preAllocatedVUs: 50,
    },
  },
  thresholds: {
    http_req_duration: ["p(99)<200"],
    http_req_failed: ["rate<0.01"],
  },
};

// Scenario 2: Mixed workload (realistic)
// 70% recall, 20% write, 10% timeline
// Ramp: 10 → 50 → 100 → 200 VUs over 15 minutes

// Scenario 3: Burst (agent swarm)
// 200 VUs hitting recall simultaneously for 60s
// Measures: queue depth, p99, error rate under pressure
```

### Metrics to Track

```
# Performance regression detection (CI)
- recall_p99_ms: must not increase >20% vs baseline
- write_p99_ms: must not increase >20% vs baseline
- throughput_rps: must not decrease >10% vs baseline
- memory_peak_mb: must not increase >30% vs baseline
- pg_pool_wait_ms: must stay <50ms at p99
```

---

## 14. Decisions Log

| #   | Decision            | Chosen                                       | Rejected                           | Reason                                                              |
| --- | ------------------- | -------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| 1   | Server language     | Node/Hono                                    | Go/Rust                            | MCP SDK, LLM ecosystem, types, dev speed                            |
| 2   | CLI language        | TypeScript/Node (shipped as `@mnemo-ai/cli`) | Go TUI (aspirational, not shipped) | Go+Bubbletea was designed but not built; TypeScript CLI ships today |
| 3   | Future perf layer   | Rust (ONNX)                                  | Go                                 | SIMD requirement for local embeddings                               |
| 4   | Concurrency model   | Event loop + worker threads                  | Cluster-first                      | Simple, sufficient for 200 agents                                   |
| 5   | PG pooling (cloud)  | PgBouncer transaction mode                   | Direct connections                 | 10x connection multiplexing                                         |
| 6   | Redis HA            | Sentinel                                     | Cluster                            | Simpler for <4GB, Cluster for larger                                |
| 7   | Cache coherence     | Write-through invalidation                   | TTL-only                           | Consistency SOTA for multi-tenant                                   |
| 8   | Local DB (future)   | SQLite via libSQL/Turso                      | PG-lite                            | True zero-dependency, single file                                   |
| 9   | Scaling trigger     | CPU >70% sustained 5min                      | Request rate                       | CPU correlates better with actual capacity                          |
| 10  | Binary distribution | Go (goreleaser)                              | Bun compile                        | Cross-platform, proven toolchain                                    |
