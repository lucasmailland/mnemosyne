// Internal CoreContext — the dependency bundle threaded through all domain functions.
// Never exported from the public API surface.

import type {
  StorageAdapter,
  CacheAdapter,
  VectorAdapter,
  EmbedAdapter,
  LLMAdapter,
  QueueAdapter,
  OutboxAdapter,
  Logger,
  Telemetry,
  AuthAdapter,
  SensitiveTextPolicy,
} from "@mnemo-ai/types";
import type { SessionBuffer } from "../session/session-buffer.js";
import type { EmbeddingNoiseConfig } from "../security/embedding-noise.js";
import type { CacheErrorReport } from "./cache-observability.js";

/**
 * One LLM call's token/cost usage, reported through the {@link CoreContext.onLlmUsage}
 * hook so a host (e.g. @mnemo-ai/server) can emit metrics WITHOUT core importing it.
 *
 * Hexagonal: this is a plain data shape + a plain injected function. Core never
 * imports the server's Prometheus layer; the host wires `onLlmUsage` to its own
 * `recordLlmUsage(...)`. `kind` discriminates which side of the call the tokens
 * came from — completions emit two reports (`prompt` for input, `completion` for
 * output); embeddings emit a single `embedding` report.
 *
 * `costUSD` is optional: the {@link LLMAdapter} port surfaces only token counts,
 * so completion-path callers leave it undefined and the host records zero cost
 * (model labelled "unknown") rather than fabricating a rate.
 */
export interface LlmUsageReport {
  /** Vendor identity ("openai", "anthropic", ...). Bounded-cardinality label. */
  provider: string;
  /** Model name. Bounded-cardinality label. */
  model: string;
  /** Which side of the call these tokens came from. */
  kind: "completion" | "prompt" | "embedding";
  /** Vendor-reported token count for this side (>= 0). */
  tokens: number;
  /** Vendor-estimated USD cost when known; undefined when unavailable. */
  costUSD?: number;
}

/**
 * Optional usage-reporting hook. A plain function injected by the host. MUST be
 * treated as fire-and-forget by callers (wrap in try/catch — a metrics failure
 * must never break the memory operation).
 */
export type OnLlmUsage = (usage: LlmUsageReport) => void;

/**
 * One hot-tier eviction event, reported through {@link CoreContext.onHotTierEvict}
 * so the host can drive Prometheus counters WITHOUT core importing the metrics
 * layer (hexagonal — same pattern as onLlmUsage). `evicted` is the number of
 * entries removed in this trim; `size` is the post-trim occupancy of the
 * workspace hot-tier ZSet.
 */
export interface HotTierEvictReport {
  workspaceId: string;
  evicted: number;
  size: number;
}

/**
 * Optional hot-tier eviction hook. Plain injected function — keeps core
 * hexagonal. Callers MUST invoke it fire-and-forget (never let it throw onto
 * the work path).
 */
export type OnHotTierEvict = (report: HotTierEvictReport) => void;

/**
 * Optional cache-failure reporting hook (P59, design.md §4). Plain injected
 * function — keeps core hexagonal, same contract as {@link OnHotTierEvict}.
 * Callers MUST invoke it fire-and-forget (never let it throw onto the work
 * path); see {@link reportCacheFailure} in `cache-observability.ts`, which
 * enforces this.
 */
export type OnCacheError = (report: CacheErrorReport) => void;

/**
 * One co-recall STDP measurement event, reported through
 * {@link CoreContext.onCoRecallTail} (p60-corecall-stdp-convergence, design.md
 * D3) so the host can drive Prometheus counters WITHOUT core importing the
 * metrics layer — same pattern as {@link OnHotTierEvict} / {@link OnCacheError}.
 *
 * Emitted once per `recordCoRecall` invocation that reaches the pair loop
 * (i.e. `candidateFacts >= 2`), BEFORE the pair loop runs, from
 * `co-recall.ts`. This is the measurement input for the deferred Option 3
 * cap-raise decision (proposal.md "Deferred, needs a decision"): whether the
 * facts beyond rank `capK` that never get an auto-created `related` link are
 * a negligible tail or a real, recoverable loss.
 */
export interface CoRecallTailReport {
  workspaceId: string;
  /** Distinct fact ids offered to co-recall for this recall event (before the cap). */
  candidateFacts: number;
  /** Cap applied (CO_RECALL_TOP_K). */
  capK: number;
  /** Pairs actually STDP'd: C(min(candidateFacts, capK), 2). */
  processedPairs: number;
  /** Pairs present in the candidate set but never processed because of the cap. */
  skippedPairs: number;
}

