# Mnemosyne — Observability Specification v3

> Every operation is traceable. Every error is coded. Every cost is tracked.
> Observability is not a feature — it is a first-class architectural constraint.
> No adapter ships without telemetry. No operation runs without a span.

---

## 1. Philosophy

Mnemosyne is a distributed cognitive system. Debuggability at scale requires
three independent signals: **traces** (what happened and when), **metrics**
(how well it happened), and **logs** (why it went wrong). All three must be
present from day one — not added as an afterthought.

### Principles

- **Core spans emitted.** The primary operation spans (`mnemo.recall`, `mnemo.recall.hot`, `mnemo.recall.cold`, `mnemo.recall.pointer`, `mnemo.remember`, `mnemo.forget`, `mnemo.embed`, `mnemo.rerank`, `mnemo.composition`, `mnemo.self.edit`, `mnemo.self.reflect`, `mnemo.worth.update`, `mnemo.relation.hebb`, `mnemo.session.collapse`, `mnemo.reasoning.resolve`, `mnemo.federation.sync`, `mnemo.auth`) are wired. Not every internal helper or utility method carries a span — the goal is coverage on every public service boundary. `NoopTelemetry` costs nothing; `OTelTelemetry` exports everything.
- **Coded errors everywhere.** Every error has a `MNEMO_XXX` code. Codes are
  stable across releases. Dashboards and runbooks reference codes, not messages.
- **Cost is a first-class metric.** Token spend, tokens saved by distillation
  and anticipation, and workspace-level ROI are emitted as Prometheus counters.
  If we can't measure savings, we can't justify the system's existence.
- **No PII in any signal.** Query content, fact text, and user identifiers
  are never included in span attributes, metric labels, or log fields. Only
  structural identifiers (`workspace_id`, `agent_id`, `fact_id`) cross the
  observability boundary.
- **Zero-cost in the hot path.** `NoopTelemetry` and `NoopLogger` implement
  every interface with empty bodies. Callers pay no branch cost. Adapters are
  injected — the hot path never inspects which implementation is active.
- **Label cardinality is a budget.** Every metric label set must have bounded
  cardinality. Free-text values, IDs, and query strings are forbidden as labels.
  Maximum distinct label combinations per metric: 500.

---

## 2. Logger Interface

### Port Definition

```typescript
// @mnemo-ai/types/src/ports/logger.ts

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  fatal(msg: string, ctx?: LogContext): void;

  /** Returns a new Logger with ctx merged into every subsequent call. */
  child(bindings: Record<string, unknown>): Logger;
}

export interface LogContext {
  // Trace correlation (injected by middleware, propagated via child())
  traceId?: string; // W3C trace-id (32 hex chars)
  spanId?: string; // W3C span-id (16 hex chars)
  parentSpanId?: string;

  // Identity — always present in server context
  workspaceId?: string;
  agentId?: string;
  sessionId?: string;

  // Operation
  operation?: string; // "recall", "write", "collapse", "extract"
  duration_ms?: number;

  // Error detail — only on error/fatal
  error?: {
    type: string; // Class name, e.g. "ConflictError"
    message: string;
    code?: string; // snake_case, e.g. "conflict"
    stack?: string; // Only in non-production (NODE_ENV !== "production")
  };

  // Cost — only when an LLM call occurred in this operation
  cost?: {
    model: string; // "claude-sonnet-4-20250514"
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };

  // Recall-specific
  tier?: "hot" | "warm" | "cold";
  resultCount?: number;
  cacheHit?: boolean;

  // Structured extension — must NOT contain raw user content
  [key: string]: unknown;
}

/** Minimal structured log entry shape (what pino serialises) */
export interface MnemoLogEntry {
  timestamp: string; // ISO 8601
  level: "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  service: "mnemosyne-server" | "mnemosyne-mcp" | "mnemosyne-worker";
  version: string;
  env: "development" | "staging" | "production";
  // All LogContext fields flattened here at serialisation time
}
```

### Implementations

#### PinoLogger (default for server/cloud)

```typescript
// packages/server/src/telemetry/logger.ts
// (Logger interface defined in @mnemo-ai/types/src/ports/observability.ts)

import pino from "pino";
import type { Logger, LogContext } from "@mnemo-ai/types";

export interface PinoLoggerOpts {
  level?: "debug" | "info" | "warn" | "error" | "fatal";
  pretty?: boolean; // Human-readable in dev; never in production
  destination?: string; // File path or "stdout"
  redactPaths?: string[]; // Additional pino redact paths beyond defaults
}

export function createPinoLogger(opts: PinoLoggerOpts = {}): Logger {
  // Defaults: redact any "content", "text", "query", "embedding" keys
  // at any depth so PII never leaks to log sinks.
}
```

**Level conventions:**

| Level   | When to use                                                                                |
| ------- | ------------------------------------------------------------------------------------------ |
| `debug` | Cache lookup outcomes, query plan, span attributes during development                      |
| `info`  | Operation completed (recall, write, collapse), adapter connected, migration ran            |
| `warn`  | Degraded path taken (Redis down → memory fallback), retry attempted, worth below threshold |
| `error` | Operation failed with a coded error, adapter health check failed, job permanently failed   |
| `fatal` | Process cannot continue — unrecoverable PG failure, missing required config                |

#### NoopLogger (default for embedded/library use)

```typescript
// packages/server/src/telemetry/logger.ts — NoopLogger impl
// (Logger interface: @mnemo-ai/types/src/ports/observability.ts)

export function createNoopLogger(): Logger {
  const noop = () => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => createNoopLogger(),
  };
}
```

#### TestLogger (for unit tests)

```typescript
// packages/server/src/telemetry/logger.ts — TestLogger impl
// (Logger interface: @mnemo-ai/types/src/ports/observability.ts)

export interface TestLogger extends Logger {
  entries: Array<{ level: string; msg: string; ctx?: LogContext }>;
  clear(): void;
  find(level: string, msgFragment: string): LogContext | undefined;
}

export function createTestLogger(): TestLogger {
  // Captures all calls in-memory. Never writes to stdout.
  // Useful in Vitest tests: assert logger.find("error", "conflict").
}
```

---

## 3. Telemetry Interface

### Port Definition

```typescript
// @mnemo-ai/types/src/ports/telemetry.ts

export interface Telemetry {
  // ─── Distributed Tracing ───────────────────────────────────────────

  /**
   * Starts a new span. Caller MUST call span.end() in a finally block.
   * If a parent is provided, the new span becomes a child span.
   */
  startSpan(name: string, opts?: SpanOpts): Span;

  // ─── Metrics ───────────────────────────────────────────────────────

  /** Increment a counter by `value` (default 1). */
  counter(name: string, value?: number, attrs?: SpanAttributes): void;

  /** Record a histogram observation (latency, sizes, costs). */
  histogram(name: string, value: number, attrs?: SpanAttributes): void;

  /** Set a gauge to an absolute value (pool sizes, queue depth). */
  gauge(name: string, value: number, attrs?: SpanAttributes): void;

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /** Flush all pending spans and metrics, then shut down exporters. */
  shutdown(): Promise<void>;
}

export interface Span {
  /** Set a typed attribute on the span. */
  setAttribute(key: string, value: string | number | boolean): void;

  /** Batch-set multiple attributes. */
  setAttributes(attrs: SpanAttributes): void;

  /**
   * Mark span outcome. Call setStatus("error") before end() on any
   * thrown exception. Call setStatus("ok") on successful completion.
   * Omitting setStatus leaves the span in UNSET state (treated as ok
   * by most backends).
   */
  setStatus(status: "ok" | "error", message?: string): void;

  /** Record an exception as a span event (includes stack trace). */
  recordException(error: Error): void;

  /**
   * End the span and submit it for export. Must be called exactly once.
   * Prefer the try/finally pattern over manual calls.
   */
  end(): void;
}

export type SpanAttributes = Record<string, string | number | boolean>;

export interface SpanOpts {
  /** Parent span. If omitted, uses active context propagation. */
  parent?: Span;
  /** Initial attributes. Avoids a separate setAttribute call per attribute. */
  attributes?: SpanAttributes;
  /**
   * SpanKind following OTel semantics:
   *   "internal" — default for domain operations
   *   "client"   — outbound calls (embed API, LLM API)
   *   "server"   — inbound HTTP / gRPC
   *   "producer" — job enqueued
   *   "consumer" — job processed
   */
  kind?: "internal" | "client" | "server" | "producer" | "consumer";
}
```

