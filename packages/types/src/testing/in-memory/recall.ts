// in-memory/recall.ts — InMemoryStorageAdapter's Recall port methods.
// decompose-inmemory-storage-adapter Batch B10a/B10b (design.md Module Map row 22).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).
//
// `getRecallPrimitives` is the Cross-Domain Inventory's largest body (10
// collections: facts, decisions, episodes, entities, strategies, workflows,
// skills, tasks, events, reasonings) AND is the one method in the whole file
// that calls into another module's function directly — it calls
// `reconstructEpisode`, so this file imports it from `episodes.js` (design.md
// D6's one directed inter-module edge; not re-exported through
// `InMemoryStorageAdapter.ts`).
//
// `getRecallStructures` is cross-domain but only `relations`+`hyperedges` —
// design.md corrects an earlier (wrong) claim that it also reads `facts`; it
// receives `sourceIds: string[]` as a parameter and never touches
// `state.facts`.
//
// `updateWorth` is the Cross-Domain Inventory's 3-collection case
// (`facts`+`hyperedges`+`reasonings`); its fact-branch mutates the fact
// object directly in place (D7) — preserved exactly, not converted to a
// re-`set` pattern. `recordRecall` is cross-domain (`recallLog`+`facts` — the
// `facts` write is a hit-count side effect). `getTdPredecessors` is a stub
// returning `[]`.

import type { RecallHitObservation, RecallRequestObservation } from "../../recall.js";
import type {
  RecallLogEntry,
  RecallPrimitiveRef,
  RecallPrimitiveRecord,
  RecallLogRecord,
  RecallStructures,
  RecallPrecisionAtK,
  RecallPrecisionReport,
  PrimitiveCandidate,
  PrimitiveCandidateQuery,
  RecallMetrics,
  RecallMetricsWindow,
  FactStats,
} from "../../ports.js";
import { RECALL_PRECISION_METHODOLOGY_NOTE } from "../../ports.js";
import type { PrimitiveKind, MnemoDecision } from "../../primitives.js";
import type { WorthDelta } from "../../common.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid, hasPendingMarker, cosineSimilarity } from "./support.js";
import { reconstructEpisode } from "./episodes.js";
import { touchesHiddenRow } from "./relations.js";
import { hasHiddenMember } from "./hyperedges.js";
import type { Sensitivity } from "../../common.js";
import { SENSITIVITY_ORDER, tiersAtOrBelow } from "../../security.js";

/** Tiers whose stored statement is plaintext, at or under `ceiling`. */
const plaintextTiersAtOrBelow = (ceiling: Sensitivity): Sensitivity[] =>
  tiersAtOrBelow(ceiling).filter((s) => s === "public" || s === "internal");

export async function getRecallPrimitives(
  state: InMemoryStorageState,
  workspaceId: string,
  refs: RecallPrimitiveRef[]
): Promise<RecallPrimitiveRecord[]> {
  const stores = {
    fact: state.facts,
    decision: state.decisions,
    episode: state.episodes,
    entity: state.entities,
    strategy: state.strategies,
    workflow: state.workflows,
    skill: state.skills,
    task: state.tasks,
    event: state.events,
    reasoning: state.reasonings,
  } as const;
  const records: RecallPrimitiveRecord[] = [];
  for (const ref of refs) {
    const value =
      ref.kind === "episode"
        ? await reconstructEpisode(state, ref.id, workspaceId).catch(() => null)
        : stores[ref.kind].get(ref.id);
    if (value?.workspaceId === workspaceId) {
      records.push({ ...ref, value });
    }
  }
  return records;
}

