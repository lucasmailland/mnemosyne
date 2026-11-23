// in-memory/facts.ts — Facts domain module for InMemoryStorageAdapter.
// decompose-inmemory-storage-adapter Batch B13a/B13b/B13c (design.md Module Map row 5).
// Move-only: bodies are verbatim transplants, `this.` -> `state.` is the only edit (D7).
// This is the largest module in the whole Module Map (13 methods).

import type {
  CreateFactInput,
  UpdateFactInput,
  MergeFactByTopicKeyInput,
  ReplaceFactInput,
  ReplaceFactResult,
  FindLiveFactByStatementInput,
  FactFilter,
  FactPageFilter,
  FactPage,
  PurgeFactsFilter,
  PurgeFactsResult,
  FindContradictingFactsInput,
  ContradictingFact,
} from "../../ports.js";
import type { MnemoFact } from "../../primitives.js";
import type { MnemoRelation } from "../../relations.js";
import type { PaginatedResult } from "../../common.js";
import { SENSITIVITY_ORDER } from "../../security.js";
import {
  DEFAULT_CONTRADICTION_MIN_SIMILARITY,
  FactRevisionConflictError,
  isSpecificFactSubject,
} from "../../ports.js";
import type { InMemoryStorageState } from "./state.js";
import { factStatementHash } from "../../fact-hash.js";
import {
  closeAt,
  uuid,
  paginate,
  hasPendingMarker,
  withoutPendingMarker,
  PENDING_KEY,
  cosineSimilarity,
} from "./support.js";
import { scopeRefMatches } from "../../scope-ref.js";

export async function createFact(
  state: InMemoryStorageState,
  input: CreateFactInput
): Promise<MnemoFact> {
  const now = new Date();
  const fact: MnemoFact = {
    id: uuid(),
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    actorId: input.actorId,
    userId: input.userId,
    actorType: input.actorType,
    scope: input.scope,
    scopeRef: input.scopeRef,
    scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
    statement: input.statement,
    subject: input.subject,
    kind: input.kind,
    confidence: input.confidence ?? 0.8,
    relevance: input.relevance ?? 0.8,
    hitCount: 0,
    worthSuccess: 0,
    worthFailure: 0,
    worthAlpha: 2,
    worthBeta: 2,
    worth: 0.5,
    memoryType: "semantic",
    memoryStrength: 1,
    memoryStability: 1,
    attribution: input.attribution ?? "inferred",
    sourceMessageIds: input.sourceMessageIds ?? [],
    // flatten-legacy-dual-core PR9a: physical `linked_memory_ids` is
    // NOT NULL DEFAULT '{}' — CreateFactInput has no setter for it (same
    // as the real column default), so it always starts empty.
    linkedMemoryIds: [],
    sessionId: input.sessionId,
    extractionSource: input.extractionSource,
    topicKey: input.topicKey,
    revisionCount: 1,
    protocolVersion: "3.0",
    entityId: input.entityId,
    episodeId: input.episodeId,
    status: input.status ?? "active",
    pinned: input.pinned ?? false,
    canonical: false,
    sensitivity: input.sensitivity ?? "internal",
    validFrom: input.validFrom ?? now,
    validTo: input.validTo,
    embeddingStale: true,
    createdAt: now,
    updatedAt: now,
    // Generic creators may never forge a pending-consolidation marker — only
    // applyConsolidationMerge is allowed to attach it. Strip any supplied key.
    metadata: withoutPendingMarker(input.metadata ?? {}),
  };
  state.facts.set(fact.id, fact);
  // P130 — production writes the precomputed vector onto the ROW
  // (`mnemo_fact.embedding`) inside createFact, so anything querying by cosine
  // sees it immediately. Here the vector only ever reached the outbox payload,
  // and `state.embeddings` was populated exclusively by the `setEmbedding` test
  // helper — so a fact created the normal way had no vector, and any semantic
  // query against this double silently found nothing.
  //
  // That is the same divergence class already corrected twice in this area
  // (`updateEmbeddingVector` was a pure no-op; `listStaleEmbeddings` returned
  // `[]` unconditionally) and it is the worst possible shape for a double:
  // every "found no candidates" assertion passes by construction.
  if (input.embedding && input.embedding.length > 0) {
    state.embeddings.set(fact.id, [...input.embedding]);
  }
  // Mirror FactRepository.createFact: a precomputed embedding yields the
  // authoritative vector-form payload (no re-embed clobber); otherwise the
  // text-form payload the worker would embed (make-primitives-recallable
  // PR1 — was previously missing `text` here, unlike FactRepository's
  // already-existing fallback at FactRepository.ts:218-224, so a fact
  // created without a precomputed embedding carried no indexable payload
  // at all against InMemoryStorageAdapter).
  state.outbox.push({
    id: uuid(),
    workspaceId: fact.workspaceId,
    eventType: "vector_upsert",
    payload:
      input.embedding && input.embedding.length > 0
        ? { id: fact.id, kind: "fact", vector: input.embedding }
        : { id: fact.id, kind: "fact", text: fact.statement },
    createdAt: new Date(),
    attempts: 0,
  });
  return fact;
}