### Standard Span Attributes

Every span MUST carry these attributes when the context is available:

```typescript
// Mandatory identity attributes (set on root span, inherited by children
// via context propagation — do not re-set on every child span)
interface MnemoSpanAttributes {
  "mnemo.workspace_id": string; // Stable workspace identifier
  "mnemo.agent_id": string; // Agent or client ID
  "mnemo.session_id"?: string; // Present when inside a session
  "mnemo.operation": string; // "recall" | "write" | "collapse" | ...

  // Outcome (set before span.end())
  "mnemo.tier_hit"?: "hot" | "warm" | "cold";
  "mnemo.cache_hit"?: boolean;
  "mnemo.result_count"?: number;
  "mnemo.worth_avg"?: number; // Average worth of returned facts

  // Cost (only when LLM involved)
  "mnemo.llm_tokens_used"?: number;
  "mnemo.llm_cost_usd"?: number;
  "mnemo.tokens_saved"?: number; // vs. executing the LLM call

  // Embed
  "mnemo.embedding_calls"?: number;
}
```

### Implementations

#### OTelTelemetry (production)

```typescript
// packages/server/src/telemetry/otel.ts
// (Telemetry interface: @mnemo-ai/types/src/ports/observability.ts)

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";

export interface OTelTelemetryOpts {
  endpoint: string; // OTLP gRPC endpoint, e.g. "http://otel-collector:4317"
  serviceName?: string; // Default: "mnemosyne-server"
  serviceVersion?: string; // Injected from package.json version
  prometheusPort?: number; // Default: 9464 (Prometheus scrape)
}

export function createOTelTelemetry(opts: OTelTelemetryOpts): Telemetry {
  // Initialises NodeSDK with:
  //   - OTLPTraceExporter (gRPC to collector)
  //   - PrometheusExporter (scrape endpoint for metrics)
  //   - Auto-instrumentation: http, pg, ioredis, grpc
}
```

**OTel Collector configuration (recommended):**

```yaml
# collector/config.yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: "0.0.0.0:4317" }
      http: { endpoint: "0.0.0.0:4318" }

processors:
  batch:
    timeout: 200ms
    send_batch_size: 512
  memory_limiter:
    limit_mib: 500
    spike_limit_mib: 100
    check_interval: 1s
  attributes/redact:
    actions:
      - key: query.text
        action: delete
      - key: fact.content
        action: delete
  tail_sampling:
    decision_wait: 10s
    policies:
      - name: errors-always
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow-always
        type: latency
        latency: { threshold_ms: 500 }
      - name: sample-normal
        type: probabilistic
        probabilistic: { sampling_percentage: 10 }

exporters:
  otlp/tempo:
    endpoint: "http://tempo:4317"
  prometheusremotewrite:
    endpoint: "http://prometheus:9090/api/v1/write"
  loki:
    endpoint: "http://loki:3100/loki/api/v1/push"

service:
  pipelines:
    traces:
      {
        receivers: [otlp],
        processors: [memory_limiter, batch, attributes/redact, tail_sampling],
        exporters: [otlp/tempo],
      }
    metrics:
      { receivers: [otlp], processors: [memory_limiter, batch], exporters: [prometheusremotewrite] }
    logs:
      {
        receivers: [otlp],
        processors: [memory_limiter, batch, attributes/redact],
        exporters: [loki],
      }
```

#### NoopTelemetry (default for embedded/library)

```typescript
// packages/server/src/telemetry/noop.ts
// (Telemetry interface: @mnemo-ai/types/src/ports/observability.ts)

const NOOP_SPAN: Span = {
  setAttribute: () => {},
  setAttributes: () => {},
  setStatus: () => {},
  recordException: () => {},
  end: () => {},
};

export function createNoopTelemetry(): Telemetry {
  return {
    startSpan: () => NOOP_SPAN,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
}
```

#### MockTelemetry (for unit and integration tests)

```typescript
// packages/server/src/telemetry/mock.ts
// (Telemetry interface: @mnemo-ai/types/src/ports/observability.ts)

export interface MockSpan extends Span {
  name: string;
  attributes: SpanAttributes;
  status?: { code: "ok" | "error"; message?: string };
  ended: boolean;
  children: MockSpan[];
}

export interface MockTelemetry extends Telemetry {
  spans: MockSpan[];
  counters: Map<string, number>;
  histograms: Map<string, number[]>;
  gauges: Map<string, number>;

  findSpan(name: string): MockSpan | undefined;
  assertSpan(name: string): MockSpan; // Throws if not found
  reset(): void;
}
```

### Context Propagation

The server middleware injects W3C `traceparent` headers on every inbound HTTP
request and propagates the context through the async call chain via OTel's
`context.with()` API. All child spans created during the request lifetime
automatically attach to the root span.

For MCP calls (stdio transport), propagation uses `baggage` headers in the
JSON-RPC request metadata. The MCP server extracts them via a request hook
before dispatching to core.

---

## 4. Span Catalog

### Naming Convention

All manual spans follow the pattern `mnemo.<domain>[.<sub-operation>]`.
Auto-instrumented spans (`pg.query`, `http.client`, `redis.command`) retain
their default names from the OTel instrumentation libraries.

### Core Package (`@mnemo-ai/core`)

#### `mnemo.recall` — Full recall pipeline (parent span)

```
mnemo.recall
  ├── mnemo.recall.hot          Tier 1: Redis sorted-set lookup
  ├── mnemo.recall.warm         Tier 2: Entity drawer + FTS
  │     └── pg.query            (auto-instrumented)
  ├── mnemo.recall.cold         Tier 3: Full vector pipeline
  │     ├── mnemo.embed         Embedding generation
  │     │     └── http.client   (auto-instrumented API call)
  │     ├── pg.query            HNSW vector search
  │     ├── pg.query            FTS parallel branch
  │     ├── mnemo.rerank        Optional LLM-based rerank
  │     └── mnemo.graph_expand  1-hop relation traversal
  ├── mnemo.composition         Inference engine (if enabled)
  └── mnemo.render              Format + serialize response
```

| Attribute            | Type                      | Required                               |
| -------------------- | ------------------------- | -------------------------------------- |
| `mnemo.workspace_id` | string                    | yes                                    |
| `mnemo.tier_hit`     | "hot" \| "warm" \| "cold" | yes (on end)                           |
| `mnemo.cache_hit`    | boolean                   | yes                                    |
| `mnemo.result_count` | number                    | yes                                    |
| `mnemo.worth_avg`    | number                    | on result                              |
| `mnemo.tokens_saved` | number                    | when hot tier hit served cached result |

