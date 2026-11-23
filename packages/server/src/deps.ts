import type { ApiKeyLookup } from "./auth.js";

/**
 * Dependency contract for the server.
 *
 * Why structural typing instead of importing concrete classes:
 *  - Tests can pass tiny in-memory fakes without spinning up Postgres.
 *  - The package builds even before @mnemo-ai/core and
 *    @mnemo-ai/llm-providers are fully shipped, because we only ever
 *    reference these interfaces — peer deps stay peer deps.
 *
 * flatten-legacy-dual-core Phase 7: the legacy `CoreLike` wire contract
 * (and the `core: CoreLike` field it backed) is DELETED — every route is
 * off `deps.core` (design.md D4, tasks.md Phase 6/7). `Fact`/`MemoryFact`
 * below are NOT part of that deletion: they are the still-live HTTP wire
 * DTOs `mappers.ts`'s `toApiFact`/`toMemoryFact` project `MnemoFact` (v3
 * domain model) onto, consumed by the ported `facts.ts`/`entities.ts`/
 * `episodes.ts` routes independently of `CoreLike`.
 */

export interface Fact {
  id: string;
  workspaceId: string;
  content: string;
  attribution: Record<string, unknown>;
  tags: string[];
  pinned: boolean;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  sensitivity?: string;
  /** CLIENTS-20 — additive: the columns the drill-down used to drop. */
  kind?: MemoryFact["kind"];
  subject?: string;
  scopeRef?: string | null;
  confidence?: number;
  topicKey?: string | null;
  episodeId?: string | null;
  status?: MemoryFact["status"];
  revisionCount?: number;
  /** How many times recall has served this fact. */
  hitCount?: number;
  /** Set only when the encrypted text could not be opened (`MnemoFact.redacted`). */
  redacted?: import("@mnemo-ai/types").FactRedaction;
}

/**
 * The "rich fact" wire shape — what the inspector renders for entity
 * and episode detail views. Distinct from the simplified {@link Fact}
 * exposed by `GET /facts/:id` (which trades the rich columns for
 * a content/attribution/tags projection more useful to ingest tools).
 *
 * Date fields are ISO 8601 strings. NULL-able columns from the SQL
 * row stay null (rather than collapsing to undefined) so the wire
 * stays explicit about "we know it's empty" vs "we don't know".
 */
export interface MemoryFact {
  id: string;
  workspaceId: string;
  agentId: string | null;
  scope: "global" | "conversation";
  scopeRef: string | null;
  kind: import("@mnemo-ai/types").MnemoFact["kind"];
  subject: string;
  statement: string;
  confidence: number;
  pinned: boolean;
  relevance: number;
  hitCount: number;
  lastRecalledAt: string | null;
  sourceMessageIds: string[];
  attributedTo: "user" | "assistant" | "system" | null;
  linkedMemoryIds: string[];
  metadata: Record<string, unknown>;
  status: "active" | "merged" | "forgotten";
  sensitivity?: string;
  mergedIntoId: string | null;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
  memoryType?: "semantic" | "episodic" | "procedural" | "working";
  actorId?: string | null;
  /** CLIENTS-20 / CHAOS-8 — additive. */
  topicKey?: string | null;
  episodeId?: string | null;
  revisionCount?: number;
  /** Set only when the encrypted text could not be opened (`MnemoFact.redacted`). */
  redacted?: import("@mnemo-ai/types").FactRedaction;
}

/**
 * Vendor-reported usage for a single embedding call. Mirrors the
 * `EmbedWithUsageResult` shape returned by @mnemo-ai/llm-providers'
 * `createProvider`, but is redeclared here so the server keeps zero static
 * dependency on the provider package (it is dynamically imported at boot).
 */
export interface EmbedUsage {
  /** The embedding vector. */
  vector: number[];
  /** Vendor-reported tokens charged (input only — embeddings have no output). */
  tokensUsed: number;
  /** Estimated USD cost; undefined when the model is not in the pricing table. */
  costUSD?: number;
  /** Exact model the vendor billed. */
  model: string;
  /** Vendor name ("openai", "voyage", ...). */
  provider: string;
}

/**
 * Minimal LLM provider surface the server needs. Just embeddings. We
 * intentionally do NOT expose chat/completion here — that's a different
 * concern and a different package.
 */
