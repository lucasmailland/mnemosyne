// in-memory/entities.ts — InMemoryStorageAdapter's Entity port methods.
// decompose-inmemory-storage-adapter Batch B1 (design.md Module Map row 10).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type {
  CreateEntityInput,
  UpdateEntityInput,
  EntityFilter,
  SimilarEntity,
  SupersedeEntityInput,
} from "../../ports.js";
import { StorageConflictError, StorageNotFoundError } from "../../storage-errors.js";
import type { MnemoRelation } from "../../relations.js";
import type { MnemoEntity } from "../../primitives.js";
import type { PaginatedResult } from "../../common.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid, paginate } from "./support.js";

/** Mirrors `uq_mnemo_entity_live_name_kind`: a (workspace, name, kind) is unique among LIVE rows only. */
function assertNameFree(
  state: InMemoryStorageState,
  workspaceId: string,
  name: string,
  kind: MnemoEntity["kind"],
  exceptId?: string
): void {
  for (const e of state.entities.values()) {
    if (
      e.id !== exceptId &&
      e.workspaceId === workspaceId &&
      e.name === name &&
      e.kind === kind &&
      e.validTo == null
    ) {
      throw new StorageConflictError(`An entity named "${name}" of kind ${kind} already exists`);
    }
  }
}

export async function createEntity(
  state: InMemoryStorageState,
  input: CreateEntityInput
): Promise<MnemoEntity> {
  assertNameFree(state, input.workspaceId, input.name, input.kind);
  const now = new Date();
  const entity = {
    id: uuid(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    userId: input.userId,
    actorType: input.actorType,
    kind: input.kind,
    name: input.name,
    description: input.description,
    aliases: input.aliases ?? [],
    canonicalId: input.canonicalId,
    sensitivity: input.sensitivity ?? "internal",
    firstSeenAt: now,
    lastSeenAt: now,
    mentionCount: 0,
    // P18: initialize bitemporal columns
    validFrom: now,
    validTo: undefined,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata ?? {},
  } as unknown as MnemoEntity;
  state.entities.set(entity.id, entity);
  return entity;
}

export async function getEntity(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoEntity | null> {
  const e = state.entities.get(id);
  return e && e.workspaceId === workspaceId ? e : null;
}

export async function updateEntity(
  state: InMemoryStorageState,
  id: string,
  input: UpdateEntityInput
): Promise<MnemoEntity> {
  const e = state.entities.get(id);
  if (!e) throw new Error(`Entity ${id} not found`);
  if ((input.name !== undefined || input.kind !== undefined) && e.validTo == null) {
    assertNameFree(state, e.workspaceId, input.name ?? e.name, input.kind ?? e.kind, id);
  }
  // flatten-legacy-dual-core PR9a: UpdateEntityInput's canonicalId/
  // description accept `null` (explicit "clear"); MnemoEntity's own read
  // shape only ever carries `undefined` for "unset" (mirrors
  // mapRowToEntity's `row.canonicalId ?? undefined` normalization in
  // adapter-postgres) — normalize the same way here.
  const updated: MnemoEntity = {
    ...e,
    ...input,
    canonicalId: input.canonicalId === null ? undefined : (input.canonicalId ?? e.canonicalId),
    description: input.description === null ? undefined : (input.description ?? e.description),
    updatedAt: new Date(),
  };
  state.entities.set(id, updated);
  return updated;
}

export async function archiveEntity(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const e = state.entities.get(id);
  if (e && e.workspaceId === workspaceId) {
    // P18: close bitemporal interval (do NOT delete — mirrors Postgres repository)
    state.entities.set(id, { ...e, validTo: new Date(), updatedAt: new Date() });
  }
}

/** WP-6 / PRIM-2 — in-memory twin of `EntityRepository.supersedeEntity`. */
export async function supersedeEntity(
  state: InMemoryStorageState,
  input: SupersedeEntityInput
): Promise<MnemoEntity> {
  const closed = state.entities.get(input.id);
  if (!closed || closed.workspaceId !== input.workspaceId) {
    throw new StorageNotFoundError(`Entity ${input.id} not found`);
  }
  if (closed.validTo != null) {
    throw new StorageConflictError(`Entity ${input.id} is already closed`);
  }
  const linked = input.successor.linkedUserId;
  if (linked != null) {
    for (const e of state.entities.values()) {
      if (
        e.id !== closed.id &&
        e.workspaceId === input.workspaceId &&
        e.validTo == null &&
        e.linkedUserId === linked
      ) {
        throw new StorageConflictError(`User ${linked} is already linked to a live entity`);
      }
    }
  }
  const now = new Date();
  state.entities.set(closed.id, { ...closed, validTo: now, updatedAt: now });
  const successor = {
    ...closed,
    id: uuid(),
    linkedUserId: linked,
    sensitivity: input.successor.sensitivity ?? closed.sensitivity,
    firstSeenAt: now,
    lastSeenAt: now,
    validFrom: now,
    validTo: undefined,
    createdAt: now,
    updatedAt: now,
    ...(input.successor.actorId !== undefined ? { actorId: input.successor.actorId } : {}),
    ...(input.successor.userId !== undefined ? { userId: input.successor.userId } : {}),
    ...(input.successor.actorType !== undefined ? { actorType: input.successor.actorType } : {}),
  } as MnemoEntity;
  state.entities.set(successor.id, successor);
  const relation: MnemoRelation = {
    id: uuid(),
    workspaceId: input.workspaceId,
    sourceId: successor.id,
    sourceType: "entity",
    targetId: closed.id,
    targetType: "entity",
    verb: "supersedes",
    weight: 1,
    coRecallCount: 0,
    directionality: 0,
    createdAt: now,
    updatedAt: now,
    validFrom: now,
    validTo: null,
    judgmentStatus: "pending",
    reason: null,
    evidence: null,
    confidence: null,
    markedByUserId: null,
    markedByKind: "system",
    markedByModel: null,
    markedByPromptVersion: null,
    provenance: null,
    conversationId: null,
    supersededByRelationId: null,
  };
  state.relations.set(relation.id, relation);
  return successor;
}

export async function queryEntities(
  state: InMemoryStorageState,
  filter: EntityFilter
): Promise<PaginatedResult<MnemoEntity>> {
  // flatten-legacy-dual-core PR9a: `kind` was declared on EntityFilter but
  // never actually applied here (pre-existing gap, fixed alongside the new
  // `q` filter this PR adds — same method, same missing-predicate class).
  const needle = filter.q?.trim().toLowerCase() ?? "";
  const items = [...state.entities.values()].filter((e) => {
    if (e.workspaceId !== filter.workspaceId) return false;
    if (filter.kind && e.kind !== filter.kind) return false;
    if (filter.name && e.name !== filter.name) return false;
    // D6.2: case-insensitive substring across name + aliases, mirroring
    // legacy `core/src/entity/query.ts`'s listEntities + EntityRepository's
    // Postgres ILIKE implementation.
    if (needle.length > 0) {
      const nameMatch = e.name.toLowerCase().includes(needle);
      const aliasMatch = (e.aliases ?? []).some((a) => a.toLowerCase().includes(needle));
      if (!nameMatch && !aliasMatch) return false;
    }
    // P18: validAt predicate — open-interval semantics (validTo > validAt, NOT >=)
    if (filter.validAt) {
      if (e.validFrom > filter.validAt) return false;
      if (e.validTo != null && e.validTo <= filter.validAt) return false;
    }
    if (filter.openOnly && e.validTo != null) return false;
    return true;
  });
  // Mirrors legacy ordering: most-recently-mentioned first, deterministic
  // tiebreakers so pagination doesn't shuffle rows on refresh.
  items.sort((a, b) => {
    const bySeen = b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
    if (bySeen !== 0) return bySeen;
    const byCreated = b.createdAt.getTime() - a.createdAt.getTime();
    if (byCreated !== 0) return byCreated;
    return b.id.localeCompare(a.id);
  });
  return paginate(items, filter.offset, filter.limit);
}

// P16 — stub: InMemoryStorageAdapter has no vector index for entities.
export async function findSimilarEntities(
  _state: InMemoryStorageState,
  _workspaceId: string,
  _embedding: number[],
  _limit: number,
  _minSim: number
): Promise<SimilarEntity[]> {
  return Promise.resolve([]);
}