#### `mnemo.write` — Write fact

| Attribute                 | Type                                      | Required |
| ------------------------- | ----------------------------------------- | -------- |
| `mnemo.workspace_id`      | string                                    | yes      |
| `mnemo.fact.kind`         | "fact" \| "rule" \| "procedure" \| "task" | yes      |
| `mnemo.conflict_detected` | boolean                                   | yes      |
| `mnemo.embedding_queued`  | boolean                                   | yes      |

#### `mnemo.consolidation` — Consolidation job (batch)

| Attribute               | Type                               | Required |
| ----------------------- | ---------------------------------- | -------- |
| `mnemo.workspace_id`    | string                             | yes      |
| `mnemo.facts_evaluated` | number                             | yes      |
| `mnemo.facts_allowed`   | number                             | yes      |
| `mnemo.facts_gated`     | number                             | yes      |
| `mnemo.gate_reason`     | "worth" \| "recent" \| "redundant" | on gate  |

#### `mnemo.session.collapse` — Session collapse (LLM-assisted)

| Attribute               | Type   | Required |
| ----------------------- | ------ | -------- |
| `mnemo.session_id`      | string | yes      |
| `mnemo.turns_count`     | number | yes      |
| `mnemo.facts_extracted` | number | on end   |
| `mnemo.llm_tokens_used` | number | yes      |
| `mnemo.llm_cost_usd`    | number | yes      |

#### `mnemo.reasoning.resolve` — CoT cache lookup + execution

| Attribute                   | Type    | Required     |
| --------------------------- | ------- | ------------ |
| `mnemo.workspace_id`        | string  | yes          |
| `mnemo.reasoning.cache_hit` | boolean | yes          |
| `mnemo.tokens_saved`        | number  | on cache hit |
| `mnemo.worth`               | number  | on end       |

#### `mnemo.self_edit` — Self-edit operation (meta-cognition)

| Attribute            | Type                                          | Required |
| -------------------- | --------------------------------------------- | -------- |
| `mnemo.workspace_id` | string                                        | yes      |
| `mnemo.edit.kind`    | "correction" \| "enrichment" \| "deprecation" | yes      |
| `mnemo.edit.fact_id` | string                                        | yes      |

#### `mnemo.worth.propagate` — Worth propagation (Hebbian update)

| Attribute              | Type    | Required |
| ---------------------- | ------- | -------- |
| `mnemo.workspace_id`   | string  | yes      |
| `mnemo.facts_updated`  | number  | yes      |
| `mnemo.cycle_detected` | boolean | yes      |

### Adapter Spans

#### `mnemo.storage.*`

| Span                          | When emitted             |
| ----------------------------- | ------------------------ |
| `mnemo.storage.vector_search` | pgvector / Qdrant search |
| `mnemo.storage.fts_search`    | tsvector / FTS5 query    |
| `mnemo.storage.get_facts`     | Batch fact fetch by ID   |
| `mnemo.storage.create_fact`   | INSERT into mnemo_fact   |
| `mnemo.storage.update_fact`   | UPDATE mnemo_fact        |
| `mnemo.storage.health_check`  | Adapter health probe     |

#### `mnemo.cache.*`

| Span                 | When emitted                  |
| -------------------- | ----------------------------- |
| `mnemo.cache.get`    | Cache lookup                  |
| `mnemo.cache.set`    | Cache write                   |
| `mnemo.cache.delete` | Cache eviction / invalidation |
| `mnemo.cache.zadd`   | ACT-R score update (hot tier) |
| `mnemo.cache.zrange` | Hot tier recall fetch         |

#### `mnemo.embed.*`

| Span                 | When emitted             |
| -------------------- | ------------------------ |
| `mnemo.embed.single` | Single text embedding    |
| `mnemo.embed.batch`  | Batch embed (write path) |

Attributes: `mnemo.embed.model`, `mnemo.embed.dimensions`,
`mnemo.embed.text_length` (character count, not content).

#### `mnemo.llm.*`

| Span                   | When emitted                   |
| ---------------------- | ------------------------------ |
| `mnemo.llm.generate`   | Free-form generation           |
| `mnemo.llm.structured` | Structured output (Zod schema) |

Attributes: `mnemo.llm.model`, `mnemo.llm.tokens_in`,
`mnemo.llm.tokens_out`, `mnemo.llm.cost_usd`, `mnemo.llm.finish_reason`.

#### `mnemo.queue.*`

| Span                   | When emitted                       |
| ---------------------- | ---------------------------------- |
| `mnemo.queue.enqueue`  | Job submitted (SpanKind: producer) |
| `mnemo.queue.process`  | Job executed (SpanKind: consumer)  |
| `mnemo.queue.schedule` | Cron job registration              |

### Server Package (`@mnemo-ai/server`)

#### `mnemo.http.*`

Auto-instrumented by `@opentelemetry/instrumentation-http`. Manual attributes
added by Hono middleware:

| Attribute            | Value                                   |
| -------------------- | --------------------------------------- |
| `http.method`        | GET \| POST \| DELETE                   |
| `http.route`         | "/memory/recall" (template, not filled) |
| `http.status_code`   | 200 \| 400 \| 401 \| 429 \| 500         |
| `mnemo.workspace_id` | resolved from API key                   |

#### `mnemo.auth`

| Attribute                 | Type               | Required   |
| ------------------------- | ------------------ | ---------- |
| `mnemo.auth.method`       | "api_key" \| "jwt" | yes        |
| `mnemo.auth.cache_hit`    | boolean            | yes        |
| `mnemo.auth.workspace_id` | string             | on success |

#### `mnemo.ratelimit`

| Attribute                      | Type                            | Required |
| ------------------------------ | ------------------------------- | -------- |
| `mnemo.ratelimit.workspace_id` | string                          | yes      |
| `mnemo.ratelimit.bucket`       | "recall" \| "write" \| "global" | yes      |
| `mnemo.ratelimit.allowed`      | boolean                         | yes      |
| `mnemo.ratelimit.remaining`    | number                          | yes      |

---

## 5. Metrics Catalog

All metrics use Prometheus exposition format. Histogram buckets are
chosen to align with SLO boundaries (see Section 7).

