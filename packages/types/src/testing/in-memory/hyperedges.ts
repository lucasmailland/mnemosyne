// in-memory/hyperedges.ts — InMemoryStorageAdapter's Hyperedge port methods
// (Wave D). decompose-inmemory-storage-adapter Batch B6 (design.md Module Map
// row 18). Bodies moved verbatim from InMemoryStorageAdapter.ts — the only
// edit is `this.<field>` → `state.<field>` (design.md D7 move-only rule).
//
// `createHyperedge`'s `memberIds.length < 3` throw preserves its `async`
// modifier so it still surfaces as a rejection, not a synchronous throw (D7).
// `updateHyperedge`, `archiveHyperedge`, `bumpHyperedgeActivation` all mutate
// the stored hyperedge object in place — preserved exactly, not converted to
// a re-`set` pattern.

import type { CreateHyperedgeInput, UpdateHyperedgeInput, HyperedgeFilter } from "../../ports.js";
import type { MnemoHyperedge } from "../../primitives.js";
import type { PaginatedResult } from "../../common.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid, paginate } from "./support.js";
import { SENSITIVITY_ORDER } from "../../security.js";
import type { Sensitivity } from "../../common.js";
import { StorageNotFoundError, StorageValidationError } from "../../storage-errors.js";
import { isHiddenRow } from "./relations.js";

export async function createHyperedge(
  state: InMemoryStorageState,
  input: CreateHyperedgeInput
): Promise<MnemoHyperedge> {
  if (input.memberIds.length < 3) {
    throw new Error("createHyperedge requires at least 3 memberIds");
  }
  if (new Set(input.memberIds).size !== input.memberIds.length) {
    throw new StorageValidationError("Hyperedge members must be distinct");
  }
  if (input.verifyMembers) {
    const known = (id: string): boolean =>
      [
        state.facts,
        state.decisions,
        state.entities,
        state.episodes,
        state.strategies,
        state.workflows,
        state.skills,
        state.tasks,
        state.events,
        state.reasonings,
      ].some((m) => {
        const row = (m as Map<string, { workspaceId: string; sensitivity?: Sensitivity }>).get(id);
        if (row === undefined || row.workspaceId !== input.workspaceId) return false;
        if (!input.maxSensitivity) return true;
        return (
          SENSITIVITY_ORDER[row.sensitivity ?? "internal"] <=
          SENSITIVITY_ORDER[input.maxSensitivity]
        );
      });
    if (input.memberIds.some((m) => !known(m))) {
      throw new StorageNotFoundError("One or more hyperedge members were not found");
    }
  }
  const now = new Date();
  const h: MnemoHyperedge = {
    id: uuid(),
    workspaceId: input.workspaceId,
    memberIds: input.memberIds,
    activationCount: 0,
    worth: 0.5,
    validFrom: now,
    createdAt: now,
  };
  if (input.label !== undefined) h.label = input.label;
  if (input.description !== undefined) h.description = input.description;
  if (input.contextQuery !== undefined) h.contextQuery = input.contextQuery;
  if (input.contextEmbedding !== undefined) h.contextEmbedding = input.contextEmbedding;
  if (input.actorId !== undefined) h.actorId = input.actorId;
  if (input.userId !== undefined) h.userId = input.userId;
  if (input.actorType !== undefined) h.actorType = input.actorType;
  state.hyperedges.set(h.id, h);
  return h;
}

export async function getHyperedge(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  opts?: { includeClosed?: boolean; maxSensitivity?: Sensitivity }
): Promise<MnemoHyperedge | null> {
  const h = state.hyperedges.get(id);
  if (!h || h.workspaceId !== workspaceId) return null;
  if (h.validTo != null && !opts?.includeClosed) return null;
  if (hasHiddenMember(state, h, opts?.maxSensitivity)) return null;
  return h;
}

/** A hyperedge with a member above the caller's ceiling is not theirs to see. */
export function hasHiddenMember(
  state: InMemoryStorageState,
  h: MnemoHyperedge,
  ceiling: Sensitivity | undefined
): boolean {
  return !!ceiling && h.memberIds.some((m) => isHiddenRow(state, m, ceiling));
}

export async function updateHyperedge(
  state: InMemoryStorageState,
  id: string,
  input: UpdateHyperedgeInput
): Promise<MnemoHyperedge> {
  const h = state.hyperedges.get(id);
  if (!h || (input.workspaceId !== undefined && h.workspaceId !== input.workspaceId)) {
    throw new StorageNotFoundError(`Hyperedge not found: ${id}`);
  }
  if (h.validTo != null) throw new StorageNotFoundError(`Hyperedge not found: ${id}`);
  if (input.label !== undefined) h.label = input.label;
  if (input.description !== undefined) h.description = input.description;
  if (input.contextQuery !== undefined) h.contextQuery = input.contextQuery;
  return h;
}

export async function archiveHyperedge(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const h = state.hyperedges.get(id);
  if (h && h.workspaceId === workspaceId && h.validTo == null) {
    h.validTo = new Date();
  }
}

export async function queryHyperedges(
  state: InMemoryStorageState,
  filter: HyperedgeFilter
): Promise<PaginatedResult<MnemoHyperedge>> {
  let items = [...state.hyperedges.values()].filter((h) => h.workspaceId === filter.workspaceId);
  if (!filter.includeClosed) items = items.filter((h) => h.validTo == null);
  if (filter.memberId) {
    items = items.filter((h) => h.memberIds.includes(filter.memberId!));
  }
  if (filter.label) {
    items = items.filter((h) => h.label === filter.label);
  }
  if (filter.maxSensitivity) {
    items = items.filter((h) => !hasHiddenMember(state, h, filter.maxSensitivity));
  }
  // Sort by activationCount desc (mirrors Drizzle impl)
  items.sort((a, b) => b.activationCount - a.activationCount);
  return paginate(items, filter.offset, filter.limit);
}

export async function bumpHyperedgeActivation(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const h = state.hyperedges.get(id);
  if (h && h.workspaceId === workspaceId) {
    h.activationCount += 1;
  }
}
