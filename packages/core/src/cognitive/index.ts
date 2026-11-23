// @mnemo-ai/core v3 public entry point.
// Zero infrastructure imports — all I/O flows through injected ports.
// Cardinal rule: this file (and all src/v3/*.ts) MUST NOT import from
//   drizzle-orm, pg, redis, @neondatabase, or any infrastructure package.

import { createHash } from "node:crypto";
import { isActiveOpenFact } from "./fact-lifecycle.js";

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
  AuthContext,
  RememberRequest,
  RememberResponse,
  RecallQuery,
  RecallResponse,
  RecallHit,
  PrimitiveKind,
  WorthDelta,
  Span,
  SensitiveTextPolicy,
} from "@mnemo-ai/types";
import { MNEMO_SPAN_NAMES } from "@mnemo-ai/types";

import type {
  CoreContext,
  LlmUsageReport,
  OnLlmUsage,
  OnHotTierEvict,
  HotTierEvictReport,
  OnCacheError,
  OnCoRecallTail,
  CoRecallTailReport,
} from "./context.js";
import type { EmbeddingNoiseConfig } from "../security/embedding-noise.js";
import { reportCacheFailure } from "./cache-observability.js";
import { remember } from "./remember.js";
import { finalizeRecallObservation } from "./recall-observation.js";
import { appliesOrganicEffects } from "./recall-effects.js";
import { resolveProjectScopeRef, withProjectScope } from "./project-scope.js";
import {
  recallCold,
  buildResponse,
  sensitivityAllowed,
  stampHitStatus,
  startTrace,
  attachTrace,
} from "./recall-cold.js";
import { cosineSimilarity, defaultRelevanceFloor, isNothingRelevant } from "./recall-relevance.js";
import { recallHot, tryHotTier } from "./recall-hot.js";
import { withFederatedHits } from "./recall-federated.js";
import { tryPointerTier, applyTokenBudget } from "./recall-pointer.js";
import {
  isUntestedWorth,
  passesWorthGate,
  updateWorth,
  wilsonLowerBound,
  wilsonUpperBound,
} from "./worth.js";
import { forget } from "./forget.js";
import { updateRelationStrength } from "./relations.js";
import {
  classifyGovernance,
  propagateGovernanceForSession,
  GOVERNANCE_MAX_HOPS,
} from "./governance.js";
import { hotTierKey } from "./recall-hot.js";
import { matchesRecallFilter } from "./recall-filter.js";
import {
  prepareManagedCollapse as runPrepareManagedCollapse,
  type PrepareManagedCollapseInput,
} from "../session/managed-collapse.js";
import type { ManagedCollapsePlan } from "@mnemo-ai/types";

import {
  collapseSession as runCollapseSessionPipeline,
  type CollapseInput,
  type CollapseResult,
  type CollapsePolicy,
  type CollapseReason,
} from "../session/collapse.js";

// ─── Public types ─────────────────────────────────────────────────────────────

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
  /**
   * Optional usage-reporting hook. The host (e.g. @mnemo-ai/server) wires this
   * to its metrics layer (`recordLlmUsage`). Plain injected function — core never
   * imports the server. Invoked fire-and-forget after each metered LLM call.
   */
  onLlmUsage?: OnLlmUsage;
  /**
   * Optional hot-tier eviction hook. The host wires this to its metrics layer
   * (hotTierEvictions counter + hotTierSize gauge). Plain injected function —
   * core never imports the server. Invoked fire-and-forget on each eviction.
   */
  onHotTierEvict?: OnHotTierEvict;
  /**
   * Optional cache-failure reporting hook (P59, design.md §4). The host wires
   * this to its metrics layer (mnemo_cache_errors_total{cache,op}). Plain
   * injected function — core never imports the server. Invoked
   * fire-and-forget on every L3/embedding cache-port failure.
   */
  onCacheError?: OnCacheError;
  /**
   * Optional co-recall tail-measurement hook (p60-corecall-stdp-convergence,
   * design.md D3). The host wires this to its metrics layer (4 counters —
   * events / events_over_cap / pairs_processed / pairs_skipped). Plain
   * injected function — core never imports the server. Invoked
   * fire-and-forget once per `recordCoRecall` invocation that reaches the
   * pair loop.
   */
  onCoRecallTail?: OnCoRecallTail;
}

export interface CoreConfig {
  maxHotTierSize?: number; // ACT-R sorted-set cap, default 1000
  worthDecayLambda?: number; // TD(λ) decay factor, default 0.85
  surpriseThreshold?: number; // Prediction-error gate, default 0.15
  hotTierTtlSeconds?: number; // Redis ACT-R key TTL, default 86400
  injectionScoreThreshold?: number; // Wave X: noisy-OR injection detection, default 0.85
  anomalyScoreThreshold?: number; // Wave X: semantic anomaly detection, default 0.8
  /** §5 / SECURITY.md §10: optional ε-DP noise on embeddings. Default off (noise degrades recall). */
  embeddingNoise?: EmbeddingNoiseConfig;
  /**
   * auto-trigger-scoped-consolidation: global kill switch for the write-time
   * scoped semantic conflict check outbox append. Default true (enabled) when unset.
   */
  scopedConflictCheckEnabled?: boolean;
  /**
   * WP-3 (RECALL-11 / AGENTSIM-14): learn graph structure from retrieval —
   * `related` relations between co-recalled facts and Hebbian hyperedges.
   * Default false: being served together is not evidence of belonging together.
   */
  recallGraphLearning?: boolean;
  /**
   * WP-7: classify each fact write against its closest facts with the LLM
   * before writing (up to 3 calls per write). Default false: the cost is
   * opt-in, and contradictions surface through the async scoped check.
   */
  writeConflictClassification?: boolean; /**
   * MNEMO_SENSITIVE_TEXT_TO_PROVIDERS (SECURITY.md §7): which external
   * providers may receive confidential+ plaintext. Unset = "embed".
   */
  sensitiveTextToProviders?: SensitiveTextPolicy;
}

/**
 * Args for {@link MnemoCore.collapseSession} — mirrors the legacy `CoreLike.collapseSession`
 * call shape (flatten-legacy-dual-core PR16, design.md) so the route port is a pure
 * swap-the-call. `collapseHint`/`llmOverride` are additive over the old `CoreLike`
 * interface's DECLARED shape (both were already being passed at the `session.ts`
 * call site through an object-literal spread, which suppresses TS excess-property
 * checking — this interface now declares them honestly instead of relying on that).
 */