```
# ─── RED Metrics ─────────────────────────────────────────────────────────────

# TYPE mnemo_requests_total counter
# HELP mnemo_requests_total Total HTTP requests by method, endpoint, and status.
mnemo_requests_total{method="POST",endpoint="/memory/recall",status_code="200"} 0

# TYPE mnemo_errors_total counter
# HELP mnemo_errors_total Total request errors by endpoint and error code.
mnemo_errors_total{endpoint="/memory/recall",error_code="conflict"} 0

# TYPE mnemo_request_duration_seconds histogram
# HELP mnemo_request_duration_seconds HTTP request latency distribution.
# Buckets: 0.005 0.01 0.025 0.05 0.1 0.25 0.5 1.0 2.5 5.0 10.0
mnemo_request_duration_seconds_bucket{endpoint="/memory/recall",le="0.05"} 0

# ─── USE Metrics: PostgreSQL ──────────────────────────────────────────────────

# TYPE mnemo_pg_pool_connections_active gauge
mnemo_pg_pool_connections_active 0

# TYPE mnemo_pg_pool_connections_idle gauge
mnemo_pg_pool_connections_idle 0

# TYPE mnemo_pg_pool_connections_total gauge
mnemo_pg_pool_connections_total 0

# TYPE mnemo_pg_pool_utilization_ratio gauge
# HELP mnemo_pg_pool_utilization_ratio active / total connections (0.0–1.0).
mnemo_pg_pool_utilization_ratio 0.0

# TYPE mnemo_pg_pool_wait_duration_seconds histogram
# HELP mnemo_pg_pool_wait_duration_seconds Time waiting for a PG connection.
# Buckets: 0.001 0.005 0.01 0.025 0.05 0.1 0.25 0.5
mnemo_pg_pool_wait_duration_seconds_bucket{le="0.05"} 0

# TYPE mnemo_pg_query_duration_seconds histogram
# HELP mnemo_pg_query_duration_seconds PG query latency by query type.
# Labels: query_type = "recall_fts" | "recall_vector" | "write" | "admin"
mnemo_pg_query_duration_seconds_bucket{query_type="recall_fts",le="0.025"} 0

# ─── USE Metrics: Redis ───────────────────────────────────────────────────────

# TYPE mnemo_redis_connections_active gauge
mnemo_redis_connections_active 0

# TYPE mnemo_redis_memory_used_bytes gauge
mnemo_redis_memory_used_bytes 0

# TYPE mnemo_redis_operations_total counter
# Labels: operation = "get" | "set" | "del" | "zadd" | "zrange" | "publish"
mnemo_redis_operations_total{operation="get"} 0

# TYPE mnemo_redis_latency_seconds histogram
mnemo_redis_latency_seconds_bucket{operation="get",le="0.005"} 0

# ─── USE Metrics: Queue ───────────────────────────────────────────────────────

# TYPE mnemo_queue_depth gauge
# Labels: job_key = "embed" | "extract" | "collapse" | "consolidate" | "worth"
#         priority = "1" | "2" | "3" | "4"
mnemo_queue_depth{job_key="embed",priority="2"} 0

# TYPE mnemo_queue_lag_seconds gauge
# HELP mnemo_queue_lag_seconds Age of the oldest pending job per job_key.
mnemo_queue_lag_seconds{job_key="embed"} 0

# TYPE mnemo_queue_completed_total counter
mnemo_queue_completed_total{job_key="embed"} 0

# TYPE mnemo_queue_failed_total counter
mnemo_queue_failed_total{job_key="embed"} 0

# TYPE mnemo_queue_shed_total counter
# HELP mnemo_queue_shed_total Backpressure shedding events per stage.
mnemo_queue_shed_total{stage="enqueue"} 0

# ─── Domain Metrics: Recall ───────────────────────────────────────────────────

# TYPE mnemo_recall_duration_seconds histogram
# Buckets: 0.002 0.005 0.01 0.03 0.05 0.1 0.2 0.5 1.0
# Labels: tier = "hot" | "warm" | "cold"
mnemo_recall_duration_seconds_bucket{tier="hot",le="0.005"} 0

# TYPE mnemo_recall_tier_hits_total counter
# HELP mnemo_recall_tier_hits_total Recalls served by tier.
mnemo_recall_tier_hits_total{tier="hot"} 0
mnemo_recall_tier_hits_total{tier="warm"} 0
mnemo_recall_tier_hits_total{tier="cold"} 0

# TYPE mnemo_recall_empty_total counter
# HELP mnemo_recall_empty_total Recalls that returned 0 results.
mnemo_recall_empty_total 0

# TYPE mnemo_recall_composition_inferences_total counter
# HELP mnemo_recall_composition_inferences_total Inferences appended by composition engine.
mnemo_recall_composition_inferences_total 0

# ─── Domain Metrics: Facts & Worth ───────────────────────────────────────────

# TYPE mnemo_fact_total gauge
# Labels: status = "active" | "archived" | "quarantined"
#         type   = "fact" | "rule" | "procedure" | "task"
# Note: workspace label omitted — use recording rule to aggregate per workspace.
mnemo_fact_total{status="active",type="fact"} 0

# TYPE mnemo_worth_distribution_bucket gauge
# HELP mnemo_worth_distribution_bucket Count of facts per worth bucket.
# Labels: bucket = "0_0.2" | "0.2_0.4" | "0.4_0.6" | "0.6_0.8" | "0.8_1.0"
mnemo_worth_distribution_bucket{bucket="0.6_0.8"} 0

# TYPE mnemo_consolidation_decisions_total counter
# Labels: decision = "allowed" | "gated_worth" | "gated_recent" | "gated_redundant"
mnemo_consolidation_decisions_total{decision="allowed"} 0

# TYPE mnemo_hot_tier_size gauge
# HELP mnemo_hot_tier_size Number of facts in hot tier per workspace.
mnemo_hot_tier_size 0

# TYPE mnemo_hot_tier_evictions_total counter
mnemo_hot_tier_evictions_total 0

# ─── Domain Metrics: Sessions ─────────────────────────────────────────────────

# TYPE mnemo_session_active_total gauge
mnemo_session_active_total 0

# TYPE mnemo_session_collapsed_total counter
# Labels: reason = "turn_limit" | "token_limit" | "explicit" | "idle_timeout"
#         outcome = "success" | "failed" | "partial"
mnemo_session_collapsed_total{reason="turn_limit",outcome="success"} 0

# TYPE mnemo_session_collapse_duration_seconds histogram
# Buckets: 0.5 1.0 2.0 3.0 5.0 8.0 15.0
mnemo_session_collapse_duration_seconds_bucket{le="3.0"} 0

# TYPE mnemo_session_turns_histogram histogram
# HELP mnemo_session_turns_histogram Turns per session before collapse.
# Buckets: 5 10 20 50 100 200 500
mnemo_session_turns_histogram_bucket{le="50"} 0

# ─── Domain Metrics: Reasoning (CoT Distillation) ────────────────────────────

# TYPE mnemo_reasoning_resolve_total counter
# Labels: result = "cache_hit" | "execute"
mnemo_reasoning_resolve_total{result="cache_hit"} 0

# TYPE mnemo_reasoning_tokens_saved_total counter
# HELP mnemo_reasoning_tokens_saved_total Cumulative tokens saved by CoT cache.
mnemo_reasoning_tokens_saved_total 0

# TYPE mnemo_reasoning_worth_histogram histogram
# HELP mnemo_reasoning_worth_histogram Worth distribution of CoT cache results served.
mnemo_reasoning_worth_histogram_bucket{le="0.5"} 0

# ─── Domain Metrics: Federation ───────────────────────────────────────────────

# TYPE mnemo_federation_sync_duration_seconds histogram
# Labels: peer (short identifier, not URL)
mnemo_federation_sync_duration_seconds_bucket{peer="peer-a",le="1.0"} 0

# TYPE mnemo_federation_conflicts_total counter
# Labels: resolution = "local_wins" | "remote_wins" | "manual" | "merkle_mismatch"
mnemo_federation_conflicts_total{resolution="local_wins"} 0

# TYPE mnemo_federation_lag_seconds gauge
# HELP mnemo_federation_lag_seconds Sync lag behind each peer.
mnemo_federation_lag_seconds{peer="peer-a"} 0

# ─── Cost Metrics ─────────────────────────────────────────────────────────────

# TYPE mnemo_llm_tokens_used_total counter
# Labels: model     = short model identifier ("claude-sonnet-4", "gpt-4o", etc.)
#         operation = "embed" | "extract" | "collapse" | "compose" | "self_edit"
mnemo_llm_tokens_used_total{model="claude-sonnet-4",operation="collapse"} 0

# TYPE mnemo_llm_cost_usd_total counter
# HELP mnemo_llm_cost_usd_total Cumulative LLM spend in USD (label cardinality: low).
mnemo_llm_cost_usd_total{model="claude-sonnet-4",operation="collapse"} 0

# TYPE mnemo_tokens_saved_estimated_total counter
# Labels: mechanism = "distillation" | "anticipation" | "composition" | "hot_tier" | "consensus"
mnemo_tokens_saved_estimated_total{mechanism="distillation"} 0

# ─── Adapters & Feature Flags ─────────────────────────────────────────────────

# TYPE mnemo_adapter_health gauge
# HELP mnemo_adapter_health 1 = healthy, 0.5 = degraded, 0 = down.
# Labels: adapter = adapter id strings — real ids: "pgvector" (PgVectorAdapter),
#         "redis" (RedisCacheAdapter), provider name for LLM adapters (e.g. "anthropic", "openai")
mnemo_adapter_health{adapter="pgvector"} 1

# TYPE mnemo_feature_flag_status gauge
# HELP mnemo_feature_flag_status 1 = enabled, 0 = disabled.
# Labels: flag = FeatureFlag enum values
mnemo_feature_flag_status{flag="hotTier"} 1
```

