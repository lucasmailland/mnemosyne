/**
 * Tier 2 pointer recall — FTS ∪ LSH narrowing + exact cosine re-ranking.
 * COGNITIVE_ALGORITHMS.md §17, CALMem token-budget ladder (spec §17 lines 1338-1342).
 *
 * Architecture: three-tier cascade
 *   Tier 1: Hot tier (Redis ACT-R activation) — tryHotTier()
 *   Tier 2: Pointer recall (this file) — FTS union LSH collision → exact cosine
 *   Tier 3: Cold recall (HNSW + 7-stage cascade) — recallCold()
 *
 * Token-budget gating:
 *   <500   → skip entirely
 *   <2000  → hot only, 3 hits max
 *   <8000  → hot + pointer, 5 hits max
 *   ≥8000  → full pipeline
 *   absent → full pipeline (backward compatible)
 *
 * Sufficiency gate (§17 lines 1362-1365):
 *   If ≥3 candidates score >0.7, return immediately without cascading to cold.
 *   This prevents expensive HNSW searches when pointer recall already covers the query.
 */

import type {
  RecallQuery,
  RecallResponse,
  RecallHit,
  AuthContext,
  PointerCandidate,
  Provenance,
  Span,
} from "@mnemo-ai/types";
import type { CoreContext } from "./context.js";
import { appliesOrganicEffects } from "./recall-effects.js";
import {
  sensitivityAllowed,
  buildResponse,
  recallFilterForAuth,
  stampHitStatus,
} from "./recall-cold.js";
import { reinforceDeliveredHot } from "./recall-hot.js";
import { lshBands } from "./lsh.js";
import { isRecallableFact } from "./fact-lifecycle.js";
import { matchesRecallFilter } from "./recall-filter.js";
import { isUntestedWorth, passesWorthGate, worthGateLowerBound } from "./worth.js";

const SUFFICIENCY_MIN_HITS = 3;
const SUFFICIENCY_MIN_SCORE = 0.7;
const CANDIDATE_FETCH = 50;

// ─── CALMem token-budget ladder ───────────────────────────────────────────────

export interface TierPlan {
  skip: boolean;
  tryHot: boolean;
  tryPointer: boolean;
  tryCold: boolean;
  limit: number;
}

export function applyTokenBudget(budget: number | undefined, requestedLimit = 10): TierPlan {
  if (budget !== undefined && budget < 500) {
    return { skip: true, tryHot: false, tryPointer: false, tryCold: false, limit: 0 };
  }
  if (budget !== undefined && budget < 2000) {
    return { skip: false, tryHot: true, tryPointer: false, tryCold: false, limit: 3 };
  }
  if (budget !== undefined && budget < 8000) {
    return { skip: false, tryHot: true, tryPointer: true, tryCold: false, limit: 5 };
  }
  return { skip: false, tryHot: true, tryPointer: true, tryCold: true, limit: requestedLimit };
}

// ─── Pointer-term extraction ──────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "with",
  "that",
  "this",
  "from",
  "have",
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
  "did",
  "does",
  "has",
]);

export function extractPointerTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= 8) break;
  }
  return [...seen];
}

// ─── Cosine similarity ────────────────────────────────────────────────────────

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0,
    na = 0,
    nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─── Tier 2 pointer recall ────────────────────────────────────────────────────

