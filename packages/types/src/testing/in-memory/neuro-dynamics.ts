// in-memory/neuro-dynamics.ts — InMemoryStorageAdapter's neuro-dynamics stub
// methods (Wave Y §25.1-§25.3). decompose-inmemory-storage-adapter Batch B6
// (design.md Module Map row 26). Bodies moved verbatim — confirmed by
// design.md as pure stubs reading zero collections; not cross-domain despite
// the proposal's earlier candidate claim.

import type { InMemoryStorageState } from "./state.js";
import type { Sensitivity } from "../../common.js";

export async function decayKind(
  _state: InMemoryStorageState,
  _workspaceId: string,
  _decayClass: string,
  _halfLifeDays: number
): Promise<number> {
  return 0; // in-memory: no decay applied
}

export async function recordCoRecallStdp(
  _state: InMemoryStorageState,
  _workspaceId: string,
  _relationId: string,
  _coRecalledAt: Date
): Promise<void> {
  // in-memory: no-op
}

export async function normalizeHebbianWeights(
  _state: InMemoryStorageState,
  _workspaceId: string
): Promise<number> {
  return 0; // in-memory: no normalization
}

export async function enqueueReviewItem(
  state: InMemoryStorageState,
  input: {
    workspaceId: string;
    primitiveId: string;
    primitiveKind?: string;
    reason: string;
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  // P111 — was a no-op, which meant no unit test could ever assert that a
  // review had been enqueued. Four production paths write here (contradiction
  // §33, self-edit abuse §34.7, self-reflect knowledge gaps, Wave X anomaly);
  // all four were unobservable in tests.
  state.reviewItems.push({
    workspaceId: input.workspaceId,
    primitiveId: input.primitiveId,
    ...(input.primitiveKind !== undefined ? { primitiveKind: input.primitiveKind } : {}),
    reason: input.reason,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    createdAt: new Date(),
  });
}

export async function queryDriftCandidates(
  _state: InMemoryStorageState,
  _workspaceId: string
): Promise<
  Array<{
    id: string;
    statement: string;
    metadata: Record<string, unknown>;
    sensitivity: Sensitivity;
  }>
> {
  return []; // in-memory: no drift candidates
}