---

## 6. Error Code System

> ⚠️ **Proposed operational taxonomy — not the shipped wire codes.** The `MNEMO_xxx` codes
> below are a planned internal failure-mode catalog (for runbooks/alerting); they are **not**
> emitted today. The shipped errors are `HttpError` subclasses in `packages/server/src/errors.ts`
> whose `code` field is a snake_case HTTP code: `bad_request` (400), `unauthorized` (401),
> `forbidden` (403), `not_found` (404), `conflict` (409), `unprocessable_entity` (422),
> `rate_limited` (429), `internal_error` (500), `not_implemented` (501), `service_unavailable` (503).
> Those appear in the JSON envelope (`error.code`) and the `mnemo.error_code` span attribute.
> See [docs/architecture/API.md](../architecture/API.md) §6 for the canonical table.

The failure-mode catalog below maps operational conditions to severity and recovery actions.

### MNEMO_0xx — Infrastructure

| Code        | Name                          | Severity | Description                                          | Common Causes                                                            | Recovery                                                                    |
| ----------- | ----------------------------- | -------- | ---------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `MNEMO_001` | RedisConnectionFailed         | WARN     | Redis unavailable; degrading to in-memory cache      | Redis down, misconfigured URL, network partition                         | Automatic: fallback to MemoryCache. Alert if duration > 5min.               |
| `MNEMO_002` | PgPoolExhausted               | ERROR    | All PG connections in use; request queued or dropped | Traffic spike, slow queries holding connections, PgBouncer misconfigured | Increase pool max or add PgBouncer; kill long-running queries.              |
| `MNEMO_003` | EmbedTimeout                  | WARN     | Embedding provider exceeded deadline                 | Provider API latency spike, rate limit, cold start                       | Retry with backoff. If persistent: disable vector search, fall back to FTS. |
| `MNEMO_004` | LLMCallFailed                 | ERROR    | LLM completion failed or timed out                   | Provider outage, invalid API key, context length exceeded                | Queue for retry. If collapse: defer session; if extract: retry later.       |
| `MNEMO_005` | FederationPeerUnreachable     | WARN     | Cannot reach federation peer                         | Network partition, peer shut down, DNS failure                           | Sync deferred. Resume on next scheduled sync cycle.                         |
| `MNEMO_006` | WorthCycleDetected            | ERROR    | Cyclic dependency found during worth propagation     | Data bug — relation graph has cycle                                      | Log offending fact IDs; skip cycle and alert for manual review.             |
| `MNEMO_007` | ConsolidationRollback         | ERROR    | Consolidation transaction rolled back mid-batch      | PG constraint violation, concurrent write conflict                       | Retry consolidation batch with smaller window.                              |
| `MNEMO_008` | MerkleChainVerificationFailed | ERROR    | Merkle audit trail integrity check failed            | Storage corruption, unauthorized direct DB write                         | Halt further writes for affected workspace; trigger audit.                  |
| `MNEMO_009` | HotTierFull                   | WARN     | Redis memory limit reached; hot tier entries evicted | Too many workspaces, insufficient Redis memory                           | Increase Redis memory or reduce hot tier TTL.                               |
| `MNEMO_010` | PluginTimeout                 | WARN     | Plugin execution exceeded deadline                   | Slow plugin, infinite loop, external dependency in plugin                | Kill plugin goroutine/worker; mark plugin as degraded.                      |
| `MNEMO_011` | QueueShed                     | WARN     | Job rejected due to backpressure                     | Queue lag exceeds threshold, worker pool saturated                       | Scale workers or reduce ingestion rate.                                     |
| `MNEMO_012` | WorkerThreadCrash             | ERROR    | Node.js worker thread crashed unexpectedly           | OOM in worker, uncaught exception                                        | Restart worker pool; alert if crash rate > 1/min.                           |

### MNEMO_1xx — Authentication & Authorization

| Code        | Name              | Severity | Description                                   | Recovery                               |
| ----------- | ----------------- | -------- | --------------------------------------------- | -------------------------------------- |
| `MNEMO_100` | ApiKeyMissing     | WARN     | No Authorization header present               | 401 to client.                         |
| `MNEMO_101` | ApiKeyInvalid     | WARN     | Key not found or revoked                      | 401 to client.                         |
| `MNEMO_102` | ApiKeyExpired     | WARN     | Key TTL exceeded                              | 401. Client should rotate key.         |
| `MNEMO_103` | WorkspaceNotFound | ERROR    | Workspace ID resolved from key does not exist | 404. Data inconsistency — investigate. |
| `MNEMO_104` | RbacDenied        | WARN     | Authenticated agent lacks required permission | 403 to client.                         |
| `MNEMO_105` | RateLimitExceeded | INFO     | Request rate exceeds workspace quota          | 429. Client implements backoff.        |

### MNEMO_2xx — Storage

| Code        | Name                     | Severity | Description                                                      |
| ----------- | ------------------------ | -------- | ---------------------------------------------------------------- |
| `MNEMO_200` | FactNotFound             | INFO     | Fact ID does not exist or is archived                            |
| `MNEMO_201` | FactConflict             | WARN     | Duplicate or contradicting fact detected during write            |
| `MNEMO_202` | EntityNotFound           | INFO     | Entity referenced in relation does not exist                     |
| `MNEMO_203` | StorageMigrationFailed   | FATAL    | Schema migration could not complete                              |
| `MNEMO_204` | VectorDimensionMismatch  | ERROR    | Stored embedding dimension differs from adapter dimension        |
| `MNEMO_205` | StorageCapabilityMissing | WARN     | Requested operation requires capability not available in adapter |

### MNEMO_3xx — Recall

| Code        | Name               | Severity | Description                                             |
| ----------- | ------------------ | -------- | ------------------------------------------------------- |
| `MNEMO_300` | RecallEmptyResult  | INFO     | Query returned zero results (not an error, but tracked) |
| `MNEMO_301` | RecallTierTimeout  | WARN     | A specific recall tier exceeded its latency budget      |
| `MNEMO_302` | RerankFailed       | WARN     | Reranker returned error; falling back to score order    |
| `MNEMO_303` | GraphExpandTimeout | WARN     | Graph traversal exceeded budget                         |
| `MNEMO_304` | CompositionFailed  | WARN     | Inference engine failed to compose result               |

