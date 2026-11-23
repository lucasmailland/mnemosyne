// in-memory/episodes.ts — InMemoryStorageAdapter's Episode port methods.
// decompose-inmemory-storage-adapter Batch B5 (design.md Module Map row 9).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).
//
// `findSimilarEpisodes` is cross-domain (episodes + embeddings, per design.md's
// Cross-Domain Inventory) — reads both directly off `state`, no extra import
// needed. `persistCompression` mutates the stored episode object in place
// (D7) — preserved exactly, not converted to a re-`set` pattern.
//
// `reconstructEpisode` is exported normally (not module-private) — it is the
// target of D6's one inter-module edge: `recall.ts` (landing in B10a) imports
// it from here.

import type {
  CreateEpisodeInput,
  UpdateEpisodeInput,
  EpisodeFilter,
  SimilarEpisode,
} from "../../ports.js";
import type { MnemoEpisode } from "../../primitives.js";
import type { PaginatedResult } from "../../common.js";
import { applyDelta } from "../../delta-text.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid, cosineSimilarity, paginate } from "./support.js";
import { projectPrimitiveText } from "../../indexing.js";

export async function createEpisode(
  state: InMemoryStorageState,
  input: CreateEpisodeInput
): Promise<MnemoEpisode> {
  const now = new Date();
  const episode = {
    id: uuid(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    userId: input.userId,
    actorType: input.actorType,
    agentId: input.agentId,
    title: input.title,
    narrative: input.narrative,
    occurredAt: input.occurredAt,
    durationMinutes: input.durationMinutes,
    participants: input.participants ?? [],
    topics: input.topics ?? [],
    linkedFactIds: input.linkedFactIds ?? [],
    parentEpisodeId: input.parentEpisodeId,
    deltaContent: input.deltaContent,
    isSynthetic: input.isSynthetic ?? false,
    isRoot: !input.parentEpisodeId,
    depth: (() => {
      if (!input.parentEpisodeId) return 0;
      const parent = state.episodes.get(input.parentEpisodeId);
      if (!parent || parent.workspaceId !== input.workspaceId) {
        throw new Error(
          `Parent episode ${input.parentEpisodeId} not found in workspace ${input.workspaceId}`
        );
      }
      return parent.depth + 1;
    })(),
    sourceConversationId: input.sourceConversationId,
    sensitivity: input.sensitivity ?? "internal",
    // P18: initialize bitemporal columns
    validFrom: now,
    validTo: undefined,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata ?? {},
  } as unknown as MnemoEpisode;
  state.episodes.set(episode.id, episode);
  // P65: mirrors the real adapter's in-transaction text-form vector_upsert.
  // Deliberately kept in step: a double that indexes nothing while Postgres
  // does (or vice versa) makes every unit test agree with the wrong thing —
  // the shape P116 hid behind for as long as it did.
  state.outbox.push({
    id: uuid(),
    workspaceId: episode.workspaceId,
    eventType: "vector_upsert",
    payload: {
      id: episode.id,
      kind: "episode",
      text: projectPrimitiveText("episode", episode as unknown as Record<string, unknown>),
    },
    createdAt: new Date(),
    attempts: 0,
  });
  return episode;
}

export async function getEpisode(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoEpisode | null> {
  const e = state.episodes.get(id);
  return e && e.workspaceId === workspaceId ? e : null;
}

export async function updateEpisode(
  state: InMemoryStorageState,
  id: string,
  input: UpdateEpisodeInput
): Promise<MnemoEpisode> {
  const e = state.episodes.get(id);
  if (!e) throw new Error(`Episode ${id} not found`);
  const updated = { ...e, ...input, updatedAt: new Date() };
  state.episodes.set(id, updated);
  return updated;
}

export async function archiveEpisode(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const e = state.episodes.get(id);
  if (e && e.workspaceId === workspaceId) {
    // P18: close bitemporal interval (do NOT delete — mirrors Postgres repository)
    state.episodes.set(id, { ...e, validTo: new Date(), updatedAt: new Date() });
  }
}

export async function queryEpisodes(
  state: InMemoryStorageState,
  filter: EpisodeFilter
): Promise<PaginatedResult<MnemoEpisode>> {
  const items = [...state.episodes.values()].filter((e) => {
    if (e.workspaceId !== filter.workspaceId) return false;
    if (filter.parentEpisodeId !== undefined && e.parentEpisodeId !== filter.parentEpisodeId)
      return false;
    // P18: validAt predicate — open-interval semantics (validTo > validAt, NOT >=)
    if (filter.validAt) {
      if (e.validFrom > filter.validAt) return false;
      if (e.validTo != null && e.validTo <= filter.validAt) return false;
    }
    return true;
  });
  return paginate(items, filter.offset, filter.limit);
}

export async function getEpisodeTreeNeighbors(
  state: InMemoryStorageState,
  episodeId: string,
  workspaceId: string,
  limit = 10
): Promise<MnemoEpisode[]> {
  const target = state.episodes.get(episodeId);
  if (!target || target.workspaceId !== workspaceId) return [];

  const all = [...state.episodes.values()].filter(
    (e) => e.workspaceId === workspaceId && e.id !== episodeId
  );
  const neighbors: MnemoEpisode[] = [];

  // Parent
  if (target.parentEpisodeId) {
    const parent = state.episodes.get(target.parentEpisodeId);
    if (parent && parent.workspaceId === workspaceId) {
      neighbors.push(parent);
    }
  }

  // Siblings (same parent, excluding self and parent already added)
  const addedIds = new Set(neighbors.map((e) => e.id));
  for (const ep of all) {
    if (addedIds.has(ep.id)) continue;
    if (target.parentEpisodeId && ep.parentEpisodeId === target.parentEpisodeId) {
      neighbors.push(ep);
      addedIds.add(ep.id);
    }
  }

  // Direct children (parentEpisodeId === target.id)
  for (const ep of all) {
    if (addedIds.has(ep.id)) continue;
    if (ep.parentEpisodeId === episodeId) {
      neighbors.push(ep);
      addedIds.add(ep.id);
    }
  }

  return neighbors.slice(0, limit);
}

export async function persistCompression(
  state: InMemoryStorageState,
  input: {
    workspaceId: string;
    rootEpisodeId: string;
    compressedNarrative: string;
    retainedDeltas: Array<{ episodeId: string; deltaContent: string }>;
  }
): Promise<void> {
  const ep = state.episodes.get(input.rootEpisodeId);
  if (!ep || ep.workspaceId !== input.workspaceId) return;
  ep.narrative = input.compressedNarrative;
  ep.metadata = { ...ep.metadata, compressed: true, retainedDeltas: input.retainedDeltas };
  ep.updatedAt = new Date();
}

export async function reconstructEpisode(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoEpisode> {
  // Walk leaf→root collecting the chain.
  const chain: MnemoEpisode[] = [];
  let cursor: string | null = id;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const ep = state.episodes.get(cursor);
    if (!ep || ep.workspaceId !== workspaceId) break;
    chain.push(ep);
    cursor = ep.parentEpisodeId ?? null;
  }
  if (chain.length === 0) throw new Error(`episode ${id} not found`);
  // Reverse to root→leaf order.
  const rootFirst = [...chain].reverse();
  const root = rootFirst[0]!;
  // Fold root→leaf: apply each descendant's residual deltaContent in depth order
  // (DELTAMEM §16). A header-less legacy deltaContent applies as a literal.
  let reconstructed = root.narrative;
  for (const ep of rootFirst.slice(1)) {
    reconstructed = applyDelta(reconstructed, ep.deltaContent ?? "");
  }
  // Return the leaf episode with the reconstructed narrative.
  return { ...chain[0]!, narrative: reconstructed };
}

// DELTAMEM §16 — cosine search over stored episode embeddings (set via
// setEmbedding(episodeId, vec)). Returns workspace-scoped episodes with
// cosine ≥ minSim, most-similar first. Episodes without a stored embedding
// are excluded (mirrors the SQL `embedding IS NOT NULL` predicate).
export async function findSimilarEpisodes(
  state: InMemoryStorageState,
  workspaceId: string,
  embedding: number[],
  limit: number,
  minSim: number
): Promise<SimilarEpisode[]> {
  const hits: SimilarEpisode[] = [];
  for (const ep of state.episodes.values()) {
    if (ep.workspaceId !== workspaceId) continue;
    const vec = state.embeddings.get(ep.id);
    if (!vec) continue;
    const cosine = cosineSimilarity(embedding, vec);
    if (cosine >= minSim) hits.push({ id: ep.id, cosine, depth: ep.depth });
  }
  hits.sort((a, b) => b.cosine - a.cosine);
  return hits.slice(0, limit);
}
