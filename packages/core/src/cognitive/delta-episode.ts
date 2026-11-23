// DELTAMEM §16 — delta-episode auto-formation.
//
// Before an episode is created, embed its narrative and search existing episodes
// (HNSW cosine over mnemo_episode.embedding via the StorageAdapter port). If the
// nearest existing episode is sufficiently similar, link the new episode to it as
// a delta: parentEpisodeId = nearest.id, and store only the new narrative as
// deltaContent so the reconstruction infra (reconstructEpisode) can fold
// root→leaf. This builds delta-encoded episode trees instead of flat duplicates.
//
// Port-only: depends solely on ctx.embed (EmbedAdapter) and
// ctx.storage.findSimilarEpisodes (StorageAdapter). No drizzle/SQL here.

import type { CoreContext } from "./context.js";
import { encodeDelta } from "@mnemo-ai/types";

/**
 * Similarity threshold above which a new episode is delta-linked to its nearest
 * neighbour. Cosine in [0,1]; 0.85 mirrors the recall-path injection threshold
 * and is high enough that only genuinely-overlapping episodes form a tree.
 */
export const DELTA_EPISODE_SIM_THRESHOLD = 0.85;

/**
 * Fields to merge into a CreateEpisodeInput to delta-encode it against an
 * existing parent. When no suitable parent is found, returns `{}` (the episode
 * is created as a root, exactly as before).
 */
export interface DeltaEpisodeLink {
  parentEpisodeId?: string;
  deltaContent?: string;
}

/**
 * Compute the delta-link for a new episode whose full narrative is `narrative`.
 *
 * Steps:
 *   1. Embed the narrative (skip if empty — nothing to compare).
 *   2. findSimilarEpisodes(workspaceId, embedding, 1, threshold).
 *   3. If a match ≥ threshold exists, return parentEpisodeId = match.id and
 *      deltaContent = narrative (the delta the child contributes over its parent).
 *
 * Caller behaviour on the returned link:
 *   - link.parentEpisodeId set → create the episode with narrative kept as-is
 *     AND deltaContent set; depth is derived from the parent by the storage
 *     adapter, and reconstructEpisode folds the chain on read.
 *   - link empty → create the episode as a root (unchanged legacy behaviour).
 *
 * Failures are surfaced to the caller; callers wrap episode creation in a
 * non-fatal try/catch already, so a degraded embedder does not block the write.
 */
export async function computeDeltaEpisodeLink(
  ctx: CoreContext,
  workspaceId: string,
  narrative: string,
): Promise<DeltaEpisodeLink> {
  const trimmed = narrative.trim();
  if (trimmed.length === 0) return {};

  // findSimilarEpisodes + reconstructEpisode are part of the StorageAdapter port,
  // but guard for partial test doubles that may not implement them.
  if (typeof ctx.storage.findSimilarEpisodes !== "function") return {};
  if (typeof ctx.storage.reconstructEpisode !== "function") return {};

  const embedding = await ctx.embed.embedSingle(trimmed);
  const matches = await ctx.storage.findSimilarEpisodes(
    workspaceId,
    Array.from(embedding),
    1,
    DELTA_EPISODE_SIM_THRESHOLD,
  );

  const best = matches[0];
  if (!best) return {};

  // DELTAMEM §16: store the RESIDUAL of this narrative against the parent's
  // fully-reconstructed narrative, not the full text. reconstructEpisode folds
  // the parent chain root→leaf, so the delta is computed against exactly the
  // text reconstructEpisode will splice this child onto at read time.
  const parent = await ctx.storage.reconstructEpisode(best.id, workspaceId);
  const deltaContent = encodeDelta(parent.narrative, trimmed);

  return { parentEpisodeId: best.id, deltaContent };
}