export interface CollapseSessionArgs {
  sessionId: string;
  workspaceId: string;
  strategy?: "auto" | "explicit";
  reason?: CollapseReason;
  collapseHint?: string;
  /** C6: per-agent collapse policy — forwarded into CollapseInput so thresholds are honoured. */
  policy?: CollapsePolicy;
  /** P6: per-workspace LLM override, resolved by the host from dynamic config. */
  llmOverride?: LLMAdapter;
}

export interface CollapseSessionOutcome {
  turnsProcessed?: number;
  anticipationAccuracy?: number | null;
  /**
   * P115: the pipeline's own verdict, propagated instead of swallowed.
   *
   * This facade used to return only the two fields above, so a collapse that
   * was DISCARDED by a threshold gate was indistinguishable from one that
   * extracted knowledge. The route consumed that ambiguity faithfully and
   * answered `202 {accepted:true}` with a `outcome:"success"` metric for both.
   * A caller could not tell that its session had been thrown away.
   */
  status?: CollapseResult["status"];
  /** Why a non-`completed` status happened, e.g. `low_recurrence_signal`. */
  skipReason?: CollapseResult["skipReason"];
}

export interface RecallCallOptions {
  observation?: Partial<Parameters<typeof finalizeRecallObservation>[1]["context"]>;
  /** Skip the observation AND reinforcement effects (caller owns both). */
  deferEffects?: boolean;
  /**
   * Skip only the observation: the caller (e.g. the HTTP route after
   * multi-level merging) records the single observation itself, while
   * reinforcement and composition still run here as before.
   */
  deferObservation?: boolean;
  /**
   * Receives the measured serving metadata (actual tier, L3 cache hit, phase
   * timings) on success AND error, so a caller that defers the observation
   * records real values instead of reconstructing them.
   */
  onRecallMeta?: (served: RecallServeMeta) => void;
}
export interface RecallServeMeta {
  tiers: string[];
  cacheHit: boolean;
  phaseDurationsMs: Record<string, number>;
}
type RecallRun = { runEffects: boolean; tiers: string[]; phases: Record<string, number> };
export interface MnemoCore {
  /**
   * `llmOverride`: the workspace's own completion adapter (WP-1 resolver), used
   * for the write-time conflict classification instead of the boot adapter.
   */
  remember(
    req: RememberRequest,
    auth: AuthContext,
    opts?: { llmOverride?: LLMAdapter }
  ): Promise<RememberResponse>;
  recall(query: RecallQuery, auth: AuthContext, opts?: RecallCallOptions): Promise<RecallResponse>;
  recallHot(workspaceId: string, auth: AuthContext, limit?: number): Promise<RecallHit[]>;
  forget(
    id: string,
    kind: PrimitiveKind,
    mode: "soft" | "hard",
    auth: AuthContext,
    reason?: string
  ): Promise<void>;
  updateWorth(id: string, kind: PrimitiveKind, delta: WorthDelta, auth: AuthContext): Promise<void>;
  updateRelationStrength(relationId: string, reinforced: boolean, auth: AuthContext): Promise<void>;
  /**
   * Collapse a session into durable knowledge (facts/decisions/strategies).
   * Exposes the real 8-step v3 extraction pipeline (`session/collapse.ts`,
   * COGNITIVE_ALGORITHMS.md §2.2) through the public facade — flatten-legacy-dual-core
   * PR16. Throws with `.code === "NOT_FOUND"` when the session does not exist, and
   * `.code === "LLM_UNAVAILABLE"` when the LLM adapter failed mid-collapse (session
   * is preserved, not closed, so a retry can resume it) — same error-code contract
   * the legacy `CoreLike.collapseSession` exposed, so route-layer error handling
   * (`session.ts`) needs zero changes.
   */
  collapseSession(args: CollapseSessionArgs, auth: AuthContext): Promise<CollapseSessionOutcome>;

  /**
   * Managed-session counterpart of {@link MnemoCore.collapseSession}: decides and
   * builds the collapse plan, writing nothing.
   *
   * Exposed on the facade so a caller never has to assemble a `CoreContext` of its
   * own — the server has the adapters but not core's config defaults, and a
   * hand-built context would drift from the one every other core call uses.
   * The commit half is a storage-port call, deliberately not part of core.
   */
  prepareManagedCollapse(
    input: PrepareManagedCollapseInput,
    auth: AuthContext
  ): Promise<ManagedCollapsePlan>;
  /**
   * §11 governance.propagate: after a rated collapse, walk the provenance DAG
   * for facts recalled in the session (≤{@link GOVERNANCE_MAX_HOPS} hops) and
   * apply lambda^depth-decayed worth credit to each predecessor. No-ops
   * silently when the session has no recall log entries.
   *
   * flatten-legacy-dual-core Phase 7: exposes the pure `governance.ts`
   * function (already used internally) through the public facade so the host
   * (`@mnemo-ai/server`'s session-sweep drain loop) no longer needs the
   * legacy `CoreLike.propagateGovernanceForSession` — same fixed credit
   * shape (`{success:1, failure:0, creditWeight:1}`) and `worthDecayLambda`
   * the legacy `factory.ts` implementation used.
   */
  propagateGovernanceForSession(workspaceId: string, sessionId: string): Promise<void>;
}

// ─── §9 L3 cache — embedding LRU + cosine≥0.95 query cache ───────────────────

const L3_COSINE = 0.95; // spec line 777 — only near-identical queries reuse results
// P59 (docs/archive/openspec/p59-query-cache-l3-fix, design.md D5): replaces the fictional
// 24h expires_at TTL — the real table has no expiry column, only
// last_used_at. Only replaceFact busts the cache, so this window IS the
// staleness bound; 5 minutes covers the real hit case (a burst of
// near-identical queries inside one agent turn) at negligible omission cost.
const L3_MAX_AGE_MS = 300_000;

/**
 * Hydrate a cached hit list into a full RecallResponse.
 * Fetches each fact by id and preserves order. Any invalid member makes the
 * whole entry a miss so cache hydration can never return a partial result set.
 */
