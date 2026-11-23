/**
 * Hot-tier recall — Redis ZSet sorted by running activation score.
 * COGNITIVE_ALGORITHMS.md §5.2, REDIS_CONVENTIONS.md §3.
 *
 * Key: `mnemo:{workspaceId}:hot:facts` (facts only — ZSet score is per-primitive-ID)
 *
 * Why facts only?
 *   Hot-tier activation requires a per-item score that is bumped on every recall
 *   and write (Hebbian reinforcement). In v3.0 only MnemoFact has the full TD(λ)
 *   worth feedback loop. Other primitives are retrieved via cold cascade for now.
 *
 * Score bump on every recall:
 *   Each zincrby(key, 1, factId) call is a Hebbian potentiation step — "fire together,
 *   wire together." The more a fact is recalled in any context, the higher its score
 *   and the more likely it surfaces on the next hot-tier query.
 *
 * Hot tier misses:
 *   tryHotTier() returns null on cache miss or when the query requests non-fact
 *   kinds. The caller (recall.ts) falls through to the cold cascade automatically.
 *
 * Eviction: keeps top-N (config.maxHotTierSize). The eviction hack below uses
 *   zincrby with -1e9 instead of ZREMRANGEBYRANK because the ZSet operations in
 *   CacheAdapter are minimal by design (InMemoryCacheAdapter lacks ZREM). A real
 *   Redis deployment should swap to ZREMRANGEBYRANK for O(log N) eviction.
 */

import type {
  RecallFilter,
  RecallHit,
  RecallQuery,
  RecallResponse,
  AuthContext,
  DerivedInference,
  Span,
  MnemoFact,
  StorageAdapter,
} from "@mnemo-ai/types";
import type { CoreContext } from "./context.js";
import { appliesOrganicEffects } from "./recall-effects.js";
import { isActiveOpenFact } from "./fact-lifecycle.js";
import {
  buildResponse,
  sensitivityAllowed,
  petrovActivation,
  stampHitStatus,
  attachTrace,
  traceCounts,
} from "./recall-cold.js";
import { composeInferences } from "./compositionality.js";
import { wilsonLowerBound, passesWorthGate } from "./worth.js";
import { scoreInjection, DEFAULT_INJECTION_THRESHOLD } from "../security/injection.js";
import { matchesRecallFilter } from "./recall-filter.js";
import { contentTerms } from "./topic-key.js";

// ─── §17 Tier-1 hot-tier constants ────────────────────────────────────────────
// Spec MEMORY_MODEL.md §"Three-Tier Retrieval Cascade":
//   "Boost: Recent recall (last 5min) gets +0.3"
//   "Sufficient: ≥3 results with activation > 0.7"
const HOT_SUFFICIENT_COUNT = 3;
const HOT_SUFFICIENT_ACTIVATION = 0.7;
const HOT_RECENCY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const HOT_RECENCY_BOOST = 0.3;

/**
 * Canonical ACT-R activation for a hot-tier fact, normalised to [0,1].
 *
 * The hot ZSet score is an unbounded recall counter — not directly comparable
 * to the spec's "activation > 0.7" gate. Instead we recompute the SAME Petrov
 * activation A(t)=ln(∑ t_j^{-d}) the cold path uses, from the recall log, and
 * squash it with tanh so it shares the cold path's [0,1] scale. A fact with a
 * recall in the last 5 minutes gets a +0.3 recency boost (spec), clamped to 1.
 *
 * Returns 0 when the storage adapter has no recall log (graceful degradation):
 * with no activation evidence the sufficiency gate then can't trip on this fact,
 * and the caller waterfalls to the pointer/cold tiers — the safe direction.
 */
