/**
 * Observability types — Wave AC §AC2
 *
 * CognitiveHealthSnapshot gives a high-level view of a workspace's
 * memory health across four key dimensions from spec §28–§34:
 *
 *   worthConvergenceRate    — fraction of facts whose worth has stabilised
 *                             (α/(α+β) within ε of previous evaluation).
 *   compositionUtilization  — ratio of active composition rules that fired
 *                             at least once in the last 7 days.
 *   knowledgeTypeBalance    — Shannon entropy over primitive type distribution
 *                             (fact/decision/episode/entity/…), in bits.
 *   proceduralEvolutionDelta — mean score-delta of the last activated prompt
 *                             version (avgScoreAfter − avgScoreBefore).
 *   unitEconomics.roiMultiplier — always null: no measured value of a recall
 *                             exists (APP-015). Kept for wire compatibility.
 *   unitEconomics.costUsdThisMonth — total LLM cost for the billing period.
 *   unitEconomics.recallCount — number of recall operations this billing period.
 *
 * All numeric fields are in [0,∞) unless noted; null means the metric
 * could not be computed (e.g. no facts in the workspace yet).
 */

export interface CognitiveHealthUnitEconomics {
  /** Always null: nothing measures a recall in dollars (APP-015). */
  roiMultiplier: number | null;
  /** Total LLM spend in USD for the current calendar month. */
  costUsdThisMonth: number;
  /** Number of recall operations executed this calendar month. */
  recallCount: number;
}

export interface CognitiveHealthSnapshot {
  /** Workspace this snapshot is scoped to. */
  workspaceId: string;
  /** ISO-8601 timestamp when the snapshot was computed. */
  computedAt: string;

  /**
   * Fraction [0,1] of active facts whose Beta-Bernoulli worth has
   * stabilised (|α/(α+β) − previous| < 0.01). null if no facts.
   */
  worthConvergenceRate: number | null;

  /**
   * Fraction [0,1] of active composition rules that fired at least
   * once in the last 7 days. 0 if no rules exist.
   */
  compositionUtilization: number | null;

  /**
   * Shannon entropy (bits) over the distribution of memory primitive
   * types in the workspace. Higher = more diverse memory portfolio.
   * null if workspace has no primitives.
   */
  knowledgeTypeBalance: number | null;

  /**
   * Score delta (avgScoreAfter − avgScoreBefore) of the most recently
   * activated prompt version for any agent in this workspace.
   * Positive = procedural improvement. null if no prompt versions exist.
   */
  proceduralEvolutionDelta: number | null;

  /** Unit economics for the current billing period. */
  unitEconomics: CognitiveHealthUnitEconomics;

  // ── B2.2: 7 additional fields (spec §AC2) ──────────────────────────────────

  /**
   * Fraction of sessions that were collapsed due to turn-limit/inactivity
   * (i.e. involuntary collapses / total sessions started).
   * null if no sessions have been started in-process.
   */
  sessionCollapseRate?: number | null;

  /**
   * Fraction of reasoning.resolve() calls served from the CoT distillation
   * cache (cache_hit / (cache_hit + execute)).
   * null if no reasoning.resolve calls recorded.
   */
  reasoningCacheHitRate?: number | null;

  /**
   * Mean Beta-Bernoulli worth (α/(α+β)) across active facts in the workspace.
   * null if the workspace has no active facts.
   */
  avgMemoryWorth?: number | null;

  /**
   * Fraction of recall operations served from the hot (Redis L1) tier
   * (hot / (hot + cold + unified + miss)).
   * null if no recall tier hits recorded.
   */
  hotTierHitRate?: number | null;

  /**
   * Per-workspace anticipation accuracy: fraction of pre-staged anticipated
   * memories subsequently recalled in the same session.
   * null if no session for this workspace has collapsed yet.
   */
  anticipationAccuracy?: number | null;

  /**
   * Fraction of consolidation jobs that were gated (skipped) rather than
   * merged (skipped / (merged + skipped + failed)).
   * null if no consolidation decisions recorded.
   */
  consolidationGateRate?: number | null;