export async function getRecallStructures(
  state: InMemoryStorageState,
  workspaceId: string,
  sourceIds: string[],
  hyperedgeLimitPerMember: number,
  maxSensitivity?: Sensitivity
): Promise<RecallStructures> {
  const ids = new Set(sourceIds);
  const relations = [...state.relations.values()].filter(
    (relation) =>
      relation.workspaceId === workspaceId &&
      ids.has(relation.sourceId) &&
      !touchesHiddenRow(state, relation, maxSensitivity)
  );
  const counts = new Map<string, number>();
  const hyperedges: RecallStructures["hyperedges"] = [];
  for (const hyperedge of state.hyperedges.values()) {
    if (hyperedge.workspaceId !== workspaceId || hyperedge.validTo != null) continue;
    if (hasHiddenMember(state, hyperedge, maxSensitivity)) continue;
    for (const memberId of hyperedge.memberIds) {
      if (!ids.has(memberId)) continue;
      const count = counts.get(memberId) ?? 0;
      if (count >= hyperedgeLimitPerMember) continue;
      hyperedges.push({ memberId, hyperedge });
      counts.set(memberId, count + 1);
    }
  }
  return { relations, hyperedges };
}

// make-primitives-recallable (design.md D4/Interfaces, PR3 — Phase 5).
// Non-fact recall candidates over `state.decisions` — the only
// `RECALLABLE_KIND` besides `fact` today. `kinds` DRIVES the query (not a
// post-filter): a `kinds` array without `"decision"` scans nothing. Runs the
// semantic arm (cosine over `state.embeddings`, set via `setEmbedding(id,
// vec)` — mirrors `findSimilarEpisodes`'s in-memory shape) when `embedding`
// is supplied, the lexical arm (crude substring match over `title`+`body`,
// scored by fraction of matched terms — mirrors `fact-index.ts`'s
// `ftsCandidates`) when `terms` is supplied, both when both are supplied,
// neither (→ `[]`, no scan) otherwise. Merges by id, keeping the higher score
// when both arms hit the same decision.
export async function recallableCandidates(
  state: InMemoryStorageState,
  query: PrimitiveCandidateQuery
): Promise<PrimitiveCandidate[]> {
  if (!query.kinds.includes("decision")) return [];
  const hasSemantic = query.embedding !== undefined && query.embedding.length > 0;
  const hasLexical = query.terms !== undefined && query.terms.length > 0;
  if (!hasSemantic && !hasLexical) return [];

  const isCurrent = (d: MnemoDecision): boolean =>
    d.workspaceId === query.workspaceId &&
    d.status === "active" &&
    d.validTo == null &&
    (query.scopeOwner === undefined || d.scopeOwner === query.scopeOwner);

  const byId = new Map<string, PrimitiveCandidate>();

  if (hasSemantic) {
    const minSim = query.minSimilarity ?? 0;
    for (const d of state.decisions.values()) {
      if (!isCurrent(d)) continue;
      const vec = state.embeddings.get(d.id);
      if (!vec) continue;
      const cosine = cosineSimilarity(query.embedding!, vec);
      if (cosine < minSim) continue;
      byId.set(d.id, {
        id: d.id,
        kind: "decision",
        score: cosine,
        sensitivity: d.sensitivity,
        similarity: cosine,
      });
    }
  }

  if (hasLexical) {
    const terms = query.terms!.map((t) => t.toLowerCase());
    for (const d of state.decisions.values()) {
      if (!isCurrent(d)) continue;
      const hay = `${d.title} ${d.body}`.toLowerCase();
      const matched = terms.filter((t) => hay.includes(t)).length;
      if (matched === 0) continue;
      const score = matched / terms.length;
      const existing = byId.get(d.id);
      // Mirrors the Postgres lexical arm: a matched row's cosine comes back too.
      const vec = hasSemantic ? state.embeddings.get(d.id) : undefined;
      const lexicalCosine = vec ? cosineSimilarity(query.embedding!, vec) : undefined;
      // Per-arm evidence, as the Postgres adapter reports it: `score` keeps
      // the larger value, `similarity` and `lexicalRank` keep each arm's own.
      byId.set(d.id, {
        id: d.id,
        kind: "decision",
        score: Math.max(score, existing?.score ?? 0),
        sensitivity: d.sensitivity,
        ...(lexicalCosine !== undefined ? { similarity: lexicalCosine } : {}),
        lexicalRank: score,
      });
    }
  }

  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, query.limit);
}