export interface LLMProviderLike {
  /**
   * Embed a string. The provider is responsible for honouring the
   * requested model name; if unsupported, it should throw.
   */
  embed(text: string, model: string): Promise<number[]>;

  /**
   * Optional: embed a string AND return the vendor's token usage + cost, so
   * the server can emit `mnemo_llm_tokens_total` / `mnemo_llm_cost_microdollars_total`.
   * Present when the provider was built via `createProvider` (the boot path);
   * absent on bare/test doubles, in which case callers fall back to {@link embed}
   * and skip token/cost metrics. Same round-trip cost as `embed`.
   */
  embedWithUsage?(text: string, model: string): Promise<EmbedUsage>;
}

// MnemoCore is imported as a type only — the real module is dynamically
// imported at runtime so the server still boots when @mnemo-ai/core/cognitive
// is not present (it's a peer dep). We reference the type here purely for
// the ServerDeps interface.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import type { MnemoCore } from "@mnemo-ai/core/cognitive";
import type {
  StorageAdapter,
  CacheAdapter,
  ApprovalStore,
  AccessPolicyStore,
  Telemetry,
} from "@mnemo-ai/types";

export type { MnemoCore };

export interface FederationDeps {
  /** In-memory or persistent store for peer registry. */
  peerStore: import("@mnemo-ai/federation").PeerStore;
  /** mTLS auth adapter for key-continuity rotation and peer authentication. */
  mtls: import("@mnemo-ai/federation").MtlsAuthAdapter;
  /** Async sync jobs: Postgres (0063) when the adapter is installed, else in memory. */
  jobStore: import("./federation/JobStore.js").SyncJobStore;
  /**
   * SyncEngine wired at boot time — processes incoming federated items via the
   * SyncStorage implementation supplied during construction.
   * Optional: absent when federation is booted without a storage adapter.
   */
  syncEngine?: import("@mnemo-ai/federation").SyncEngine;
  /**
   * §20 app-layer crypto: when set (instance Ed25519 key + shared symmetric key
   * from env), GET /federation/items signs + seals the served payload. Absent →
   * plaintext serve (transport mTLS/JWT still applies).
   */
  serveCrypto?: import("@mnemo-ai/federation").ServeCryptoKeys;
  /** JTI replay store for service-to-service federation JWT verification (§6). */
  jtiStore?: import("@mnemo-ai/core").JtiStore;
  /** The audience claim expected in incoming service JWTs (this server's MNEMO_FED_PEER_ID). */
  selfAudience?: string;
  /** Where the peer gate learns the TLS version (MNEMO_FED_TLS_PROXY / MNEMO_FED_INSECURE_TRANSPORT). */
  transport?: import("./federation/authenticateFederationRequest.js").FederationTransport;
  /** Our id and signing key, used to pull from peers. Absent → this server cannot pull. */
  identity?: import("./federation/federationIdentity.js").FederationIdentity;
  /** Client certificate and/or CA for pulls from https peers (MNEMO_FED_*_FILE). */
  pullTls?: import("@mnemo-ai/federation").PullTls;
}

