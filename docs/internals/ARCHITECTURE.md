# Mnemosyne — Package Architecture (Hexagonal, Everything Replaceable)

> **Note:** This is the hexagonal design rationale. For the authoritative, current package list see [`docs/INDEX.md`](../INDEX.md) and [`docs/architecture/ARCHITECTURE.md`](../architecture/ARCHITECTURE.md). Mnemosyne ships **18 packages** today.

> Every dependency is behind an interface. Every feature is flaggable.
> Every cross-cutting concern is its own library. Nothing is coupled.
> If it can be swapped tomorrow without touching business logic, the
> architecture is correct.

---

## Core Principle: Ports & Adapters (Hexagonal)

```
                    ┌─────────────────────────────────────┐
                    │         @mnemo-ai/core              │
                    │                                      │
                    │  Pure business logic.                │
                    │  ZERO infrastructure imports.        │
                    │  Defines PORTS (interfaces).         │
                    │  Knows nothing about:               │
                    │    - Which DB (PG, SQLite, Mongo)    │
                    │    - Which cache (Redis, Memcached)  │
                    │    - Which vector DB (pgvector, QD)  │
                    │    - Which logger (pino, winston)    │
                    │    - Which queue (pg-boss, BullMQ)   │
                    │    - Which telemetry (OTel, DD)      │
                    │                                      │
                    │  Receives ADAPTERS via injection.    │
                    └───────────────────┬─────────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                          │
              ▼                         ▼                          ▼
    ┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
    │  ADAPTERS        │     │  CROSS-CUTTING    │     │  TRANSPORTS       │
    │  (replaceable)   │     │  (libraries)      │     │  (consumers)      │
    │                  │     │                    │     │                    │
    │  adapter-postgres│     │  Logger iface      │     │  server (Hono)    │
    │  adapter-redis   │     │  Telemetry iface   │     │  mcp              │
    │  adapter-vector  │     │  ConfigProvider    │     │  cli (TS/Node)    │
    │  adapter-llm     │     │  (all interfaces   │     │  sdk-go           │
    │  llm-providers   │     │  in @mnemo-ai/    │     │  sdk-python       │
    │  (7 providers)   │     │  types; impls in   │     │                    │
    │                  │     │  packages/server/  │     │                    │
    │                  │     │  src/telemetry/)   │     │                    │
    └─────────────────┘     └──────────────────┘     └──────────────────┘
```

---

## Package Topology (New)

### Tier 1: Interfaces & Pure Logic (zero deps)

| Package           | Purpose                                                                                                                                                               | External Deps          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `@mnemo-ai/types` | All TypeScript interfaces, types, enums, constants — **including** `Logger`, `Telemetry`, `ConfigProvider`, and all error types via `observability.ts` and `ports.ts` | **NONE**               |
| `@mnemo-ai/core`  | Business logic (recall orchestration, consolidation, worth, graph traversal)                                                                                          | `@mnemo-ai/types` only |

> **Note:** There are no separate `@mnemo-ai/errors`, `@mnemo-ai/logger`, `@mnemo-ai/telemetry`, or `@mnemo-ai/config` packages. These are **interfaces defined in `@mnemo-ai/types`** (`src/ports/observability.ts`). Concrete implementations (pino logger, OTel telemetry, `HttpError`) live in `packages/server/src/errors.ts` and `packages/server/src/telemetry/`. The `ConfigProvider` interface is in `@mnemo-ai/types`; env/yaml wiring is in `packages/server/src/boot.ts`.

### Tier 2: Cross-Cutting Implementations (in `packages/server/src/`)

| Concern                | Interface (in `@mnemo-ai/types`) | Shipped Implementation | Location                         |
| ---------------------- | -------------------------------- | ---------------------- | -------------------------------- |
| Structured logging     | `Logger`                         | pino wrapper           | `packages/server/src/telemetry/` |
| Spans, metrics, traces | `Telemetry`                      | OpenTelemetry SDK      | `packages/server/src/telemetry/` |
| Config + feature flags | `ConfigProvider`                 | env + yaml             | `packages/server/src/boot.ts`    |
| Errors                 | `MnemoError` / error codes       | `HttpError` class      | `packages/server/src/errors.ts`  |

### Tier 3: Infrastructure Adapters (each one replaceable)

| Package                      | Port (interface)                             | Default Impl                                               | Alternatives             |
| ---------------------------- | -------------------------------------------- | ---------------------------------------------------------- | ------------------------ |
| `@mnemo-ai/adapter-postgres` | `StorageAdapter`                             | Drizzle + postgres.js                                      | —                        |
| `@mnemo-ai/adapter-redis`    | `CacheAdapter`                               | ioredis                                                    | Valkey, DragonflyDB      |
| `@mnemo-ai/adapter-vector`   | `VectorAdapter`                              | pgvector SQL                                               | Qdrant, Pinecone, Milvus |
| `@mnemo-ai/adapter-llm`      | `LLMAdapter`                                 | bridges `@mnemo-ai/llm-providers` (7 providers)            | —                        |
| `@mnemo-ai/llm-providers`    | `EmbedAdapter` / `LLMAdapter` provider impls | OpenAI, Anthropic, Ollama, Voyage, Cohere, Gemini, Mistral | per-provider swap        |

### Tier 4: Transport / Consumers (compose everything)