export async function tryPointerTier(
  ctx: CoreContext,
  query: RecallQuery,
  auth: AuthContext,
  parentSpan?: Span,
  runEffects = appliesOrganicEffects(query) // false: synthetic traffic or deferred to the outer boundary
): Promise<RecallResponse | null> {
  // Pointer tier is fact-scoped by storage: only mnemo_fact_lsh exists.
  // Non-fact-only queries (decisions, episodes, entities, etc.) fall through
  // gracefully to the cold tier rather than being skipped entirely. Returning
  // null here is correct — it signals "no pointer result" so the cascade
  // continues to recallCold() which covers all primitive kinds via HNSW.
  if (query.filter?.kinds && !query.filter.kinds.includes("fact")) return null;

  const startMs = Date.now();
  const span = ctx.telemetry.startSpan("mnemo.recall.pointer", {
    parent: parentSpan,
    attributes: { "mnemo.workspace_id": query.workspaceId },
  });
  try {
    const limit = query.limit ?? 10;
    let embedding: Float32Array;
    try {
      embedding = query.embedding ?? (await ctx.embed.embedSingle(query.text));
    } catch {
      return null; // transient embed failure → fall through to cold tier
    }
    const terms = extractPointerTerms(query.text);
    const bands = lshBands(embedding).map((b) => ({ bandIdx: b.bandIdx, bandHash: b.bandHash }));

    if (terms.length === 0 && bands.length === 0) return null;

    const offset = query.offset ?? 0;
    const candidates: PointerCandidate[] = await ctx.storage
      .pointerCandidates({
        workspaceId: query.workspaceId,
        terms,
        bands,
        limit: Math.min(1000, Math.max(CANDIDATE_FETCH, (limit + offset) * 5)),
        filter: recallFilterForAuth(query.filter, auth),
        includeArchived: query.includeArchived,
        includeLowWorth: query.includeLowWorth ?? false,
      })
      .catch(() => []);
    if (candidates.length === 0) return null;

    const hydrated = await Promise.all(
      candidates.map(async (c) => {
        if (!isRecallableFact(c, query.includeArchived === true)) return null;
        if (
          !matchesRecallFilter(
            {
              primitive: "fact",
              tags: c.tags ?? [],
              validFrom: c.validFrom ?? c.createdAt,
              validTo: c.validTo,
              worth: c.worth,
              confidence: c.confidence,
              sensitivity: c.sensitivity,
              provenance: c.attribution,
              entityId: c.entityId,
              sessionId: c.sessionId,
              scope: c.scope,
              scopeRef: c.scopeRef,
              actorId: c.actorId,
            },
            query.filter
          )
        )
          return null;
        const sensitivity = c.sensitivity;
        if (!sensitivityAllowed(sensitivity, auth)) return null;
        const sim = c.embedding ? cosine(embedding, c.embedding) : 0;
        const worthLowerBound = worthGateLowerBound(c);
        const isUntested = isUntestedWorth(c);
        if (
          !query.includeLowWorth &&
          !passesWorthGate(
            {
              primitive: "fact",
              worth: c.worth,
              worthLowerBound,
            },
            isUntested
          )
        )
          return null;
        const score = sim * c.worth;
        return {
          id: c.factId,
          primitive: "fact" as const,
          content: c.statement,
          score,
          ...(c.embedding ? { similarity: sim } : {}),
          sensitivity,
          injectionScore: 0,
          provenance: c.attribution as Provenance,
          origin: "local" as const,
          contested: false,
          validFrom: c.validFrom ?? c.createdAt,
          validTo: c.validTo ?? null,
          tags: c.tags ?? [],
          relations: [],
          worth: c.worth,
          worthLowerBound,
          ...(c.scope ? { scope: c.scope } : {}),
          actorId: c.actorId ?? null,
          userId: c.userId ?? null,
          ...(c.actorType ? { actorType: c.actorType } : {}),
          ...(c.scopeRef ? { scopeRef: c.scopeRef } : {}),
          ...(c.scopeOwner ? { scopeOwner: c.scopeOwner } : {}),
          ...(c.topicKey ? { topicKey: c.topicKey } : {}),
          ...(c.subject ? { subject: c.subject } : {}),
        } satisfies RecallHit;
      })
    );
    const nonNullHits = hydrated.filter((hit): hit is NonNullable<typeof hit> => hit !== null);
    const hits: RecallHit[] = nonNullHits.sort((a, b) => b.score - a.score);

    // Sufficiency gate: if ≥3 hits exceed the score threshold, stop cascading
    const strong = hits.filter((h) => h.score > SUFFICIENCY_MIN_SCORE);
    if (strong.length < SUFFICIENCY_MIN_HITS) return null;

    const top = hits.slice(offset, offset + limit);
    await stampHitStatus(ctx, query.workspaceId, top, auth);

    // Promote to hot tier (fire-and-forget)
    if (runEffects) void reinforceDeliveredHot(ctx, query.workspaceId, top, auth);

    return buildResponse(top, query.text, limit, query.offset ?? 0, startMs, false, []);
  } finally {
    ctx.telemetry.histogram("mnemo_recall_duration_seconds", (Date.now() - startMs) / 1000, {
      tier: "pointer",
    });
    span.end();
  }
}
