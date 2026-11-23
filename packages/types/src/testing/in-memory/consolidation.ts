// in-memory/consolidation.ts — Consolidation domain module for InMemoryStorageAdapter.
// decompose-inmemory-storage-adapter Batch B12c (design.md Module Map row 6).
// Move-only: bodies are verbatim transplants, `this.` -> `state.` is the only edit (D7).
// The 3 private helpers (`consolidationRows`, `pendingConsolidationRows`,
// `compensateConsolidationMerge`) travel with their only caller cluster and
// become module-private (non-exported) functions (D6).

import type {
  ApplyConsolidationMergeInput,
  ConsolidationMergeSnapshot,
  ReplayFailureReview,
} from "../../ports.js";
import type { MnemoFact } from "../../primitives.js";
import type { InMemoryStorageState } from "./state.js";
import {
  uuid,
  PENDING_KEY,
  worthSnapshot,
  worthEquals,
  markerFor,
  withoutPendingMarker,
  type ConsolidationMarker,
} from "./support.js";

export async function applyConsolidationMerge(
  state: InMemoryStorageState,
  input: ApplyConsolidationMergeInput
): Promise<ConsolidationMergeSnapshot | null> {
  const participantIds = [input.survivorId, ...input.absorbedFactIds].sort();
  const rows = participantIds.flatMap((id) => {
    const row = state.facts.get(id);
    return row ? [row] : [];
  });
  const eligible =
    input.absorbedFactIds.length > 0 &&
    new Set(participantIds).size === participantIds.length &&
    rows.length === participantIds.length &&
    rows.every(
      (row) =>
        row.workspaceId === input.workspaceId &&
        row.status === "active" &&
        row.validTo == null &&
        !Object.prototype.hasOwnProperty.call(row.metadata ?? {}, PENDING_KEY)
    );
  const survivor = rows.filter((row) => row.id === input.survivorId);
  const absorbed = input.absorbedFactIds.map((id) => rows.find((row) => row.id === id));
  if (!eligible || survivor.length !== 1 || absorbed.some((row) => !row)) return null;

  const previousWorth = worthSnapshot(survivor[0]!);
  const expectedMergedWorth = {
    ...previousWorth,
    alpha: previousWorth.alpha + 1,
    success: previousWorth.success + 1,
  };
  const snapshot: ConsolidationMergeSnapshot = {
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    survivorId: input.survivorId,
    absorbedFactIds: [...input.absorbedFactIds],
    previousWorth,
    expectedMergedWorth,
  };
  const marker: ConsolidationMarker = {
    ...snapshot,
    leaseExpiresAt: input.leaseExpiresAt.toISOString(),
  };
  const closedAt = new Date();
  for (const row of rows) {
    const isSurvivor = row.id === input.survivorId;
    const updated: MnemoFact = {
      ...row,
      metadata: { ...row.metadata, [PENDING_KEY]: marker },
      updatedAt: closedAt,
      ...(isSurvivor
        ? {
            worthAlpha: expectedMergedWorth.alpha,
            worthBeta: expectedMergedWorth.beta,
            worthSuccess: expectedMergedWorth.success,
            worthFailure: expectedMergedWorth.failure,
            worth:
              expectedMergedWorth.alpha / (expectedMergedWorth.alpha + expectedMergedWorth.beta),
          }
        : { status: "merged", validTo: closedAt, mergedIntoId: input.survivorId }),
    };
    state.facts.set(row.id, updated);
  }
  return snapshot;
}

function consolidationRows(
  state: InMemoryStorageState,
  snapshot: ConsolidationMergeSnapshot
): MnemoFact[] | null {
  const ids = [snapshot.survivorId, ...snapshot.absorbedFactIds];
  const rows = ids.flatMap((id) => {
    const row = state.facts.get(id);
    return row ? [row] : [];
  });
  return rows.length === ids.length && rows.every((row) => row.workspaceId === snapshot.workspaceId)
    ? rows
    : null;
}

function pendingConsolidationRows(
  state: InMemoryStorageState,
  snapshot: ConsolidationMergeSnapshot
): MnemoFact[] | null {
  const rows = consolidationRows(state, snapshot);
  if (!rows || !rows.every((row) => markerFor(row)?.operationId === snapshot.operationId))
    return null;
  const survivor = rows.find((row) => row.id === snapshot.survivorId)!;
  const absorbed = rows.filter((row) => row.id !== snapshot.survivorId);
  return survivor.status === "active" &&
    survivor.validTo == null &&
    worthEquals(survivor, snapshot.expectedMergedWorth) &&
    absorbed.every(
      (row) =>
        row.status === "merged" && row.validTo != null && row.mergedIntoId === snapshot.survivorId
    )
    ? rows
    : null;
}

function compensateConsolidationMerge(
  state: InMemoryStorageState,
  snapshot: ConsolidationMergeSnapshot,
  review: ReplayFailureReview
): boolean {
  const rows = pendingConsolidationRows(state, snapshot);
  if (!rows) return false;
  const now = new Date();
  for (const row of rows) {
    const isSurvivor = row.id === snapshot.survivorId;
    const updated: MnemoFact = {
      ...row,
      status: "active",
      validTo: undefined,
      mergedIntoId: undefined,
      metadata: withoutPendingMarker(row.metadata),
      updatedAt: now,
      ...(isSurvivor
        ? {
            worthAlpha: snapshot.previousWorth.alpha,
            worthBeta: snapshot.previousWorth.beta,
            worthSuccess: snapshot.previousWorth.success,
            worthFailure: snapshot.previousWorth.failure,
            worth:
              snapshot.previousWorth.alpha /
              (snapshot.previousWorth.alpha + snapshot.previousWorth.beta),
          }
        : {}),
    };
    state.facts.set(row.id, updated);
  }
  state.consolidationReviews.push({
    id: `mrev_${uuid()}`,
    workspaceId: snapshot.workspaceId,
    factId: snapshot.survivorId,
    reason: "manual",
    review,
  });
  return true;
}