async function hydrateCachedHits(
  ctx: CoreContext,
  query: RecallQuery,
  auth: AuthContext,
  cached: { resultIds: string[]; resultKinds: string[] },
  startMs: number
): Promise<RecallResponse | null> {
  if (cached.resultIds.length !== cached.resultKinds.length) return null;
  const hits: RecallHit[] = [];
  for (let i = 0; i < cached.resultIds.length; i++) {
    const id = cached.resultIds[i]!;
    if (cached.resultKinds[i] !== "fact") return null;
    try {
      const fact = await ctx.storage.getFact(id, query.workspaceId);
      if (!fact || !isActiveOpenFact(fact)) return null;
      if (!matchesRecallFilter(fact, query.filter)) return null;
      if (!sensitivityAllowed(fact.sensitivity, auth)) return null;
      const worthLowerBound = wilsonLowerBound(fact.worthAlpha ?? 2, fact.worthBeta ?? 2);
      const isUntested = isUntestedWorth(fact);
      if (
        !query.includeLowWorth &&
        !passesWorthGate(
          {
            primitive: "fact",
            worth: fact.worth,
            worthLowerBound,
          },
          isUntested
        )
      )
        return null;
      const metadataTags = fact.metadata?.tags;
      // WP-3 review: the cache stores ids, not evidence. Re-measure each
      // hit's cosine from its stored vector, so the hit carries `similarity`
      // and the "nothing relevant" verdict can be judged again below.
      const similarity =
        query.embedding && fact.embedding && fact.embedding.length === query.embedding.length
          ? cosineSimilarity(query.embedding, fact.embedding)
          : undefined;
      // Build a lightweight RecallHit from the cached fact
      hits.push({
        id: fact.id,
        primitive: "fact" as PrimitiveKind,
        content: fact.statement,
        score: fact.worth ?? 0.5,
        ...(similarity !== undefined ? { similarity } : {}),
        sensitivity: fact.sensitivity as RecallHit["sensitivity"],
        injectionScore: 0,
        provenance: (fact.attribution ?? "inferred") as RecallHit["provenance"],
        origin: "local",
        contested: false,
        validFrom: fact.validFrom ?? new Date(fact.createdAt),
        validTo: fact.validTo ?? null,
        tags: Array.isArray(metadataTags)
          ? metadataTags.filter((tag): tag is string => typeof tag === "string")
          : [],
        relations: [],
        worth: fact.worth,
        worthLowerBound,
        scope: fact.scope,
        ...(fact.scopeRef ? { scopeRef: fact.scopeRef } : {}),
        ...(fact.scopeOwner ? { scopeOwner: fact.scopeOwner } : {}),
        ...(fact.topicKey ? { topicKey: fact.topicKey } : {}),
        ...(fact.subject ? { subject: fact.subject } : {}),
        actorId: fact.actorId ?? null,
        userId: fact.userId ?? null,
        ...(fact.actorType ? { actorType: fact.actorType } : {}),
      });
    } catch {
      return null;
    }
  }
  await stampHitStatus(ctx, query.workspaceId, hits, auth);
  // Only results with something relevant are cached (see the write-back), so
  // a hit is relevant unless every cosine could be re-measured and none
  // clears the floor for this query.
  const floor = query.relevanceFloor ?? defaultRelevanceFloor(ctx.embed.model);
  const nothingRelevant = hits.every((hit) => hit.similarity !== undefined)
    ? isNothingRelevant(
        hits.map((hit) => hit.similarity),
        floor,
        hits.length
      )
    : false;
  return buildResponse(
    hits,
    query.text,
    query.limit ?? 10,
    query.offset ?? 0,
    startMs,
    false,
    [],
    undefined,
    undefined,
    nothingRelevant
  );
}

/**
 * L3 result entries are reusable only for the default, unfiltered retrieval
 * contract. Embedding read-through is intentionally independent of this gate.
 */
export function canUseL3ResultCache(query: RecallQuery, auth: AuthContext): boolean {
  return (
    query.filter === undefined &&
    sensitivityAllowed("restricted", auth) &&
    query.includeArchived !== true &&
    query.includeLowWorth !== true &&
    (query.offset ?? 0) === 0 &&
    (query.limit ?? 10) === 10 &&
    query.materialiseInferences !== true &&
    query.conversationId === undefined &&
    query.tokenBudget === undefined &&
    query.rerank !== true &&
    query.recurrenceThreshold === undefined &&
    query.hyde !== true &&
    query.hybridFts !== true &&
    query.minSimilarity === undefined &&
    query.embeddingMigrationActive !== true &&
    query.asOf === undefined
  );
}

/**
 * §9 L3 cache wrap around the 3-tier recall orchestrator.
 *
 * 1. Embedding LRU read-through — avoids re-embedding identical text (spec line 778)
 * 2. cosine≥0.95 L3 short-circuit — skips full cascade for near-identical queries
 * 3. Hot → Pointer → Cold cascade (unchanged)
 * 4. Write back hits to L3 with 24h TTL
 *
 * All `?.` calls degrade gracefully when the adapter lacks the method (e.g.
 * InMemoryStorageAdapter without optional methods, or no storage at all).
 */
/**
 * Compute the spec MnemoSpanAttributes derivable from a recall result and set
 * them on the recall span. Called on every return path so the span carries
 * result_count/worth_avg/tier_hit/cache_hit regardless of which tier served.
 *
 * tokens_saved + llm_cost_usd are 0 on the recall path: recall performs no LLM
 * completion, and the embedding-call cost is reported separately through
 * ctx.onLlmUsage → the host's Prometheus layer (it is NOT a span concern). They
 * are still set (to 0) so dashboards see the attribute keys consistently.
 */
function setSpanResultAttrs(
  span: Span,
  resp: RecallResponse,
  tierHit: string,
  cacheHit: boolean
): void {
  const worthSum = resp.hits.reduce((acc, h) => acc + (h.worth ?? h.score ?? 0), 0);
  const worthAvg = resp.hits.length > 0 ? worthSum / resp.hits.length : 0;
  span.setAttribute("mnemo.result_count", resp.hits.length);
  span.setAttribute("mnemo.worth_avg", worthAvg);
  span.setAttribute("mnemo.tier_hit", tierHit);
  span.setAttribute("mnemo.cache_hit", cacheHit);
  span.setAttribute("mnemo.tokens_saved", 0);
  span.setAttribute("mnemo.llm_cost_usd", 0);
  span.setAttribute("mnemo.llm_tokens_used", 0);
}

/**
 * Upper bound on how long a completed recall waits for its observation write.
 * The write keeps running in the background past it (it never throws), but an
 * unavailable observation store cannot stall direct core, gRPC or plugin callers.
 */