/** Mirrors RecallRepository.getUnresolvedConflictIds: either end of an open conflicts_with. */
export async function getUnresolvedConflictIds(
  state: InMemoryStorageState,
  workspaceId: string,
  ids: string[],
  maxSensitivity?: Sensitivity
): Promise<string[]> {
  const wanted = new Set(ids);
  const out = new Set<string>();
  for (const relation of state.relations.values()) {
    if (relation.workspaceId !== workspaceId) continue;
    if (relation.verb !== "conflicts_with" || relation.validTo != null) continue;
    if (touchesHiddenRow(state, relation, maxSensitivity)) continue;
    if (wanted.has(relation.sourceId)) out.add(relation.sourceId);
    if (wanted.has(relation.targetId)) out.add(relation.targetId);
  }
  return [...out];
}

export async function getRecallLog(
  state: InMemoryStorageState,
  workspaceId: string,
  memoryId: string,
  limit: number
): Promise<Array<{ id: string; recalledAt: string; recallScore: number }>> {
  return state.mnemoRecallLog
    .filter((e) => e.workspaceId === workspaceId && e.memoryId === memoryId)
    .slice(-limit)
    .reverse()
    .map(({ id, recalledAt, recallScore }) => ({ id, recalledAt, recallScore }));
}

export async function getRecallLogs(
  state: InMemoryStorageState,
  workspaceId: string,
  memoryIds: string[],
  limitPerMemory: number
): Promise<RecallLogRecord[]> {
  const ids = new Set(memoryIds);
  const counts = new Map<string, number>();
  const out: RecallLogRecord[] = [];
  for (let index = state.mnemoRecallLog.length - 1; index >= 0; index--) {
    const entry = state.mnemoRecallLog[index]!;
    if (entry.workspaceId !== workspaceId || !ids.has(entry.memoryId)) continue;
    const count = counts.get(entry.memoryId) ?? 0;
    if (count >= limitPerMemory) continue;
    out.push({
      memoryId: entry.memoryId,
      id: entry.id,
      recalledAt: entry.recalledAt,
      recallScore: entry.recallScore,
    });
    counts.set(entry.memoryId, count + 1);
  }
  return out;
}

export async function getRecentQueriesForFacts(
  state: InMemoryStorageState,
  workspaceId: string,
  factIds: string[],
  limit: number
): Promise<string[]> {
  if (factIds.length === 0) return [];
  const factIdSet = new Set(factIds);
  // Collect entries matching workspace + factIds with a non-empty queryText
  const matching = state.recallLog.filter(
    (e) =>
      e.workspaceId === workspaceId &&
      factIdSet.has(e.factId) &&
      typeof e.queryText === "string" &&
      e.queryText.trim() !== ""
  );
  // Deduplicate by queryText, preserving most-recent order (recallLog is
  // push-appended so the last element is the most recent).
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = matching.length - 1; i >= 0 && result.length < limit; i--) {
    const entry = matching[i];
    const q = entry?.queryText;
    // q is guaranteed non-null/non-empty by the filter above, but narrow for TS
    if (q != null && !seen.has(q)) {
      seen.add(q);
      result.push(q);
    }
  }
  return result;
}

export async function getRecalledFactIds(
  state: InMemoryStorageState,
  workspaceId: string,
  sessionId: string
): Promise<string[]> {
  const seen = new Set<string>();
  for (const entry of state.recallLog) {
    if (syntheticRecallRows.has(entry)) continue; // telemetry only, never session learning
    if (entry.workspaceId === workspaceId && entry.sessionId === sessionId) {
      seen.add(entry.factId);
    }
  }
  return [...seen];
}