| Package                | What it does                                                                 | Consumes                       |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------ |
| `@mnemo-ai/server`     | HTTP API (Hono)                                                              | core + any adapters configured |
| `@mnemo-ai/mcp`        | MCP server                                                                   | core + config                  |
| `@mnemo-ai/cli`        | `mnemo` CLI (TypeScript/Node, thin HTTP client, 13 commands + built-in help) | server REST API                |
| `@mnemo-ai/client-ts`  | SDK for TypeScript consumers                                                 | types only (HTTP calls)        |
| `@mnemo-ai/sdk-go`     | Go SDK                                                                       | server REST API                |
| `@mnemo-ai/sdk-python` | Python SDK                                                                   | server REST API                |

### Tier 5: Optional Enhancements

| Package                   | What it does                                                 | When needed                        |
| ------------------------- | ------------------------------------------------------------ | ---------------------------------- |
| `@mnemo-ai/consolidation` | Memory consolidation scheduler (UCE, worth decay)            | Background maintenance             |
| `@mnemo-ai/cup`           | Client update protocol (keyset pagination, incremental sync) | High-frequency SDK clients         |
| `@mnemo-ai/federation`    | Cross-instance sync                                          | Multi-region / multi-org           |
| `@mnemo-ai/plugins`       | Plugin loader + lifecycle                                    | Extensibility                      |
| `@mnemo-ai/mock-server`   | In-process test server (InMemoryStorageAdapter)              | Integration tests without Postgres |

---

## Interface Contracts (Ports)

### StorageAdapter (the most critical interface)

```typescript
// @mnemo-ai/types/src/ports.ts — StorageAdapter section

interface StorageAdapter {
  // ── Session ─────────────────────────────────────────────────────────────
  createSession(data: CreateSessionInput): Promise<MnemoSession>;
  appendTurn(sessionId: string, turn: SessionTurn): Promise<void>;
  closeSession(id: string, workspaceId: string): Promise<void>;
  getSession(id: string, workspaceId: string): Promise<MnemoSession | null>;

  // ── Facts ────────────────────────────────────────────────────────────────
  createFact(data: CreateFactInput): Promise<MnemoFact>;
  getFact(id: string, workspaceId: string): Promise<MnemoFact | null>;
  updateFact(id: string, data: Partial<UpdateFactInput>): Promise<MnemoFact>;
  archiveFact(id: string, workspaceId: string): Promise<void>;
  queryFacts(filter: FactFilter): Promise<PaginatedResult<MnemoFact>>;

  // ── Decisions ────────────────────────────────────────────────────────────
  createDecision(data: CreateDecisionInput): Promise<MnemoDecision>;
  getDecision(id: string, workspaceId: string): Promise<MnemoDecision | null>;
  updateDecision(id: string, data: Partial<UpdateDecisionInput>): Promise<MnemoDecision>;
  archiveDecision(id: string, workspaceId: string): Promise<void>;
  queryDecisions(filter: DecisionFilter): Promise<PaginatedResult<MnemoDecision>>;

  // ── Episodes ─────────────────────────────────────────────────────────────
  createEpisode(data: CreateEpisodeInput): Promise<MnemoEpisode>;
  getEpisode(id: string, workspaceId: string): Promise<MnemoEpisode | null>;
  updateEpisode(id: string, data: Partial<UpdateEpisodeInput>): Promise<MnemoEpisode>;
  archiveEpisode(id: string, workspaceId: string): Promise<void>;
  queryEpisodes(filter: EpisodeFilter): Promise<PaginatedResult<MnemoEpisode>>;

  // ── Entities ─────────────────────────────────────────────────────────────
  createEntity(data: CreateEntityInput): Promise<MnemoEntity>;
  getEntity(id: string, workspaceId: string): Promise<MnemoEntity | null>;
  updateEntity(id: string, data: Partial<UpdateEntityInput>): Promise<MnemoEntity>;
  archiveEntity(id: string, workspaceId: string): Promise<void>;
  queryEntities(filter: EntityFilter): Promise<PaginatedResult<MnemoEntity>>;

  // ── Strategies ───────────────────────────────────────────────────────────
  createStrategy(data: CreateStrategyInput): Promise<MnemoStrategy>;
  getStrategy(id: string, workspaceId: string): Promise<MnemoStrategy | null>;
  updateStrategy(id: string, data: Partial<UpdateStrategyInput>): Promise<MnemoStrategy>;
  archiveStrategy(id: string, workspaceId: string): Promise<void>;
  queryStrategies(filter: StrategyFilter): Promise<PaginatedResult<MnemoStrategy>>;

  // ── Workflows ────────────────────────────────────────────────────────────
  createWorkflow(data: CreateWorkflowInput): Promise<MnemoWorkflow>;
  getWorkflow(id: string, workspaceId: string): Promise<MnemoWorkflow | null>;
  updateWorkflow(id: string, data: Partial<UpdateWorkflowInput>): Promise<MnemoWorkflow>;
  archiveWorkflow(id: string, workspaceId: string): Promise<void>;
  queryWorkflows(filter: WorkflowFilter): Promise<PaginatedResult<MnemoWorkflow>>;

  // ── Skills ───────────────────────────────────────────────────────────────
  createSkill(data: CreateSkillInput): Promise<MnemoSkill>;
  getSkill(id: string, workspaceId: string): Promise<MnemoSkill | null>;
  updateSkill(id: string, data: Partial<UpdateSkillInput>): Promise<MnemoSkill>;
  archiveSkill(id: string, workspaceId: string): Promise<void>;
  querySkills(filter: SkillFilter): Promise<PaginatedResult<MnemoSkill>>;

  // ── Tasks ────────────────────────────────────────────────────────────────
  createTask(data: CreateTaskInput): Promise<MnemoTask>;
  getTask(id: string, workspaceId: string): Promise<MnemoTask | null>;
  updateTask(id: string, data: Partial<UpdateTaskInput>): Promise<MnemoTask>;
  archiveTask(id: string, workspaceId: string): Promise<void>;
  queryTasks(filter: TaskFilter): Promise<PaginatedResult<MnemoTask>>;

  // ── Events ───────────────────────────────────────────────────────────────
  createEvent(data: CreateEventInput): Promise<MnemoEvent>;
  getEvent(id: string, workspaceId: string): Promise<MnemoEvent | null>;
  archiveEvent(id: string, workspaceId: string): Promise<void>;
  queryEvents(filter: EventFilter): Promise<PaginatedResult<MnemoEvent>>;

  // ── Reasoning ────────────────────────────────────────────────────────────
  createReasoning(data: CreateReasoningInput): Promise<MnemoReasoning>;
  getReasoning(id: string, workspaceId: string): Promise<MnemoReasoning | null>;
  updateReasoning(id: string, data: Partial<UpdateReasoningInput>): Promise<MnemoReasoning>;
  archiveReasoning(id: string, workspaceId: string): Promise<void>;
  queryReasoning(filter: ReasoningFilter): Promise<PaginatedResult<MnemoReasoning>>;

  // ── Relations ────────────────────────────────────────────────────────────
  createRelation(data: CreateRelationInput): Promise<MnemoRelation>;
  getRelations(filter: RelationFilter): Promise<MnemoRelation[]>;
  updateRelationStrength(id: string, delta: number): Promise<void>;
  deleteRelation(id: string, workspaceId: string): Promise<void>;

  // ── Worth governance ─────────────────────────────────────────────────────
  updateWorth(id: string, primitiveType: PrimitiveKind, delta: WorthDelta): Promise<void>;
  recordRecall(log: RecallLogEntry): Promise<void>;

  // ── Audit ────────────────────────────────────────────────────────────────
  appendAuditEntry(entry: AuditLogEntry): Promise<void>;

  // ── Outbox (transactional) ───────────────────────────────────────────────
  appendOutbox(entry: OutboxEntry): Promise<void>;
  claimOutbox(limit: number): Promise<OutboxEntry[]>;
  markOutboxProcessed(ids: string[]): Promise<void>;
  markOutboxFailed(id: string, error: string): Promise<void>;

  // ── Health ───────────────────────────────────────────────────────────────
  healthCheck(): Promise<{ status: "ok" | "degraded" | "down"; latencyMs: number }>;
}

interface StorageCapabilities {
  vectorSearch: boolean; // false for SQLite without extensions
  ftsSearch: boolean; // true for both PG (tsvector) and SQLite (FTS5)
  bitemporal: boolean; // true for PG (tstzrange), false for basic SQLite
  graphExpansion: boolean; // true for PG (recursive CTE), limited for SQLite
  transactions: boolean; // true for both
  rls: boolean; // true for PG only
}
```

