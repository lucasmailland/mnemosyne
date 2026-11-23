// Shared two-direction, verb-parameterised relation lookup (design.md D2).
//
// Extracted from `scoped-conflict-check.ts`'s private `loadDedupeSet`, which
// was module-private and hardcoded to the single `"conflicts_with"` verb.
// The scheduler's deep-mode memoization (Requirement 2) needs the same
// two-direction lookup pattern across BOTH `"conflicts_with"` and
// `"not_conflict"`, so the lookup is generalised here and both call sites
// delegate to it.

import type { RelationPort, RelationVerb } from "@mnemo-ai/types";

/** Narrow structural surface — only `getRelations` is required. Canonical
 *  derivation (design D3), byte-identical to the previous hand-rolled signature. */
export type RelationLookupStorage = Pick<RelationPort, "getRelations">;

/**
 * For each verb in `verbs`, issue two `getRelations` calls (one per
 * direction — `sourceId: factId` and `targetId: factId`) and union the
 * far-side fact ids across every verb and both directions.
 *
 * Two calls per verb (not per-pair) — mirrors the dedupe-set lookup already
 * used by the write-time scoped conflict check.
 */
export async function loadLinkedFactIds(
  storage: RelationLookupStorage,
  workspaceId: string,
  factId: string,
  verbs: readonly RelationVerb[]
): Promise<Set<string>> {
  const results = await Promise.all(
    verbs.flatMap((verb) => [
      // History included, as before getRelations defaulted to open rows: a
      // closed judgment still says the pair was looked at.
      storage.getRelations({ workspaceId, sourceId: factId, verb, openOnly: false }),
      storage.getRelations({ workspaceId, targetId: factId, verb, openOnly: false }),
    ])
  );
  const linked = new Set<string>();
  for (const [i, rels] of results.entries()) {
    for (const rel of rels) linked.add(i % 2 === 0 ? rel.targetId : rel.sourceId);
  }
  return linked;
}