export async function updateWorth(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  primitiveKind: PrimitiveKind,
  delta: WorthDelta
): Promise<void> {
  switch (primitiveKind) {
    case "fact": {
      const f = state.facts.get(id);
      if (!f || f.workspaceId !== workspaceId) return;
      // Worth is snapshotted by the consolidation merge — a generic worth
      // bump on a pending fact would corrupt the rollback baseline. No-op.
      if (hasPendingMarker(f.metadata)) return;
      const sDelta = delta.success * delta.creditWeight;
      const fDelta = delta.failure * delta.creditWeight;
      f.worthAlpha = (f.worthAlpha ?? 2) + sDelta;
      f.worthBeta = (f.worthBeta ?? 2) + fDelta;
      f.worthSuccess = (f.worthSuccess ?? 0) + sDelta;
      f.worthFailure = (f.worthFailure ?? 0) + fDelta;
      const denom = f.worthAlpha + f.worthBeta;
      f.worth = denom > 0 ? f.worthAlpha / denom : 0;
      f.updatedAt = new Date();
      break;
    }
    case "hyperedge": {
      const h = state.hyperedges.get(id);
      if (!h || h.workspaceId !== workspaceId) return;
      const netDelta = (delta.success - delta.failure) * delta.creditWeight * 0.1;
      h.worth = Math.min(1.0, Math.max(0.0, h.worth + netDelta));
      break;
    }
    case "reasoning": {
      const r = state.reasonings.get(id);
      if (!r || r.workspaceId !== workspaceId) return;
      const newSuccess =
        (r.successCount ?? 0) + Math.round((delta.success ?? 0) * (delta.creditWeight ?? 1));
      const newFailure =
        (r.failureCount ?? 0) + Math.round((delta.failure ?? 0) * (delta.creditWeight ?? 1));
      const total = newSuccess + newFailure;
      state.reasonings.set(id, {
        ...r,
        successCount: newSuccess,
        failureCount: newFailure,
        worth: total === 0 ? 0.5 : newSuccess / total,
        updatedAt: new Date(),
      });
      break;
    }
    default:
      // Other primitive kinds have no worth columns — no-op
      break;
  }
}

export async function recordRecall(
  state: InMemoryStorageState,
  entry: RecallLogEntry
): Promise<void> {
  state.recallLog.push({ ...entry, recalledAt: new Date() });
  // Postgres writes ONE table, mnemo_recall_log, and getRecallLog(s) read the
  // activation history back from it. This double kept two logs and fed only
  // the one nothing reads, so every recall through it ran at activation 0 and
  // could never reproduce what activation does to ranking (RECALL-1).
  state.mnemoRecallLog.push({
    id: uuid(),
    workspaceId: entry.workspaceId,
    memoryId: entry.factId,
    recalledAt: new Date().toISOString(),
    recallScore: entry.activationScore ?? 0,
  });
  // Increment hitCount on the referenced fact
  const f = state.facts.get(entry.factId);
  if (f) state.facts.set(f.id, { ...f, hitCount: f.hitCount + 1, lastRecalledAt: new Date() });
}

/**
 * recallLog rows written by synthetic/test requests (Postgres: organicRecallLogRow).
 * Keyed by row identity, so nothing leaks between adapter instances.
 */
const syntheticRecallRows = new WeakSet<object>();

/** Per-adapter-instance observation store; never module-level, so tests cannot leak. */
export interface RecallObservationStore {
  requests: Map<string, RecallRequestObservation>;
  hits: RecallHitObservation[];
}

export const createRecallObservationStore = (): RecallObservationStore => ({
  requests: new Map(),
  hits: [],
});

