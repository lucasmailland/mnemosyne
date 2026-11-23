// in-memory/embedding-maintenance.ts — InMemoryStorageAdapter's embedding
// lifecycle methods (§36 embedding-model migration, §37 hot-tier snapshots).
// decompose-inmemory-storage-adapter Batch B6 (design.md Module Map row 34).
// Bodies moved verbatim — the last 2 (`upsertHotTierSnapshot`,
// `loadHotTierSnapshots`) are stubs per D4.

import type { InMemoryStorageState } from "./state.js";

// §36 Embedding-model migration (fact rows only in this double)
/**
 * P111: mirrors the production predicate — `embedding_stale = true OR
 * embedding_model IS NULL OR embedding_model != currentModel`.
 *
 * It used to return `[]` unconditionally, which is the worst shape for a
 * double of a QUERY: every "nothing is stale" assertion passed by
 * construction, and so would every "the migration finds it" assertion have
 * failed, for a reason that has nothing to do with the code under test.
 * Only `fact` is modelled by this maintenance surface.
 */
export async function listStaleEmbeddings(
  state: InMemoryStorageState,
  table: import("../../ports.js").EmbeddableTable,
  workspaceId: string,
  currentModel: string,
  limit: number,
  opts?: { plaintextOnly?: boolean }
): Promise<Array<{ id: string; text: string }>> {
  if (table !== "fact") return [];
  const out: Array<{ id: string; text: string }> = [];
  for (const f of state.facts.values()) {
    if (f.workspaceId !== workspaceId) continue;
    if (opts?.plaintextOnly && f.sensitivity !== "public" && f.sensitivity !== "internal") continue;
    const stale =
      f.embeddingStale === true || !f.embeddingModel || f.embeddingModel !== currentModel;
    if (!stale) continue;
    out.push({ id: f.id, text: f.statement });
    if (out.length >= limit) break;
  }
  return out;
}

export async function hasActiveEmbeddingMigration(
  state: InMemoryStorageState,
  workspaceId: string,
  currentModel: string
): Promise<boolean> {
  for (const f of state.facts.values()) {
    if (f.workspaceId !== workspaceId) continue;
    if (!state.embeddings.has(f.id) && !f.embedding) continue;
    if (f.embeddingStale === true || f.embeddingModel !== currentModel) return true;
  }
  return false;
}

export async function markEmbeddingsStale(
  _state: InMemoryStorageState,
  _table: import("../../ports.js").EmbeddableTable,
  _workspaceId: string,
  _currentModel: string
): Promise<number> {
  return 0;
}

/**
 * P111: this used to be a pure no-op, which made the double MORE FORGIVING than
 * production and hid exactly the behaviour a test would come here to check.
 * The real adapter stamps `embedding_model = model` and clears
 * `embedding_stale` (EmbeddingRepository.updateEmbeddingVector), and the
 * staleness lifecycle depends on those fields — a double that skips them can
 * never fail a test about it.
 *
 * Store the vector so the migration flag can distinguish a stale vector from
 * a fact that has never been embedded.
 */
export async function updateEmbeddingVector(
  state: InMemoryStorageState,
  table: import("../../ports.js").EmbeddableTable,
  id: string,
  workspaceId: string,
  vector: number[],
  model: string
): Promise<void> {
  if (table !== "fact") return;
  const f = state.facts.get(id);
  if (!f || f.workspaceId !== workspaceId) return;
  state.embeddings.set(id, [...vector]);
  state.facts.set(id, {
    ...f,
    embedding: Float32Array.from(vector),
    embeddingModel: model,
    embeddingStale: false,
  });
}

// §37 Hot-tier snapshot stubs
export async function upsertHotTierSnapshot(
  _state: InMemoryStorageState,
  _rows: import("../../ports.js").HotTierSnapshotRow[]
): Promise<void> {
  // no-op
}

export async function loadHotTierSnapshots(
  _state: InMemoryStorageState,
  _workspaceId?: string
): Promise<import("../../ports.js").HotTierSnapshotRow[]> {
  return [];
}