/** CHAOS-7 — mirrors FactRepository.findLiveFactByStatement (the dedup key). */
export async function findLiveFactByStatement(
  state: InMemoryStorageState,
  input: FindLiveFactByStatementInput
): Promise<MnemoFact | null> {
  for (const f of state.facts.values()) {
    if (
      f.workspaceId === input.workspaceId &&
      f.scope === input.scope &&
      (f.scopeRef ?? "") === (input.scopeRef ?? "") &&
      f.subject === input.subject &&
      f.statement === input.statement &&
      (input.scopeOwner === undefined ||
        (f.scopeOwner ?? `workspace:${input.workspaceId}`) === input.scopeOwner) &&
      (input.sensitivity === undefined || f.sensitivity === input.sensitivity) &&
      f.status === "active" &&
      f.validTo == null
    ) {
      return f;
    }
  }
  return null;
}

export async function getFact(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoFact | null> {
  const f = state.facts.get(id);
  return f && f.workspaceId === workspaceId ? f : null;
}

export async function findFactByImportedId(
  state: InMemoryStorageState,
  workspaceId: string,
  importedId: string
): Promise<MnemoFact | null> {
  for (const f of state.facts.values()) {
    if (f.workspaceId === workspaceId && f.metadata?.["importedId"] === importedId) return f;
  }
  return null;
}

export async function updateFact(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  input: UpdateFactInput
): Promise<MnemoFact | null> {
  const f = state.facts.get(id);
  if (!f || f.workspaceId !== workspaceId) return null;
  const pending = hasPendingMarker(f.metadata);
  // `pinned` is a consolidation-gate eligibility input — a pending row must
  // never have its pinned flag flipped by a generic writer. Reject before any
  // mutation so the caller cannot spread `pinned` into a pending fact.
  if (pending && input.pinned !== undefined) return null;
  if (input.statement !== undefined && (f.status !== "active" || f.validTo !== undefined))
    return null;
  // CHAOS-8: mirrors FactRepository — a stale precondition changes nothing.
  if (input.expectedRevision !== undefined && input.expectedRevision !== f.revisionCount) {
    throw new FactRevisionConflictError(id, input.expectedRevision, f.revisionCount);
  }
  // P85.2 — `validTo: null` means "reopen the interval". MnemoFact models an open
  // interval as `undefined`, and this file tests it with `!== undefined` (line
  // above), so spreading `null` straight through would read as CLOSED and invert
  // the very operation being requested. Destructured out and normalised so the
  // three cases stay distinct: absent leaves it untouched, `null` reopens,
  // a Date closes. This null/undefined split is the same one that made
  // GET /conflicts always empty (P75).
  const { validTo: validToInput, expectedRevision: _expected, ...restInput } = input;
  const updated: MnemoFact = {
    ...f,
    ...restInput,
    ...(validToInput !== undefined
      ? { validTo: validToInput ? closeAt(validToInput, f.validFrom) : undefined }
      : {}),
    revisionCount: f.revisionCount + 1,
    updatedAt: new Date(),
    // P111: mirrors DrizzleStorageAdapter — an in-place text change leaves the
    // stored vector describing the previous text, and `embedding_model` is
    // unchanged so the model-based migration never picks it up. Kept in step
    // with the real adapter deliberately: a double that is more forgiving than
    // production is how a test proves something production does not do.
    ...(input.statement !== undefined && input.statement !== f.statement
      ? { embeddingStale: true }
      : {}),
  };
  // P126: the dedupe fingerprint is derived from the statement, so an in-place
  // edit orphans it — and an orphaned fingerprint is not a stale index, it is a
  // lost write: the next `remember()` of the ORIGINAL text matches it, gets
  // handed this fact's id, and stores nothing. Mirrors DrizzleStorageAdapter,
  // and uses the SAME shared hash helper, because two implementations of the
  // formula are exactly how the double stops reproducing production.
  if (input.statement !== undefined && input.statement !== f.statement) {
    state.factHashes.delete(`${workspaceId}|${factStatementHash(f.statement, f.subject)}`);
  }

  // Metadata updates atomically strip a caller-supplied marker (anti-spoofing)
  // while reattaching the genuine current marker when the row is pending.
  if (input.metadata !== undefined) {
    const stripped = withoutPendingMarker(input.metadata);
    updated.metadata = pending ? { ...stripped, [PENDING_KEY]: f.metadata[PENDING_KEY] } : stripped;
  }
  state.facts.set(id, updated);
  return updated;
}

export async function mergeFactByTopicKey(
  state: InMemoryStorageState,
  input: MergeFactByTopicKeyInput
): Promise<MnemoFact | null> {
  const fact = [...state.facts.values()].find(
    (candidate) =>
      candidate.workspaceId === input.workspaceId &&
      candidate.topicKey === input.topicKey &&
      candidate.status === "active" &&
      candidate.validTo == null
  );
  if (!fact) return null;
  // B6.35: a pending-consolidation fact must not be mutated via topic-key
  // merge — the || merge could overwrite the genuine pending marker.
  if (hasPendingMarker(fact.metadata)) return null;
  const existingTags = Array.isArray(fact.metadata.tags)
    ? fact.metadata.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const metadataTags = Array.isArray(input.metadata?.tags)
    ? input.metadata.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const tags = [...new Set([...existingTags, ...metadataTags, ...(input.tags ?? [])])];
  const metadata = {
    ...fact.metadata,
    ...(input.metadata ?? {}),
    ...(tags.length ? { tags } : {}),
  };
  const updated = {
    ...fact,
    statement: input.statement,
    metadata,
    revisionCount: fact.revisionCount + 1,
    embeddingModel: undefined,
    embeddingStale: true,
    updatedAt: new Date(),
    // Mirrors FactRepository: a given session re-homes the provenance.
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId, episodeId: undefined } : {}),
    ...(input.extractionSource !== undefined ? { extractionSource: input.extractionSource } : {}),
  };
  state.facts.set(fact.id, updated);
  state.embeddings.delete(fact.id);
  state.factLsh.delete(`${input.workspaceId}:${fact.id}`);
  return updated;
}