async function hotActivation(
  ctx: CoreContext,
  workspaceId: string,
  factId: string,
  nowMs: number
): Promise<number> {
  if (!("getRecallLog" in ctx.storage)) return 0;
  const storage = ctx.storage as {
    getRecallLog: (w: string, m: string, n: number) => Promise<Array<{ recalledAt: string }>>;
  };
  const log = await storage.getRecallLog(workspaceId, factId, 20).catch(() => []);
  if (log.length === 0) return 0;
  const timestampsMs = log.map((e) => new Date(e.recalledAt).getTime());
  const activationNorm = Math.tanh(petrovActivation(timestampsMs, nowMs));
  const mostRecentMs = Math.max(...timestampsMs);
  const recencyBoost = nowMs - mostRecentMs <= HOT_RECENCY_WINDOW_MS ? HOT_RECENCY_BOOST : 0;
  return Math.min(1, activationNorm + recencyBoost);
}
// SECURITY: L2 value cache MUST call unwrapCacheValue when storing fact payloads
// to prevent workspace-A cache entries from being served to workspace-B.

// ─── Key convention ───────────────────────────────────────────────────────────
// mnemo:{workspaceId}:hot:facts — REDIS_CONVENTIONS.md §3

export function hotTierKey(workspaceId: string): string {
  return `mnemo:${workspaceId}:hot:facts`;
}

// ─── Score bump (call at every recall + write) ────────────────────────────────

export async function bumpHotTierScore(
  ctx: CoreContext,
  workspaceId: string,
  factId: string
): Promise<void> {
  if (!ctx.cache || !ctx.cache.zincrby) return;
  const key = hotTierKey(workspaceId);
  await ctx.cache.zincrby(key, 1, factId);

  // Trim to maxHotTierSize by evicting lowest-scored entries
  if (!ctx.cache.zrangeByScore) return;
  const all = await ctx.cache.zrangeByScore(key, -Infinity, Infinity);
  if (all.length > ctx.config.maxHotTierSize) {
    const toEvict = all.slice(0, all.length - ctx.config.maxHotTierSize);
    for (const id of toEvict) {
      // Penalise to -∞ so it sorts to bottom; a real Redis impl would ZREMRANGEBYRANK
      if (ctx.cache.zincrby) {
        await ctx.cache.zincrby(key, -1e9, id);
      }
    }
    if (toEvict.length > 0) {
      // Legacy no-op path (kept harmless): server Telemetry.counter is a stub.
      ctx.telemetry.counter("mnemo_hot_tier_evictions_total", toEvict.length, {});
      // Live path: fire-and-forget host metrics hook. `size` is the post-trim
      // occupancy (cap), since the trim brings the set down to maxHotTierSize.
      if (ctx.onHotTierEvict) {
        try {
          ctx.onHotTierEvict({
            workspaceId,
            evicted: toEvict.length,
            size: ctx.config.maxHotTierSize,
          });
        } catch {
          // metrics failure must never break the bump path
        }
      }
    }
  }
}

// ─── Hot-tier recall ──────────────────────────────────────────────────────────

