// Metrics module (TASK-11001, OBSERVABILITY.md §3, AUDIT_REPORT.md OPS-02).
//
// Prometheus-compatible counters and histograms exposed at GET /metrics.
// Label rules:
//   CORRECT: tier/operation/kind labels only
//   WRONG: never use workspace_id as a label — cardinality explosion (OPS-02)
//
// Per-workspace billing data → mnemo_workspace_billing table, not here.
//
// This module is intentionally dependency-free (no prom-client import) so it
// can be imported without installing an extra package. The Prometheus text
// format is trivial to emit manually for the small set of metrics we need.
// If the set grows significantly, swap this for prom-client.

// ─── Types ────────────────────────────────────────────────────────────────────

interface CounterSample {
  labels: Record<string, string>;
  value: number;
}

interface GaugeSample {
  labels: Record<string, string>;
  value: number;
}

interface HistogramSample {
  labels: Record<string, string>;
  buckets: Map<number, number>; // le → count
  count: number;
  sum: number;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

class Counter {
  private samples = new Map<string, CounterSample>();
  constructor(
    readonly name: string,
    readonly help: string
  ) {}

  inc(labels: Record<string, string>, value = 1): void {
    const key = JSON.stringify(labels);
    const existing = this.samples.get(key);
    if (existing) {
      existing.value += value;
    } else {
      this.samples.set(key, { labels, value });
    }
  }

  /** Read the current samples (for in-process SLO gate evaluation). */
  read(): IterableIterator<CounterSample> {
    return this.samples.values();
  }

  toLines(): string[] {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const s of this.samples.values()) {
      lines.push(`${this.name}${formatLabels(s.labels)} ${s.value}`);
    }
    return lines;
  }
}

export class Gauge {
  private samples = new Map<string, GaugeSample>();
  constructor(
    readonly name: string,
    readonly help: string
  ) {}

  set(labels: Record<string, string>, value: number): void {
    const key = JSON.stringify(labels);
    this.samples.set(key, { labels, value });
  }

  /**
   * Forget every series.
   *
   * A gauge rebuilt from a storage snapshot has to drop what the snapshot no
   * longer reports: otherwise a label that stopped occurring — an archive reason
   * nobody hits any more — keeps publishing its last value forever, and an alert
   * on it never clears.
   */
  clear(): void {
    this.samples.clear();
  }

  toLines(): string[] {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const s of this.samples.values()) {
      lines.push(`${this.name}${formatLabels(s.labels)} ${s.value}`);
    }
    return lines;
  }
}

class Histogram {
  private samples = new Map<string, HistogramSample>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[]
  ) {}

  observe(labels: Record<string, string>, value: number): void {
    const key = JSON.stringify(labels);
    let s = this.samples.get(key);
    if (!s) {
      s = { labels, buckets: new Map(), count: 0, sum: 0 };
      for (const le of this.buckets) s.buckets.set(le, 0);
      this.samples.set(key, s);
    }
    for (const le of this.buckets) {
      if (value <= le) s.buckets.set(le, (s.buckets.get(le) ?? 0) + 1);
    }
    s.count++;
    s.sum += value;
  }

  /**
   * Approximate a quantile from the cumulative bucket counts (linear interpolation).
   * Aggregates across all label combinations.
   * Returns null when no observations have been recorded.
   */
  quantile(q: number): number | null {
    // Aggregate buckets across all label-sets
    const agg = new Map<number, number>();
    let total = 0;
    for (const s of this.samples.values()) {
      for (const [le, cnt] of s.buckets) {
        agg.set(le, (agg.get(le) ?? 0) + cnt);
      }
      total += s.count;
    }
    if (total === 0) return null;

    const target = q * total;
    const sorted = [...agg.entries()].sort(([a], [b]) => a - b);
    let prev = 0;
    let prevLe = 0;
    for (const [le, cumulative] of sorted) {
      if (cumulative >= target) {
        // Linear interpolation within bucket [prevLe, le]
        const bucketCount = cumulative - prev;
        if (bucketCount === 0) return prevLe;
        const fraction = (target - prev) / bucketCount;
        return prevLe + fraction * (le - prevLe);
      }
      prev = cumulative;
      prevLe = le;
    }
    // Fell through all finite buckets — value is in the +Inf bucket
    return prevLe;
  }

  toLines(): string[] {
    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.samples.values()) {
      for (const [le, cnt] of s.buckets) {
        lines.push(`${this.name}_bucket${formatLabels({ ...s.labels, le: String(le) })} ${cnt}`);
      }
      lines.push(`${this.name}_bucket${formatLabels({ ...s.labels, le: "+Inf" })} ${s.count}`);
      lines.push(`${this.name}_sum${formatLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${formatLabels(s.labels)} ${s.count}`);
    }
    return lines;
  }
}

function formatLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`
  );
  return parts.length ? `{${parts.join(",")}}` : "";
}

// ─── Metric definitions ───────────────────────────────────────────────────────

const LATENCY_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5];

// §22 SLO histogram buckets — request_duration_seconds tracks the API SLO
// (p99 ≤ 250ms read / ≤ 500ms write). The bucket set must straddle those SLO
// thresholds so the recording rule that derives the burn-rate has the right
// quantile resolution. (The deep re-audit flagged the prior buckets as
// diverging from the spec's SLO targets.)
const SLO_LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];

// Valid tier label values: "hot" | "cold" | "unified" | "miss" — no other values are valid.
export const recallLatency = new Histogram(
  "mnemo_recall_duration_seconds",
  "Latency of memory recall operations",
  LATENCY_BUCKETS
  // labelNames: ['tier', 'kind', 'cache_hit'] — NO workspace_id (OPS-02)
);

// §22 — top-level request duration histogram. Emitted by the request-timing
// middleware for every route. labelNames: ['method', 'route', 'status'].
export const requestDuration = new Histogram(
  "mnemo_request_duration_seconds",
  "End-to-end HTTP request latency (SLO-bucketed)",
  SLO_LATENCY_BUCKETS
);

// Valid tier values for writeLatency: "direct"
export const writeLatency = new Histogram(
  "mnemo_write_duration_seconds",
  "Latency of memory write operations",
  LATENCY_BUCKETS
  // labelNames: ['tier', 'kind']
);

export const collapseLatency = new Histogram(
  "mnemo_collapse_duration_seconds",
  "Latency of session collapse pipeline",
  [0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0]
  // labelNames: ['tier', 'outcome']
);

// Which image this process runs, one series per process (always 1). The canary
// workflow joins on it (`* on(instance) group_left mnemo_build_info{image=...}`)
// to compare the machines on a new image with the rest; no other series carries
// the image, so their cardinality is unchanged.
export const buildInfo = new Gauge("mnemo_build_info", "Image this server process runs (always 1)");
buildInfo.set({ image: process.env.FLY_IMAGE_REF || "unknown" }, 1);

export const requestsTotal = new Counter(
  "mnemo_requests_total",
  "Total HTTP requests processed"
  // labelNames: ['method', 'route', 'status']
);

export const authFailuresTotal = new Counter(
  "mnemo_auth_failures_total",
  "Authentication failures by reason"
  // labelNames: ['adapter', 'reason']
);

export const authScopeNarrowedTotal = new Counter(
  "mnemo_auth_scope_narrowed_total",
  "Requests whose scopes were narrowed by workspace membership role"
  // labelNames: ['role']
);

export const vectorUpsertTotal = new Counter(
  "mnemo_vector_upsert_total",
  "Vector index upsert operations"
  // labelNames: ['tier', 'kind']
);

// B1.3: renamed from mnemo_consolidation_total{outcome} → mnemo_consolidation_decisions_total{decision}
export const consolidationDecisionsTotal = new Counter(
  "mnemo_consolidation_decisions_total",
  "Consolidation decisions by outcome"
  // labelNames: ['decision']  — 'merged', 'skipped', 'failed'
);
/** @deprecated Use consolidationDecisionsTotal. Alias kept so existing callers compile. */
export const consolidationTotal = consolidationDecisionsTotal;

// ─── §22 missing metric families (deep re-audit P1-8) ─────────────────────────
// These families were defined nowhere before; ~29 of ~41 spec metrics emitted
// nowhere. The set below covers the core families the server can actually feed:
// errors, recall-tier hits, sessions, reasoning (CoT), federation, and LLM
// token/cost accounting.

/** Every unhandled/handled error surfaced to the error middleware. */
export const errorsTotal = new Counter(
  "mnemo_errors_total",
  "Total errors by route and error code"
  // labelNames: ['route', 'code', 'status']
);

/** Which recall tier served a request — hot | pointer | cold | unified | miss. */
export const recallTierHits = new Counter(
  "mnemo_recall_tier_hits_total",
  "Recall hits broken down by serving tier"
  // labelNames: ['tier']  — 'hot' | 'pointer' | 'cold' | 'unified' | 'miss'
);

// B1.3: renamed from mnemo_sessions_total{event} → mnemo_sessions_collapsed_total{reason,outcome}
/** Session collapse events (the only lifecycle event the server currently emits for sessions). */
export const sessionsCollapsedTotal = new Counter(
  "mnemo_sessions_collapsed_total",
  "Session collapse events by reason and outcome"
  // labelNames: ['reason', 'outcome']
);
/** @deprecated Use sessionsCollapsedTotal. Alias kept so existing callers compile. */
export const sessionsTotal = sessionsCollapsedTotal;

// B2.1: session-start counter — emitted in POST /session/start handler.
/** Sessions created (started). labelNames: none (instance-wide). */
export const sessionsStartedTotal = new Counter(
  "mnemo_sessions_started_total",
  "Sessions created via POST /session/start"
);

// NOTE (observability sweep): mnemo_sessions_active, mnemo_reasoning_total, and
// mnemo_federation_total were declared here but emitted nowhere. No reachable,
// safe source exists within the server's editable surface:
//   • sessions_active — sessions are Redis/L0-resident; no global active-session
//     count is exposed (StorageAdapter has getSession by id only).
//   • reasoning_total / federation_total — their natural emit sites live in the
//     reasoning route and the federation runtime, which are out of scope for this
//     change. Rather than ship declared-but-dead families, they are removed; add
//     them back at their real emit sites when that work lands.
// (mnemo_sessions_total IS now emitted — see routes/index.ts session collapse.)

// B1.3: renamed from mnemo_llm_tokens_total{provider,model,kind} → mnemo_llm_tokens_used_total{model,operation}
/** LLM tokens consumed (prompt + completion + embedding). */
export const llmTokensUsedTotal = new Counter(
  "mnemo_llm_tokens_used_total",
  "LLM tokens consumed"
  // labelNames: ['model', 'operation']  — operation: 'embed'|'extract'|'collapse'|'procedural'|'reasoning'|'unknown'
);
/** @deprecated Use llmTokensUsedTotal. Alias kept so existing callers compile. */
export const llmTokensTotal = llmTokensUsedTotal;

// B1.3: renamed from mnemo_llm_cost_microdollars_total{provider,model} → mnemo_llm_cost_usd_total{model,operation}
// (also unit change: µ$ → USD)
/** LLM cost in USD (float). labelNames: ['model', 'operation']. */
export const llmCostUsdTotal = new Counter(
  "mnemo_llm_cost_usd_total",
  "LLM cost in USD"
  // labelNames: ['model', 'operation']
);
/** @deprecated Use llmCostUsdTotal. Alias kept so existing callers compile. */
export const llmCostMicrodollarsTotal = llmCostUsdTotal;

/** Completion spend under MNEMO_LLM_DAILY_BUDGET_USD so far today (UTC). No series without the cap. */
export const llmDailySpendUsd = new Gauge(
  "mnemo_llm_daily_spend_usd",
  "USD the server's completion provider spent today (UTC), counted against MNEMO_LLM_DAILY_BUDGET_USD"
);

/**
 * Estimated savings $ / LLM spend $. Refreshed on each Prometheus scrape. The
 * numerator is mnemo_tokens_saved_estimated_total priced at a flat rate, and
 * only distillation feeds that counter: an estimate, not a measured return.
 */
export const roiMultiplier = new Gauge(
  "mnemo_roi_multiplier",
  "Estimate, not a measurement: estimated token savings in $ (mnemo_tokens_saved_estimated_total, fed only by reasoning distillation, priced at a flat rate) divided by LLM spend in $"
);

// F19: refreshed on each hot-tier eviction via CoreDeps.onHotTierEvict (wired in
// index.ts). The value reflects post-trim occupancy as of the last eviction
// event (the cap), NOT a per-scrape live size — the in-process cache size is
// still not exposed on ServerDeps for a scrape-time read. This is a deliberate
// trade-off: eviction-event accuracy beats the previous always-zero gauge.
export const hotTierSize = new Gauge(
  "mnemo_hot_tier_size",
  "Number of entries currently in the hot-tier cache"
  // labelNames: ['workspace_id'] — NOTE: workspace_id OK on gauges (low cardinality vs. labels on high-rate counters)
);

export const circuitBreakerState = new Gauge(
  "mnemo_circuit_breaker_state",
  "Circuit breaker state: 0=closed 1=open 2=half-open"
  // labelNames: ['service']
);

// NOTE (observability sweep): mnemo_active_connections and
// mnemo_embedding_queue_depth were declared but emitted nowhere and have no
// reachable source — there is no HTTP-connection accessor on the Hono server,
// and listStaleEmbeddings is per-table/per-workspace (returns rows, not a global
// count). Removed rather than shipping declared-but-dead families.

// ─── USE gauges: PG pool + Redis (refreshed on each Prometheus scrape) ───────

export const pgPoolConnectionsActive = new Gauge(
  "mnemo_pg_pool_connections_active",
  "Active PG pool connections"
);
export const pgPoolConnectionsIdle = new Gauge(
  "mnemo_pg_pool_connections_idle",
  "Idle PG pool connections"
);
export const pgPoolConnectionsTotal = new Gauge(
  "mnemo_pg_pool_connections_total",
  "Total PG pool connections (max)"
);
export const pgPoolUtilizationRatio = new Gauge(
  "mnemo_pg_pool_utilization_ratio",
  "PG pool utilization (active/total)"
);
export const redisConnectionsActive = new Gauge(
  "mnemo_redis_connections_active",
  "Active Redis connections (1 when connected)"
);
// NOTE (observability sweep): mnemo_redis_memory_used_bytes removed — the
// CacheAdapter port exposes only healthCheck() (HealthStatus = status +
// latencyMs + detail); there is no INFO/used_memory accessor to refresh it from
// on scrape. Re-add alongside a CacheAdapter.info() capability when it exists.

// ─── §22 additional spec metric families ─────────────────────────────────────
// Defined + registered so they appear in /metrics (zero until first emission)
// and emitted at their single call sites below.
export const recallEmpty = new Counter(
  "mnemo_recall_empty_total",
  "Recalls that returned zero results"
);

// B1.1: replaced mnemo_reasoning_tokens_saved_total (no labels) with one
// counter labeled by mechanism. R-19: renamed to ..._estimated_total because
// every increment is an estimate, not a measurement. Only distillation emits
// it today (a size estimate of the cached chain, reasoning.ts); the flat
// composition/hot_tier increments are gone. Measured served context is
// GET /admin/stats → context (APP-015).
/** Estimated LLM tokens saved, labeled by the mechanism that produced the saving. */
export const tokensSavedTotal = new Counter(
  "mnemo_tokens_saved_estimated_total",
  "Estimated LLM tokens saved by mechanism (distillation|composition|hot_tier|anticipation); flat per-event estimates, not measured"
  // labelNames: ['mechanism']
);
/** @deprecated Use tokensSavedTotal. Alias kept for backwards compat. */
export const reasoningTokensSaved = {
  /** @deprecated emit via tokensSavedTotal.inc({ mechanism: "distillation" }, n) */
  inc: (_labels: Record<string, string>, value = 1): void => {
    tokensSavedTotal.inc({ mechanism: "distillation" }, value);
  },
};

// B1.2: reasoning-worth histogram — observe candidate.worth / hit.worth at cache-hit paths.
const WORTH_BUCKETS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
/** Worth score of reasoning chains that were served as cache hits. */
export const reasoningWorthHistogram = new Histogram(
  "mnemo_reasoning_worth_histogram",
  "Worth score distribution of reasoning chains served as cache hits",
  WORTH_BUCKETS
);

// B1 (CoT resolve latency): latency of the resolve handler split by path taken.
/** Latency of CoT reasoning resolve by path (topic_key|vector). Buckets in seconds. */
export const reasoningResolveLatency = new Histogram(
  "mnemo_reasoning_resolve_latency_seconds",
  "Latency of CoT reasoning resolve by path (topic_key|vector)",
  [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5]
);

// NOTE: mnemo_queue_shed_total lives in metrics/backpressure.ts (queueShedTotal),
// which is the wired emitter — do not redeclare it here (duplicate Prometheus name).
export const federationConflicts = new Counter(
  "mnemo_federation_conflicts_total",
  "Federation conflicts surfaced during sync apply"
);
// NOTE: redis_*/pg_query_duration ARE adapter-layer families — they are declared
// and emitted inside @mnemo-ai/adapter-postgres and @mnemo-ai/adapter-redis and
// composed into GET /metrics via renderAdapterMetrics()/renderRedisMetrics()
// (see routes/metrics.ts). hot_tier_evictions (Counter, below) + hot_tier_size
// (Gauge, above) are now LIVE via the CoreDeps.onHotTierEvict hook wired in
// index.ts (F19) — no longer dead declarations.

// ─── §3.4 domain counters — reasoning / composition / federation / queue ──────

export const reasoningResolve = new Counter(
  "mnemo_reasoning_resolve_total",
  "CoT cache resolve decisions by result (cache_hit|execute)"
  // labelNames: ['result']
);

export const recallCompositionInferences = new Counter(
  "mnemo_recall_composition_inferences_total",
  "Inferences produced by the composition engine on recall"
);

export const federationSyncDuration = new Histogram(
  "mnemo_federation_sync_duration_seconds",
  "Duration of federation pull-sync operations",
  [0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30]
  // labelNames: ['peer']
);

export const federationLag = new Gauge(
  "mnemo_federation_lag_seconds",
  "Lag between now and the last successful federation sync per peer"
  // labelNames: ['peer']
);

export const queueCompleted = new Counter(
  "mnemo_queue_completed_total",
  "Jobs completed successfully by job type"
  // labelNames: ['job_key']
);

export const queueFailed = new Counter(
  "mnemo_queue_failed_total",
  "Jobs that failed by job type"
  // labelNames: ['job_key']
);

// ─── §3.5 snapshot + event-driven counters ────────────────────────────────────

export const factsTotal = new Gauge(
  "mnemo_facts_total",
  "Total facts in storage by type and status"
  // labelNames: ['type', 'status']
);

export const worthDistribution = new Gauge(
  "mnemo_worth_distribution",
  "Distribution of fact worth scores across 5 buckets"
  // labelNames: ['bucket']  — '0.0-0.2','0.2-0.4','0.4-0.6','0.6-0.8','0.8-1.0'
);

export const sessionsActiveTotal = new Gauge(
  "mnemo_sessions_active_total",
  "Number of active sessions"
);

export const sessionTurnsHistogram = new Histogram(
  "mnemo_session_turns_histogram",
  "Distribution of turns-per-session at collapse time",
  [1, 2, 5, 10, 20, 50, 100, 200]
);

export const tasksTotal = new Gauge(
  "mnemo_tasks_total",
  "Total tasks by status"
  // labelNames: ['status']
);

export const tasksStaleTotal = new Gauge(
  "mnemo_tasks_stale_total",
  "Number of stale tasks (pending/blocked past deadline or stale threshold)"
);

export const hotTierEvictions = new Counter(
  "mnemo_hot_tier_evictions_total",
  "Hot-tier entries evicted to enforce size cap"
);

// P59 (docs/archive/openspec/p59-query-cache-l3-fix, design.md §4): the L3 query-result
// cache and the sibling embedding LRU cache both swallow port failures with
// no observability. This counter is the live path — wired via
// CoreDeps.onCacheError in packages/server/src/index.ts, next to
// onHotTierEvict.
export const cacheErrorsTotal = new Counter(
  "mnemo_cache_errors_total",
  "Cache port failures by cache and operation"
  // labelNames: ['cache', 'op'] — cache: 'l3_query'|'embedding_lru'|'hot_tier', op: 'lookup'|'insert'|'get'|'put'
);

// p60-corecall-stdp-convergence PR2 (design.md D3): measures what Option 1's
// single-writer convergence gives up — facts beyond CO_RECALL_TOP_K that
// never get co-recall STDP applied. Wired via CoreDeps.onCoRecallTail in
// packages/server/src/index.ts, next to onHotTierEvict/onCacheError. This is
// the input to the deferred Option 3 cap-raise decision (see
// docs/archive/BACKLOG.md P60 for the read-later rule).
export const coRecallEventsTotal = new Counter(
  "mnemo_co_recall_events_total",
  "Cold-recall events that reached the co-recall pair loop (>=2 candidate facts)"
);

export const coRecallEventsOverCapTotal = new Counter(
  "mnemo_co_recall_events_over_cap_total",
  "Co-recall events where candidateFacts exceeded CO_RECALL_TOP_K"
);

export const coRecallPairsProcessedTotal = new Counter(
  "mnemo_co_recall_pairs_processed_total",
  "Fact pairs that received co-recall STDP (denominator for the tail-loss ratio)"
);

export const coRecallPairsSkippedTotal = new Counter(
  "mnemo_co_recall_pairs_skipped_total",
  "Fact pairs present in the candidate set but never processed because of the CO_RECALL_TOP_K cap — the tail-loss number Option 1 gives up"
);

export const taskDelegationTotal = new Counter(
  "mnemo_task_delegation_total",
  "Task delegation events by from/to agent"
  // labelNames: ['from_agent', 'to_agent']
);

// ─── L0 Working Memory metrics ────────────────────────────────────────────────
// OPS-02: no workspace_id label (cardinality guard)

/** Count of WorkingMemory operations by backend and result. */
export const workingMemoryOpsTotal = new Counter(
  "mnemo_working_memory_ops_total",
  "Count of L0 working memory operations"
  // labelNames: ['backend', 'op', 'result'] — backend: redis|fallback, op: get|set|bloom|ratelimit, result: hit|miss|ok|error
);

/** Approximate in-process fallback size in bytes. */
export const workingMemoryFallbackBytes = new Gauge(
  "mnemo_working_memory_fallback_bytes",
  "Approximate bytes used by the in-process WorkingMemory fallback map"
);

/** Count of forced evictions from the in-process fallback (capacity-driven). */
export const workingMemoryFallbackEvictionsTotal = new Counter(
  "mnemo_working_memory_fallback_evictions_total",
  "Count of capacity-driven evictions from the in-process WorkingMemory fallback"
);

/** Count of Redis fallback activations (Redis threw, fell through to in-process). */
export const workingMemoryRedisFallbackTotal = new Counter(
  "mnemo_working_memory_redis_fallback_total",
  "Count of times WorkingMemory fell back to in-process map due to Redis error"
  // labelNames: ['op'] — op: get|set|bloom|ratelimit
);

// ─── Convenience helpers ──────────────────────────────────────────────────────

/**
 * Observe a latency duration (in seconds) from a start time in milliseconds.
 * Usage:
 *   const t = Date.now()
 *   await doWork()
 *   observeDuration(recallLatency, { tier: 'team', kind: 'fact', cache_hit: 'false' }, t)
 */
export function observeDuration(
  histogram: Histogram,
  labels: Record<string, string>,
  startMs: number
): void {
  histogram.observe(labels, (Date.now() - startMs) / 1000);
}

// ─── LLM token/cost emission (OBSERVABILITY.md §3, AUDIT OPS-02) ──────────────

/** Discriminates which side of an LLM call the tokens came from. */
export type LlmTokenKind = "prompt" | "completion" | "embedding";

/** Bounded vocabulary of operation labels for LLM metrics. */
export type LlmOperation =
  "embed" | "extract" | "collapse" | "procedural" | "reasoning" | "unknown";

/**
 * Bound the `model` label cardinality. We only ever emit model/operation —
 * never raw text — but a misconfigured or vendor-renamed model could still
 * inject an unbounded set of distinct model strings. When the cost is unknown
 * (the provider's static pricing table had no entry), we collapse the model
 * label to "unknown" so the gap is *visible* in Grafana rather than silently
 * mislabelled, and we emit zero cost rather than fabricating a rate.
 */
const UNKNOWN_MODEL_LABEL = "unknown";

/** Bounded set of LLM operation labels. Anything outside this list maps to "unknown". */
const VALID_OPERATIONS = new Set<string>([
  "embed",
  "extract",
  "collapse",
  "procedural",
  "reasoning",
]);

/**
 * Emit `mnemo_llm_tokens_used_total{model,operation}` and
 * `mnemo_llm_cost_usd_total{model,operation}` for one LLM call.
 *
 * (B1.3) Renames: mnemo_llm_tokens_total → mnemo_llm_tokens_used_total,
 *   mnemo_llm_cost_microdollars_total → mnemo_llm_cost_usd_total (unit µ$ → USD).
 *
 * Cost = the vendor-derived `costUSD` (already computed from the per-model rate
 * table in @mnemo-ai/llm-providers). When `costUSD` is undefined the model is
 * not in the pricing table: we label the model "unknown" and emit zero cost
 * (no fabricated basis — see AUDIT note).
 *
 * Server-side only (hexagonal: core never imports metrics). Fire-and-forget;
 * callers must not let metric emission throw on the request path.
 *
 * @param tokens    vendor-reported token count for this call/side (>= 0)
 * @param costUSD   vendor-estimated USD cost, or undefined when the model is unpriced
 * @param operation bounded operation label (embed|extract|collapse|procedural|reasoning); defaults to "unknown"
 */
export function recordLlmUsage(args: {
  provider: string;
  model: string;
  kind: LlmTokenKind;
  tokens: number;
  costUSD?: number;
  operation?: string;
}): void {
  const priced = args.costUSD !== undefined;
  // Keep the model label bounded + the unpriced case explicit.
  const model = priced ? args.model : UNKNOWN_MODEL_LABEL;
  const operation: string = VALID_OPERATIONS.has(args.operation ?? "")
    ? (args.operation as string)
    : "unknown";

  if (Number.isFinite(args.tokens) && args.tokens > 0) {
    llmTokensUsedTotal.inc({ model, operation }, args.tokens);
  }

  // Emit USD cost directly (no conversion to microdollars — B1.3 unit change).
  const costUsd = priced ? (args.costUSD as number) : 0;
  if (costUsd > 0) {
    llmCostUsdTotal.inc({ model, operation }, costUsd);
  }
}

// ─── Text exposition ──────────────────────────────────────────────────────────

const ALL_METRICS: Array<Counter | Histogram | Gauge> = [
  buildInfo,
  recallLatency,
  requestDuration,
  writeLatency,
  collapseLatency,
  requestsTotal,
  authFailuresTotal,
  authScopeNarrowedTotal,
  vectorUpsertTotal,
  // B1.3 renamed: consolidationDecisionsTotal (was consolidationTotal)
  consolidationDecisionsTotal,
  errorsTotal,
  recallTierHits,
  // B1.3 renamed: sessionsCollapsedTotal (was sessionsTotal)
  sessionsCollapsedTotal,
  // B2.1: session-start counter
  sessionsStartedTotal,
  // B1.3 renamed: llmTokensUsedTotal (was llmTokensTotal)
  llmTokensUsedTotal,
  // B1.3 renamed: llmCostUsdTotal (was llmCostMicrodollarsTotal)
  llmCostUsdTotal,
  llmDailySpendUsd,
  // A4: ROI multiplier gauge (token-savings $ / LLM spend $)
  roiMultiplier,
  hotTierSize,
  circuitBreakerState,
  pgPoolConnectionsActive,
  pgPoolConnectionsIdle,
  pgPoolConnectionsTotal,
  pgPoolUtilizationRatio,
  redisConnectionsActive,
  recallEmpty,
  // B1.1: tokensSavedTotal{mechanism} (replaced reasoningTokensSaved)
  tokensSavedTotal,
  // B1.2: reasoningWorthHistogram
  reasoningWorthHistogram,
  // B1: reasoningResolveLatency histogram (topic_key|vector)
  reasoningResolveLatency,
  federationConflicts,
  reasoningResolve,
  recallCompositionInferences,
  federationSyncDuration,
  federationLag,
  queueCompleted,
  queueFailed,
  factsTotal,
  worthDistribution,
  sessionsActiveTotal,
  sessionTurnsHistogram,
  tasksTotal,
  tasksStaleTotal,
  hotTierEvictions,
  cacheErrorsTotal,
  coRecallEventsTotal,
  coRecallEventsOverCapTotal,
  coRecallPairsProcessedTotal,
  coRecallPairsSkippedTotal,
  taskDelegationTotal,
  workingMemoryOpsTotal,
  workingMemoryFallbackBytes,
  workingMemoryFallbackEvictionsTotal,
  workingMemoryRedisFallbackTotal,
];

// ─── §22 Service Level Objectives ─────────────────────────────────────────────
/**
 * MnemoSLOs — the canonical service-level objective table. Alerting rules and
 * the error-budget burn calculation derive from these targets. Kept here (next
 * to the metric families they reference) so they can never drift from the
 * metric names that feed them.
 *
 * `objective` is the target success ratio over `windowDays`; `latencyP99Seconds`
 * is the latency SLO for the relevant histogram. A `null` latency means the SLO
 * is availability-only.
 */
export interface MnemoSLO {
  /** Human-readable SLO id, e.g. "recall-latency". */
  name: string;
  /** Which metric family this SLO is computed from. */
  metric: string;
  /** Target success ratio in [0,1], e.g. 0.999. */
  objective: number;
  /** Rolling evaluation window in days. */
  windowDays: number;
  /** p99 latency target in seconds, or null for availability-only SLOs. */
  latencyP99Seconds: number | null;
}

export const MnemoSLOs: readonly MnemoSLO[] = [
  // Recall is the hot read path — p99 ≤ 250ms, 99.9% availability over 30d.
  {
    name: "recall-latency",
    metric: "mnemo_recall_duration_seconds",
    objective: 0.999,
    windowDays: 30,
    latencyP99Seconds: 0.25,
  },
  // Writes carry the surprise gate + outbox — p99 ≤ 500ms.
  {
    name: "write-latency",
    metric: "mnemo_write_duration_seconds",
    objective: 0.999,
    windowDays: 30,
    latencyP99Seconds: 0.5,
  },
  // Overall request availability (non-5xx ratio).
  {
    name: "request-availability",
    metric: "mnemo_requests_total",
    objective: 0.999,
    windowDays: 30,
    latencyP99Seconds: null,
  },
  // Overall request latency SLO (the SLO-bucketed histogram).
  {
    name: "request-latency",
    metric: "mnemo_request_duration_seconds",
    objective: 0.99,
    windowDays: 30,
    latencyP99Seconds: 0.5,
  },
] as const;

/**
 * Render all metrics in Prometheus text format (exposition format v0.0.4).
 * Mount at GET /metrics. Only expose to internal/admin networks — this is not
 * a public API endpoint and MUST be behind IP allowlisting or network policy.
 */
export function renderMetrics(): string {
  return ALL_METRICS.flatMap((m) => m.toLines()).join("\n") + "\n";
}
