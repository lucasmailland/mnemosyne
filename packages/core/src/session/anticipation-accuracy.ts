// §30 anticipation-accuracy: pure helper that scores how many pre-staged
// anticipated memory ids were actually recalled (extracted) in the collapsed
// session. accuracy = hits / staged ("% of pre-fetched facts actually used",
// spec §30). Pure: no infra imports — the cache read is owned by the collapse
// orchestrator; this helper only consumes the already-fetched slot.
//
// F1 Bug B: the staged objects are `AnticipatedMemory` whose id field is `.id`
// (see packages/core/src/v3/anticipation.ts). Earlier collapse code read
// `.memoryId`, which is undefined on the staged shape → accuracy always 0.

/** Shape of the anticipation slot as written by preinjectAnticipation
 *  ({ generatedAt, items }) and read back by collapse via the CacheAdapter. */
export interface AnticipationSlot {
  generatedAt?: string;
  items: Array<{ id: string }>;
}

/**
 * Compute anticipation accuracy = (# staged ids that were recalled) / (# staged ids).
 *
 * @param slot   the slot fetched from the cache (may be null or malformed).
 * @param recalledIds  ids recalled/extracted this session (e.g. createdFactIds).
 * @returns fraction in [0,1], or null when there is nothing to score
 *          (no slot, or no staged items — keeps the gauge unset rather than 0).
 */
export function computeAnticipationAccuracy(
  slot: AnticipationSlot | null,
  recalledIds: readonly string[],
): number | null {
  if (!slot || typeof slot !== "object" || !Array.isArray(slot.items) || slot.items.length === 0) {
    return null;
  }
  const anticipatedIds = new Set(slot.items.map((i) => i.id));
  let hits = 0;
  for (const id of recalledIds) {
    if (anticipatedIds.has(id)) hits += 1;
  }
  return hits / slot.items.length;
}