async function recallHotCandidates(
  ctx: CoreContext,
  workspaceId: string,
  auth: AuthContext,
  skipGate = false,
  filter?: RecallFilter
): Promise<RecallHit[]> {
  if (!ctx.cache?.zrangeByScore) return [];

  const key = hotTierKey(workspaceId);
  // Fetch highest-scored fact IDs (top-N = last N in ascending ZRANGEBYSCORE)
  const all = await ctx.cache.zrangeByScore(key, -Infinity, Infinity);
  if (all.length === 0) return [];

  const fetchLimit = Math.min(1000, ctx.config.maxHotTierSize, all.length);
  const topIds = all.slice(-fetchLimit).reverse();
  const nowMs = Date.now();
  const batchStorage = ctx.storage as Partial<
    Pick<StorageAdapter, "getRecallPrimitives" | "getRecallLogs">
  >;
  const [primitiveRecords, recallLogs] = await Promise.all([
    batchStorage.getRecallPrimitives
      ? batchStorage
          .getRecallPrimitives(
            workspaceId,
            topIds.map((id) => ({ id, kind: "fact" as const }))
          )
          .catch(() => [])
      : Promise.resolve(null),
    batchStorage.getRecallLogs
      ? batchStorage.getRecallLogs(workspaceId, topIds, 20).catch(() => [])
      : Promise.resolve(null),
  ]);
  const factsById = new Map<string, MnemoFact>();
  for (const record of primitiveRecords ?? []) factsById.set(record.id, record.value as MnemoFact);
  const historyById = new Map<string, number[]>();
  for (const entry of recallLogs ?? []) {
    const history = historyById.get(entry.memoryId) ?? [];
    history.push(new Date(entry.recalledAt).getTime());
    historyById.set(entry.memoryId, history);
  }
  const facts = await Promise.all(
    topIds.map(async (id) => {
      const fact = primitiveRecords
        ? (factsById.get(id) ?? null)
        : await ctx.storage.getFact(id, workspaceId).catch(() => null);
      if (!fact || !isActiveOpenFact(fact)) return null;
      if (!matchesRecallFilter(fact, filter)) return null;
      if (!sensitivityAllowed(fact.sensitivity ?? "internal", auth)) return null;
      // §17: score on ACT-R activation (+recency boost), NOT raw worth.
      const history = recallLogs ? (historyById.get(id) ?? []) : null;
      const activation =
        history === null
          ? await hotActivation(ctx, workspaceId, id, nowMs)
          : history.length === 0
            ? 0
            : Math.min(
                1,
                Math.tanh(petrovActivation(history, nowMs)) +
                  (nowMs - Math.max(...history) <= HOT_RECENCY_WINDOW_MS ? HOT_RECENCY_BOOST : 0)
              );
      return { fact, activation };
    })
  );

  // Tracked out-of-band (not on RecallHit itself) so the worth-gate filter
  // below can exempt never-observed facts without widening the wire type.
  const isUntestedById = new Map<string, boolean>();

  const hits: RecallHit[] = facts
    .filter(
      (
        x
      ): x is {
        fact: NonNullable<Awaited<ReturnType<typeof ctx.storage.getFact>>>;
        activation: number;
      } => x !== null
    )
    .map(({ fact: f, activation }) => {
      isUntestedById.set(f.id, (f.worthAlpha ?? 2) === 2 && (f.worthBeta ?? 2) === 2);
      const injection = scoreInjection(
        f.statement,
        ctx.config?.injectionScoreThreshold ?? DEFAULT_INJECTION_THRESHOLD
      );
      // Score IS the activation (with recency boost); injection demotes it.
      const demotedScore = injection.flagged ? activation * (1 - injection.score) : activation;
      return {
        id: f.id,
        primitive: "fact" as const,
        content: f.statement,
        score: demotedScore,
        sensitivity: f.sensitivity ?? "internal",
        injectionScore: injection.score,
        provenance: (f.attribution ?? "user_stated") as RecallHit["provenance"],
        origin: "local" as const,
        contested: false,
        validFrom: f.validFrom,
        validTo: f.validTo ?? null,
        tags: Array.isArray(f.metadata?.tags)
          ? f.metadata.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
        relations: [],
        worth: f.worth ?? 0.5,
        worthLowerBound: wilsonLowerBound(f.worthAlpha ?? 2, f.worthBeta ?? 2),
        scope: f.scope,
        ...(f.scopeRef ? { scopeRef: f.scopeRef } : {}),
        ...(f.scopeOwner ? { scopeOwner: f.scopeOwner } : {}),
        ...(f.topicKey ? { topicKey: f.topicKey } : {}),
        ...(f.subject ? { subject: f.subject } : {}),
        actorId: f.actorId ?? null,
        userId: f.userId ?? null,
        ...(f.actorType ? { actorType: f.actorType } : {}),
      };
    })
    // §17 cascade orders by activation descending so the sufficiency gate in
    // tryHotTier inspects the strongest results first.
    .sort((a, b) => b.score - a.score);

  // Worth serving gate (spec §11, lines 728–730). Applied after sensitivity check.
  // Untested facts (never observed either way) are exempt — see worth.ts bugfix note.
  const gated = skipGate
    ? hits
    : hits.filter((h) => passesWorthGate(h, isUntestedById.get(h.id) ?? false));

  // §17 near-duplicate suppression: drop a hit whose content is ≥0.88 similar to
  // an already-kept higher-ranked hit. Uses lexical Jaccard over word shingles
  // (cheap, embedding-free) so the <5ms hot-tier SLO is preserved — the spec's
  // cosine>0.88 intent without a per-hit vector fetch on the latency-critical path.
  return dedupeNearDuplicates(gated, HOT_DEDUP_THRESHOLD);
}

