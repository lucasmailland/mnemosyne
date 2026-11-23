// §"Predictive Memory" pattern 4 (co-occurrence / Hebbian): when ≥2 facts are
// recalled together, strengthen the pairwise relation via STDP. Co-recall is
// stored on the mnemo_relation row connecting the pair (see getCoOccurrencePatterns).
// Pure: all I/O via the storage port.
import type { StorageAdapter, MnemoRelation } from "@mnemo-ai/types";
import type { OnCoRecallTail } from "./context.js";

// Cap on facts considered for pairwise co-recall: top-K by rank. K=6 → ≤15 pairs.
// Exported (p60-corecall-stdp-convergence) — `recordCoRecall` is the sole
// co-recall STDP writer; the cap is public so callers/tests can reason about it.
export const CO_RECALL_TOP_K = 6;

/** Deterministic ordering so (A,B) and (B,A) resolve to the same canonical pair. */
function canonicalPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

async function findOrCreateRelatedRelation(
  storage: StorageAdapter,
  workspaceId: string,
  sourceId: string,
  targetId: string
): Promise<MnemoRelation | null> {
  // Look for an existing relation in either direction, closed ones included:
  // co-recall must not re-create an edge someone retracted.
  const forward = await storage
    .getRelations({ workspaceId, sourceId, targetId, openOnly: false })
    .catch(() => [] as MnemoRelation[]);
  if (forward.length > 0) return forward[0]!;
  const reverse = await storage
    .getRelations({ workspaceId, sourceId: targetId, targetId: sourceId, openOnly: false })
    .catch(() => [] as MnemoRelation[]);
  if (reverse.length > 0) return reverse[0]!;
  // None exists — create a generic symmetric "related" link to carry the Hebbian signal.
  return storage
    .createRelation({
      workspaceId,
      sourceId,
      sourceType: "fact",
      targetId,
      targetType: "fact",
      verb: "related",
      weight: 0.5,
      evidence: { origin: "co_recall" },
    })
    .catch(() => null);
}

/**
 * Record pairwise co-recall for a set of co-recalled fact ids.
 * No-op when <2 ids or when the storage adapter lacks recordCoRecallStdp.
 * Fully best-effort: never throws to the recall path.
 *
 * p60-corecall-stdp-convergence: this is the SOLE co-recall STDP writer.
 * A server-side duplicate (`packages/server/src/recall/co-recall-stdp.ts`)
 * used to run a second, uncoordinated pass over the same `mnemo_relation`
 * rows on every `POST /recall` — double-counting some pairs and silently
 * missing others. It has been deleted; do not reintroduce a second writer.
 */
export async function recordCoRecall(
  storage: StorageAdapter,
  workspaceId: string,
  factIds: string[],
  nowMs: number = Date.now(),
  onTail?: OnCoRecallTail
): Promise<number> {
  if (typeof storage.recordCoRecallStdp !== "function") return 0;
  const distinctIds = [...new Set(factIds)];
  const ids = distinctIds.slice(0, CO_RECALL_TOP_K);
  if (ids.length < 2) return 0;

  // p60-corecall-stdp-convergence D3: measure what the cap gives up, BEFORE
  // the pair loop, so the report reflects the full candidate set rather than
  // the already-capped `ids`. Fire-and-forget — never let a broken host hook
  // affect the recall path.
  if (onTail) {
    try {
      const pairCount = (n: number): number => (n * (n - 1)) / 2;
      const candidateFacts = distinctIds.length;
      const processedPairs = pairCount(ids.length);
      const skippedPairs = pairCount(candidateFacts) - processedPairs;
      onTail({
        workspaceId,
        candidateFacts,
        capK: CO_RECALL_TOP_K,
        processedPairs,
        skippedPairs,
      });
    } catch {
      // never let a broken host hook affect the caller
    }
  }

  const coRecalledAt = new Date(nowMs);
  let recorded = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = canonicalPair(ids[i]!, ids[j]!);
      const rel = await findOrCreateRelatedRelation(storage, workspaceId, a, b);
      if (!rel) continue;
      await storage.recordCoRecallStdp(workspaceId, rel.id, coRecalledAt).catch(() => undefined);
      recorded++;
    }
  }
  return recorded;
}
