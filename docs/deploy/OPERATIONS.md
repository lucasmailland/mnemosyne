# Mnemosyne — Operational Interfaces (Status Page & Metrics Dashboard)

**English** · [Español](OPERATIONS.es.md)

> **Scope:** Day-2 runbooks — monitoring, health checks, incident response, backup/restore, upgrades.
> Does NOT own Dockerfiles (see [`docker/`](../../docker/README.md)) or platform configs (see [`deploy/`](../../deploy/README.md)).
> Entry point: [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md).

> Consumer-facing operational visibility. Not the internal Grafana (that's for ops) —
> these are public/workspace-scoped interfaces for consumers to understand system
> health and their usage.

---

## 1. Public Status Page

### Purpose

Real-time system health visible to ALL consumers. Communicates:

- Is the system up?
- What's degraded?
- When will it be fixed?
- What maintenance is planned?

### Components Monitored

| Component               | What it checks                     | Healthy        | Degraded               | Down             |
| ----------------------- | ---------------------------------- | -------------- | ---------------------- | ---------------- |
| **REST API**            | HTTP 200 on /health/live           | <50ms p99      | <500ms p99             | Timeout/5xx      |
| **MCP Server**          | stdio/HTTP handshake               | Responding     | Slow (>1s)             | Not responding   |
| **PostgreSQL**          | SELECT 1 on primary                | <10ms          | <100ms                 | Unreachable      |
| **Redis**               | PING on master                     | <5ms           | <50ms                  | Unreachable      |
| **Embedding Providers** | Health endpoint per provider       | <200ms         | <2s                    | Timeout          |
| **Recall Pipeline**     | Synthetic recall query             | <200ms p99     | <500ms p99             | Failures >1%     |
| **Session Service**     | Redis + collapse pipeline          | Functional     | Degraded (no collapse) | Offline          |
| **Federation**          | Peer health per connected instance | All synced     | Lag >5min              | Peer unreachable |
| **Hot Tier**            | Redis sorted set + hit rate        | Hit rate >50%  | Hit rate <30%          | Redis down       |
| **Webhooks**            | Delivery success rate              | >99% delivered | >95% delivered         | <95% delivered   |

### Status Levels

```
OPERATIONAL  → All components healthy. No action needed.
DEGRADED     → One or more components degraded. System functional with reduced performance.
PARTIAL      → Major component down. Some features unavailable.
MAJOR        → Core functionality impaired. Immediate action in progress.
MAINTENANCE  → Planned downtime. Announced in advance.
```

### Incident Timeline

```typescript
interface Incident {
  id: string;
  title: string; // "Elevated recall latency"
  status: "investigating" | "identified" | "monitoring" | "resolved";
  severity: "minor" | "major" | "critical";
  components: string[]; // ["REST API", "Recall Pipeline"]

  updates: Array<{
    timestamp: string; // ISO 8601
    status: string; // Status at this update
    message: string; // "Root cause identified: PG replica lag"
  }>;

  startedAt: string;
  resolvedAt?: string;
  duration?: number; // minutes
}
```

### Uptime Display

- Per-component uptime: 30-day, 90-day, 365-day
- Historical calendar (green/yellow/red per day)
- SLA compliance indicator (target: 99.9%)
- Error budget remaining (% of monthly budget consumed)

### Subscription Options

| Method   | Use Case                                       |
| -------- | ---------------------------------------------- |
| Email    | Workspace admins get incident notifications    |
| Webhook  | Integrate with Slack/PagerDuty/custom          |
| RSS/Atom | Feed reader, automation                        |
| API      | `GET /status/current`, `GET /status/incidents` |

### Maintenance Announcements

```typescript
interface MaintenanceWindow {
  id: string;
  title: string; // "Database migration — v3.2 schema update"
  description: string; // What's happening and why
  scheduledStart: string; // ISO 8601
  scheduledEnd: string;
  affectedComponents: string[];
  expectedImpact: "none" | "brief_interruption" | "degraded" | "offline";

  // Notifications sent:
  // - 7 days before (email + webhook)
  // - 24 hours before (email + webhook)
  // - Start (email + webhook + status page update)
  // - End (email + webhook + status page resolved)
}
```

### Implementation Options

| Option                           | Pros                          | Cons                 | Cost      |
| -------------------------------- | ----------------------------- | -------------------- | --------- |
| **Self-hosted (Upptime/Cachet)** | Full control, git-based, free | Maintenance overhead | $0        |
| **Hosted (Instatus/Statuspage)** | Zero maintenance, polished UI | Dependency, cost     | $20-80/mo |
| **Custom (part of Studio)**      | Perfect integration, branded  | Dev effort           | Dev time  |

**Recommendation**: Self-hosted (Upptime) for open-source. Custom integration in Studio for cloud/SaaS mode. Both options available via feature flag.

### API Endpoints

> **v1.0 note:** The `/status/*` router is a post-1.0 milestone. Use your external status page provider (Upptime, Instatus, etc.) or the Prometheus `/metrics` endpoint for availability data. The route design above is the intended v2.0 API surface.

The v1.0 server exposes `/healthz` (liveness probe) and `/health` (full dependency check including PG + Redis + embeddings) as the operational health interface. No `/v1` path prefix on the wire — see `docs/architecture/API.md`'s top-of-file note.

---

## 2. Consumer Metrics Dashboard

### Purpose

Per-workspace usage visibility. Consumers see THEIR metrics — not the system's internals. Answers:

- How much am I using?
- Am I getting value? (ROI)
- Am I approaching my limits?
- What's the quality of my memory?

### Metric Categories

#### 2.1 Usage Metrics (Billing-Relevant)

| Metric             | Description                                      | Visualization              |
| ------------------ | ------------------------------------------------ | -------------------------- |
| Recalls / day      | Total recall API calls                           | Line chart (7d, 30d)       |
| Writes / day       | Facts + decisions + strategies created           | Line chart                 |
| Sessions collapsed | Sessions that produced knowledge                 | Counter + trend            |
| Active facts       | Currently valid facts in workspace               | Gauge                      |
| Storage used       | Total PG storage (facts + embeddings + metadata) | Gauge + percentage of plan |
| Agents active      | Unique agent IDs this period                     | Counter                    |
| API calls total    | All endpoint calls combined                      | Line chart                 |

#### 2.2 Quality Metrics (Value Demonstration)

| Metric                    | Description                                   | Visualization                   |
| ------------------------- | --------------------------------------------- | ------------------------------- |
| Recall hit rate           | % of recalls that returned ≥1 relevant result | Percentage gauge                |
| Hot tier hit rate         | % of recalls served from cache (<5ms)         | Percentage gauge                |
| Average recall latency    | p50, p95, p99 for this workspace              | Histogram                       |
| Memory worth distribution | How many facts at each worth level            | Bar chart (0-0.2, 0.2-0.4, ...) |
| Embedding coverage        | % of facts with valid embeddings              | Progress bar                    |
| Knowledge diversity       | Distribution across 10 primitive types        | Pie chart                       |
| Stale facts detected      | Facts invalidated by codebase verification    | Counter                         |
| Consolidation events      | Facts merged (with quality maintained)        | Counter + trend                 |

#### 2.3 Token Economics

What the server measures today (Prometheus, `GET /metrics`):

| Metric                                                  | What it is                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mnemo_llm_tokens_used_total{model,operation}`          | Tokens the LLM and embedding providers reported for each call. Measured.                                                                                                                    |
| `mnemo_llm_cost_usd_total`, `mnemo_llm_daily_spend_usd` | Spend derived from those tokens.                                                                                                                                                            |
| `mnemo_tokens_saved_estimated_total{mechanism}`         | **Estimate, not a measurement.** Only `distillation` emits it (a size estimate of the cached chain on a CoT cache hit). Measured served context per recall: `GET /admin/stats` → `context`. |
| `mnemo_roi_multiplier`                                  | Estimated savings in USD divided by LLM spend. Inherits the estimate above; reads 0 without distillation. No alert is built on it.                                                          |

Token savings are not measured yet: no code compares the context a recall avoided with the context
it sent, and anticipation and consensus emit no savings at all. Feature status: `docs/STATUS.md`.

#### 2.4 Rate Limit Consumption

| Metric              | Description             | Visualization   |
| ------------------- | ----------------------- | --------------- |
| Recall rate         | Current rps vs limit    | Progress bar    |
| Write rate          | Current rps vs limit    | Progress bar    |
| Concurrent sessions | Active vs max allowed   | Progress bar    |
| Export quota        | Used today vs daily max | Progress bar    |
| Approaching limit   | % of any limit consumed | Alert indicator |

#### 2.5 Provider Health (Consumer-Visible)

| Metric             | Description                          | Visualization   |
| ------------------ | ------------------------------------ | --------------- |
| Embedding provider | Status + avg latency                 | Status dot + ms |
| LLM provider       | Status + avg latency                 | Status dot + ms |
| Rerank provider    | Status + avg latency                 | Status dot + ms |
| Mode active        | A (FTS) / B (Vector) / C (Full)      | Badge           |
| Degradation events | Times system fell back to lower mode | Counter (30d)   |

### Dashboard Layout

Design sketch; the figures are placeholders, not output of any running screen.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  MNEMOSYNE — Workspace: {name}                        Period: [7d ▾]    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │ Active Facts │ │ Recall Rate  │ │ LLM spend    │ │  Mode        │  │
│  │    1,247     │ │  94% hit     │ │   $0.14      │ │    C (Full)  │  │
│  │  ▲ +23 today │ │  ▲ +2% week  │ │  7 days      │ │  ● Healthy   │  │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘  │
│                                                                          │
│  ┌─ Usage (7 days) ─────────────┐ ┌─ Worth Distribution ────────────┐  │
│  │  ╭──╮                        │ │                                   │  │
│  │  │  ╰──╮    ╭──╮            │ │  0.8-1.0: ████████████ 34%       │  │
│  │  │     ╰──╮╭╯  ╰──╮        │ │  0.6-0.8: ████████ 28%           │  │
│  │  │        ╰╯       ╰──      │ │  0.4-0.6: █████ 19%              │  │
│  │  Recalls ── Writes           │ │  0.2-0.4: ███ 12%                │  │
│  └──────────────────────────────┘ │  0.0-0.2: █ 7%                   │  │
│                                    └──────────────────────────────────┘  │
│                                                                          │
│  ┌─ Rate Limits ────────────────────────────────────────────────────┐   │
│  │  Recall:  ████████████░░░░░░  587/600 rpm                        │   │
│  │  Write:   ████░░░░░░░░░░░░░░   43/120 rpm                        │   │
│  │  Sessions: ██░░░░░░░░░░░░░░░░  3/10 concurrent                   │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### API Endpoints (Workspace-Scoped)

```yaml
# Consumer metrics (requires memory:read scope) — no /v1 path prefix on the wire
GET /metrics/prometheus                   # Prometheus text (alias GET /metrics); bearer MNEMO_METRICS_TOKEN, 404 in production without one
GET /usage                                # Durable usage counters (recalls, writes, tokens) — WP10
GET /cost                                 # Cost breakdown by operation type — WP10

# Post-1.0 roadmap (not yet implemented):
#   GET /metrics/quality                  # Quality metrics (hit rate, worth, coverage)
#   GET /metrics/tokens                   # Token economics (spend, savings, ROI)
#   GET /metrics/history?period=7d        # Historical data points
#   GET /metrics/export?format=csv        # Export metrics data
```

> **v1.0 note:** The per-workspace quality/ROI sub-endpoints (`/metrics/quality` etc.) are a post-1.0 milestone. The `mnemo_meter_event` table (migration 0070) and `/usage` + `/cost` routes deliver durable billing-relevant counters in v1.0. Full analytics aggregation is v2.0.

### Response Format

> Planned shape for the post-1.0 metrics endpoint; no route returns it today.

```typescript
interface MetricsResponse {
  workspace: string;
  period: { from: string; to: string };

  usage: {
    recalls: { total: number; trend: number }; // trend: % change vs previous period
    writes: { total: number; trend: number };
    sessions: { collapsed: number; active: number };
    facts: { active: number; archived: number; total: number };
    storage: { usedBytes: number; limitBytes: number; percentage: number };
  };

  quality: {
    recallHitRate: number; // 0-1
    hotTierHitRate: number; // 0-1
    avgRecallLatency: { p50: number; p95: number; p99: number }; // ms
    worthDistribution: Record<string, number>; // "0.0-0.2": 42, "0.2-0.4": 87, ...
    embeddingCoverage: number; // 0-1
    knowledgeDiversity: Record<string, number>; // "fact": 890, "strategy": 23, ...
  };

  tokens: {
    spent: { total: number; byOperation: Record<string, number> };
    saved: { total: number; byMechanism: Record<string, number> };
    roi: number; // saved / spent
    netCostPerSession: number; // USD
  };

  limits: {
    recall: { used: number; limit: number; resetAt: string };
    write: { used: number; limit: number; resetAt: string };
    sessions: { active: number; limit: number };
    export: { usedToday: number; dailyLimit: number };
  };

  providers: Array<{
    type: string; // "embedding" | "llm" | "rerank"
    id: string; // "ollama" | "openai" | "voyage"
    status: "healthy" | "degraded" | "down";
    latency: { p50: number; p99: number }; // ms
    lastError?: string;
  }>;
}
```

### Historical Data Points

```typescript
interface MetricsHistoryResponse {
  workspace: string;
  period: { from: string; to: string };
  granularity: "hour" | "day" | "week";

  dataPoints: Array<{
    timestamp: string; // Start of period bucket
    recalls: number;
    writes: number;
    recallHitRate: number;
    tokensSpent: number;
    tokensSaved: number;
    avgLatency: number; // p50 ms
    factsActive: number;
  }>;
}
```

### Implementation

| Deployment Mode | Dashboard Available?                     | How                                       |
| --------------- | ---------------------------------------- | ----------------------------------------- |
| **Personal**    | CLI `mnemo metrics` or TUI health view   | In-process calculation                    |
| **Team**        | REST API (`/metrics`) + optional Studio  | Server-side aggregation                   |
| **Cloud**       | Full dashboard in Studio + API + exports | Pre-computed (Prometheus recording rules) |
| **Embedded**    | Host exposes via its own UI              | Core exposes `getMetrics()` method        |

### Data Retention for Metrics

| Granularity          | Retention | Storage                                         |
| -------------------- | --------- | ----------------------------------------------- |
| Durable meter events | Rolling   | PostgreSQL `mnemo_meter_event` (migration 0070) |
| Usage counters       | Rolling   | PostgreSQL via `GET /usage`                     |
| Cost breakdown       | Rolling   | PostgreSQL via `GET /cost`                      |

> **v1.0 note:** Pre-aggregated hourly/daily/weekly rollup tables (`mnemo_metrics_hourly` etc.) are a post-1.0 milestone. v1.0 delivers durable per-event billing data in `mnemo_meter_event` and exposes it via `/usage` + `/cost`.

### Metrics Storage Schema

```sql
CREATE TABLE mnemo_metrics_hourly (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  UUID NOT NULL,
  hour_start    TIMESTAMPTZ NOT NULL,

  -- Usage
  recalls       INT DEFAULT 0,
  writes        INT DEFAULT 0,
  sessions      INT DEFAULT 0,

  -- Quality
  recall_hits   INT DEFAULT 0,       -- For computing hit rate
  recall_total  INT DEFAULT 0,
  hot_hits      INT DEFAULT 0,
  latency_sum   BIGINT DEFAULT 0,    -- Sum of all recall latencies (ms)
  latency_count INT DEFAULT 0,       -- For computing average

  -- Tokens
  tokens_spent  BIGINT DEFAULT 0,
  tokens_saved  BIGINT DEFAULT 0,

  -- Snapshot
  facts_active  INT DEFAULT 0,       -- Point-in-time count at hour end

  UNIQUE (workspace_id, hour_start)
);

-- Partition by month for retention management
-- BRIN index on hour_start for time-range queries
CREATE INDEX idx_metrics_hourly_time ON mnemo_metrics_hourly
  USING brin (hour_start);

-- RLS: workspace isolation
ALTER TABLE mnemo_metrics_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_metrics_hourly FORCE ROW LEVEL SECURITY;
CREATE POLICY metrics_workspace ON mnemo_metrics_hourly
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
```

### Aggregation Cron

```
mnemo.metrics.aggregate_hourly  — every hour (roll raw counters → hourly row)
mnemo.metrics.aggregate_daily   — daily 00:05 (roll hourly → daily)
mnemo.metrics.aggregate_weekly  — Monday 00:10 (roll daily → weekly)
mnemo.metrics.prune_raw         — hourly (delete Redis counters older than 24h)
mnemo.metrics.prune_hourly      — monthly (delete hourly rows older than 30d)
```

---

## 3. Session Management API

> Status: Implemented as of 2026-06-12

These endpoints are implemented in `@mnemo-ai/server` and are the canonical REST interface for session lifecycle. The routes differ from the legacy `/v1/memory/sessions` paths documented in earlier drafts — the live implementation uses the `/session` prefix, with no `/v1` path prefix on the wire (see `docs/architecture/API.md`'s top-of-file note).

### POST /session/start

Creates a new ephemeral conversation session.

**Request body** (optional):

```json
{
  "agentId": "orchester-v2",
  "label": "Support ticket #4291",
  "metadata": {}
}
```

**Response** (201 Created):

```json
{
  "id": "01j9abc...",
  "agentId": "orchester-v2",
  "status": "active",
  "createdAt": "2026-06-12T14:23:00.000Z"
}
```

### POST /session/:id/turn

Appends a conversation turn to an active session.

**Request body** (required):

```json
{
  "role": "user",
  "content": "What should we prioritize this sprint?",
  "metadata": {}
}
```

**Response**: 204 No Content

**Errors**: 404 if session not found or already collapsed.

### POST /session/:id/collapse

Marks a session as collapsed. Returns 202 Accepted (async — fact extraction is queued).

**Request body** (optional):

```json
{
  "strategy": "auto"
}
```

**Response** (202 Accepted):

```json
{
  "accepted": true,
  "sessionId": "01j9abc..."
}
```

**Implementation note:** As of v2.0.0-alpha.1, `collapse` marks the session status as `collapsed`
and returns 202. The LLM-powered fact extraction pipeline (reading turns → synthesizing facts →
persisting to mnemo_fact) is planned for v3.1.

---

## 4. Package Placement

| Interface              | Package                                         | Deployment                        |
| ---------------------- | ----------------------------------------------- | --------------------------------- |
| Status page (public)   | `apps/status` or `@mnemo-ai/status`             | Standalone (Upptime) or in Studio |
| Metrics API            | `@mnemo-ai/server` (endpoints)                  | Part of main server               |
| Metrics aggregation    | `@mnemo-ai/server` (cron jobs via QueueAdapter) | Same server process               |
| Metrics storage schema | `@mnemo-ai/adapter-postgres` (migrations)       | PG tables                         |
| Metrics dashboard UI   | `@mnemo-ai/studio`                              | Optional web UI                   |
| CLI metrics view       | `mnemo` Go binary                               | `mnemo metrics` command           |
| TUI metrics view       | `mnemo` Go binary                               | TUI health tab                    |
