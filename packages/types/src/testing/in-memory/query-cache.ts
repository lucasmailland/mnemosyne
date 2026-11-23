// in-memory/query-cache.ts — InMemoryStorageAdapter's query-cache/embedding-cache
// port methods. decompose-inmemory-storage-adapter Batch B7b (design.md Module
// Map row 32). Bodies moved verbatim from InMemoryStorageAdapter.ts — the only
// edit is `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type { LookupQueryCacheInput, InsertQueryCacheInput } from "../../ports.js";
import type { InMemoryStorageState } from "./state.js";
import { cosineSimilarity } from "./support.js";

// ── §9 L3 — Query cache (cosine >= threshold) ─────────────────────────────────
// P59 (docs/archive/openspec/p59-query-cache-l3-fix, design.md D13): mirrors production
// semantics exactly — insert-only (no replace-on-near-duplicate), age
// window on createdAt (stands in for last_used_at, since writes never
// touch-on-hit — D6), topK matched exactly, newest-first scan. Divergent
// semantics here is how "green tests, dead SQL" happened in the first
// place; every core unit test asserts against this adapter.

export async function lookupQueryCache(
  state: InMemoryStorageState,
  input: LookupQueryCacheInput
): Promise<{ resultIds: string[]; resultKinds: string[] } | null> {
  const { workspaceId, embedding, threshold, topK, maxAgeMs } = input;
  const now = Date.now();
  // Freshness + topK + workspace-shared filter, newest-first (mirrors the
  // `fresh` CTE's ORDER BY last_used_at DESC in FactRepository).
  const candidates = state.queryCache
    .filter(
      (entry) =>
        entry.workspaceId === workspaceId && entry.topK === topK && now - entry.createdAt < maxAgeMs
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const entry of candidates) {
    const cosine = cosineSimilarity(embedding, entry.embedding);
    if (cosine >= threshold) {
      return { resultIds: entry.resultIds, resultKinds: entry.resultKinds };
    }
  }
  return null;
}

export async function insertQueryCache(
  state: InMemoryStorageState,
  input: InsertQueryCacheInput
): Promise<void> {
  const { workspaceId, embedding, resultIds, resultKinds, topK } = input;
  // Mirrors FactRepository.insertQueryCache: a NOT NULL empty-array row is
  // pure garbage growth, and a length mismatch would corrupt
  // hydrateCachedHits' index-paired walk on read.
  if (resultIds.length === 0 || resultIds.length !== resultKinds.length) return;
  // Insert-only — no replace-on-near-duplicate. Repeated queries append
  // near-identical rows; the newest wins the read-side ordering.
  state.queryCache.push({
    workspaceId,
    embedding,
    resultIds,
    resultKinds,
    topK,
    createdAt: Date.now(),
  });
}

// ── §9 L3 — Embedding LRU (exact text-hash) ───────────────────────────────────

// Keyed by (workspace, text hash) to mirror the real table's unique index, with
// the producing model carried alongside the vector. A read that supplies a
// model only hits when it matches — see the `getCachedEmbedding` port doc for
// why a model-blind hit is not merely stale but fatal to the query that
// consumes it.
export async function getCachedEmbedding(
  state: InMemoryStorageState,
  workspaceId: string,
  textHash: string,
  model?: string
): Promise<Float32Array | null> {
  const entry = state.embeddingCache.get(`${workspaceId}:${textHash}`);
  if (!entry) return null;
  if (model !== undefined && entry.model !== model) return null;
  return entry.embedding;
}

export async function putCachedEmbedding(
  state: InMemoryStorageState,
  input: {
    workspaceId: string;
    textHash: string;
    embedding: Float32Array;
    model: string;
  }
): Promise<void> {
  state.embeddingCache.set(`${input.workspaceId}:${input.textHash}`, {
    embedding: input.embedding,
    model: input.model,
  });
}

/**
 * P68 — mirrors FactRepository.pruneQueryCache: removes rows created before the
 * cutoff. Anchored on createdAt, not lastUsedAt, for the reason in the port doc.
 */
export async function pruneQueryCache(
  state: InMemoryStorageState,
  workspaceId: string,
  olderThanMs: number
): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const before = state.queryCache.length;
  state.queryCache = state.queryCache.filter(
    // `createdAt` is stored as an epoch number here, not a Date.
    (r) => !(r.workspaceId === workspaceId && r.createdAt < cutoff)
  );
  return before - state.queryCache.length;
}