### The Edge-Cognitive Model (Bitemporal Polyfill)

Because `StorageCapabilities.bitemporal` may be `false` (e.g., when using a lightweight SQLite-backed adapter on the edge), `@mnemo-ai/core` implements an **Application-Level Bitemporal Polyfill**.

- If the adapter supports it (Postgres), the Core passes down `valid_time` and `transaction_time` as native `tstzrange` constructs, leaning on the database for maximum query speed.
- If the adapter lacks native support (SQLite/D1), the Core automatically maps temporal queries into equivalent AST constraints over standard integer columns (`valid_from_ms`, `valid_to_ms`).
  This guarantees the "Everything is bitemporal" v3 promise remains intact regardless of the underlying storage engine, enabling rigorous memory time-travel even in edge deployments.

### CacheAdapter

```typescript
// @mnemo-ai/types/src/ports.ts — CacheAdapter section

interface CacheAdapter {
  readonly id: string; // "memory-lru" | "redis" | "noop"

  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, opts?: CacheSetOpts): Promise<void>;
  delete(key: string): Promise<void>;
  deletePattern(pattern: string): Promise<number>; // For workspace flush

  // Sorted sets (for ACT-R hot tier)
  zadd?(key: string, score: number, member: string): Promise<void>;
  zrangeByScore?(key: string, min: number, max: number, limit?: number): Promise<string[]>;
  zincrby?(key: string, increment: number, member: string): Promise<number>;

  // Pub/Sub (for invalidation across pods)
  publish?(channel: string, message: string): Promise<void>;
  subscribe?(channel: string, handler: (message: string) => void): Promise<void>;

  // Lifecycle
  healthCheck(): Promise<HealthStatus>;
  close(): Promise<void>;
}

interface CacheSetOpts {
  ttlMs?: number; // Time to live in milliseconds
  ifNotExists?: boolean; // SET NX semantics
}

// Capability check — consumers use this to feature-detect
interface CacheCapabilities {
  sortedSets: boolean; // false for memory-lru, true for Redis
  pubSub: boolean; // false for memory-lru, true for Redis
  patterns: boolean; // deletePattern support (SCAN-based)
  atomic: boolean; // true for Redis (MULTI/EXEC), false for memory
}
```

### VectorAdapter (separate from StorageAdapter)

