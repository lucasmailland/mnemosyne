// in-memory/fact-index.ts — InMemoryStorageAdapter's Fact-Hash + LSH Tier-2/3
// pointer-recall port methods. decompose-inmemory-storage-adapter Batch B9c
// (design.md Module Map row 23). Bodies moved verbatim from
// InMemoryStorageAdapter.ts — the only edit is `this.<field>` →
// `state.<field>` (design.md D7 move-only rule).
//
// `candidateFactMatches` and `pointerCandidate` travel with their only
// callers (`pointerCandidates`/`ftsCandidates`) per design.md D6 and become
// module-private (non-exported) functions here — no class-level delegation
// exists for either. `setEmbedding`/`setFactEmbedding` are test-only helpers
// (not on any port) that DO get class-level delegations since they remain
// part of the class's public test-helper surface.
//
// `pointerCandidates` and `ftsCandidates` are both cross-domain per the
// Cross-Domain Inventory: `factLsh`+`facts`+`embeddings`, and
// `facts`+`embeddings` respectively — both read the extra collections
// directly off `state`, no extra import needed.

import type {
  UpsertFactHashInput,
  UpsertFactLshInput,
  PointerCandidateQuery,
  PointerCandidate,
  FtsCandidate,
} from "../../ports.js";
import type { MnemoFactHash, MnemoFact } from "../../primitives.js";
import type { InMemoryStorageState } from "./state.js";
import { scopeRefMatches } from "../../scope-ref.js";

export async function lookupFactHash(
  state: InMemoryStorageState,
  workspaceId: string,
  statementHash: string
): Promise<MnemoFactHash | null> {
  return state.factHashes.get(`${workspaceId}|${statementHash}`) ?? null;
}

export async function upsertFactHash(
  state: InMemoryStorageState,
  input: UpsertFactHashInput
): Promise<MnemoFactHash> {
  const key = `${input.workspaceId}|${input.statementHash}`;
  const existing = state.factHashes.get(key);
  if (existing) {
    const updated = { ...existing, seenCount: existing.seenCount + 1, lastSeenAt: new Date() };
    state.factHashes.set(key, updated);
    return updated;
  }
  const entry: MnemoFactHash = {
    workspaceId: input.workspaceId,
    statementHash: input.statementHash,
    factId: input.factId,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    seenCount: 1,
  };
  state.factHashes.set(key, entry);
  return entry;
}

// ── LSH bands — Tier 2 pointer recall (Wave P) ──────────────────────────────

function candidateFactMatches(
  fact: MnemoFact,
  query: Pick<
    PointerCandidateQuery,
    "workspaceId" | "filter" | "includeArchived" | "includeLowWorth"
  >
): boolean {
  if (fact.workspaceId !== query.workspaceId) return false;
  const active = fact.status === "active" && fact.validTo == null;
  const archived =
    query.includeArchived === true && fact.status === "forgotten" && fact.validTo != null;
  if (!active && !archived) return false;
  if (query.includeLowWorth === false) {
    const n = fact.worthAlpha + fact.worthBeta;
    const p = n > 0 ? fact.worthAlpha / n : 0;
    const z2 = 1.96 ** 2;
    const lower =
      n > 0
        ? (p + z2 / (2 * n) - 1.96 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n)
        : 0;
    // Mirrors candidateConditions' isUntested exemption: a fact still at the
    // Beta(2,2) prior has no evidence either way and is servable. Without it
    // this double hid every fresh fact from the FTS and pointer arms.
    const untested = fact.worthAlpha === 2 && fact.worthBeta === 2;
    if (!untested && (fact.worth <= 0.5 || lower < 0.3)) return false;
  }
  const filter = query.filter;
  if (!filter) return true;
  const tags = Array.isArray(fact.metadata.tags)
    ? fact.metadata.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  if (filter.kinds && !filter.kinds.includes("fact")) return false;
  if (filter.tags && !filter.tags.every((tag) => tags.includes(tag))) return false;
  if (filter.validAfter && fact.validFrom < filter.validAfter) return false;
  if (filter.validBefore && fact.validFrom > filter.validBefore) return false;
  if (filter.minWorth !== undefined && fact.worth < filter.minWorth) return false;
  if (filter.minConfidence !== undefined && fact.confidence < filter.minConfidence) return false;
  if (filter.sensitivity && !filter.sensitivity.includes(fact.sensitivity)) return false;
  if (filter.provenance && !filter.provenance.includes(fact.attribution)) return false;
  if (filter.entityId && fact.entityId !== filter.entityId) return false;
  if (filter.sessionId && fact.sessionId !== filter.sessionId) return false;
  if (filter.scope && fact.scope !== filter.scope) return false;
  if (!scopeRefMatches(fact.scopeRef, filter)) return false;
  if (filter.actorId && fact.actorId !== filter.actorId) return false;
  if (filter.scopeOwner && fact.scopeOwner !== filter.scopeOwner) return false;
  return true;
}