### MNEMO_4xx — Cognitive Operations

| Code        | Name                       | Severity | Description                                         |
| ----------- | -------------------------- | -------- | --------------------------------------------------- |
| `MNEMO_400` | SessionCollapsePartial     | WARN     | Collapse completed but not all turns were processed |
| `MNEMO_401` | SessionCollapseLLMFailed   | ERROR    | LLM call during collapse returned error             |
| `MNEMO_402` | ExtractionFailed           | WARN     | Fact extraction from content yielded no facts       |
| `MNEMO_403` | SelfEditConflict           | WARN     | Self-edit tried to modify an archived fact          |
| `MNEMO_404` | AnticipationEvictionFailed | WARN     | Pre-warming task could not write to hot tier        |
| `MNEMO_405` | ProceduralMemoryInvalid    | ERROR    | Procedure fact failed validation on execution       |

### MNEMO_5xx — Federation

| Code        | Name                       | Severity | Description                                        |
| ----------- | -------------------------- | -------- | -------------------------------------------------- |
| `MNEMO_500` | FederationSyncConflict     | WARN     | Merge conflict during federated sync               |
| `MNEMO_501` | FederationAuthFailed       | ERROR    | Peer rejected auth credentials                     |
| `MNEMO_502` | FederationProtocolMismatch | ERROR    | Peer runs incompatible federation protocol version |
| `MNEMO_503` | FederationSyncTimeout      | WARN     | Sync to peer exceeded deadline                     |

### MNEMO_6xx — Plugins

| Code        | Name                   | Severity | Description                                          |
| ----------- | ---------------------- | -------- | ---------------------------------------------------- |
| `MNEMO_600` | PluginNotFound         | WARN     | Registered plugin name has no loader entry           |
| `MNEMO_601` | PluginLoadFailed       | ERROR    | Plugin module could not be imported                  |
| `MNEMO_602` | PluginValidationFailed | WARN     | Plugin returned output that failed schema validation |
| `MNEMO_603` | PluginRateLimited      | INFO     | Plugin execution rate limit reached for workspace    |

---

## 7. SLO Definitions

### Latency SLOs

| Operation                       | p50    | p95    | p99    | Notes                                 |
| ------------------------------- | ------ | ------ | ------ | ------------------------------------- |
| `recall` — hot tier hit         | 2ms    | 4ms    | 8ms    | Redis GET + deserialize               |
| `recall` — warm (pointer + FTS) | 8ms    | 15ms   | 30ms   | PG FTS + entity drawer                |
| `recall` — cold (full pipeline) | 50ms   | 120ms  | 200ms  | Embed + vector + FTS + rerank + graph |
| `write` (fact)                  | 10ms   | 20ms   | 50ms   | Validate + conflict check + INSERT    |
| `session.addTurn`               | 1ms    | 3ms    | 5ms    | Redis RPUSH                           |
| `session.collapse`              | 1000ms | 2500ms | 5000ms | LLM call dominates                    |
| `health check`                  | 1ms    | 5ms    | 10ms   | PG SELECT 1 + Redis PING              |
| `auth` — cached                 | 0.5ms  | 1ms    | 2ms    | LRU bcrypt lookup                     |
| `auth` — cold                   | 50ms   | 80ms   | 120ms  | bcrypt(12) comparison                 |

### Availability SLO

```
Target:      99.9% (43.2 minutes downtime per month)

Measurement: successful_requests / total_requests

Excluded from SLO window:
  - HTTP 429 (rate limit — expected behavior)
  - HTTP 503 during declared maintenance window
  - All /admin/* endpoints
  - /health endpoints

Error budget per 30 days: 43.2 minutes
  ├── Planned maintenance reserve: 15 minutes
  └── Unplanned incident budget:   28.2 minutes
```

### Quality SLOs

| SLO                | Target | Measurement                                   |
| ------------------ | ------ | --------------------------------------------- |
| Recall precision   | 0.95   | relevant_results / returned_results (sampled) |
| CoT cache hit rate | ≥ 0.30 | cache_hits / total_reasoning_resolves         |
| Hot tier hit rate  | ≥ 0.60 | tier1_hits / total_recalls                    |

### Burn Rate Alert Thresholds (multi-window)

| Window   | Consumption Rate | Severity | Action                   |
| -------- | ---------------- | -------- | ------------------------ |
| 1 hour   | 14.4× budget     | CRITICAL | Page on-call immediately |
| 6 hours  | 6.0× budget      | WARNING  | Alert team, investigate  |
| 24 hours | 3.0× budget      | INFO     | Review in next standup   |

---

## 8. Alerting Rules

```yaml
# prometheus/alerts.yaml
groups:
  - name: mnemosyne.slo
    rules:
      # ─── Fast burn: 1h window ─────────────────────────────────────────────
      - alert: MnemoSLOFastBurn
        expr: |
          (
            rate(mnemo_errors_total[1h]) /
            rate(mnemo_requests_total[1h])
          ) > (14.4 * 0.001)
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Mnemosyne SLO fast burn rate exceeded"
          description: >
            Error rate over the last 1h is consuming the monthly error budget
            at 14.4× the allowed rate. Immediate investigation required.

      # ─── Slow burn: 6h window ─────────────────────────────────────────────
      - alert: MnemoSLOSlowBurn
        expr: |
          (
            rate(mnemo_errors_total[6h]) /
            rate(mnemo_requests_total[6h])
          ) > (6 * 0.001)
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Mnemosyne SLO slow burn rate elevated"

      # ─── Latency SLOs ─────────────────────────────────────────────────────
      - alert: MnemoRecallHotP99High
        expr: |
          histogram_quantile(0.99, rate(mnemo_recall_duration_seconds_bucket{tier="hot"}[5m]))
          > 0.010
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Recall hot tier p99 exceeds 10ms SLO"

      - alert: MnemoRecallColdP99High
        expr: |
          histogram_quantile(0.99, rate(mnemo_recall_duration_seconds_bucket{tier="cold"}[5m]))
          > 0.500
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Recall cold tier p99 exceeds 500ms SLO"

  - name: mnemosyne.infra
    rules:
      # ─── PG pool saturation ───────────────────────────────────────────────
      - alert: MnemoPostgresPoolSaturated
        expr: mnemo_pg_pool_utilization_ratio > 0.85
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "PostgreSQL connection pool > 85% utilization"

      - alert: MnemoPostgresPoolExhausted
        expr: mnemo_pg_pool_utilization_ratio >= 1.0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "PostgreSQL connection pool exhausted (MNEMO_002)"

      - alert: MnemoPostgresPoolWaitHigh
        expr: |
          histogram_quantile(0.99, rate(mnemo_pg_pool_wait_duration_seconds_bucket[5m]))
          > 0.100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "PG pool p99 wait time exceeds 100ms"

      # ─── Redis health ─────────────────────────────────────────────────────
      - alert: MnemoRedisDegraded
        expr: mnemo_adapter_health{adapter="redis"} < 1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Redis adapter degraded (MNEMO_001) — hot tier disabled"

      # ─── Queue health ─────────────────────────────────────────────────────
      - alert: MnemoQueueLagHigh
        expr: mnemo_queue_lag_seconds{job_key="embed"} > 300
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Embed queue lag exceeds 5 minutes"

      - alert: MnemoQueueFailureRateHigh
        expr: |
          rate(mnemo_queue_failed_total[5m])
          / (rate(mnemo_queue_completed_total[5m]) + rate(mnemo_queue_failed_total[5m]))
          > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Queue job failure rate exceeds 5%"

  - name: mnemosyne.cognitive
    rules:
      # ─── Session collapse failures ────────────────────────────────────────
      - alert: MnemoCollapseFailureRateHigh
        expr: |
          rate(mnemo_session_collapsed_total{outcome="failed"}[10m])
          / rate(mnemo_session_collapsed_total[10m])
          > 0.10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Session collapse failure rate > 10% (MNEMO_401)"

      # ─── Hot tier hit rate drop ───────────────────────────────────────────
      - alert: MnemoHotTierHitRateLow
        expr: |
          rate(mnemo_recall_tier_hits_total{tier="hot"}[15m])
          / rate(mnemo_recall_tier_hits_total[15m])
          < 0.40
        for: 15m
        labels:
          severity: info
        annotations:
          summary: "Hot tier hit rate below 40% — cache warming may be needed"

  - name: mnemosyne.cost
    rules:
      # ─── LLM spend anomaly ────────────────────────────────────────────────
      - alert: MnemoLLMSpendAnomalyHigh
        expr: |
          rate(mnemo_llm_cost_usd_total[1h]) * 3600
          > 2 * (
            avg_over_time(
              rate(mnemo_llm_cost_usd_total[1h])[7d:1h]
            ) * 3600
          )
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "LLM spend rate 2× above 7-day average"

      # ─── Token savings drop ───────────────────────────────────────────────
      - alert: MnemoTokenSavingsDropped
        expr: |
          rate(mnemo_tokens_saved_estimated_total[1h])
          / rate(mnemo_llm_tokens_used_total[1h])
          < 0.20
        for: 1h
        labels:
          severity: info
        annotations:
          summary: "Token savings ratio below 20% — CoT cache or hot tier degraded"
```