  /**
   * Fraction of consolidation jobs that failed (failed / total).
   * Note: `failed` is a superset of `rolled_back` until the scheduler emits
   * a dedicated `rolled_back` outcome label.
   * null if no consolidation decisions recorded.
   * @remarks FIXME: failed is a superset of rolled_back
   */
  consolidationRollbackRate?: number | null;
}

// ── MNEMO_ERROR_CODES registry ──────────────────────────────────────────────
// Canonical error codes for all Mnemosyne v3 error conditions.
// Used by telemetry spans, structured logs, and error responses.

export const MNEMO_ERROR_CODES = {
  // Storage errors
  STORAGE_NOT_FOUND:        "mnemo.storage.not_found",
  STORAGE_CONFLICT:         "mnemo.storage.conflict",
  STORAGE_CONSTRAINT:       "mnemo.storage.constraint_violation",
  STORAGE_TIMEOUT:          "mnemo.storage.timeout",
  // Auth errors
  AUTH_MISSING_KEY:         "mnemo.auth.missing_key",
  AUTH_EXPIRED_KEY:         "mnemo.auth.expired_key",
  AUTH_INSUFFICIENT_SCOPE:  "mnemo.auth.insufficient_scope",
  AUTH_WORKSPACE_MISMATCH:  "mnemo.auth.workspace_mismatch",
  // Recall errors
  RECALL_BUDGET_EXCEEDED:   "mnemo.recall.budget_exceeded",
  RECALL_VECTOR_MISSING:    "mnemo.recall.vector_missing",
  RECALL_UPSTREAM_TIMEOUT:  "mnemo.recall.upstream_timeout",
  // Composition errors
  COMPOSE_DSL_INVALID:      "mnemo.compose.dsl_invalid",
  COMPOSE_MAX_FIRINGS:      "mnemo.compose.max_firings_reached",
  COMPOSE_MATERIALISE_FAIL: "mnemo.compose.materialise_failed",
  // Self-edit errors
  SELF_EDIT_BUDGET:         "mnemo.self_edit.budget_exceeded",
  SELF_EDIT_COOLDOWN:       "mnemo.self_edit.cooldown_active",
  SELF_EDIT_SCOPE:          "mnemo.self_edit.scope_denied",
  SELF_EDIT_ABUSE_FLAG:     "mnemo.self_edit.abuse_flagged",
  SELF_EDIT_WORTH_FROZEN:   "mnemo.self_edit.worth_frozen",
  // Federation errors
  FED_SIGNATURE_INVALID:    "mnemo.federation.signature_invalid",
  FED_VERSION_SKEW:         "mnemo.federation.version_skew",
  FED_QUORUM_UNREACHABLE:   "mnemo.federation.quorum_unreachable",
  // Procedural errors
  PROC_BUDGET_BELOW_GATE:   "mnemo.procedural.budget_below_gate",
  PROC_NO_TRAJECTORIES:     "mnemo.procedural.no_trajectories",
  // General
  RATE_LIMIT:               "mnemo.rate_limit",
  VALIDATION:               "mnemo.validation",
  INTERNAL:                 "mnemo.internal",
} as const;

export type MnemoErrorCode = typeof MNEMO_ERROR_CODES[keyof typeof MNEMO_ERROR_CODES];

// ── MnemoSpanAttributes ───────────────────────────────────────────────────────
// Standard attribute names for OpenTelemetry spans emitted by Mnemosyne.