export async function recallHot(
  ctx: CoreContext,
  workspaceId: string,
  auth: AuthContext,
  limit = 10,
  skipGate = false,
  filter?: RecallFilter,
  offset = 0,
  runEffects = true // false: synthetic traffic or deferred to the outer boundary
): Promise<RecallHit[]> {
  const candidates = await recallHotCandidates(ctx, workspaceId, auth, skipGate, filter);
  const deduped = candidates.slice(offset, offset + limit);

  if (runEffects) await reinforceDeliveredHot(ctx, workspaceId, deduped, auth);

  return deduped;
}

/**
 * Effect data for finalization: unique fact ids of the delivered hits that the
 * caller may see. Sensitivity-filtered, non-fact and duplicate hits are excluded.
 */
export function hotReinforcementIds(hits: readonly RecallHit[], auth: AuthContext): string[] {
  const ids = new Set<string>();
  for (const h of hits) {
    if (h.primitive === "fact" && sensitivityAllowed(h.sensitivity ?? "internal", auth)) {
      ids.add(h.id);
    }
  }
  return [...ids];
}

/** Bump the hot-tier activation of the final delivered eligible facts, once each. */
export async function reinforceDeliveredHot(
  ctx: CoreContext,
  workspaceId: string,
  hits: readonly RecallHit[],
  auth: AuthContext
): Promise<void> {
  await Promise.allSettled(
    hotReinforcementIds(hits, auth).map((id) => bumpHotTierScore(ctx, workspaceId, id))
  );
}

/** §17 near-duplicate threshold (lexical analogue of the spec's cosine>0.88). */
const HOT_DEDUP_THRESHOLD = 0.88;

/** Word-shingle set for cheap Jaccard similarity (lowercased, deduped tokens). */
function shingles(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 0)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Remove near-duplicate hits, keeping the first (highest-ranked) of each cluster.
 * O(n²) over the already-tiny hot set (≤ limit), so negligible cost.
 */
export function dedupeNearDuplicates(hits: RecallHit[], threshold: number): RecallHit[] {
  const kept: RecallHit[] = [];
  const keptShingles: Array<Set<string>> = [];
  for (const h of hits) {
    const s = shingles(h.content ?? "");
    if (keptShingles.some((ks) => jaccard(s, ks) >= threshold)) continue;
    kept.push(h);
    keptShingles.push(s);
  }
  return kept;
}

/**
 * §17 Tier-1 hot sufficiency gate: the hot tier is only authoritative when it
 * returns ≥3 results whose activation exceeds 0.7. Below that bar the caller
 * must fall through to the pointer/cold tiers rather than serve a thin hot
 * result (the prior code returned on ANY non-empty hot result).
 */
export function hotTierSufficient(hits: RecallHit[]): boolean {
  return hits.filter((h) => h.score > HOT_SUFFICIENT_ACTIVATION).length >= HOT_SUFFICIENT_COUNT;
}

/**
 * Keep only the hits that cover more than half of the query's content terms.
 *
 * Activation says what is top of mind, not what answers this query: without
 * this filter the most-recalled facts satisfied every query, and serving them
 * bumped their activation again, so the same few facts won every recall. A
 * query with no content terms matches nothing. Being strict is safe here —
 * a miss only falls through to the cold cascade.
 */
export function keepQueryRelevant(hits: RecallHit[], queryText: string): RecallHit[] {
  const queryTerms = contentTerms(queryText);
  if (queryTerms.length === 0) return [];
  return hits.filter((h) => {
    const terms = new Set(contentTerms(h.content));
    const covered = queryTerms.filter((t) => terms.has(t)).length;
    return covered * 2 > queryTerms.length;
  });
}