```typescript
// @mnemo-ai/types/src/ports.ts — VectorAdapter section

interface VectorAdapter {
  readonly id: string; // "pgvector" | "qdrant" | "pinecone"
  readonly dimensions: number; // 384, 768, 1536, etc.

  search(input: VectorSearchInput): Promise<VectorSearchHit[]>;
  upsert(id: string, vector: Float32Array, metadata?: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByFilter(filter: VectorFilter): Promise<number>;

  healthCheck(): Promise<HealthStatus>;
  close(): Promise<void>;
}

// When VectorAdapter is provided, StorageAdapter.vectorSearch delegates to it.
// When not provided, StorageAdapter.vectorSearch uses its internal impl
// (pgvector inside PG) or throws MnemoCapabilityError.
```

### EmbedAdapter

```typescript
// @mnemo-ai/types/src/ports.ts — EmbedAdapter section

interface EmbedAdapter {
  readonly id: string; // "openai" | "ollama" | "voyage"
  readonly model: string; // "text-embedding-3-small"
  readonly dimensions: number; // Output dimensions

  embed(texts: string[]): Promise<Float32Array[]>;
  embedSingle(text: string): Promise<Float32Array>;

  healthCheck(): Promise<HealthStatus>;
}
```

### LLMAdapter

```typescript
// @mnemo-ai/types/src/ports.ts — LLMAdapter section

interface LLMAdapter {
  readonly id: string; // "anthropic" | "openai" | "ollama"
  readonly model: string; // "claude-sonnet-4-20250514"

  generate(input: LLMInput): Promise<LLMOutput>;
  generateStructured<T>(input: LLMInput, schema: ZodSchema<T>): Promise<T>;

  healthCheck(): Promise<HealthStatus>;
}

interface LLMInput {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
}

interface LLMOutput {
  content: string;
  tokensUsed: { input: number; output: number };
  model: string;
  finishReason: "stop" | "length" | "tool_use";
}
```

### QueueAdapter

```typescript
// @mnemo-ai/types/src/ports.ts — QueueAdapter section

interface QueueAdapter {
  readonly id: string; // "pg-boss" | "bullmq" | "memory"

  enqueue(jobName: string, data: unknown, opts?: EnqueueOpts): Promise<string>;
  schedule(jobName: string, cron: string, data?: unknown): Promise<void>;
  process(jobName: string, handler: JobHandler): Promise<void>;

  healthCheck(): Promise<HealthStatus>;
  close(): Promise<void>;
}

interface EnqueueOpts {
  priority?: number; // 1 (critical) to 4 (low)
  retryLimit?: number;
  retryDelay?: number; // ms
  startAfter?: Date; // Delayed execution
  singletonKey?: string; // Dedup — only one job with this key active
}
```

### OutboxAdapter

```typescript
// @mnemo-ai/types/src/ports.ts — OutboxAdapter section

/**
 * OutboxAdapter — manages the transactional outbox for cross-adapter side effects.
 * The PG commit is the atomic boundary; this adapter provides at-least-once fan-out.
 */
interface OutboxAdapter {
  append(entry: OutboxEntry): Promise<void>;
  claimBatch(limit: number): Promise<OutboxEntry[]>;
  markProcessed(ids: string[]): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  getStats(): Promise<{ pending: number; failed: number; oldestPendingMs: number }>;
}
```

### Session Collapse Atomicity Contract

All non-PG side effects are written to `mnemo_outbox` within the same PG transaction as the fact writes. The outbox worker fans out to vector/cache/queue adapters with at-least-once semantics. The PG transaction commit is the atomic boundary. If the vector upsert fails after commit, the outbox entry is retried until success. Maximum retry attempts: 10. After 10 failures, the entry is moved to a dead-letter state (`processed_at = NULL`, `attempts = 10`, `last_error` set) and triggers an alert.

### Logger

```typescript
// @mnemo-ai/types/src/ports.ts — Logger section

interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  fatal(msg: string, ctx?: LogContext): void;

  child(bindings: Record<string, unknown>): Logger; // Scoped logger
}

interface LogContext {
  workspaceId?: string;
  agentId?: string;
  traceId?: string;
  spanId?: string;
  operation?: string;
  duration_ms?: number;
  error?: { type: string; message: string; stack?: string; code?: string };
  cost?: { model: string; tokensIn: number; tokensOut: number; costUsd: number };
  [key: string]: unknown;
}
```

### Telemetry

```typescript
// @mnemo-ai/types/src/ports.ts — Telemetry section

interface Telemetry {
  // Spans (distributed tracing)
  startSpan(name: string, opts?: SpanOpts): Span;

  // Metrics (counters, histograms, gauges)
  counter(name: string, value?: number, attrs?: Record<string, string>): void;
  histogram(name: string, value: number, attrs?: Record<string, string>): void;
  gauge(name: string, value: number, attrs?: Record<string, string>): void;

  // Shutdown (flush pending)
  shutdown(): Promise<void>;
}

interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: "ok" | "error", message?: string): void;
  end(): void;
}

interface SpanOpts {
  parent?: Span;
  attributes?: Record<string, string | number | boolean>;
}
```

### ConfigProvider