export async function replaceFact(
  state: InMemoryStorageState,
  input: ReplaceFactInput
): Promise<ReplaceFactResult | null> {
  // Hash before reading the source. After this await, validation and every map
  // mutation are synchronous, so concurrent calls cannot both replace it.
  const sourceBeforeHash = state.facts.get(input.id);
  const hash = await factStatementHash(input.statement, sourceBeforeHash?.subject ?? "");
  const source = state.facts.get(input.id);
  const now = new Date();
  if (
    !source ||
    source.workspaceId !== input.workspaceId ||
    source.status !== "active" ||
    source.validTo != null ||
    source.validFrom.getTime() > now.getTime() ||
    hasPendingMarker(source.metadata) ||
    (input.actorIsolationId != null &&
      source.actorId != null &&
      source.actorId !== input.actorIsolationId) ||
    (input.userIsolationId != null &&
      source.userId != null &&
      source.userId !== input.userIsolationId)
  ) {
    return null;
  }

  const previous: MnemoFact = {
    ...source,
    status: "forgotten",
    validTo: now,
    updatedAt: now,
  };
  const replacement: MnemoFact = {
    ...source,
    id: uuid(),
    agentId: input.agentId ?? source.agentId,
    statement: input.statement,
    revisionCount: source.revisionCount + 1,
    status: "active",
    validFrom: now,
    validTo: undefined,
    embedding: undefined,
    embeddingModel: undefined,
    embeddingStale: true,
    createdAt: now,
    updatedAt: now,
    // A replacement is a brand-new fact — it must never inherit the source's
    // pending-consolidation marker, or a rollback would resurrect a stranger.
    metadata: withoutPendingMarker(source.metadata),
  };

  state.facts.set(source.id, previous);
  state.facts.set(replacement.id, replacement);
  state.factLsh.delete(`${input.workspaceId}:${source.id}`);
  state.queryCache = state.queryCache.filter((entry) => entry.workspaceId !== input.workspaceId);

  state.outbox.push(
    {
      id: uuid(),
      workspaceId: input.workspaceId,
      eventType: "vector_delete",
      payload: { id: source.id, kind: "fact" },
      createdAt: now,
      attempts: 0,
    },
    {
      id: uuid(),
      workspaceId: input.workspaceId,
      eventType: "cache_bust",
      payload: { pattern: `mnemo:${input.workspaceId}:*` },
      createdAt: now,
      attempts: 0,
    }
  );
  if (SENSITIVITY_ORDER[source.sensitivity] < SENSITIVITY_ORDER.confidential) {
    state.outbox.push({
      id: uuid(),
      workspaceId: input.workspaceId,
      eventType: "vector_upsert",
      payload: { id: replacement.id, kind: "fact", text: input.statement },
      createdAt: now,
      attempts: 0,
    });
  }

  const relation: MnemoRelation = {
    id: uuid(),
    workspaceId: input.workspaceId,
    sourceId: replacement.id,
    sourceType: "fact",
    targetId: source.id,
    targetType: "fact",
    verb: "supersedes",
    weight: 1,
    coRecallCount: 0,
    directionality: 0,
    createdAt: now,
    updatedAt: now,
    validFrom: now,
    validTo: null,
    judgmentStatus: "pending",
    reason: null,
    evidence: null,
    confidence: null,
    markedByUserId: null,
    markedByKind: "system",
    markedByModel: null,
    markedByPromptVersion: null,
    provenance: null,
    conversationId: null,
    supersededByRelationId: null,
  };
  state.relations.set(relation.id, relation);

  const hashKey = `${input.workspaceId}|${hash}`;
  const existingHash = state.factHashes.get(hashKey);
  state.factHashes.set(
    hashKey,
    existingHash
      ? {
          ...existingHash,
          factId: replacement.id,
          lastSeenAt: now,
          seenCount: existingHash.seenCount + 1,
        }
      : {
          workspaceId: input.workspaceId,
          statementHash: hash,
          factId: replacement.id,
          firstSeenAt: now,
          lastSeenAt: now,
          seenCount: 1,
        }
  );

  return { previous, replacement };
}