// ─── Query-context hot-tier attempt ──────────────────────────────────────────
// Returns null on miss — caller falls through to cold cascade.

export async function tryHotTier(
  ctx: CoreContext,
  query: RecallQuery,
  auth: AuthContext,
  parentSpan?: Span,
  runEffects = appliesOrganicEffects(query) // false: synthetic traffic or deferred to the outer boundary
): Promise<RecallResponse | null> {
  if (!ctx.cache?.zrangeByScore) return null;
  // The hot set contains active facts only, so it cannot satisfy a historical query.
  if (query.includeArchived === true) return null;
  // Hot tier is activation-score-only; skip if caller requested non-fact kinds
  if (query.filter?.kinds && !query.filter.kinds.includes("fact")) return null;
  // RECALL-8: a query with one content term ("Eos", "borealis://") is covered by
  // every warm fact that names the project, so the coverage filter below lets
  // the most-recalled ones answer it. Fall through to the cold cascade before
  // anything is fetched or bumped. An empty query keeps its deliberate
  // activation-only behaviour.
  if (query.text?.trim() && new Set(contentTerms(query.text)).size < 2) return null;

  const tierStart = Date.now();
  const span = ctx.telemetry.startSpan("mnemo.recall.hot", {
    parent: parentSpan,
    attributes: { "mnemo.workspace_id": query.workspaceId },
  });
  try {
    const activated = await recallHotCandidates(
      ctx,
      query.workspaceId,
      auth,
      query.includeLowWorth ?? false,
      query.filter
    );
    // Filter before the bump below, so an unrelated fact is not reinforced.
    const candidates = query.text?.trim() ? keepQueryRelevant(activated, query.text) : activated;
    if (candidates.length === 0) return null;

    const offset = query.offset ?? 0;
    const hits = candidates.slice(offset, offset + (query.limit ?? 10));
    if (runEffects) await reinforceDeliveredHot(ctx, query.workspaceId, hits, auth);

    // §17 sufficiency gate: only serve from the hot tier (and skip the lower
    // tiers) when ≥3 results have activation > 0.7. Otherwise return null so the
    // caller waterfalls to pointer → cold. The hot ZSet scores were already
    // bumped inside recallHot ("async promote results later", spec), so a
    // fall-through still reinforces these facts.
    if (!hotTierSufficient(candidates)) return null;

    // AGENTSIM-4: dispute state for what is actually served.
    await stampHitStatus(ctx, query.workspaceId, hits, auth);

    // Post-recall composition hook (Wave J2) — mirrors cold-path hook exactly.
    // materialise is always false: hot-tier hits must not double-persist if the
    // same query also waterfalls through to cold recall. materialise:false is
    // NOT read-only (it appends inference history and bumps rule counters), so
    // effect-free traffic (synthetic/test/deferred/asOf) skips it, like cold.
    const inferences = runEffects
      ? await composeInferences(ctx, query.workspaceId, hits, {
          materialise: false,
          ...(query.text ? { triggeredByQuery: query.text } : {}),
          ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        }).catch((err) => {
          ctx.logger.warn("hot-tier.compose_failed", {
            error: { type: "compose_failed", message: String(err) },
          });
          return [] as DerivedInference[];
        })
      : [];

    const response = buildResponse(
      hits,
      query.text,
      query.limit ?? 10,
      query.offset ?? 0,
      Date.now(),
      true,
      inferences
    );
    return query.debug === true
      ? attachTrace(
          response,
          [
            {
              name: "hot_tier",
              ...traceCounts("hot_tier", candidates.length, hits.length, auth),
              ms: Date.now() - tierStart,
            },
          ],
          "hot"
        )
      : response;
  } finally {
    ctx.telemetry.histogram("mnemo_recall_duration_seconds", (Date.now() - tierStart) / 1000, {
      tier: "hot",
    });
    span.end();
  }
}