```typescript
// @mnemo-ai/types/src/ports.ts — ConfigProvider section

interface ConfigProvider {
  get<T>(key: string): T | undefined;
  getRequired<T>(key: string): T; // Throws if missing

  // Feature flags
  isEnabled(feature: FeatureFlag): boolean;

  // Reload (for API-driven config changes)
  reload(): Promise<void>;

  // Watch (for reactive config updates)
  onChange(handler: (key: string, value: unknown) => void): void;
}

type FeatureFlag =
  | "redis"
  | "hotTier"
  | "sessions"
  | "vectorSearch"
  | "extraction"
  | "federation"
  | "telemetry"
  | "consolidation"
  | "anticipation"
  | "composition"
  | "metaCognition"
  | "selfEdit"
  | "proceduralMemory"
  | "tasks"
  | "events"
  | "websocket"
  | "grpc"
  | "plugins";
```

---

## Dependency Injection: The Factory

`createCore(deps, config)` lives in `packages/core/src/cognitive/index.ts` and is exported
from `@mnemo-ai/core/cognitive`. It is synchronous and takes the ports already built:

```typescript
export interface CoreDeps {
  // Required
  storage: StorageAdapter;
  vector: VectorAdapter;
  embed: EmbedAdapter;
  outbox: OutboxAdapter;
  logger: Logger;
  telemetry: Telemetry;
  // Optional — core degrades gracefully when absent
  cache?: CacheAdapter;
  llm?: LLMAdapter;
  queue?: QueueAdapter;
  auth?: AuthAdapter;
  // ...plus optional reporting hooks (onLlmUsage, onHotTierEvict, ...)
}

export function createCore(deps: CoreDeps, config: CoreConfig = {}): MnemoCore;
```

It opens no database connection, runs no migrations and has no `close()`. The server
builds the adapters (`DrizzleStorageAdapter`, `PgVectorAdapter`, `RedisCacheAdapter`, the
`llm-providers` implementations through `adapter-llm`) and calls `createCore` in
`packages/server/src/index.ts`; consumers of `@mnemo-ai/server` never call it.
`@mnemo-ai/core` and the adapters are private packages, not published to npm.

## Feature Flags: How Capabilities Degrade

```typescript
// Inside core — every feature checks before acting

class RecallPipeline {
  async execute(query: RecallQuery): Promise<RecallHit[]> {
    const { config, cache, embed, vector, telemetry } = this.deps;

    const span = telemetry.startSpan("mnemo.recall");

    // Tier 1: Hot tier (only if cache supports sorted sets)
    if (config.isEnabled("hotTier") && cache.capabilities.sortedSets) {
      const hot = await this.tier1Hot(query);
      if (hot.length >= 3) {
        span.end();
        return hot;
      }
    }

    // Tier 2: Pointer + FTS (always available if storage supports FTS)
    if (this.deps.storage.capabilities.ftsSearch) {
      const warm = await this.tier2Warm(query);
      if (warm.length >= 3) {
        span.end();
        return warm;
      }
    }

    // Tier 3: Full pipeline (only if embed + vector are available)
    if (config.isEnabled("vectorSearch") && embed && vector) {
      const cold = await this.tier3Cold(query);
      span.end();
      return cold;
    }

    // Fallback: return whatever Tier 2 found
    span.end();
    return warm ?? [];
  }
}
```

---

## Error Handling: Structured, Typed, Traceable

```typescript
// packages/server/src/errors.ts
// (error codes and base error type — there is no separate @mnemo-ai/errors package)

// Base error — every typed error extends this. The wire envelope is
// { error: { type, code, message, param?, details?, request_id? } } (snake_case).
export class HttpError extends Error {
  public readonly status: number; // HTTP status code returned to the client
  public readonly code: string; // machine-readable, snake_case, stable contract
  public readonly type: string; // Stripe-style, derived from status
  public readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.type = errorTypeFromStatus(status);
  }
}

// Specific typed errors — each pins its HTTP status + stable snake_case code:
export class BadRequestError extends HttpError {} // 400 bad_request
export class UnauthorizedError extends HttpError {} // 401 unauthorized
export class ForbiddenError extends HttpError {} // 403 forbidden
export class NotFoundError extends HttpError {} // 404 not_found
export class ConflictError extends HttpError {} // 409 conflict
export class UnprocessableEntityError extends HttpError {} // 422 unprocessable_entity
export class RateLimitedError extends HttpError {} // 429 rate_limited
export class InternalServerError extends HttpError {} // 500 internal_error
export class NotImplementedError extends HttpError {} // 501 not_implemented
export class ServiceUnavailableError extends HttpError {} // 503 service_unavailable
// Codes are stable across versions; see docs/architecture/API.md §6 for the full table.
```

---

## Telemetry: Core Operations Are Traced

Core operations (recall pipeline tiers, session collapse, fact writes, federation sync) emit spans and metrics. Internal helpers below the public-method boundary are not individually spanned. See `docs/internals/OBSERVABILITY.md` for the full list of instrumented spans and metric families.

```typescript
// Pattern: every public method wraps in a span

class FactService {
  async create(workspaceId: string, input: CreateFactInput): Promise<FactRecord> {
    const span = this.telemetry.startSpan("mnemo.fact.create", {
      attributes: { "mnemo.workspace_id": workspaceId, "mnemo.fact.kind": input.kind },
    });

    try {
      // Business logic...
      const result = await this.storage.createFact(workspaceId, input);

      // Metrics
      this.telemetry.counter("mnemo_fact_created_total", 1, { workspace: workspaceId });

      span.setStatus("ok");
      return result;
    } catch (error) {
      span.setStatus("error", error.message);
      this.telemetry.counter("mnemo_errors_total", 1, { operation: "fact.create" });
      throw error;
    } finally {
      span.end();
    }
  }
}
```