export interface ServerDeps {
  /** Operator-maintained actor-ref -> traffic-origin bindings. Never read from request metadata. */
  trafficOrigins?: Readonly<Record<string, import("@mnemo-ai/types").TrafficOrigin>>;
  apiKeys: ApiKeyLookup;
  /** Optional injected password service; defaults to Postgres when configured. */
  dashboardPasswordAuth?: import("./dashboard-password.js").DashboardPasswordAuth;
  /** Live disabled / session-revocation / superadmin status, cached ~15 s. */
  userStatus?: import("./user-status.js").UserStatusService;
  /**
   * §6 optional scoped-key (`mk_*`) auth adapter. When present, the auth
   * middleware verifies `mk_*` keys through it while leaving live `mns_*` keys
   * on the bcrypt path. Wired only when MNEMO_SCOPED_AUTH=1 (dark-launch).
   */
  scopedAuthAdapter?: import("@mnemo-ai/types").AuthAdapter;
  /**
   * The scoped-key store (mnemo_scoped_api_keys) POST /admin/scoped-keys issues
   * into. Wired whenever there is a database, flag or not, so keys can be
   * issued before MNEMO_SCOPED_AUTH=1 turns their verification on.
   */
  scopedKeyStore?: import("@mnemo-ai/types").ApiKeyStore;
  /** Optional — recall can still work if caller supplies `vector` directly. */
  llm?: LLMProviderLike;
  /** Model name passed to LLM.embed(). Defaults to "text-embedding-3-small". */
  embedModel: string;
  /**
   * cognitive core — remember/forget/recall with full surprise gate + outbox.
   * Required: server fails fast at boot if this cannot be initialized.
   */
  cognitive: MnemoCore;
  /**
   * Direct storage adapter — used by webhook CRUD routes which need access
   * to mnemo_webhook_endpoint and mnemo_webhook_delivery tables.
   * Optional: absent when the v3 adapter-postgres peer dep is not installed.
   */
  storage?: StorageAdapter;
  /**
   * F12: encrypts/decrypts webhook signing secrets at the storage boundary.
   * Present only when MNEMO_MASTER_KEY is configured (KeyRing available). When
   * absent, webhook secrets are stored as-is (dev convenience); the encryption
   * boot gate (F8) makes the KeyRing mandatory in production, so this is present
   * in any production boot.
   */
  webhookSecretCipher?: import("./encryption/webhookSecretCipher.js").WebhookSecretCipher;
  /**
   * §9 degradation ladder — Redis cache adapter.
   * Used to gate session-mutating ops (503 when Redis is down) while leaving
   * recall and task routes working. Optional: when absent session ops behave
   * as if Redis is always down (sessions disabled at boot time).
   */
  cache?: CacheAdapter;
  /**
   * §19 concurrent-session probe for RBAC maxSessionsConcurrent. When absent the
   * limit fails open; assertRbacLimitsWired makes that fatal in production.
   */
  activeSessions?: { countActive(workspaceId: string, actorId: string): Promise<number> };
  /**
   * Federation runtime — peer registry, mTLS auth, and sync engine.
   * Optional: when absent all /memory/federation/* routes return 503.
   */
  federation?: FederationDeps;
  /**
   * Wave X2.4 — Approval store for export gate and future approval-required ops.
   * Optional: when absent the export route does not enforce the approval gate.
   */
  approvals?: ApprovalStore;
  /** B6.35: Replay validator context for consolidation ticks. */
  replayValidator?: unknown;
  /** B6.35: Per-workspace replay validator resolver. */
  getReplayValidator?: (workspaceId: string) => Promise<unknown>;
  /**
   * §19 RBAC — per-agent access policy store (namespace allow-lists + approval
   * triggers). Optional: when absent the RBAC middleware is not mounted and
   * only the coarse API-key scope guard runs.
   */
  accessPolicies?: AccessPolicyStore;
  /**
   * WP8 (F10) SOC2 break-glass two-person store. Absent → mk_admin_ privileged
   * ops fail CLOSED (403) so a misconfigured deployment cannot silently bypass
   * dual control. The `/break-glass` routes are only mounted when present.
   */
  breakGlass?: import("@mnemo-ai/types").BreakGlassStore;
  /**
   * §4 Internal event bus — wires lifecycle events to WebSocket subscribers.
   * Optional: when absent all emitEvent() calls are no-ops.
   */
  bus?: import("@mnemo-ai/core").EventBus;
  /**
   * §35 WS replay buffer — records emitted events for reconnection catch-up.
   * Optional: when absent resubscribe frames return a gap response.
   */
  replay?: import("./resilience/replayBuffer.js").ReplayBuffer;
  /**
   * §35 Idempotency store — Stripe-pattern SERIALIZABLE key storage.
   * Optional: when absent idempotency middleware is not mounted.
   */
  idempotencyStore?: import("./idempotency.js").IdempotencyStore;
  /**
   * §35 Rate-limit backend — Redis token-bucket + concurrency.
   * Optional: when absent rate limiting is disabled (dev mode).
   */
  rateLimitBackend?: import("./ratelimit.js").RateLimitBackend;
  /**
   * Fleet-shedding signal for the rate limiter, in [0,1]: the share of Postgres
   * `max_connections` busy across the cluster (pg_stat_activity, sampled every
   * 2 s, the same reading as the job-shedding gate). Absent: never shed.
   */
  fleetUtil?: () => number;
  /**
   * §21 Plugin loader — run write/read hooks and async event hooks.
   * Optional: when absent all plugin hook calls are no-ops.
   */
  pluginLoader?: import("@mnemo-ai/plugins").PluginLoader;
  /**
   * H1: Circuit breakers for external-call categories (LLM + storage).
   * Optional: when absent calls proceed without breaker protection (dev mode).
   */
  circuitBreakers?: import("./resilience/circuitBreakers.js").CircuitBreakers;
  /**
   * §29 L0 Working Memory — ephemeral in-session activation buffer backed
   * by Redis sorted set. Absent when no cache adapter is configured.
   */
  workingMemory?: import("@mnemo-ai/core").WorkingMemory;
  /**
   * §7/§9 L1 Session Buffer — write-through Redis cache over durable PG sessions
   * (turns List + scratch Hash + sess:active SortedSet, 24h TTL). Always present
   * when `storage` is wired; degrades to PG-only when no cache adapter exists.
   */
  sessionBuffer?: import("@mnemo-ai/core").SessionBuffer;
  /**
   * OPS-3: postgres-js client exposed for USE-gauge refresh on Prometheus scrape.
   * Absent when the server boots without adapter-postgres.
   */
  metricsPgClient?: import("postgres").Sql;
  /**
   * OpenTelemetry span + metric adapter.
   * Always present — a no-op shim is provided when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
   */
  telemetry: Telemetry;
  /**
   * P127 — per-dependency probes for `/health/ready`.
   *
   * Declared here, and not only in `routes/health.ts`, because the previous
   * arrangement is what let this go unnoticed: the route accepted
   * `ServerDeps & { healthAdapters?: HealthAdapters }` as a local widening, so
   * nothing in the shared deps contract ever mentioned it, nothing populated
   * it, and the route's `?? { status: "ok" }` defaults silently became the only
   * answer `vector` and `cache` ever gave. Putting it on the contract is what
   * makes "did anyone wire this?" a question the type system participates in.
   *
   * Still optional: partial test fixtures build ServerDeps by hand. But an
   * absent adapter now reports `unknown`, never `ok`.
   */
  healthAdapters?: {
    storage?: { healthCheck(): Promise<{ status: string; latencyMs?: number }> };
    vector?: { healthCheck(): Promise<{ status: string; latencyMs?: number }> };
    cache?: { healthCheck(): Promise<{ status: string; latencyMs?: number }> };
    embed?: { healthCheck(): Promise<{ status: string; latencyMs?: number }> };
    /** PG-TIMEOUTS / CHAOS-1: pool-stall watchdog verdict, read by `/health/live`. */
    poolStall?: {
      state(): { stalled: boolean; failingSinceMs: number | null; reason: string };
    };
  };
  /**
   * P4-C: optional LLM adapter that supports chat completions (generate()).
   * Used by POST /capture to extract facts from subagent output.
   * When absent the endpoint falls back to regex heuristics.
   * Wired from collapseLlmAdapter when MNEMO_LLM_PROVIDER is configured.
   */
  llmAdapter?: import("@mnemo-ai/types").LLMAdapter;
  /** MNEMO_SENSITIVE_TEXT_TO_PROVIDERS (SECURITY.md §7). Unset = "embed". */
  sensitiveTextToProviders?: import("@mnemo-ai/types").SensitiveTextPolicy;
  /**
   * P6: per-workspace LLM config resolver.
   * Resolves LLM provider + embed model using a 3-tier fallback:
   *   workspace DB row → global sentinel row → boot-time env provider.
   * Results are cached with a 60s TTL (configurable via MNEMO_LLM_CONFIG_TTL_SECONDS).
   * When absent, routes use deps.llm directly (legacy boot path).
   */
  llmConfigResolver?: import("./config/LlmConfigResolver.js").LlmConfigResolver;
  /**
   * P6: workspace config store for direct config table access.
   * Used by PUT/DELETE config routes to persist encrypted provider settings.
   * When absent, config routes return 501.
   */
  workspaceConfigStore?: import("./config/WorkspaceConfigStore.js").WorkspaceConfigStore;
  /**
   * P29: per-workspace retention window config resolver.
   * Resolves retention windows using a 3-tier fallback:
   *   workspace DB row → global sentinel row → boot-time env values.
   * Results are cached with a 60s TTL (configurable via MNEMO_RETENTION_CONFIG_TTL_SECONDS).
   * When absent, retention routes use env-var values directly (legacy boot path).
   */
  retentionConfigResolver?: import("./config/RetentionConfigResolver.js").RetentionConfigResolver;
}