export async function rollbackConsolidationMerge(
  state: InMemoryStorageState,
  input: {
    snapshot: ConsolidationMergeSnapshot;
    review: ReplayFailureReview;
  }
): Promise<"rolled_back" | "conflict"> {
  return compensateConsolidationMerge(state, input.snapshot, input.review)
    ? "rolled_back"
    : "conflict";
}

export async function finalizeConsolidationMerge(
  state: InMemoryStorageState,
  input: {
    snapshot: ConsolidationMergeSnapshot;
    applyReplayBoost: boolean;
  }
): Promise<"finalized" | "conflict"> {
  const rows = pendingConsolidationRows(state, input.snapshot);
  if (!rows) return "conflict";
  const now = new Date();
  for (const row of rows) {
    const isSurvivor = row.id === input.snapshot.survivorId;
    const boost = isSurvivor && input.applyReplayBoost ? 1 : 0;
    const updated = {
      ...row,
      metadata: withoutPendingMarker(row.metadata),
      updatedAt: now,
      ...(isSurvivor && boost
        ? {
            worthAlpha: row.worthAlpha + boost,
            worthSuccess: row.worthSuccess + boost,
            worth: (row.worthAlpha + boost) / (row.worthAlpha + boost + row.worthBeta),
          }
        : {}),
    };
    state.facts.set(row.id, updated);
  }
  return "finalized";
}

export async function refreshConsolidationMergeLease(
  state: InMemoryStorageState,
  input: {
    snapshot: ConsolidationMergeSnapshot;
    leaseExpiresAt: Date;
  }
): Promise<"refreshed" | "conflict"> {
  const rows = pendingConsolidationRows(state, input.snapshot);
  if (!rows) return "conflict";
  for (const row of rows) {
    const marker = markerFor(row)!;
    state.facts.set(row.id, {
      ...row,
      metadata: {
        ...row.metadata,
        [PENDING_KEY]: { ...marker, leaseExpiresAt: input.leaseExpiresAt.toISOString() },
      },
    });
  }
  return "refreshed";
}

export async function inspectConsolidationMergeState(
  state: InMemoryStorageState,
  snapshot: ConsolidationMergeSnapshot
): Promise<"pending" | "restored" | "retained" | "divergent"> {
  const rows = consolidationRows(state, snapshot);
  if (!rows) return "divergent";
  const survivor = rows.find((row) => row.id === snapshot.survivorId)!;
  const absorbed = rows.filter((row) => row.id !== snapshot.survivorId);
  const markers = rows.map(markerFor);
  const noMarkers = markers.every((marker) => marker === undefined);
  if (pendingConsolidationRows(state, snapshot)) return "pending";
  if (
    noMarkers &&
    survivor.status === "active" &&
    survivor.validTo == null &&
    worthEquals(survivor, snapshot.previousWorth) &&
    absorbed.every((row) => row.status === "active" && row.validTo == null)
  )
    return "restored";
  const boostedWorth = {
    ...snapshot.expectedMergedWorth,
    alpha: snapshot.expectedMergedWorth.alpha + 1,
    success: snapshot.expectedMergedWorth.success + 1,
  };
  if (
    noMarkers &&
    survivor.status === "active" &&
    survivor.validTo == null &&
    (worthEquals(survivor, snapshot.expectedMergedWorth) || worthEquals(survivor, boostedWorth)) &&
    absorbed.every(
      (row) =>
        row.status === "merged" && row.validTo != null && row.mergedIntoId === snapshot.survivorId
    )
  )
    return "retained";
  return "divergent";
}

export async function recoverExpiredConsolidationMerges(
  state: InMemoryStorageState,
  input: {
    workspaceId: string;
    expiredBefore: Date;
  }
): Promise<number> {
  const operations = new Map<string, ConsolidationMarker>();
  for (const fact of state.facts.values()) {
    const marker = markerFor(fact);
    if (
      fact.workspaceId === input.workspaceId &&
      marker &&
      new Date(marker.leaseExpiresAt).getTime() <= input.expiredBefore.getTime()
    ) {
      operations.set(marker.operationId, marker);
    }
  }
  let recovered = 0;
  for (const marker of operations.values()) {
    const rows = pendingConsolidationRows(state, marker);
    if (
      !rows ||
      !rows.every((row) => {
        const refreshed = markerFor(row);
        return (
          refreshed?.operationId === marker.operationId &&
          new Date(refreshed.leaseExpiresAt).getTime() <= input.expiredBefore.getTime()
        );
      })
    )
      continue;
    if (
      compensateConsolidationMerge(state, marker, {
        reason: "replay_execution_failed",
        passCount: 0,
        failCount: 0,
        queriesUsed: [],
      })
    )
      recovered += 1;
  }
  return recovered;
}