### Metrics emitted (every operation)

```
# RED per endpoint
mnemo_requests_total{method, endpoint, status}
mnemo_request_duration_seconds{method, endpoint}
mnemo_errors_total{method, endpoint, error_code}

# Per-adapter health
mnemo_adapter_health{adapter, status}           # "healthy" | "degraded" | "down"
mnemo_adapter_latency_seconds{adapter, op}      # Per-operation latency

# Domain metrics
mnemo_recall_duration_seconds{tier}
mnemo_recall_tier_hits_total{tier}
mnemo_fact_total{workspace, status}
mnemo_cache_hits_total{adapter}
mnemo_cache_misses_total{adapter}
mnemo_feature_flag_status{flag}                 # 1=enabled, 0=disabled
```

---

## What Was Built: The Shipped Package Set

The migration described above is complete. Mnemosyne ships **18 packages** today:

```
packages/
├── types/           ← All TypeScript interfaces, ports, enums (zero deps)
├── core/            ← Business logic — recall orchestration, collapse pipeline,
│                       worth governance, graph traversal
├── adapter-postgres/← DrizzleStorageAdapter (Drizzle + postgres.js)
├── adapter-redis/   ← RedisCacheAdapter (ioredis)
├── adapter-vector/  ← PgVectorAdapter (pgvector SQL)
├── adapter-llm/     ← Bridges llm-providers → LLMAdapter + EmbedAdapter ports
├── llm-providers/   ← Provider impls: Anthropic, OpenAI, Ollama, Voyage,
│                       Cohere, Gemini, Mistral (7 total)
├── server/          ← Hono HTTP API — composition root + all routes
├── mcp/             ← MCP server (Model Context Protocol)
├── cli/             ← `mnemo` CLI (TypeScript/Node, 13 commands + built-in help)
├── client-ts/       ← TypeScript HTTP SDK
├── consolidation/   ← Memory consolidation scheduler (UCE, worth decay)
├── cup/             ← Client update protocol (keyset pagination)
├── federation/      ← Cross-instance sync (mesh, crypto, scoped sync)
├── plugins/         ← Plugin loader + lifecycle
├── mock-server/     ← In-process test server (InMemoryStorageAdapter)
├── sdk-go/          ← Go SDK
└── sdk-python/      ← Python SDK
```

This layout was reached incrementally — each package landed as a PR, leaving the system working. The historical phase plan (types → logger → config → cache → core refactor → storage extraction → llm split) was followed in substance, though the final package boundaries were consolidated: per-provider packages were unified under `llm-providers` and the adapter layer landed as four `adapter-*` packages rather than the original per-technology split.

---

## Decision: The 7 Questions Answered

| #   | Question   | Answer                                                                   | Reason                                                    |
| --- | ---------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| 1   | Event Bus  | InMemoryEventBus default + Redis pub/sub adapter                         | Matches "everything replaceable" — bus is a port          |
| 2   | Hot Tier   | CacheAdapter.sortedSets capability-check — Redis gets it, Memory doesn't | Feature degrades gracefully based on adapter caps         |
| 3   | CoT        | Explicit (agent calls tool)                                              | Agent controls what's worth caching                       |
| 4   | Migrations | 6 separate (one per primitive type)                                      | Independent deploy per milestone                          |
| 5   | Hypergraph | Array column + GIN (inside StorageAdapter impl)                          | Consumer never knows the storage shape                    |
| 6   | Cron       | QueueAdapter.schedule() — impl decides (pg-boss, BullMQ, cron)           | Replaceable job scheduling                                |
| 7   | Plugins    | In-process via PluginAdapter interface                                   | Can swap to V8 isolate later without changing plugin code |

---

## Remaining Interface Definitions

> These types are referenced throughout the specs and complete the public contract of `@mnemo-ai/types`.

---

### EventBus

Internal pub/sub system for cache invalidation, event propagation, and plugin notification.

```typescript
// @mnemo-ai/types/src/ports.ts — EventBus section

interface EventBus {
  /** "memory" | "redis-pubsub" */
  readonly id: string;

  /** Emit an event to all registered handlers. */
  emit(event: MnemoEvent): void;

  /** Subscribe to events of a specific type. */
  on(eventType: string, handler: (event: MnemoEvent) => void): void;

  /** Unsubscribe a previously registered handler. */
  off(eventType: string, handler: (event: MnemoEvent) => void): void;

  /**
   * Pattern subscription — glob-style matching.
   * e.g. "fact.*" matches "fact.created" and "fact.updated"
   */
  onPattern(pattern: string, handler: (event: MnemoEvent) => void): void;

  /** Close connections and flush any pending events. */
  close(): Promise<void>;
}

/**
 * The envelope for all internal events.
 * Note: this `MnemoEvent` is the bus event type, distinct from the
 * `MnemoEventRecord` knowledge primitive (see KnowledgeUnit below).
 */
interface MnemoEvent {
  /** e.g. "fact.created" | "fact.updated" | "cache.invalidate" | "session.collapsed" */
  type: string;
  workspaceId: string;
  payload: unknown;
  /** Unix ms */
  timestamp: number;
  /** Which adapter/module emitted this */
  source: string;
}
```

Two implementations ship out of the box:

- **`InMemoryEventBus`** — default, single-process, zero deps.
- **`RedisEventBus`** — cross-pod via Redis Pub/Sub; requires `@mnemo-ai/adapter-redis`.

---

### HealthStatus