---

## 9. Dashboards

### Dashboard 1: Mnemosyne Overview

**Audience:** On-call, SREs.

| Panel                 | Type          | Query                                                                                              |
| --------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| Request rate (rps)    | Time series   | `rate(mnemo_requests_total[1m])`                                                                   |
| Error rate (%)        | Stat          | `rate(mnemo_errors_total[5m]) / rate(mnemo_requests_total[5m]) * 100`                              |
| p99 recall latency    | Time series   | `histogram_quantile(0.99, rate(mnemo_request_duration_seconds_bucket{endpoint=~".*/recall"}[5m]))` |
| SLO burn rate         | Gauge (0–20×) | 1h error rate / monthly budget                                                                     |
| Adapter health matrix | Table         | `mnemo_adapter_health`                                                                             |
| Feature flag status   | Table         | `mnemo_feature_flag_status`                                                                        |
| Active sessions       | Stat          | `mnemo_session_active_total`                                                                       |

### Dashboard 2: Recall Deep-Dive

**Audience:** Engineers investigating recall quality or latency regressions.

| Panel                      | Type        | Query                                                                                           |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| Tier hit distribution      | Pie chart   | `rate(mnemo_recall_tier_hits_total[5m])`                                                        |
| Recall p50/p95/p99 by tier | Time series | `histogram_quantile(0.X, rate(mnemo_recall_duration_seconds_bucket[5m]))`                       |
| Empty recall rate          | Time series | `rate(mnemo_recall_empty_total[5m])`                                                            |
| Hot tier hit rate          | Gauge       | `rate(mnemo_recall_tier_hits_total{tier="hot"}[15m]) / rate(mnemo_recall_tier_hits_total[15m])` |
| PG pool utilization        | Time series | `mnemo_pg_pool_utilization_ratio`                                                               |
| PG pool wait p99           | Time series | `histogram_quantile(0.99, rate(mnemo_pg_pool_wait_duration_seconds_bucket[5m]))`                |
| Queue depth (embed)        | Time series | `mnemo_queue_depth{job_key="embed"}`                                                            |

### Dashboard 3: Cognitive Health

**Audience:** Product engineers, ML ops.

| Panel                   | Type        | Query                                                                                                   |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| Facts by status         | Stacked bar | `mnemo_fact_total`                                                                                      |
| Worth distribution      | Bar chart   | `mnemo_worth_distribution_bucket`                                                                       |
| CoT cache hit rate      | Gauge       | `rate(mnemo_reasoning_resolve_total{result="cache_hit"}[1h]) / rate(mnemo_reasoning_resolve_total[1h])` |
| Session collapse rate   | Time series | `rate(mnemo_session_collapsed_total[5m])`                                                               |
| Collapse failure rate   | Time series | `rate(mnemo_session_collapsed_total{outcome="failed"}[5m]) / rate(mnemo_session_collapsed_total[5m])`   |
| Consolidation decisions | Stacked bar | `rate(mnemo_consolidation_decisions_total[5m])`                                                         |
| Hot tier eviction rate  | Time series | `rate(mnemo_hot_tier_evictions_total[5m])`                                                              |

### Dashboard 4: Cost & Token Economics

**Audience:** Finance, product leadership, engineers optimising token spend.

| Panel                     | Type        | Query                                                                                  |
| ------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| Hourly LLM spend ($)      | Time series | `rate(mnemo_llm_cost_usd_total[1h]) * 3600`                                            |
| Cumulative spend by model | Stacked bar | `mnemo_llm_cost_usd_total` by `model`                                                  |
| Tokens saved by mechanism | Stacked bar | `rate(mnemo_tokens_saved_estimated_total[1h])` by `mechanism`                          |
| Savings ratio             | Gauge       | `rate(mnemo_tokens_saved_estimated_total[1h]) / rate(mnemo_llm_tokens_used_total[1h])` |
| Spend vs. savings (ROI)   | Time series | Dual axis: spend rate vs. tokens_saved rate × avg token cost                           |
| Cost per operation        | Table       | `rate(mnemo_llm_cost_usd_total[1h])` by `operation`                                    |

### Dashboard 5: Federation

**Audience:** Engineers managing multi-instance or multi-region deployments.

| Panel                         | Type        | Query                                                                               |
| ----------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| Sync lag per peer             | Time series | `mnemo_federation_lag_seconds`                                                      |
| Conflict rate                 | Time series | `rate(mnemo_federation_conflicts_total[5m])`                                        |
| Conflict resolution breakdown | Pie chart   | `mnemo_federation_conflicts_total` by `resolution`                                  |
| Sync duration p99 per peer    | Time series | `histogram_quantile(0.99, rate(mnemo_federation_sync_duration_seconds_bucket[5m]))` |
| Peer health                   | Table       | `mnemo_adapter_health{adapter=~"federation.*"}`                                     |

---

## 10. Cost Tracking

### Token Economics Model

Every workspace has a running token ledger. Both spend and savings are tracked
so the system can compute a net ROI multiplier.