/** Mirrors RecallRepository.recordRecallObservation: replay-safe, organic-only fact counters. */
export async function recordRecallObservation(
  state: InMemoryStorageState,
  store: RecallObservationStore,
  request: RecallRequestObservation,
  hits: RecallHitObservation[]
): Promise<void> {
  const key = `${request.workspaceId}\u0000${request.requestId}`;
  const prior = store.requests.get(key);
  // Replayed request: no duplicate hits or increments — except a completed
  // retry of an error-only attempt (same X-Request-Id), which upgrades it.
  if (prior && !(prior.status === "error" && request.status !== "error")) return;
  store.requests.set(key, { ...request });
  const organic = request.trafficOrigin !== "synthetic" && request.trafficOrigin !== "test";
  for (const hit of hits) {
    if (hit.workspaceId !== request.workspaceId) continue; // never cross-workspace
    store.hits.push({ ...hit });
    if (hit.primitiveKind === "fact") {
      // Same mnemo_recall_log row Postgres writes: session feedback, governance
      // (getRecalledFactIds) and precision (getRecallPrecision) read it.
      const row = {
        workspaceId: hit.workspaceId,
        factId: hit.memoryId,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        // Organic rows only: replay / conditional anticipation read query_text.
        ...(organic && request.queryText ? { queryText: request.queryText } : {}),
        hitRank: hit.rank,
        tdCredit: hit.tdCredit ?? 0,
        activationScore: hit.score,
        latencyMs: Math.round(request.totalDurationMs),
        // Like recordRecall: latency and metrics readers need the timestamp.
        recalledAt: new Date(),
      };
      state.recallLog.push(row);
      if (!organic) syntheticRecallRows.add(row);
    }
    // Activation history excludes synthetic/test traffic (Postgres read filter).
    if (organic)
      state.mnemoRecallLog.push({
        id: uuid(),
        workspaceId: hit.workspaceId,
        memoryId: hit.memoryId,
        recalledAt: new Date().toISOString(),
        recallScore: hit.score,
      });
    const f = hit.primitiveKind === "fact" ? state.facts.get(hit.memoryId) : undefined;
    if (f && organic && f.workspaceId === hit.workspaceId) {
      state.facts.set(f.id, { ...f, hitCount: f.hitCount + 1, lastRecalledAt: new Date() });
    }
  }
}

export async function getTdPredecessors(
  _state: InMemoryStorageState,
  _workspaceId: string,
  _sessionId: string,
  _excludeFactId: string
): Promise<Array<{ factId: string; tdCredit: number; recalledAt: Date }>> {
  // In-memory stub: returns empty array (sufficient for unit tests that mock this)
  return [];
}