Returned by every adapter's `healthCheck()` method.

```typescript
// @mnemo-ai/types/src/common.ts — HealthStatus

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  /** Round-trip latency of the last health probe in milliseconds. */
  latencyMs?: number;
  /** Human-readable explanation (surfaced in /health endpoint). */
  message?: string;
  /** Unix ms timestamp of the most recent check. */
  lastCheckedAt: number;
  /** Adapter-specific diagnostics (pool size, queue depth, etc.). */
  metadata?: Record<string, unknown>;
}
```

---

### MigrationResult

Returned by `StorageAdapter.migrate()`.

```typescript
// @mnemo-ai/types/src/ports.ts — MigrationResult (extends StorageAdapter section)

interface MigrationResult {
  /** Number of migrations applied in this run. */
  applied: number;
  /** Migrations still pending after this run. */
  pending: number;
  /** Schema version identifier after migration completes. */
  current: string;
  duration_ms: number;
}
```

---

### KnowledgeUnit

Discriminated union of all 10 knowledge primitives. Used in plugin hooks
(`onBeforeWrite`, `onAfterWrite`) so plugins receive a typed payload without
casting.

```typescript
// @mnemo-ai/types/src/primitives.ts — KnowledgeUnit

type KnowledgeUnit =
  | { type: "fact"; data: MnemoFact }
  | { type: "decision"; data: MnemoDecision }
  | { type: "episode"; data: MnemoEpisode }
  | { type: "entity"; data: MnemoEntity }
  | { type: "strategy"; data: MnemoStrategy }
  | { type: "workflow"; data: MnemoWorkflow }
  | { type: "skill"; data: MnemoSkill }
  | { type: "task"; data: MnemoTask }
  | { type: "event"; data: MnemoEventRecord }
  | { type: "reasoning"; data: MnemoReasoning };

// All 10 primitive type names as a literal union (useful for filters/arrays)
type KnowledgeType =
  | "fact"
  | "decision"
  | "episode"
  | "entity"
  | "strategy"
  | "workflow"
  | "skill"
  | "task"
  | "event"
  | "reasoning";
```

> `MnemoEventRecord` is the _knowledge primitive_ (a stored event observation).
> `MnemoEvent` (in the EventBus section above) is the _bus envelope_ for
> internal pub/sub. They are intentionally different types.

---

### RecallQuery / RecallInput

What consumers pass into `recall()` and the enriched internal form used by the
recall pipeline.

```typescript
// @mnemo-ai/types/src/recall.ts — RecallQuery

interface RecallQuery {
  /** Natural language query string. */
  query: string;
  /** Resolved from auth context — required. */
  workspaceId: string;
  /** Filter results to a specific agent. */
  agentId?: string;
  /** "global" | "agent" | "session" */
  scope?: string;
  /** e.g. session_id when scope="session" */
  scopeRef?: string;
  /** Maximum number of results to return (default: tier-dependent). */
  topK?: number;
  /** Filter by one or more knowledge primitive types. */
  types?: KnowledgeType[];
  /** Bitemporal time-travel — retrieve the world as it was at this moment. */
  asOf?: Date;
  /** Enable graph expansion to include related entities. */
  includeGraph?: boolean;
  /** Worth floor — omit results below this score (default: 0.3). */
  minWorth?: number;
  /** Response render format. */
  format?: "compact" | "verbose" | "json";
}

/**
 * Enriched form used internally by RecallPipeline.
 * Consumers never construct this directly.
 */
interface RecallInput extends RecallQuery {
  /** Available context window tokens — drives CALMem compression. */
  tokenBudget?: number;
  /** Pre-computed query embedding (skips re-embedding when already available). */
  embedding?: Float32Array;
  /** What triggered this recall. */
  triggerSource?: "explicit" | "auto" | "anticipation";
}
```

**Usage example:**

```typescript
const hits = await mnemo.recall({
  query: "what was the decision on auth architecture?",
  workspaceId: "ws_acme",
  types: ["decision"],
  topK: 5,
});
```

---

### Mnemosyne (public API surface)

Design-era sketch of the API surface. What `createCore()` returns today is `MnemoCore` (`packages/core/src/cognitive/index.ts`).
Methods that depend on optional adapters throw `MnemoDegradedError` when the
required adapter is not configured (e.g. sessions require Redis, reasoning
requires `EmbedAdapter`).