export async function archiveFact(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<boolean> {
  const f = state.facts.get(id);
  // PRIM-3: mirrors FactRepository.archiveFact — only an open fact transitions.
  if (
    !f ||
    f.workspaceId !== workspaceId ||
    f.validTo != null ||
    f.status === "forgotten" ||
    hasPendingMarker(f.metadata)
  ) {
    return false;
  }
  state.facts.set(id, { ...f, status: "forgotten", validTo: new Date() });
  return true;
}

/**
 * P109 — mirrors FactRepository.linkSessionFactsToEpisode: fills `episodeId`
 * for a session's facts, never overwriting one that is already set.
 */
export async function linkSessionFactsToEpisode(
  state: InMemoryStorageState,
  workspaceId: string,
  sessionId: string,
  episodeId: string
): Promise<number> {
  let linked = 0;
  for (const [id, f] of state.facts) {
    if (f.workspaceId !== workspaceId) continue;
    if (f.sessionId !== sessionId) continue;
    if (f.episodeId) continue;
    state.facts.set(id, { ...f, episodeId });
    linked++;
  }
  return linked;
}

export async function queryFacts(
  state: InMemoryStorageState,
  filter: FactFilter
): Promise<PaginatedResult<MnemoFact>> {
  let items = [...state.facts.values()].filter((f) => f.workspaceId === filter.workspaceId);
  if (filter.status) items = items.filter((f) => f.status === filter.status);
  if (filter.kind) items = items.filter((f) => f.kind === filter.kind);
  if (filter.sessionId) items = items.filter((f) => f.sessionId === filter.sessionId);
  if (filter.entityId) items = items.filter((f) => f.entityId === filter.entityId);
  if (filter.topicKey) items = items.filter((f) => f.topicKey === filter.topicKey);
  if (filter.minConfidence !== undefined)
    items = items.filter((f) => f.confidence >= filter.minConfidence!);
  // complete-mcp-tools B3 — additive: transaction-time lower bound +
  // newest-first ordering, mirrors FactRepository.queryFacts (Postgres).
  if (filter.createdSince) {
    const since = filter.createdSince;
    items = items.filter((f) => f.createdAt >= since);
    items = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  if (filter.maxSensitivity) {
    const ceiling = SENSITIVITY_ORDER[filter.maxSensitivity];
    items = items.filter((f) => SENSITIVITY_ORDER[f.sensitivity ?? "internal"] <= ceiling);
  }
  return paginate(items, filter.offset, filter.limit);
}

// ─── flatten-legacy-dual-core PR9b (D6.3) — keyset fact list + hard purge ──

export async function queryFactsPage(
  state: InMemoryStorageState,
  filter: FactPageFilter
): Promise<FactPage> {
  const limit = Math.min(Math.max(filter.limit, 1), 500);
  const status = filter.status ?? "active";
  const sortBy = filter.sortBy ?? "updated_at";
  const order = filter.order ?? "desc";
  const isDesc = order === "desc";
  const isTimestampSort = sortBy === "created_at" || sortBy === "updated_at";

  let items = [...state.facts.values()].filter((f) => f.workspaceId === filter.workspaceId);
  if (status !== "all") items = items.filter((f) => f.status === status);
  if (filter.kind) items = items.filter((f) => f.kind === filter.kind);
  if (filter.scope) items = items.filter((f) => f.scope === filter.scope);
  if (filter.scopeRef) items = items.filter((f) => scopeRefMatches(f.scopeRef, filter));
  if (filter.pinned !== undefined) items = items.filter((f) => f.pinned === filter.pinned);
  if (filter.sensitivity) items = items.filter((f) => f.sensitivity === filter.sensitivity);
  // PRIM-8 / PRIM-16: mirror FactRepository — ceiling and open interval are
  // filtered before `total` is taken.
  if (filter.maxSensitivity) {
    const ceiling = SENSITIVITY_ORDER[filter.maxSensitivity];
    items = items.filter((f) => SENSITIVITY_ORDER[f.sensitivity ?? "internal"] <= ceiling);
  }
  if (filter.currentOnly) items = items.filter((f) => f.validTo == null);
  if (filter.asOf) {
    const asOf = filter.asOf;
    items = items.filter((f) => f.validFrom <= asOf && (f.validTo == null || f.validTo > asOf));
  }
  if (filter.updatedSince) {
    const since = filter.updatedSince;
    items = items.filter((f) => f.updatedAt > since);
  }
  if (filter.createdSince) {
    const since = filter.createdSince;
    items = items.filter((f) => f.createdAt >= since);
  }
  if (filter.q && filter.q.trim().length > 0) {
    // FTS is a Postgres-only capability — substring match is the in-memory
    // stand-in, same convention as findContradictingFacts below.
    const q = filter.q.toLowerCase();
    items = items.filter((f) => f.statement.toLowerCase().includes(q));
  }

  const total = items.length;

  const sortValue = (f: MnemoFact): number => {
    switch (sortBy) {
      case "created_at":
        return f.createdAt.getTime();
      case "updated_at":
        return f.updatedAt.getTime();
      case "relevance":
        return f.relevance;
      case "hit_count":
        return f.hitCount;
    }
  };

  // Same ORDER BY sortColumn DIR, id DIR as the Postgres adapter — id
  // ties break in the SAME direction as the primary sort, not always asc.
  const sorted = [...items].sort((a, b) => {
    let primary = sortValue(a) - sortValue(b);
    if (primary === 0) primary = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return isDesc ? -primary : primary;
  });

  // Decode the opaque base64url cursor produced by a previous call.
  // Malformed cursors are silently dropped — caller gets the first page.
  let cursor: { v: string | number; id: string } | null = null;
  if (filter.cursor) {
    try {
      const json = Buffer.from(filter.cursor, "base64url").toString("utf8");
      const obj = JSON.parse(json) as Partial<{ v: string | number; id: string }>;
      if ((typeof obj.v === "string" || typeof obj.v === "number") && typeof obj.id === "string") {
        cursor = { v: obj.v, id: obj.id };
      }
    } catch {
      // ignore — caller gets the first page.
    }
  }

  let paged = sorted;
  if (cursor) {
    const cursorV = isTimestampSort ? new Date(String(cursor.v)).getTime() : Number(cursor.v);
    const cursorId = cursor.id;
    paged = sorted.filter((f) => {
      const v = sortValue(f);
      if (v !== cursorV) return isDesc ? v < cursorV : v > cursorV;
      return isDesc ? f.id < cursorId : f.id > cursorId;
    });
  }

  const hasMore = paged.length > limit;
  const page = paged.slice(0, limit);

  const cursorAfter = (f: MnemoFact): string => {
    const v = isTimestampSort
      ? (sortBy === "created_at" ? f.createdAt : f.updatedAt).toISOString()
      : sortValue(f);
    return Buffer.from(JSON.stringify({ v, id: f.id }), "utf8").toString("base64url");
  };
  const itemCursors = page.map(cursorAfter);
  const nextCursor = hasMore ? itemCursors[itemCursors.length - 1]! : null;

  return { items: page, nextCursor, total, itemCursors };
}

export async function purgeForgottenFacts(
  state: InMemoryStorageState,
  workspaceId: string,
  // Accepted for signature parity with the real adapter, which needs it for the
  // mnemo_deletion_log entry. This double has no deletion-log state to write to.
  _actorId?: string
): Promise<number> {
  let deletedCount = 0;
  for (const [id, f] of state.facts) {
    if (
      f.workspaceId === workspaceId &&
      f.status === "forgotten" &&
      !hasPendingMarker(f.metadata)
    ) {
      state.facts.delete(id);
      // P114: drop the content fingerprint with the fact, exactly as the
      // Postgres adapter now does. Deliberately mirrored here rather than left
      // out: P116 was invisible for as long as it was precisely because this
      // double disagreed with the real adapter and every unit test believed the
      // double. A test that passes against a double that leaks nothing, while
      // Postgres leaks, is worse than no test.
      for (const [key, h] of state.factHashes) {
        if (h.workspaceId === workspaceId && h.factId === id) state.factHashes.delete(key);
      }
      // PRIM-13: mirror the Postgres adapter — no open edge outlives its row.
      for (const [relId, r] of state.relations) {
        if (
          r.workspaceId === workspaceId &&
          r.validTo == null &&
          (r.sourceId === id || r.targetId === id)
        ) {
          state.relations.set(relId, { ...r, validTo: new Date() });
        }
      }
      deletedCount++;
    }
  }
  return deletedCount;
}

export async function findContradictingFacts(
  state: InMemoryStorageState,
  workspaceId: string,
  input: FindContradictingFactsInput
): Promise<ContradictingFact[]> {
  const limit = input.limit ?? 5;
  const wc = input.writeContext;
  const withinCeiling = (f: MnemoFact) =>
    (!input.maxSensitivity ||
      SENSITIVITY_ORDER[f.sensitivity] <= SENSITIVITY_ORDER[input.maxSensitivity]) &&
    (!wc ||
      (f.scope === wc.scope &&
        (f.scopeRef ?? null) === (wc.scopeRef ?? null) &&
        (f.scopeOwner ?? `workspace:${workspaceId}`) === wc.scopeOwner));

  const incomingTokens = incomingTokensOf(input.statement);

  // P130 — mirrors FactRepository: each fact is judged by the best signal it
  // has. A stored vector of matching width → cosine; anything else → the
  // lexical predicate below, because for that row there is nothing better and
  // dropping it would swap a noisy candidate for a silent blind spot.
  if (input.embedding && input.embedding.length > 0) {
    const minSim = input.minSimilarity ?? DEFAULT_CONTRADICTION_MIN_SIMILARITY;
    const query = input.embedding;
    const usable = (vec: number[] | undefined): vec is number[] =>
      vec !== undefined && vec.length === query.length;

    return [...state.facts.values()]
      .filter(
        (f) =>
          f.workspaceId === workspaceId &&
          f.status === "active" &&
          f.id !== input.excludeId &&
          withinCeiling(f)
      )
      .map((f) => {
        const vec = state.embeddings.get(f.id);
        return usable(vec)
          ? { f, sim: cosineSimilarity(query, vec), semantic: true }
          : { f, sim: 0, semantic: false };
      })
      .filter((x) =>
        x.semantic ? x.sim >= minSim : lexicalMatches(x.f, input.subject, incomingTokens)
      )
      .sort((a, b) =>
        b.sim === a.sim
          ? Number(b.f.subject === input.subject) - Number(a.f.subject === input.subject)
          : b.sim - a.sim
      )
      .slice(0, limit)
      .map((x) =>
        x.semantic ? { ...toContradicting(x.f), similarity: x.sim } : toContradicting(x.f)
      );
  }

  // Lightweight stand-in for the Drizzle FTS path: same-subject OR a
  // word-overlap substring match between statements. Scoped to active facts,
  // subject-match ranked first (mirrors fact-candidate ordering).
  const scored = [...state.facts.values()]
    .filter(
      (f) =>
        f.workspaceId === workspaceId &&
        f.status === "active" &&
        f.id !== input.excludeId &&
        withinCeiling(f)
    )
    .map((f) => ({
      f,
      // PRIM-5 — mirrors FactRepository: a generic subject is not a match.
      subjectMatch: isSpecificFactSubject(input.subject) && f.subject === input.subject,
      overlap: tokensOf(f.statement).filter((t) => incomingTokens.has(t)).length,
    }))
    .filter((s) => s.subjectMatch || s.overlap > 0)
    .sort((a, b) =>
      a.subjectMatch === b.subjectMatch ? b.overlap - a.overlap : a.subjectMatch ? -1 : 1
    )
    .slice(0, limit);

  return scored.map(({ f }) => toContradicting(f));
}

/** Words long enough to be worth matching on, lowercased. */
function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
}

function incomingTokensOf(statement: string): Set<string> {
  return new Set(tokensOf(statement));
}

/**
 * The lexical predicate, shared by both paths so the no-vector rows are judged
 * by exactly the same rule whether or not the CALLER supplied an embedding.
 */
function lexicalMatches(f: MnemoFact, subject: string, incoming: Set<string>): boolean {
  // PRIM-5 — the default subject names nothing; only a specific one counts.
  if (isSpecificFactSubject(subject) && f.subject === subject) return true;
  return tokensOf(f.statement).some((t) => incoming.has(t));
}

/** P130 — one projection, so the semantic and lexical arms cannot drift apart. */
function toContradicting(f: MnemoFact): ContradictingFact {
  return {
    id: f.id,
    subject: f.subject,
    statement: f.statement,
    confidence: f.confidence,
    attribution: f.attribution,
    worth: f.worth,
    validFrom: f.validFrom,
  };
}

// ── SOC2 CF3 — Retention purge ────────────────────────────────────────────────

export async function purgeFacts(
  state: InMemoryStorageState,
  filter: PurgeFactsFilter
): Promise<PurgeFactsResult> {
  const { workspaceId, sensitivity, olderThanDays, dryRun = false, limit = 500 } = filter;
  if (SENSITIVITY_ORDER[sensitivity] <= SENSITIVITY_ORDER.public) {
    return { softClosed: 0, eraseCandidateActorIds: [], eraseCandidateUserIds: [] };
  }
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000); // determinism-ok: retention cutoff anchored to test-run clock

  // Find facts matching: same workspace, sensitivity, createdAt < cutoff,
  // validTo IS NULL (open), and not hard_deleted (status is text in DB;
  // the TS union doesn't include 'hard_deleted' but the SQL schema does).
  const candidates = [...state.facts.values()]
    .filter(
      (f) =>
        f.workspaceId === workspaceId &&
        f.sensitivity === sensitivity &&
        f.createdAt < cutoff &&
        f.validTo == null &&
        (f.status as string) !== "hard_deleted" &&
        // Retention purge must never soft-close a fact mid-consolidation.
        !hasPendingMarker(f.metadata)
    )
    .slice(0, limit);

  if (dryRun) {
    return {
      softClosed: candidates.length,
      eraseCandidateActorIds: [],
      eraseCandidateUserIds: [],
    };
  }

  // Soft-close matching facts.
  const now = new Date();
  const affectedActorIds = new Set<string>();
  const affectedUserIds = new Set<string>();
  for (const f of candidates) {
    state.facts.set(f.id, { ...f, status: "forgotten", validTo: now, updatedAt: now });
    if (f.actorId) affectedActorIds.add(f.actorId);
    if (f.userId) affectedUserIds.add(f.userId);
  }

  // Compute erase candidates only for encrypted tiers.
  if (
    SENSITIVITY_ORDER[sensitivity] <= SENSITIVITY_ORDER.internal ||
    (affectedActorIds.size === 0 && affectedUserIds.size === 0)
  ) {
    return {
      softClosed: candidates.length,
      eraseCandidateActorIds: [],
      eraseCandidateUserIds: [],
    };
  }

  // DEK guard: actor's remaining active confidential+restricted facts across BOTH tiers.
  const eraseCandidateActorIds: string[] = [];
  for (const actorId of affectedActorIds) {
    const remaining = [...state.facts.values()].filter(
      (f) =>
        f.workspaceId === workspaceId &&
        f.actorId === actorId &&
        SENSITIVITY_ORDER[f.sensitivity] >= SENSITIVITY_ORDER.confidential &&
        f.validTo == null
    );
    if (remaining.length === 0) {
      eraseCandidateActorIds.push(actorId);
    }
  }

  // Same DEK-safety gate at the user_id grain — spans every actorId/key that
  // user has used, not just the one that triggered this soft-close batch.
  const eraseCandidateUserIds: string[] = [];
  for (const userId of affectedUserIds) {
    const remaining = [...state.facts.values()].filter(
      (f) =>
        f.workspaceId === workspaceId &&
        f.userId === userId &&
        SENSITIVITY_ORDER[f.sensitivity] >= SENSITIVITY_ORDER.confidential &&
        f.validTo == null
    );
    if (remaining.length === 0) {
      eraseCandidateUserIds.push(userId);
    }
  }

  return { softClosed: candidates.length, eraseCandidateActorIds, eraseCandidateUserIds };
}

// ─── §11 Governance ─────────────────────────────────────────────────────────

export async function setCanonical(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  canonical: boolean
): Promise<void> {
  const fact = [...state.facts.values()].find((f) => f.id === id && f.workspaceId === workspaceId);
  // `canonical` is a consolidation-gate eligibility input — silently no-op on
  // a pending row so a generic caller cannot flip it mid-operation.
  if (fact && !hasPendingMarker(fact.metadata)) state.facts.set(id, { ...fact, canonical });
}

// ── RDD-4: Hybrid dedup gate ──────────────────────────────────────────────────

/**
 * Return distinct topic_keys for facts in a session that were tagged with the
 * given extraction_source. Used by the hybrid collapse dedup gate.
 */
export async function listSessionTopicKeysBySource(
  state: InMemoryStorageState,
  workspaceId: string,
  sessionId: string,
  source: string
): Promise<string[]> {
  const keys = new Set<string>();
  for (const f of state.facts.values()) {
    if (
      f.workspaceId === workspaceId &&
      f.sessionId === sessionId &&
      f.extractionSource === source &&
      f.topicKey
    ) {
      keys.add(f.topicKey);
    }
  }
  return [...keys];
}