/** Linear-interpolated percentile over an ascending array, like Postgres percentile_cont. */
function percentileCont(sorted: number[], p: number): number {
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

/** Mirrors RecallRepository.getRecallLatency: rows in the window with a latency, rounded. */
export async function getRecallLatency(
  state: InMemoryStorageState,
  workspaceId: string,
  days: number
): Promise<{ p50Ms: number | null; p95Ms: number | null; samples: number }> {
  const since = Date.now() - days * 86_400_000;
  const ms = state.recallLog
    .filter(
      (e) =>
        e.workspaceId === workspaceId &&
        e.latencyMs != null &&
        (e.recalledAt?.getTime() ?? 0) >= since
    )
    .map((e) => e.latencyMs as number)
    .sort((a, b) => a - b);
  if (ms.length === 0) return { p50Ms: null, p95Ms: null, samples: 0 };
  return {
    p50Ms: Math.round(percentileCont(ms, 0.5)),
    p95Ms: Math.round(percentileCont(ms, 0.95)),
    samples: ms.length,
  };
}

/**
 * recall-precision-report (harden-hooks-and-measure-precision, Requirement 5/6).
 * Mirrors RecallRepository.getRecallPrecision's SQL definition of "credited"
 * exactly (see design.md): a hit is credited only when its session collapsed
 * AND created ≥1 fact, and it falls within the 20-most-recently-recalled
 * window for that session. `state.recallLog` is push-appended in chronological
 * order, so recency rank is derived from array position (entries also carry
 * `recalledAt`, but position is the tiebreak-free order).
 */
export async function getRecallPrecision(
  state: InMemoryStorageState,
  workspaceId: string
): Promise<RecallPrecisionReport> {
  const K_VALUES = [1, 3, 5] as const;

  const entries = state.recallLog.filter(
    (e) => e.workspaceId === workspaceId && e.sessionId != null && e.hitRank != null
  );

  const bySession = new Map<string, RecallLogEntry[]>();
  for (const e of entries) {
    const list = bySession.get(e.sessionId!) ?? [];
    list.push(e);
    bySession.set(e.sessionId!, list);
  }

  const sessionCreatedFact = (sessionId: string): boolean => {
    for (const f of state.facts.values()) {
      if (f.workspaceId === workspaceId && f.sessionId === sessionId) return true;
    }
    return false;
  };

  let totalHits = 0;
  let pendingHits = 0;
  const denom: Record<number, number> = { 1: 0, 3: 0, 5: 0 };
  const num: Record<number, number> = { 1: 0, 3: 0, 5: 0 };

  for (const [sessionId, list] of bySession) {
    const session = state.sessions.get(sessionId);
    // NOTE: the in-memory `closeSession` (in-memory/sessions.ts) sets
    // `status = "collapsed"` but does not populate `collapsedAt` — unlike the
    // Postgres adapter's `closeSession`, which sets both. `status` is this
    // adapter's actual collapse signal; mirroring `collapsedAt IS NOT NULL`
    // literally here would make every in-memory session look pending.
    const collapsed =
      session != null && session.workspaceId === workspaceId && session.status === "collapsed";
    const eligibleForCredit = collapsed && sessionCreatedFact(sessionId);
    const n = list.length;
    list.forEach((e, idx) => {
      totalHits++;
      if (!collapsed) {
        pendingHits++;
        return;
      }
      const recencyRank = n - idx; // list is chronological ASC; 1 = most recent
      const credited = eligibleForCredit && recencyRank <= 20;
      for (const k of K_VALUES) {
        if ((e.hitRank ?? Number.POSITIVE_INFINITY) < k) {
          denom[k]! += 1;
          if (credited) num[k]! += 1;
        }
      }
    });
  }

  const precisionAtK: RecallPrecisionAtK[] = K_VALUES.map((k) => {
    const sampleSize = denom[k]!;
    const credited = num[k]!;
    return { k, sampleSize, precision: sampleSize > 0 ? credited / sampleSize : null };
  });

  return {
    workspaceId,
    computedAt: new Date(),
    totalHits,
    pendingHits,
    precisionAtK,
    insufficientData: precisionAtK.every((p) => p.sampleSize === 0),
    methodologyNote: RECALL_PRECISION_METHODOLOGY_NOTE,
  };
}

/**
 * Mirrors RecallRepository.getRecallMetrics: `recall` audit entries are the calls
 * (a numeric `detail.resultCount` makes one readable), `hitRank === 0` recall-log
 * rows carry each serving call's latency. `days` UTC days ending today.
 */
export async function getRecallMetrics(
  state: InMemoryStorageState,
  workspaceId: string,
  days: number
): Promise<RecallMetrics> {
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  const dayOf = (d: Date) => d.toISOString().slice(0, 10);
  const keys = Array.from({ length: days }, (_, i) =>
    new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10)
  );
  const inWindow = new Set(keys);
  const calls = state.auditLog.filter(
    (e) =>
      e.workspaceId === workspaceId && e.action === "recall" && inWindow.has(dayOf(e.createdAt))
  );
  const served = state.recallLog.filter(
    (e) =>
      e.workspaceId === workspaceId &&
      e.hitRank === 0 &&
      e.latencyMs != null &&
      e.recalledAt != null &&
      inWindow.has(dayOf(e.recalledAt))
  );
  const window = (day?: string): RecallMetricsWindow => {
    const c = day ? calls.filter((e) => dayOf(e.createdAt) === day) : calls;
    const known = c.filter((e) => typeof e.detail?.["resultCount"] === "number");
    const ms = (day ? served.filter((e) => dayOf(e.recalledAt!) === day) : served)
      .map((e) => e.latencyMs as number)
      .sort((a, b) => a - b);
    return {
      queries: c.length,
      zeroHitShare: known.length
        ? known.filter((e) => e.detail!["resultCount"] === 0).length / known.length
        : null,
      p50Ms: ms.length ? Math.round(percentileCont(ms, 0.5)) : null,
      p95Ms: ms.length ? Math.round(percentileCont(ms, 0.95)) : null,
    };
  };
  return { days: keys.map((day) => ({ day, ...window(day) })), totals: window() };
}