export const RECALL_OBSERVATION_BUDGET_MS = 250;
function boundedObservation(write: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RECALL_OBSERVATION_BUDGET_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([write.catch(() => undefined), budget]).finally(() => clearTimeout(timer));
}

async function recallWithCaches(
  ctx: CoreContext,
  query: RecallQuery,
  auth: AuthContext,
  opts: RecallCallOptions = {}
): Promise<RecallResponse> {
  // A query the server classified as non-organic (installer verification,
  // evaluation) is synthetic here too: it retrieves but trains nothing, and its
  // observation says so instead of counting as organic use.
  const origin = appliesOrganicEffects(query)
    ? (opts.observation?.trafficOrigin ?? "unknown")
    : "synthetic";
  // A point-in-time read (asOf) is not use either: no worth, activation or
  // hot-tier effects.
  const runEffects =
    !opts.deferEffects && origin !== "synthetic" && origin !== "test" && query.asOf === undefined;
  const run: RecallRun = { runEffects, tiers: [], phases: {} };
  // Measured around the whole cascade (embedding, L3, every tier), so the
  // observation's total covers what the caller actually waited for.
  const startedAt = Date.now();
  const done = (response?: RecallResponse, error?: unknown) =>
    opts.deferEffects ||
    opts.deferObservation ||
    boundedObservation(
      finalizeRecallObservation(ctx, {
        context: {
          requestId: globalThis.crypto.randomUUID(),
          clientVersion: "unknown",
          pluginVersion: "unknown",
          serverVersion: "unknown",
          ...opts.observation,
          trafficOrigin: origin,
        },
        query,
        auth,
        response,
        error,
        tiers: run.tiers,
        cacheHit: run.tiers[0] === "l3_cache",
        totalDurationMs: Date.now() - startedAt,
        phaseDurationsMs: run.phases,
      })
    );
  const served = () => {
    try {
      opts.onRecallMeta?.({
        tiers: [...run.tiers],
        cacheHit: run.tiers[0] === "l3_cache",
        phaseDurationsMs: { ...run.phases },
      });
    } catch {} // a caller's metadata sink never fails recall
  };
  const resp = await recallTiers(ctx, query, auth, run).catch(async (err) => {
    served();
    await done(undefined, err);
    throw err;
  });
  served();
  await done(resp);
  return resp;
}
async function recallTiers(
  ctx: CoreContext,
  query: RecallQuery,
  auth: AuthContext,
  run: RecallRun
): Promise<RecallResponse> {
  const startMs = Date.now();
  const setRecallResultAttrs: typeof setSpanResultAttrs = (span, resp, tier, cacheHit) => {
    run.tiers = tier === "none" ? [] : [tier];
    setSpanResultAttrs(span, resp, tier, cacheHit);
  };
  // Opt-in (`query.debug`): stages this orchestrator ran; the answering tier adds its own.
  const [preTrace, traceStage] = startTrace(query.debug, auth);
  const finish = (resp: RecallResponse, tier: string): RecallResponse =>
    preTrace ? attachTrace(resp, preTrace, tier) : resp;

  const recallSpan: Span = ctx.telemetry.startSpan("mnemo.recall", {
    attributes: {
      "mnemo.workspace_id": query.workspaceId,
      "mnemo.operation": "recall",
    },
  });

  try {
    // ── CALMem token budget gate ────────────────────────────────────────────────
    const plan = applyTokenBudget(query.tokenBudget, query.limit ?? 10);
    if (plan.skip) {
      const skipped: RecallResponse = {
        hits: [],
        total: 0,
        query: { text: query.text, limit: 0, offset: query.offset ?? 0 },
        latencyMs: 0,
        fromHotTier: false,
      };
      setRecallResultAttrs(recallSpan, skipped, "none", false);
      return skipped;
    }
    const tieredQuery = { ...query, limit: plan.limit };

    // ── FTS-only short-circuit: no embed provider and no precomputed vector ──────
    // When the embed adapter is the no-op stub (model="none") and the caller
    // did not supply a precomputed embedding, skip the entire vector pipeline and
    // delegate directly to recallCold, which contains the ftsFallbackRecall path.
    // Without this gate, the embedSingle() call below throws NotImplementedError,
    // which surfaces as a 501 to the caller instead of a graceful FTS response.
    if (!tieredQuery.embedding && ctx.embed.model === "none") {
      const ftsColdResp = await recallCold(ctx, tieredQuery, auth, recallSpan, run.runEffects);
      setRecallResultAttrs(recallSpan, ftsColdResp, "fts", false);
      return ftsColdResp;
    }

    // ── Embedding LRU read-through ──────────────────────────────────────────────
    let embedding = tieredQuery.embedding;
    let textHash: string | undefined;
    if (!embedding) {
      textHash = createHash("sha256").update(tieredQuery.text.trim().toLowerCase()).digest("hex");
      const cached = await ctx.storage
        .getCachedEmbedding?.(tieredQuery.workspaceId, textHash, ctx.embed.model)
        .catch((err: unknown) => {
          reportCacheFailure(ctx, "embedding_lru", "get", err);
          return null;
        });
      if (cached) {
        embedding = cached;
      } else {
        const embedSpan = ctx.telemetry.startSpan(MNEMO_SPAN_NAMES.embed, { parent: recallSpan });
        const embedStart = Date.now();
        try {
          embedding = await ctx.embed.embedSingle(tieredQuery.text);
        } catch (err) {
          // P128 — the provider is configured but did not answer.
          //
          // The short-circuit above catches `model === "none"`, i.e. an
          // embedder configured as ABSENT. This is the other case, and the one
          // that actually happens: configured, and unreachable. Without this,
          // the throw escaped as a 500 before recallCold — which knows how to
          // fall back to full-text — was ever reached.
          //
          // Delegated rather than handled here on purpose: recallCold owns the
          // lexical path, including rethrowing for strict `semantic` mode, so
          // there is exactly one place that decides what degrading means. Two
          // copies of a fallback drift, and the drift is invisible because both
          // keep returning results.
          ctx.logger.warn("recall.embed_failed_delegating_to_cold", {
            workspaceId: tieredQuery.workspaceId,
            model: ctx.embed.model,
            error: {
              type: err instanceof Error ? err.name : "Error",
              message: err instanceof Error ? err.message : String(err),
            },
          });
          // `embedderUnavailable` so recallCold takes its lexical path WITHOUT
          // calling the dead provider again: the first failure already cost
          // real time, and paying it twice pushed the request past the 5s
          // circuit breaker — a working fallback that still answered 500.
          const degradedResp = await recallCold(
            ctx,
            { ...tieredQuery, embedderUnavailable: true },
            auth,
            recallSpan,
            run.runEffects
          );
          setRecallResultAttrs(recallSpan, degradedResp, "fts", false);
          return degradedResp;
        } finally {
          run.phases.embedding = Date.now() - embedStart;
          embedSpan.end();
        }
        if (textHash) {
          await ctx.storage
            .putCachedEmbedding?.({
              workspaceId: tieredQuery.workspaceId,
              textHash,
              embedding,
              model: ctx.embed.model,
            })
            .catch((err: unknown) => {
              reportCacheFailure(ctx, "embedding_lru", "put", err);
              return undefined;
            });
        }
      }
    }
    if (!tieredQuery.embedding) traceStage("embed", 1);
    const embeddedQuery = { ...tieredQuery, embedding };
    const useL3Results = canUseL3ResultCache(query, auth);
    // D8: topK is matched exactly against the stored entry — canUseL3ResultCache
    // already requires (query.limit ?? 10) === 10, but the requested count is
    // passed explicitly rather than hardcoded so a future gate relaxation
    // can't silently desync the cache key from the request shape.
    const l3TopK = query.limit ?? 10;

    // ── L3 cosine≥0.95 short-circuit ───────────────────────────────────────────
    const l3 = useL3Results
      ? await ctx.storage
          .lookupQueryCache?.({
            workspaceId: embeddedQuery.workspaceId,
            embedding,
            threshold: L3_COSINE,
            topK: l3TopK,
            maxAgeMs: L3_MAX_AGE_MS,
          })
          .catch((err: unknown) => {
            reportCacheFailure(ctx, "l3_query", "lookup", err);
            return null;
          })
      : null;

    if (useL3Results) traceStage("cache", 1, l3?.resultIds.length ?? 0);

    if (l3 && l3.resultIds.length > 0) {
      // Serve from cache — no vector.search call needed
      const hydrated = await hydrateCachedHits(ctx, embeddedQuery, auth, l3, startMs);
      if (hydrated && hydrated.hits.length > 0) {
        setRecallResultAttrs(recallSpan, hydrated, "l3_cache", true);
        return finish(hydrated, "l3_cache");
      }
    }

    // ── Hot → Pointer → Cold cascade ───────────────────────────────────────────
    // The hot and pointer tiers hold what is live now; a point-in-time recall
    // (`asOf`) can only be answered by the cold tier, which applies the
    // validity interval to every candidate.
    const pastRead = query.asOf !== undefined;
    let resp: RecallResponse | null = null;
    let tierHit = "none";
    if (plan.tryHot && query.minSimilarity === undefined && !pastRead) {
      // CHAOS-4: the hot tier is a cache. With Redis down its read failed the
      // whole recall; now it counts as a miss and the cascade continues.
      resp = await tryHotTier(ctx, embeddedQuery, auth, recallSpan, run.runEffects).catch(
        (err: unknown) => {
          reportCacheFailure(ctx, "hot_tier", "lookup", err);
          return null;
        }
      );
      if (resp) tierHit = "hot";
      traceStage("hot_tier", resp?.hits.length ?? 0);
    }
    if (!resp && plan.tryPointer && query.minSimilarity === undefined && !pastRead) {
      resp = await tryPointerTier(ctx, embeddedQuery, auth, recallSpan, run.runEffects);
      if (resp) tierHit = "pointer";
      traceStage("pointer_tier", resp?.hits.length ?? 0);
    }
    if (!resp && (plan.tryCold || query.minSimilarity !== undefined || pastRead)) {
      resp = await recallCold(ctx, embeddedQuery, auth, recallSpan, run.runEffects);
      if (resp) tierHit = "cold";
    }
    if (!resp) {
      const empty: RecallResponse = {
        hits: [],
        total: 0,
        query: { text: tieredQuery.text, limit: plan.limit, offset: tieredQuery.offset ?? 0 },
        latencyMs: Date.now() - startMs,
        fromHotTier: false,
      };
      setRecallResultAttrs(recallSpan, empty, "none", false);
      return empty;
    }

    // ── L3 write-back (insert-only, no eviction — design.md D1/D6) ──────────────
    // WP-3 review: a result recall judged "nothing relevant" is not cached.
    // The cache keeps ids only, so a cached copy would come back as a plain
    // non-empty answer and flip the verdict on the next identical question.
    if (
      useL3Results &&
      resp.hits.length > 0 &&
      resp.nothingRelevant !== true &&
      resp.hits.every((hit) => hit.primitive === "fact")
    ) {
      await ctx.storage
        .insertQueryCache?.({
          workspaceId: embeddedQuery.workspaceId,
          embedding,
          resultIds: resp.hits.map((h) => h.id),
          resultKinds: resp.hits.map((h) => h.primitive ?? "fact"),
          topK: l3TopK,
        })
        .catch((err: unknown) => {
          reportCacheFailure(ctx, "l3_query", "insert", err);
          return undefined;
        });
    }

    setRecallResultAttrs(recallSpan, resp, tierHit, false);
    return finish(resp, tierHit);
  } finally {
    recallSpan.end();
  }
}