```typescript
// packages/server/src/telemetry/cost-tracker.ts
// (Telemetry interface: @mnemo-ai/types/src/ports/observability.ts)

export interface WorkspaceTokenLedger {
  workspaceId: string;

  // Spend (direct LLM API costs)
  tokensUsed: {
    embed: number; // Embedding model tokens (input only)
    extract: number; // Fact extraction from raw content
    collapse: number; // Session collapse
    compose: number; // Composition engine inference
    selfEdit: number; // Meta-cognition / self-edit
    total: number; // Sum of above
  };

  costUsd: {
    embed: number;
    extract: number;
    collapse: number;
    compose: number;
    selfEdit: number;
    total: number;
  };

  // Savings (tokens that would have been spent without Mnemosyne)
  tokensSaved: {
    distillation: number; // CoT cache hits: saved re-running reasoning
    anticipation: number; // Pre-warmed hot tier: saved recall + embed
    composition: number; // Composed answer vs. full context injection
    consensus: number; // Contradiction detection avoided bad LLM calls
    hotTier: number; // Calls served from Redis (no embed needed)
    total: number;
  };

  // ROI
  roiMultiplier: number; // estimate only (APP-015); measured served context: GET /admin/stats → context
  netSavingsUsd: number; // (tokensSaved.total × avg_token_cost) - costUsd.total
}
```

### Emit Points

| When                           | Counter                                                        | Value                                         |
| ------------------------------ | -------------------------------------------------------------- | --------------------------------------------- |
| LLM call completes             | `mnemo_llm_tokens_used_total`                                  | `tokensIn + tokensOut`                        |
| LLM call completes             | `mnemo_llm_cost_usd_total`                                     | computed from model price                     |
| CoT cache hit served           | `mnemo_tokens_saved_estimated_total{mechanism="distillation"}` | estimated tokens the LLM call would have used |
| Hot tier serves recall         | `mnemo_tokens_saved_estimated_total{mechanism="hot_tier"}`     | embed tokens + average context tokens         |
| Composition skips full context | `mnemo_tokens_saved_estimated_total{mechanism="composition"}`  | full context size - composed size             |
| Anticipation pre-warm used     | `mnemo_tokens_saved_estimated_total{mechanism="anticipation"}` | embed tokens saved                            |

### Unit Economics (per workspace, monthly recording rule)

Prometheus recording rules compute per-workspace unit economics in a
30-day rolling window. These drive the Cost dashboard and can be
exposed via the `/admin/workspace/{id}/economics` API endpoint.

```promql
# Monthly token spend per workspace (requires workspace label on cost counter)
record: mnemo:workspace_monthly_cost_usd
expr: increase(mnemo_llm_cost_usd_total[30d])

# Monthly savings per workspace
record: mnemo:workspace_monthly_savings_usd
expr: increase(mnemo_tokens_saved_estimated_total[30d]) * on() group_left()
      avg(mnemo_llm_cost_usd_total / mnemo_llm_tokens_used_total)

# ROI multiplier
record: mnemo:workspace_roi_multiplier
expr: mnemo:workspace_monthly_savings_usd / mnemo:workspace_monthly_cost_usd
```

---

## 11. Conventions

Every package that calls `telemetry` or `logger` MUST follow these rules.
Reviewers reject PRs that violate them.

### Span Creation Pattern (mandatory)

```typescript
// Every public method that does meaningful work:
async function doWork(input: Input): Promise<Output> {
  const span = this.telemetry.startSpan("mnemo.<domain>.<operation>", {
    kind: "internal",
    attributes: {
      "mnemo.workspace_id": input.workspaceId,
      // Set input attributes before the try block (always present)
    },
  });

  try {
    const result = await /* ... */;

    // Set outcome attributes after the work succeeds
    span.setAttribute("mnemo.result_count", result.length);
    span.setStatus("ok");

    this.telemetry.counter("mnemo_<operation>_total", 1, {
      outcome: "success",
    });

    return result;
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus("error", (error as Error).message);

    if (error instanceof MnemoError) {
      span.setAttribute("mnemo.error_code", error.code);
    }

    this.telemetry.counter("mnemo_errors_total", 1, {
      operation: "<operation>",
      error_code: error instanceof MnemoError ? error.code : "UNKNOWN",
    });

    throw error;
  } finally {
    // end() MUST be in finally — never in try or catch alone
    span.end();
  }
}
```

### Metric Naming

- All metrics: `mnemo_<noun>_<unit>` (e.g., `mnemo_request_duration_seconds`)
- Counters: always end with `_total`
- Gauges: current state, no suffix (e.g., `mnemo_session_active_total` is a counter; `mnemo_hot_tier_size` is a gauge)
- Histograms: end with `_seconds`, `_bytes`, or `_ratio`
- Use snake_case throughout. No camelCase in metric names.

### Label Cardinality Rules

| Label         | Allowed values                                         | Max distinct values |
| ------------- | ------------------------------------------------------ | ------------------- |
| `endpoint`    | URL templates only (`/memory/recall`)                  | ~20                 |
| `method`      | `GET`, `POST`, `DELETE`, `PATCH`                       | 4                   |
| `status_code` | `200`, `400`, `401`, `403`, `404`, `429`, `500`, `503` | 8                   |
| `tier`        | `hot`, `warm`, `cold`                                  | 3                   |
| `operation`   | closed enum from domain operations                     | ~15                 |
| `model`       | short model aliases defined per release                | ~10                 |
| `mechanism`   | closed enum from savings types                         | 5                   |
| `adapter`     | adapter `id` strings (stable)                          | ~20                 |

**Forbidden as labels:** workspace IDs, agent IDs, fact IDs, query text,
session IDs, or any free-text value. Use span attributes for per-request
identifiers, not metric labels.

### Log Level Rules

- One `logger.info()` per operation at completion. Do not log every tier
  attempt inside a recall — that is `debug` level.
- `logger.warn()` when a degraded path is taken. Include the degradation
  reason and the fallback path chosen.
- `logger.error()` when an exception escapes a service boundary. Always
  include `error.code` in `LogContext`.
- `logger.fatal()` only for unrecoverable process-level failures. Follow
  with `process.exit(1)` after flushing.
- Never log in a tight loop. If a loop runs more than 100 iterations, emit
  one summary log at the end.

### No PII Rule (non-negotiable)

The following fields MUST NEVER appear in any log, span attribute, or metric label:

- Query text (`query`, `text`, `content`, `statement`)
- Fact content (any field from `FactRecord` except `id`, `kind`, `status`, `worth`)
- Session turn messages
- User-provided titles, descriptions, or free-text fields
- IP addresses, email addresses, usernames

Use `pino`'s `redact` config to strip these paths automatically. Add
`"*.content"`, `"*.text"`, `"*.query"`, `"*.embedding"` to the redact list
at logger construction time.

### Context Propagation Rules

- Server middleware: extract W3C `traceparent` from inbound request headers.
  If absent, start a new root span. Inject `traceparent` into the response
  for clients that want to correlate.
- Child loggers: call `logger.child({ traceId, spanId, workspaceId, agentId })`
  once in the request handler and pass the child logger through to all
  service calls. Never pass the root logger into a request-scoped context.
- Async jobs: carry `traceId` as a job `data` field. The job processor
  creates a new span with the stored `traceId` as the remote parent.
- MCP tool calls: propagate via `_meta.traceContext` baggage field in the
  JSON-RPC request object. The MCP server extracts this before dispatching.

### Adapter Health Check Convention

Every adapter MUST implement `healthCheck(): Promise<HealthStatus>` and emit
`mnemo_adapter_health{adapter="<id>"}` as a gauge (1/0.5/0) after each check.
The health check scheduler runs every 30 seconds and is not on the hot path.
Health check spans are named `mnemo.<adapter_type>.health_check` and sampled
at 1% to avoid noise.