/**
 * Optional co-recall tail-measurement hook. Plain injected function — keeps
 * core hexagonal. Callers MUST invoke it fire-and-forget (never let it throw
 * onto the recall path).
 */
export type OnCoRecallTail = (report: CoRecallTailReport) => void;

export interface ResolvedConfig {
  maxHotTierSize: number;
  worthDecayLambda: number;
  surpriseThreshold: number;
  hotTierTtlSeconds: number;
  /** Wave X: recall-path injection detection threshold (0–1). Default 0.85. */
  injectionScoreThreshold: number;
  /** Wave X: write-time semantic anomaly detection threshold (0–1). Default 0.8. */
  anomalyScoreThreshold: number;
  /** §5 / SECURITY.md §10: optional ε-DP noise on stored embeddings. Default off. */
  embeddingNoise?: EmbeddingNoiseConfig;
  /**
   * auto-trigger-scoped-consolidation: global kill switch for the write-time
   * scoped semantic conflict check outbox append in remember.ts. Undefined
   * (unset) behaves as enabled — only an explicit `false` disables it.
   */
  scopedConflictCheckEnabled?: boolean;
  /**
   * WP-3 (RECALL-11 / AGENTSIM-14): when true, cold recall writes `related`
   * relations between co-recalled facts and forms Hebbian hyperedges from
   * them. Unset/false: off — retrieval alone does not create graph structure.
   */
  recallGraphLearning?: boolean;
  /**
   * WP-7: how long a fact write waits for the write-time conflict classifier
   * before deferring its candidates to the async scoped check. Undefined →
   * the default in remember.ts (8 s).
   */
  conflictClassificationTimeoutMs?: number;
  /**
   * WP-7: classify a fact write against its closest existing facts with the
   * LLM before the write (up to 3 short calls, bounded by
   * conflictClassificationTimeoutMs). Only an explicit `true` enables it.
   * Unset or false: no candidate lookup, no LLM call and nothing deferred —
   * `conflict` never appears at write time, and contradictions surface only
   * through the async scoped check over close neighbours.
   */
  writeConflictClassification?: boolean; /**
   * MNEMO_SENSITIVE_TEXT_TO_PROVIDERS (SECURITY.md §7): which external
   * providers may receive confidential+ plaintext. Unset = "embed".
   */
  sensitiveTextToProviders?: SensitiveTextPolicy;
}

export interface CoreContext {
  storage: StorageAdapter;
  vector: VectorAdapter;
  embed: EmbedAdapter;
  outbox: OutboxAdapter;
  logger: Logger;
  telemetry: Telemetry;
  // Optional — degrade gracefully when absent
  cache?: CacheAdapter;
  /**
   * §7/§9 L1 session buffer. When present, the collapse pipeline reads turns
   * through it (its getDurableTurns() is PG-backed, so correctness is identical
   * to ctx.storage.listTurns) and clears the session's Redis footprint after
   * a successful collapse. Absent → collapse reads turns straight from storage.
   */
  sessionBuffer?: SessionBuffer;
  llm?: LLMAdapter;
  queue?: QueueAdapter;
  auth?: AuthAdapter;
  /**
   * Optional hook to report LLM token/cost usage to the host for metrics.
   * Plain injected function — keeps core hexagonal (no server import). Callers
   * MUST invoke it fire-and-forget (never let it throw onto the work path).
   */
  onLlmUsage?: OnLlmUsage;
  /**
   * Optional hook to report hot-tier evictions to the host for metrics.
   * Plain injected function — keeps core hexagonal. Fire-and-forget.
   */
  onHotTierEvict?: OnHotTierEvict;
  /**
   * Optional hook to report L3/embedding cache-port failures to the host for
   * metrics (P59, design.md §4). Plain injected function — keeps core
   * hexagonal. Fire-and-forget.
   */
  onCacheError?: OnCacheError;
  /**
   * Optional hook to report co-recall STDP tail measurements to the host for
   * metrics (p60-corecall-stdp-convergence, design.md D3). Plain injected
   * function — keeps core hexagonal. Fire-and-forget.
   */
  onCoRecallTail?: OnCoRecallTail;
  config: ResolvedConfig;
}