// ─── Session collapse facade (flatten-legacy-dual-core PR16) ─────────────────

/**
 * Thin result-handling wrapper around the pure `session/collapse.ts` pipeline —
 * adapted from the legacy `CoreLike.collapseSession` implementation in
 * `factory.ts`, which is glue code
 * (translating a `CollapseResult` into close-or-throw route semantics), not
 * pipeline logic. The pipeline itself (`runCollapseSessionPipeline`) is untouched.
 *
 * `CollapseResult.status`/`skipReason` → outcome mapping (mirrors factory.ts 1:1):
 *   - "skipped"                                → ARCHIVE session (not "collapsed" —
 *                                                  nothing was extracted), return outcome
 *   - "failed", skipReason="llm_unavailable"    → session PRESERVED (not closed),
 *                                                  throw `.code = "LLM_UNAVAILABLE"`
 *   - "failed", skipReason=undefined (not found)→ close session, throw `.code = "NOT_FOUND"`
 *   - "completed"                               → pipeline already closed the session (step 8)
 *   - pipeline throw (unexpected error)         → record retry, rethrow
 */
/**
 * LIFECYCLE-14 — the error a failed collapse leaves on the session, which
 * `GET /session/:id` now shows. A driver error's message is the whole failed
 * statement WITH its parameters — extracted statements included — and the
 * cause sits at the bottom of it; the innermost cause is what says why.
 */