/** Mirrors RecallRepository.getFactStats: live facts at or under the ceiling. */
export async function getFactStats(
  state: InMemoryStorageState,
  input: { workspaceId: string; maxSensitivity?: Sensitivity }
): Promise<FactStats> {
  const ceiling = SENSITIVITY_ORDER[input.maxSensitivity ?? "restricted"];
  const live = [...state.facts.values()].filter(
    (f) =>
      f.workspaceId === input.workspaceId &&
      f.validTo == null &&
      f.status === "active" &&
      SENSITIVITY_ORDER[f.sensitivity ?? "internal"] <= ceiling
  );
  // Largest group first, then by name, like the repository's ORDER BY.
  const tally = (key: (f: (typeof live)[number]) => string): Array<[string, number]> => {
    const counts = new Map<string, number>();
    for (const f of live) counts.set(key(f), (counts.get(key(f)) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  };
  return {
    live: live.length,
    pinned: live.filter((f) => f.pinned).length,
    neverRecalled: live.filter((f) => (f.hitCount ?? 0) === 0).length,
    lastWriteAt: live.length
      ? new Date(Math.max(...live.map((f) => f.createdAt.getTime()))).toISOString()
      : null,
    byKind: tally((f) => f.kind).map(([kind, count]) => ({ kind, count })),
    bySensitivity: tally((f) => f.sensitivity ?? "internal").map(([s, count]) => ({
      sensitivity: s as Sensitivity,
      count,
    })),
    byMemoryType: tally((f) => f.memoryType ?? "semantic").map(([memoryType, count]) => ({
      memoryType,
      count,
    })),
  };
}

/**
 * Mirrors RecallRepository.getContextEconomy (APP-015). The in-memory store
 * keeps no request timestamps, so every recorded request counts.
 */
export async function getContextEconomy(
  state: InMemoryStorageState,
  store: RecallObservationStore,
  workspaceId: string,
  _days: number,
  maxSensitivity: Sensitivity
): Promise<{
  recalls: number;
  servedCharsAvg: number | null;
  servedCharsP95: number | null;
  liveFacts: number;
  liveFactChars: number;
}> {
  const served = [...store.requests.values()]
    .filter((r) => r.workspaceId === workspaceId && typeof r.servedChars === "number")
    .map((r) => r.servedChars as number)
    .sort((a, b) => a - b);
  const live = [...state.facts.values()].filter(
    (f) =>
      f.workspaceId === workspaceId &&
      f.status === "active" &&
      f.validTo == null &&
      plaintextTiersAtOrBelow(maxSensitivity).includes(f.sensitivity)
  );
  return {
    recalls: served.length,
    servedCharsAvg: served.length
      ? Math.round(served.reduce((a, b) => a + b, 0) / served.length)
      : null,
    servedCharsP95: served.length ? Math.round(percentileCont(served, 0.95)) : null,
    liveFacts: live.length,
    liveFactChars: live.reduce((n, f) => n + f.statement.length, 0),
  };
}