export interface MnemoSpanAttributes {
  /** Workspace the operation is scoped to. */
  "mnemo.workspace_id"?: string;
  /** Agent (actor) the operation was performed on behalf of. */
  "mnemo.agent_id"?: string;
  /** Session the operation belongs to, when one is active. */
  "mnemo.session_id"?: string;
  /** W3C trace id, propagated across service boundaries. */
  "mnemo.trace_id"?: string;
  /** Primitive kind being operated on (fact/episode/entity/…). */
  "mnemo.kind"?: string;
  /** Operation being performed. */
  "mnemo.operation"?: string;
  /** Surprise/PE score for remember() calls. */
  "mnemo.pe"?: number;
  /** Whether the result was served from hot-tier cache. */
  "mnemo.from_hot_tier"?: boolean;
  /** Which tier served the result: "hot" | "pointer" | "cold" | "l3_cache" | "none". */
  "mnemo.tier_hit"?: string;
  /** True when the result was served from a cache layer (L3 query cache). */
  "mnemo.cache_hit"?: boolean;
  /** Number of hits returned by recall. */
  "mnemo.hit_count"?: number;
  /** Number of results returned (spec alias of hit_count for recall). */
  "mnemo.result_count"?: number;
  /** Mean worth (α/(α+β) or score fallback) across returned hits. */
  "mnemo.worth_avg"?: number;
  /** LLM tokens saved by serving this operation without a model call. */
  "mnemo.tokens_saved"?: number;
  /** LLM tokens consumed by this operation. */
  "mnemo.llm_tokens_used"?: number;
  /** LLM cost in USD attributed to this operation. */
  "mnemo.llm_cost_usd"?: number;
  /** Latency in milliseconds. */
  "mnemo.latency_ms"?: number;
  /** Error code from MNEMO_ERROR_CODES. */
  "mnemo.error_code"?: MnemoErrorCode;
  /** Rule ID that triggered a composition inference. */
  "mnemo.rule_id"?: string;
  /** Number of composition rule firings in a call. */
  "mnemo.firings"?: number;
  /** Self-edit action applied. */
  "mnemo.self_edit.action"?: string;
  /** Idempotency key for mutating operations. */
  "mnemo.idempotency_key"?: string;
  /** Reason the session was collapsed (e.g. "turn_limit", "inactivity", "manual"). */
  "mnemo.collapse.reason"?: string;
  /** Number of turns processed in the collapsed session. */
  "mnemo.collapse.turns"?: number;
  /** Outcome of a reasoning resolve operation. */
  "mnemo.reasoning.result"?: "cache_hit" | "execute";
  /** Federation peer ID for sync operations. */
  "mnemo.federation.peer"?: string;
  /** Plugin name/ID for spans that trace a single named plugin's execution. */
  "mnemo.plugin.name"?: string;
  /** Event hook name for spans that dispatch a hook to all active plugins. */
  "mnemo.plugin.hook"?: string;
}

/**
 * Canonical span names emitted by Mnemosyne.
 * Import and use these constants at span-creation sites so dashboards
 * can correlate spans by name without string-matching fragility.
 *
 * `write` is the spec's name (Observability §, line 1718) for the persist
 * span; it is an ALIAS of the live `mnemo.remember` span name (see WP13
 * RECONCILE note). Use MNEMO_SPAN_NAMES.write when referring to the spec
 * concept; the emitted span string remains "mnemo.remember".
 */
export const MNEMO_SPAN_NAMES = {
  recall: "mnemo.recall",
  remember: "mnemo.remember",
  /** Spec alias of `remember` (spec calls this span "mnemo.write"). */
  write: "mnemo.remember",
  sessionCollapse: "mnemo.session.collapse",
  reasoningResolve: "mnemo.reasoning.resolve",
  federationSync: "mnemo.federation.sync",
  /** Auth middleware span — wraps the bearer-token resolution path. */
  auth: "mnemo.auth",
  /** Embedding span — wraps embedSingle / embed batch calls. */
  embed: "mnemo.embed",
  /** Re-ranking span — wraps RecMem rerank on the cold path. */
  rerank: "mnemo.rerank",
  /** Composition span — wraps composeInferences on the cold path. */
  composition: "mnemo.composition",
  /** Render span — wraps renderFactsCompact at the call site. */
  render: "mnemo.render",
  plugin: (name: string) => `mnemo.plugin.${name}`,
} as const;