function describeCollapseError(err: unknown): string {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    const cause = (current as { cause?: unknown } | null)?.cause;
    if (!(cause instanceof Error)) break;
    current = cause;
  }
  const message = current instanceof Error ? current.message : String(current);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

async function runCollapseSessionFacade(
  ctx: CoreContext,
  args: CollapseSessionArgs,
  auth: AuthContext
): Promise<CollapseSessionOutcome> {
  const effectiveCtx: CoreContext = args.llmOverride ? { ...ctx, llm: args.llmOverride } : ctx;

  const collapseInput: CollapseInput = {
    sessionId: args.sessionId,
    workspaceId: args.workspaceId,
    reason: args.reason ?? (args.strategy === "explicit" ? "explicit" : "inactivity"),
    ...(args.collapseHint ? { collapseHint: args.collapseHint } : {}),
    ...(args.policy ? { policy: args.policy } : {}),
  };

  let result: CollapseResult;
  try {
    result = await runCollapseSessionPipeline(collapseInput, effectiveCtx, auth);
  } catch (err) {
    if ((err as { code?: string }).code === "SESSION_SNAPSHOT_CHANGED") throw err;
    await effectiveCtx.storage
      .recordCollapseFailure?.(args.sessionId, args.workspaceId, describeCollapseError(err))
      .catch(() => undefined);
    throw err;
  }

  if (result.status === "skipped") {
    // P115: a skip is NOT a collapse, and must not be recorded as one.
    //
    // `closeSession` writes status='collapsed', which claims the session was
    // turned into knowledge. For a session the gate discarded, that is false,
    // and it is unrecoverable: the sweep selects `WHERE status='active'`, so the
    // turns sit in mnemo_session_turn forever with nothing pointing at them and
    // no path back.
    //
    // `archiveSession` already means exactly the right thing — "closed WITHOUT
    // collapse, no knowledge extracted" (SessionRepository, §7 discard) — and it
    // equally keeps the session out of the sweep, which is the reason the
    // original code closed it at all. So the session stops being swept, its
    // state stops lying, and an operator or agent can still re-collapse it
    // explicitly: an explicit collapse now bypasses the gate that skipped it,
    // which makes that recovery actually work rather than loop.
    //
    // Falls back to closeSession when the adapter has no archiveSession (it is
    // optional on the port) — leaving the session active would be worse: an
    // infinite re-sweep that re-embeds and re-skips every 5 minutes.
    if (result.archived) {
      // Already archived inside the pipeline's commit, with its provenance
      // episode (review round) — archiving again would only rewrite metadata.
    } else if (effectiveCtx.storage.archiveSession) {
      await effectiveCtx.storage
        .archiveSession(args.sessionId, args.workspaceId)
        .catch(() => undefined);
    } else {
      await effectiveCtx.storage
        .closeSession(args.sessionId, args.workspaceId)
        .catch(() => undefined);
    }
  } else if (result.status === "failed" && result.skipReason !== "llm_unavailable") {
    // NOT_FOUND path — close (nothing to retry), throw below.
    await effectiveCtx.storage
      .closeSession(args.sessionId, args.workspaceId)
      .catch(() => undefined);
  } else if (result.status === "failed" && result.skipReason === "llm_unavailable") {
    // Session preserved for retry — do NOT close. Record the attempt so the
    // sweep backs off instead of re-embedding every turn on every tick while
    // the provider is down.
    await effectiveCtx.storage
      .recordCollapseFailure?.(args.sessionId, args.workspaceId, "llm_unavailable")
      .catch(() => undefined);
    throw Object.assign(new Error("Session collapse LLM failed — session preserved for retry"), {
      code: "LLM_UNAVAILABLE",
    });
  }

  if (result.status === "failed" && result.skipReason === undefined) {
    throw Object.assign(new Error(`Session ${args.sessionId} not found or collapse failed`), {
      code: "NOT_FOUND",
    });
  }

  return {
    turnsProcessed: result.turnsProcessed,
    anticipationAccuracy: result.anticipationAccuracy ?? null,
    status: result.status,
    ...(result.skipReason ? { skipReason: result.skipReason } : {}),
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  maxHotTierSize: 1000,
  worthDecayLambda: 0.85,
  surpriseThreshold: 0.15,
  hotTierTtlSeconds: 86400,
  injectionScoreThreshold: 0.85, // Wave X: noisy-OR injection detection
  anomalyScoreThreshold: 0.8, // Wave X: semantic anomaly detection
  embeddingNoise: { mode: "off" as const, epsilon: 1 }, // §5: default off — noise degrades recall
  scopedConflictCheckEnabled: true, // auto-trigger-scoped-consolidation: default-on kill switch
  writeConflictClassification: false, // WP-7: LLM calls on every fact write are opt-in
} as const;

export function createCore(deps: CoreDeps, config: CoreConfig = {}): MnemoCore {
  const ctx: CoreContext = {
    ...deps,
    config: { ...DEFAULTS, ...config },
  };

  return {
    remember: async (req, auth, opts) => {
      const writeCtx = opts?.llmOverride ? { ...ctx, llm: opts.llmOverride } : ctx;
      if (!req.scopeRef) return remember(writeCtx, req, auth);
      // P135: a scopeRef that names a project is stored as its canonical name.
      const r = await resolveProjectScopeRef(
        ctx.storage,
        req.workspaceId,
        req.scopeRef,
        ctx.logger
      );
      const res = await remember(writeCtx, { ...req, scopeRef: r.scopeRef }, auth);
      if (!r.canonicalized && !r.suggestion) return res;
      return {
        ...res,
        scopeRefResolution: {
          ...(r.canonicalized ? { canonicalized: r.canonicalized } : {}),
          ...(r.suggestion ? { suggestion: r.suggestion } : {}),
        },
      };
    },
    // 3-tier cascade gated by CALMem token budget:
    //   hot (ACT-R) → pointer (FTS∪LSH + exact cosine) → cold (HNSW 7-stage)
    // L3 embedding LRU + cosine>=0.95 short-circuit wrap:
    recall: async (query, auth, opts) => {
      const scoped = await withProjectScope(ctx.storage, query, ctx.logger);
      return withFederatedHits(ctx, scoped, auth, await recallWithCaches(ctx, scoped, auth, opts));
    },
    recallHot: (workspaceId, auth, limit) => recallHot(ctx, workspaceId, auth, limit),
    forget: (id, kind, mode, auth, reason) => forget(ctx, id, kind, mode, auth, reason),
    updateWorth: (id, kind, delta, auth) => updateWorth(ctx, id, kind, delta, auth),
    updateRelationStrength: (relationId, reinforced, auth) =>
      updateRelationStrength(ctx, relationId, reinforced, auth),
    collapseSession: (args, auth) => runCollapseSessionFacade(ctx, args, auth),
    prepareManagedCollapse: (input, auth) => runPrepareManagedCollapse(input, ctx, auth),
    propagateGovernanceForSession: (workspaceId, sessionId) =>
      propagateGovernanceForSession(
        ctx,
        workspaceId,
        sessionId,
        { success: 1, failure: 0, creditWeight: 1 },
        ctx.config.worthDecayLambda
      ),
  };
}

// ─── §11 Governance action layer ─────────────────────────────────────────────

import type { GovernanceAction } from "./governance.js";

/**
 * Narrowed dependency set for applyGovernance — a strict subset of CoreContext.
 * Lets runtime callers (crons) invoke the action layer without constructing the
 * internal CoreContext (which is intentionally not part of the public API).
 */
export interface GovernanceDeps {
  storage: Pick<StorageAdapter, "getFact" | "setCanonical" | "updateFact"> &
    Partial<Pick<StorageAdapter, "enqueueReview">>;
  cache?: Pick<CacheAdapter, "zincrby" | "zrangeByScore">;
  maxHotTierSize: number;
}

/**
 * §11 action layer (spec lines 1004-1046): classify a fact's worth signal
 * and execute the corresponding promote/demote/canonical action through ports.
 * Returns the action taken. Never throws to caller — all sub-ops degrade gracefully.
 */
export async function applyGovernance(
  deps: GovernanceDeps,
  workspaceId: string,
  factId: string
): Promise<GovernanceAction> {
  const fact = await deps.storage.getFact(factId, workspaceId);
  if (!fact) return "neutral";
  const alpha = fact.worthAlpha ?? 2;
  const beta = fact.worthBeta ?? 2;
  const action = classifyGovernance(
    fact.worth,
    wilsonLowerBound(alpha, beta),
    wilsonUpperBound(alpha, beta)
  );
  const key = hotTierKey(workspaceId);
  switch (action) {
    case "canonical":
      await deps.storage.setCanonical(factId, workspaceId, true);
      if (!fact.pinned)
        await deps.storage.updateFact(factId, workspaceId, { pinned: true }).catch(() => undefined);
      if (deps.cache?.zincrby) await deps.cache.zincrby(key, 1, factId).catch(() => undefined);
      break;
    case "promote":
      if (!fact.pinned)
        await deps.storage.updateFact(factId, workspaceId, { pinned: true }).catch(() => undefined);
      if (deps.cache?.zincrby) await deps.cache.zincrby(key, 1, factId).catch(() => undefined);
      break;
    case "demote":
      if (deps.cache?.zincrby) {
        await deps.cache.zincrby(key, -10, factId).catch(() => undefined);
      }
      await deps.storage
        .enqueueReview?.({
          workspaceId,
          primitiveKind: "fact",
          primitiveId: factId,
          reason: "low_worth_archive_candidate",
          priority: 5,
        })
        .catch(() => undefined);
      break;
    case "neutral":
      break;
  }
  return action;
}

/**
 * §11 governance sweep — apply the action layer across a workspace's active
 * facts. Bounded by `maxFacts` (default 2000) so a single cron tick cannot
 * scan an unbounded table. Never throws: per-fact failures are swallowed and
 * counted as "neutral". Returns the tally of actions taken.
 */
export async function governanceSweep(
  deps: GovernanceDeps & { storage: Pick<StorageAdapter, "queryFacts"> },
  workspaceId: string,
  opts: { maxFacts?: number; pageSize?: number } = {}
): Promise<Record<GovernanceAction, number>> {
  const maxFacts = opts.maxFacts ?? 2000;
  const pageSize = Math.min(opts.pageSize ?? 200, maxFacts);
  const tally: Record<GovernanceAction, number> = {
    canonical: 0,
    promote: 0,
    demote: 0,
    neutral: 0,
  };
  let offset = 0;
  while (offset < maxFacts) {
    const page = await deps.storage.queryFacts({
      workspaceId,
      status: "active",
      offset,
      limit: pageSize,
    });
    if (page.items.length === 0) break;
    for (const fact of page.items) {
      try {
        const action = await applyGovernance(deps, workspaceId, fact.id);
        tally[action]++;
      } catch {
        tally.neutral++;
      }
    }
    offset += page.items.length;
    if (page.items.length < pageSize) break;
  }
  return tally;
}

// §11 governance exports
export { classifyGovernance, propagateGovernanceForSession, GOVERNANCE_MAX_HOPS };
export type { GovernanceAction } from "./governance.js";

// ACT-R hot-tier key helper (used by cron jobs that seed / decay the hot ZSet)
export { hotTierKey } from "./recall-hot.js";
export { finalizeRecallObservation } from "./recall-observation.js";

// Experience-Compression (Wave Z-A3 — spec §2)
export {
  detectCompressionCandidate,
  compressSubtree,
  DEFAULT_COMPRESSION_POLICY,
} from "./compression.js";
export type { CompressionPolicy, CompressionCandidate, CompressionResult } from "./compression.js";

// UCE Knowledge-Type Scheduler (Wave Z-A2 — spec §10,§7)
export {
  buildKnowledgeScheduler,
  extractionPriority,
  DEFAULT_TARGET,
} from "./knowledge-scheduler.js";
export type { KnowledgeScheduler, KnowledgeType } from "./knowledge-scheduler.js";

// RecMem — recurrence-gated LLM invocation (Wave Z-A1 — spec §1/§2,§7)
export { recurrenceSignal, decideRecmem } from "./recmem.js";
export type { RecmemDecision, RecmemOptions } from "./recmem.js";
export { maybeRerank, sensitivityAllowed } from "./recall-cold.js";

// Worth utilities (Wave J3)
export { wilsonLowerBound, wilsonUpperBound, propagateTdCredit } from "./worth.js";

// CoT distillation cache decision module (Wave M1 — spec §8)
export {
  resolveDecision,
  dedupDecision,
  lifecycleTransition,
  passesTopicKeyResolveGate,
  RESOLVE_COSINE,
  RESOLVE_WORTH,
  RESOLVE_CONFIDENCE,
  DEDUP_COSINE,
} from "./reasoning.js";
export type {
  ReasoningCandidate,
  ResolveDecision,
  DedupDecision,
  ReasoningStatus,
} from "./reasoning.js";

// Self-Editing Memory — policy + apply (Wave M2 — spec §13)
export {
  DEFAULT_SELF_EDIT_POLICY,
  evaluateSelfEdit,
  parseTarget,
  applySelfEdit,
  SelfEditTargetNotFoundError,
  SelfEditContentRequiredError,
  selfEditContentMissing,
} from "./self-edit.js";

// WP-5 — remember()'s typed refusal (a live row already owns the key → 409).
export { RememberConflictError } from "./remember.js";
export type {
  SelfEditPolicy,
  SelfEditAction,
  SelfEditRequest,
  SelfEditOutcome,
  ParsedTarget,
  EvalInput,
  EvalResult,
  AllowedScope,
  SelfEditContext,
} from "./self-edit.js";

// Self-Reflection Cycle (Wave M2 — spec §13)
export { runReflectionCycle, REFLECTION_CADENCE } from "./self-reflect.js";
export type { ReflectionResult } from "./self-reflect.js";

// §32 Compositionality Engine
export { composeInferences, evaluateRule } from "./compositionality.js";
export type { ComposeOpts, SyntheticRule } from "./compositionality.js";

// §31 Meta-cognition
export { buildSelfModel } from "./metacognition.js";
export type { SelfModel, SuggestedAction } from "./metacognition.js";

// §8 Anticipation Engine
export { buildAnticipationFeed } from "./anticipation.js";
export type { AnticipationFeed, AnticipatedMemory } from "./anticipation.js";

// §18 Task state machine + auto-extraction
export {
  TASK_TRANSITIONS,
  isValidTransition,
  assertValidTransition,
  IllegalTaskTransitionError,
  autoExtractOnCompletion,
} from "./tasks.js";
export type { TaskStatus, AutoExtractResult, AutoExtractStorage } from "./tasks.js";

// §17 SimHash LSH banding (Tier 2 pointer recall)
export { lshBands, LSH_BANDS, LSH_DIMS } from "./lsh.js";
export type { LshBand } from "./lsh.js";

export { matchesRecallFilter } from "./recall-filter.js";
export type { RecallFilterCandidate } from "./recall-filter.js";

// Fact-pair semantic classifier — shared by remember() and @mnemo-ai/consolidation.
export { classifyFactPair, FactPairClassificationError } from "./fact-pair-classifier.js";
export type {
  SemanticClass,
  ClassifyFactPairResult,
  FactPairClassifierLLM,
} from "./fact-pair-classifier.js";

// LLM usage-reporting + hot-tier eviction + cache-failure hooks (host wires these to metrics)
export type { LlmUsageReport, OnLlmUsage, OnHotTierEvict, HotTierEvictReport, OnCacheError };
export { reportCacheFailure, resetCacheFailureThrottle } from "./cache-observability.js";
export type { CacheErrorReport, CacheName, CacheOp } from "./cache-observability.js";

// p60-corecall-stdp-convergence — `recordCoRecall` is the SOLE co-recall STDP
// writer (a server-side duplicate pass has been deleted). Exported so hosts
// and cross-layer regression tests can invoke the real function instead of
// re-implementing its pairing/cap/ordering policy.
export { recordCoRecall, CO_RECALL_TOP_K } from "./co-recall.js";
// p60-corecall-stdp-convergence PR2 — co-recall tail-measurement hook (D3),
// same host-wiring pattern as OnHotTierEvict/OnCacheError.
export type { OnCoRecallTail, CoRecallTailReport };

// Re-export types consumers need to construct CoreDeps
export type {
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
  AuthContext,
  RememberRequest,
  RememberResponse,
  RecallQuery,
  RecallResponse,
  RecallHit,
  PrimitiveKind,
  WorthDelta,
};

// ─── AB7.2 Request Coalescing (spec §35 line 4434) ───────────────────────────
export { Coalescer } from "./coalesce.js";

// ─── AB4 Canary Deploy Decision (spec §35 lines 2086–2110) ───────────────────
export { evaluateCanary, DEFAULT_CANARY_CONFIG } from "./canary.js";
export type { CanaryConfig, MetricsSnapshot, CanaryDecision } from "./canary.js";

// ─── AB3 Billing & Usage Metering (spec §35) ─────────────────────────────────
export {
  METER_METRICS,
  PLAN_LIMITS,
  computeUsageStatus,
  crossedThresholds,
  SPEND_ALERT_THRESHOLDS,
  METER_UNIT_COST_USD,
  meterEventCostUsd,
} from "./metering.js";
export type {
  MeterMetric,
  PlanLimits,
  UsageState,
  MetricUsageStatus,
  UsageStatus,
  MeterEvent,
  UsageSnapshot,
} from "./metering.js";

// ─── Neuro-dynamics (Wave Y, §25.2/§25.3) ────────────────────────────────────
export {
  DECAY_HALF_LIVES,
  decayClassForKind,
  decayFactor,
  decayEvidence,
  stdpUpdate,
  percentileNormalize,
  STDP,
  type DecayClass,
  type StdpInput,
  type StdpResult,
} from "./neuro-dynamics.js";

// ─── RDD-5: Learning-mode cold-start gates + graduation helper ────────────────
export { gatesFor, shouldGraduate, isLearningMode, GRADUATION } from "./learningMode.js";
export type { WorkspaceModeRecord, LearningGates } from "./learningMode.js";
export { runGraduationTick } from "./graduation.js";
export type { GraduationTickResult } from "./graduation.js";

// ─── Graph traversal/pathfinding (flatten-legacy-dual-core PR9f, design.md D6.5) ──
export { traverseGraph, findGraphPath } from "./graph/index.js";
export type {
  GraphTraverseDeps,
  TraverseGraphOptions,
  TraverseGraphHit,
  GraphPathOptions,
  GraphPathEdge,
  GraphPathResult,
} from "./graph/index.js";

// ─── Workspace export projection (flatten-legacy-dual-core PR9h, design.md D6.5) ──
export {
  exportWorkspace,
  exportFacts,
  exportDecisions,
  exportRelations,
  exportCitations,
  EXPORT_ROW_CAP,
} from "./export/workspace-export.js";
export type { ExportWorkspaceDeps, LegacyWorkspaceExport } from "./export/workspace-export.js";
