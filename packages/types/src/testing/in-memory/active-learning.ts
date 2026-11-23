// in-memory/active-learning.ts — InMemoryStorageAdapter's active-learning review
// queue port methods. decompose-inmemory-storage-adapter Batch B7b (design.md
// Module Map row 27). Bodies moved verbatim from InMemoryStorageAdapter.ts —
// the only edit is `this.<field>` → `state.<field>` (design.md D7 move-only
// rule).
//
// `resolveActiveLearningReview` is cross-domain (`activeLearningReviewQueue` +
// `facts`, per design.md's Cross-Domain Inventory) and mutates the stored
// review row in place (D7) — preserved exactly, not converted to a re-`set`
// pattern.

import type {
  ActiveLearningReviewFilter,
  ActiveLearningReviewRow,
  EnqueueActiveLearningReviewInput,
  EnqueueActiveLearningReviewResult,
  ResolveActiveLearningReviewInput,
  ResolveActiveLearningReviewResult,
} from "../../ports.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid, hasPendingMarker } from "./support.js";

// ── flatten-legacy-dual-core Slice 3c pt.1 (PR10) — active-learning review queue ──

export async function listActiveLearningReview(
  state: InMemoryStorageState,
  filter: ActiveLearningReviewFilter
): Promise<ActiveLearningReviewRow[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  return state.activeLearningReviewQueue
    .filter((r) => {
      if (r.workspaceId !== filter.workspaceId) return false;
      if (!filter.includeResolved && r.resolvedAt !== null) return false;
      if (filter.reason && r.reason !== filter.reason) return false;
      return true;
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

export async function countUnresolvedActiveLearningReview(
  state: InMemoryStorageState,
  workspaceId: string
): Promise<number> {
  return state.activeLearningReviewQueue.filter(
    (r) => r.workspaceId === workspaceId && r.resolvedAt === null
  ).length;
}

export async function enqueueActiveLearningReview(
  state: InMemoryStorageState,
  input: EnqueueActiveLearningReviewInput
): Promise<EnqueueActiveLearningReviewResult> {
  if ((input.factId == null) === (input.decisionId == null)) {
    throw new Error(
      "enqueueActiveLearningReview: exactly one of factId or decisionId must be supplied"
    );
  }
  const existing = state.activeLearningReviewQueue.find(
    (r) =>
      r.workspaceId === input.workspaceId &&
      r.resolvedAt === null &&
      (input.factId != null ? r.factId === input.factId : r.decisionId === input.decisionId)
  );
  if (existing) return { id: existing.id, inserted: false };

  const row: ActiveLearningReviewRow = {
    id: `mrev_${uuid()}`,
    workspaceId: input.workspaceId,
    factId: input.factId ?? null,
    decisionId: input.decisionId ?? null,
    reason: input.reason,
    createdAt: new Date(),
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  };
  state.activeLearningReviewQueue.push(row);
  return { id: row.id, inserted: true };
}

export async function resolveActiveLearningReview(
  state: InMemoryStorageState,
  input: ResolveActiveLearningReviewInput
): Promise<ResolveActiveLearningReviewResult> {
  const row = state.activeLearningReviewQueue.find(
    (r) => r.id === input.reviewId && r.workspaceId === input.workspaceId
  );
  if (!row) return { resolved: false, factId: null, decisionId: null, cascaded: false };
  if (row.resolvedAt !== null) {
    return { resolved: false, factId: row.factId, decisionId: row.decisionId, cascaded: false };
  }

  row.resolvedAt = new Date();
  row.resolvedBy = input.resolvedBy;
  row.resolution = input.resolution;

  let cascaded = false;
  if (input.resolution === "forgotten" && row.factId) {
    const fact = state.facts.get(row.factId);
    if (fact && fact.workspaceId === input.workspaceId && !hasPendingMarker(fact.metadata)) {
      state.facts.set(row.factId, {
        ...fact,
        status: "forgotten",
        updatedAt: new Date(),
      });
      cascaded = true;
    }
  }

  return { resolved: true, factId: row.factId, decisionId: row.decisionId, cascaded };
}