function pointerCandidate(fact: MnemoFact, embedding: number[] | null): PointerCandidate {
  return {
    factId: fact.id,
    statement: fact.statement,
    embedding,
    sensitivity: fact.sensitivity,
    worth: fact.worth,
    worthAlpha: fact.worthAlpha,
    worthBeta: fact.worthBeta,
    attribution: fact.attribution,
    createdAt: fact.createdAt,
    validFrom: fact.validFrom,
    status: fact.status,
    validTo: fact.validTo ?? null,
    confidence: fact.confidence,
    tags: Array.isArray(fact.metadata.tags)
      ? fact.metadata.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    scope: fact.scope,
    scopeRef: fact.scopeRef,
    actorId: fact.actorId ?? null,
    entityId: fact.entityId,
    sessionId: fact.sessionId,
    ...(fact.scopeOwner ? { scopeOwner: fact.scopeOwner } : {}),
    ...(fact.topicKey ? { topicKey: fact.topicKey } : {}),
    ...(fact.subject ? { subject: fact.subject } : {}),
  };
}

/** Test-only helper: store a pre-computed embedding to be returned by pointerCandidates. */
export function setEmbedding(state: InMemoryStorageState, id: string, vec: number[]): void {
  state.embeddings.set(id, vec);
}

/**
 * Test-only helper (flatten-legacy-dual-core PR9g): directly set a fact's
 * `embedding` column — `createFact` never writes it synchronously (it
 * enqueues a `vector_upsert` outbox entry instead, mirroring
 * `FactRepository`'s real async-embed contract), so tests exercising
 * `backfillSemanticNeighbors`'s kNN over `MnemoFact.embedding` need a way
 * to seed it deterministically without draining the outbox.
 */
export function setFactEmbedding(
  state: InMemoryStorageState,
  id: string,
  vec: ArrayLike<number>
): void {
  const fact = state.facts.get(id);
  if (!fact) return;
  state.facts.set(id, { ...fact, embedding: Float32Array.from(vec), embeddingStale: false });
}

export async function upsertFactLsh(
  state: InMemoryStorageState,
  input: UpsertFactLshInput
): Promise<void> {
  const fact = state.facts.get(input.factId);
  if (!fact || fact.workspaceId !== input.workspaceId || fact.revisionCount !== input.revision)
    return;
  state.factLsh.set(`${input.workspaceId}:${input.factId}`, input.bands);
}

export async function pointerCandidates(
  state: InMemoryStorageState,
  query: PointerCandidateQuery
): Promise<PointerCandidate[]> {
  const signals = new Map<string, { collisions: number; ftsRank: number }>();
  const sig = new Set(query.bands.map((b) => `${b.bandIdx}:${b.bandHash}`));
  for (const [key, bands] of state.factLsh) {
    const colonIdx = key.indexOf(":");
    const ws = key.slice(0, colonIdx);
    const factId = key.slice(colonIdx + 1);
    if (ws !== query.workspaceId) continue;
    const collisions = bands.filter((b) => sig.has(`${b.bandIdx}:${b.bandHash}`)).length;
    if (collisions > 0) signals.set(factId, { collisions, ftsRank: 0 });
  }
  const terms = query.terms.map((t) => t.toLowerCase());
  for (const f of state.facts.values()) {
    if (!candidateFactMatches(f, query)) continue;
    const hay = f.statement.toLowerCase();
    const ftsRank = terms.reduce((score, term) => score + (hay.includes(term) ? 1 : 0), 0);
    if (ftsRank > 0) {
      const current = signals.get(f.id) ?? { collisions: 0, ftsRank: 0 };
      signals.set(f.id, { ...current, ftsRank });
    }
  }
  const out: PointerCandidate[] = [];
  const ordered = [...signals.entries()].sort(
    (a, b) =>
      b[1].ftsRank - a[1].ftsRank || b[1].collisions - a[1].collisions || a[0].localeCompare(b[0])
  );
  for (const [id] of ordered) {
    const f = state.facts.get(id);
    if (!f || !candidateFactMatches(f, query)) continue;
    out.push(pointerCandidate(f, state.embeddings.get(id) ?? null));
    if (out.length >= query.limit) break;
  }
  return out;
}

/** FTS arm of hybrid Tier-3 recall: lexical substring match over statement. */
export async function ftsCandidates(
  state: InMemoryStorageState,
  query: Omit<PointerCandidateQuery, "bands">
): Promise<FtsCandidate[]> {
  if (query.terms.length === 0) return [];
  const terms = query.terms.map((t) => t.toLowerCase());
  const out: FtsCandidate[] = [];
  for (const f of state.facts.values()) {
    if (!candidateFactMatches(f, query)) continue;
    const hay = f.statement.toLowerCase();
    if (!terms.some((t) => hay.includes(t))) continue;
    out.push({ ...pointerCandidate(f, state.embeddings.get(f.id) ?? null), rank: 1 });
    if (out.length >= query.limit) break;
  }
  return out;
}