```typescript
// Design rationale: the public API surface CoreLike exposes (see packages/core/src/factory.ts)

interface CoreLike {
  // === Recall ===

  /** Retrieve relevant knowledge for a query. */
  recall(query: RecallQuery): Promise<RecallResult>;

  /** Recall with explainability — includes tier used, scores, graph path. */
  recallExplain(query: RecallQuery): Promise<RecallExplainResult>;

  // === Write ===

  /** Store a new knowledge unit (type inferred from input shape). */
  remember(workspaceId: string, input: RememberInput): Promise<KnowledgeUnit>;

  /** Soft-delete a knowledge unit with an auditable reason. */
  forget(workspaceId: string, id: string, reason: string): Promise<void>;

  /** Update an existing knowledge unit (creates a new temporal version). */
  update(workspaceId: string, id: string, input: UpdateInput): Promise<KnowledgeUnit>;

  // === Entities & Graph ===

  /** Find an entity by display name (case-insensitive). */
  findEntity(workspaceId: string, name: string): Promise<MnemoEntity | null>;

  /** Create a new entity node. */
  createEntity(workspaceId: string, input: CreateEntityInput): Promise<MnemoEntity>;

  /** Traverse the knowledge graph from an entity up to `depth` hops. */
  getGraph(workspaceId: string, entityId: string, depth?: number): Promise<SubGraph>;

  // === Sessions (requires Redis) ===

  /** Start a new session buffer. Throws MnemoDegradedError without Redis. */
  startSession(workspaceId: string, opts: SessionOpts): Promise<Session>;

  /** Retrieve an active session by ID. */
  getSession(sessionId: string): Promise<Session | null>;

  // === Tasks ===

  /** Create a tracked task. */
  createTask(workspaceId: string, input: CreateTaskInput): Promise<MnemoTask>;

  /** Update task status or metadata. */
  updateTask(workspaceId: string, taskId: string, input: UpdateTaskInput): Promise<MnemoTask>;

  // === Events ===

  /** Record an observed external or internal event. */
  recordEvent(workspaceId: string, input: RecordEventInput): Promise<MnemoEventRecord>;

  // === Reasoning (CoT) — requires EmbedAdapter ===

  /**
   * Retrieve relevant past reasoning chains for a query.
   * Throws MnemoDegradedError if EmbedAdapter is not configured.
   */
  resolveReasoning(workspaceId: string, query: string): Promise<ResolveResult>;

  /** Persist a chain-of-thought reasoning trace. */
  recordReasoning(workspaceId: string, input: RecordReasoningInput): Promise<void>;

  // === Self-Edit ===

  /** Agent-initiated self-correction of existing knowledge units. */
  selfEdit(workspaceId: string, input: SelfEditInput): Promise<void>;

  // === Governance ===

  /** Aggregate health across all adapters for a workspace. */
  getHealth(workspaceId: string): Promise<WorkspaceHealth>;

  /** Retrieve operational metrics (fact counts, cache ratios, etc.). */
  getMetrics(workspaceId: string): Promise<WorkspaceMetrics>;

  // === Lifecycle ===

  /** Run pending migrations and warm caches. Call before serving traffic. */
  initialize(): Promise<void>;

  /** Gracefully close adapter pools and flush telemetry. */
  shutdown(): Promise<void>;

  /** Quick liveness probe (suitable for Kubernetes readinessProbe). */
  isHealthy(): Promise<HealthStatus>;
}
```

---

### MnemoMode

Operational mode, detected automatically from which adapters are provided.

```typescript
// @mnemo-ai/types/src/common.ts — MnemoMode

/**
 * A = FTS-only          — only StorageAdapter configured (no embedder)
 * B = Vector + FTS      — EmbedAdapter present; semantic recall enabled
 * C = Full cognitive    — EmbedAdapter + LLMAdapter + Redis; all features on
 *
 * Detected automatically from the adapters present in collapse config.
 * Consumers can observe the active mode via the /health endpoint.
 */
type MnemoMode = "A" | "B" | "C";
```

---

### Naming Conventions (v3 Canonical)

| Concern           | v3 Canonical                                                   | v2 (deprecated)                            |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------ |
| HTTP port         | `3939` (`PORT`)                                                | —                                          |
| API key prefixes  | `mk_live_` · `mk_test_` · `mk_sess_` · `mk_fed_` · `mk_admin_` | —                                          |
| Package scope     | `@mnemo-ai/`                                                   | `@orchester/`                              |
| Factory function  | `createCore(deps, config)` (returns `MnemoCore`)               | `createMnemosyne()` (planned, not shipped) |
| Storage interface | `StorageAdapter`                                               | `MnemoStorage`                             |
| DB table prefix   | `mnemo_` (unchanged)                                           | `mnemo_`                                   |
| CLI binary        | `mnemo`                                                        | —                                          |
| Redis key pattern | `mnemo:{workspace}:{domain}:{key}`                             | —                                          |

---

### KnowledgeScheduler (UCE Algorithm)

The **Uniform Cognitive Extraction** algorithm ensures the workspace maintains
a healthy distribution across all 10 knowledge types. An imbalanced workspace
(e.g. 90% facts, 0% strategies) degrades recall quality and agent reasoning.

```typescript
// @mnemo-ai/core/src/scheduler/knowledge-scheduler.ts

interface KnowledgeScheduler {
  /** Current count distribution across the workspace. */
  getDistribution(workspaceId: string): Promise<Record<KnowledgeType, number>>;

  /** Target percentage distribution (configurable per workspace). */
  getTarget(workspaceId: string): Promise<Record<KnowledgeType, number>>;

  /**
   * Compute extraction bias weights for the next session collapse.
   * Returns values in [0, 1] — higher = more extraction emphasis.
   * Passed to the collapse LLM prompt as soft emphasis instructions.
   */
  computeBias(workspaceId: string): Promise<Record<KnowledgeType, number>>;
}

// Default target distribution:
// fact: 40%  decision: 15%  strategy: 15%  episode: 10%
// entity: auto  workflow: 5%  skill: 5%  task: 5%  event: 5%  reasoning: auto

// UCE Algorithm (runs inside session collapse):
// 1. Count current distribution per type in workspace
// 2. Compare against target percentages
// 3. bias[type] = Math.max(0, (target[type] - actual[type]) / target[type])
// 4. Inject bias into collapse LLM prompt:
//    "Pay special attention to extracting {type} — it is underrepresented."
// 5. Scheduled via QueueAdapter: cron "mnemo.type.schedule" (daily 06:00 UTC)
```
