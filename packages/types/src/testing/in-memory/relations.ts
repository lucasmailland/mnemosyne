// in-memory/relations.ts — Relations domain module for InMemoryStorageAdapter.
// decompose-inmemory-storage-adapter Batch B11a/B11b (design.md Module Map row 20).
// Move-only: bodies are verbatim transplants, `this.` -> `state.` is the only edit (D7).

import type {
  CreateRelationInput,
  RelationFilter,
  ApplyRelationJudgmentInput,
  ResolveConflictInput,
  ResolveConflictResult,
} from "../../ports.js";
import type { MnemoRelation, RelationNodeKind } from "../../relations.js";
import type { MnemoFact } from "../../primitives.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid } from "./support.js";
import { StorageValidationError } from "../../storage-errors.js";
import { SENSITIVITY_ORDER } from "../../security.js";
import type { Sensitivity } from "../../common.js";

export async function createRelation(
  state: InMemoryStorageState,
  input: CreateRelationInput
): Promise<MnemoRelation> {
  if (input.sourceType === input.targetType && input.sourceId === input.targetId) {
    throw new StorageValidationError("A relation cannot link a node to itself");
  }
  const now = new Date();
  const relation: MnemoRelation = {
    id: uuid(),
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    sourceType: input.sourceType,
    targetId: input.targetId,
    targetType: input.targetType,
    verb: input.verb,
    weight: input.weight ?? 1,
    coRecallCount: 0,
    directionality: 0,
    createdAt: now,
    updatedAt: now,
    // flatten-legacy-dual-core D6.4 bugfix: mirrors GraphRepository —
    // defaults, never a forced `evidence: {}`, so a pure-Hebbian create
    // leaves the judgment overlay's natural unset (`null`) state alone.
    validFrom: input.validFrom ?? now,
    validTo: input.validTo ?? null,
    judgmentStatus: input.judgmentStatus ?? "pending",
    reason: input.reason ?? null,
    evidence: input.evidence ?? null,
    confidence: input.confidence ?? null,
    markedByUserId: input.markedByUserId ?? null,
    markedByKind: input.markedByKind ?? "system",
    markedByModel: input.markedByModel ?? null,
    markedByPromptVersion: input.markedByPromptVersion ?? null,
    provenance: input.provenance ?? null,
    conversationId: input.conversationId ?? null,
    supersededByRelationId: input.supersededByRelationId ?? null,
  };
  if (input.actorId !== undefined) relation.actorId = input.actorId;
  if (input.userId !== undefined) relation.userId = input.userId;
  if (input.actorType !== undefined) relation.actorType = input.actorType;
  state.relations.set(relation.id, relation);
  // ENTITY-1 (flatten-legacy-dual-core PR9d) — mirrors GraphRepository's
  // fact->entity part_of/member_of entity_id backfill, first-relation-wins.
  if (
    input.sourceType === "fact" &&
    input.targetType === "entity" &&
    (input.verb === "part_of" || input.verb === "member_of")
  ) {
    const fact = state.facts.get(input.sourceId);
    if (fact && fact.workspaceId === input.workspaceId && fact.entityId == null) {
      state.facts.set(input.sourceId, { ...fact, entityId: input.targetId });
    }
  }
  return relation;
}

export async function getRelations(
  state: InMemoryStorageState,
  filter: RelationFilter
): Promise<MnemoRelation[]> {
  let items = [...state.relations.values()].filter((r) => r.workspaceId === filter.workspaceId);
  if (filter.sourceId) items = items.filter((r) => r.sourceId === filter.sourceId);
  if (filter.targetId) items = items.filter((r) => r.targetId === filter.targetId);
  if (filter.sourceIds && filter.sourceIds.length > 0) {
    const set = new Set(filter.sourceIds);
    items = items.filter((r) => set.has(r.sourceId));
  }
  if (filter.targetIds && filter.targetIds.length > 0) {
    const set = new Set(filter.targetIds);
    items = items.filter((r) => set.has(r.targetId));
  }
  if (filter.verb) items = items.filter((r) => r.verb === filter.verb);
  if (filter.verbs && filter.verbs.length > 0) {
    const set = new Set(filter.verbs);
    items = items.filter((r) => set.has(r.verb));
  }
  if (filter.judgmentStatus) {
    items = items.filter((r) => r.judgmentStatus === filter.judgmentStatus);
  }
  // Mirrors GraphRepository.getRelations: open rows only unless validAt or an
  // explicit openOnly: false asks for history.
  if (filter.openOnly ?? filter.validAt === undefined) {
    items = items.filter((r) => r.validTo === null);
  }
  if (filter.validAt) {
    const at = filter.validAt.getTime();
    items = items.filter(
      (r) => r.validFrom.getTime() <= at && (r.validTo === null || r.validTo.getTime() > at)
    );
  }
  if (filter.maxSensitivity) {
    const ceiling = filter.maxSensitivity;
    items = items.filter((r) => !touchesHiddenRow(state, r, ceiling));
  }
  items = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (filter.limit) items = items.slice(0, filter.limit);
  return items;
}

type RowMap = Map<string, { workspaceId?: string; sensitivity?: Sensitivity }>;

/** The rows a node of each kind resolves in (GraphRepository's `mnemo_<kind>` tables). */
function rowsByKind(state: InMemoryStorageState): Record<RelationNodeKind, RowMap> {
  return {
    fact: state.facts,
    decision: state.decisions,
    entity: state.entities,
    episode: state.episodes,
    strategy: state.strategies,
    workflow: state.workflows,
    skill: state.skills,
    task: state.tasks,
    event: state.events,
    reasoning: state.reasonings,
  };
}

/**
 * True when `id` resolves to a row above `ceiling`: in `kind`'s rows when the
 * kind is known (a relation endpoint), in any kind's otherwise (a hyperedge
 * member). An id that resolves to nothing is not hidden.
 */
export function isHiddenRow(
  state: InMemoryStorageState,
  id: string,
  ceiling: Sensitivity,
  kind?: RelationNodeKind
): boolean {
  const maps = rowsByKind(state);
  return (kind ? [maps[kind]] : Object.values(maps)).some((rows) => {
    const row = rows.get(id);
    return !!row && SENSITIVITY_ORDER[row.sensitivity ?? "internal"] > SENSITIVITY_ORDER[ceiling];
  });
}

/** GraphPort.findHiddenIds: the ids that resolve, in this workspace, to a row above the ceiling. */
export async function findHiddenIds(
  state: InMemoryStorageState,
  input: { workspaceId: string; ids: string[]; maxSensitivity: Sensitivity }
): Promise<string[]> {
  const maps = Object.values(rowsByKind(state));
  return [...new Set(input.ids)].filter((id) =>
    maps.some((rows) => {
      const row = rows.get(id);
      return (
        !!row &&
        row.workspaceId === input.workspaceId &&
        SENSITIVITY_ORDER[row.sensitivity ?? "internal"] > SENSITIVITY_ORDER[input.maxSensitivity]
      );
    })
  );
}

/** GraphPort.countOpenConflicts: the pairs GET /conflicts can list. */
export async function countOpenConflicts(
  state: InMemoryStorageState,
  input: { workspaceId: string; maxSensitivity?: Sensitivity }
): Promise<number> {
  const listable = (id: string) => {
    const f = state.facts.get(id);
    return (
      !!f &&
      f.workspaceId === input.workspaceId &&
      f.validTo == null &&
      (!input.maxSensitivity ||
        SENSITIVITY_ORDER[f.sensitivity ?? "internal"] <= SENSITIVITY_ORDER[input.maxSensitivity])
    );
  };
  return [...state.relations.values()].filter(
    (r) =>
      r.workspaceId === input.workspaceId &&
      r.verb === "conflicts_with" &&
      r.validTo == null &&
      listable(r.sourceId) &&
      listable(r.targetId)
  ).length;
}

export function touchesHiddenRow(
  state: InMemoryStorageState,
  r: MnemoRelation,
  ceiling: Sensitivity | undefined
): boolean {
  return (
    !!ceiling &&
    (isHiddenRow(state, r.sourceId, ceiling, r.sourceType) ||
      isHiddenRow(state, r.targetId, ceiling, r.targetType))
  );
}

export async function updateRelationStrength(
  state: InMemoryStorageState,
  id: string,
  delta: number
): Promise<void> {
  const r = state.relations.get(id);
  if (r) state.relations.set(id, { ...r, weight: (r.weight ?? 1) + delta });
}

export async function deleteRelation(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const r = state.relations.get(id);
  if (r && r.workspaceId === workspaceId) state.relations.delete(id);
}

/**
 * P111 — bitemporal close, mirroring GraphRepository.closeRelation: the row
 * stays, `validTo` is stamped, and an already-closed relation reports false
 * rather than being re-stamped.
 */
export async function closeRelation(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  opts?: { maxSensitivity?: Sensitivity }
): Promise<boolean> {
  const r = state.relations.get(id);
  if (!r || r.workspaceId !== workspaceId) return false;
  if (r.validTo != null) return false;
  if (touchesHiddenRow(state, r, opts?.maxSensitivity)) return false;
  state.relations.set(id, { ...r, validTo: new Date() });
  return true;
}

/** flatten-legacy-dual-core D6.4 — see `ApplyRelationJudgmentInput`'s doc comment (ports.ts). */
export async function applyRelationJudgment(
  state: InMemoryStorageState,
  input: ApplyRelationJudgmentInput
): Promise<MnemoRelation | null> {
  const r = state.relations.get(input.id);
  if (!r || r.workspaceId !== input.workspaceId) return null;
  if (touchesHiddenRow(state, r, input.maxSensitivity)) return null;
  const updated: MnemoRelation = {
    ...r,
    verb: input.relation,
    judgmentStatus: "judged",
    markedByKind: input.markedByKind,
    updatedAt: new Date(),
  };
  if (input.reason !== undefined) updated.reason = input.reason;
  if (input.evidence !== undefined) updated.evidence = input.evidence;
  if (input.confidence !== undefined) updated.confidence = input.confidence;
  if (input.markedByUserId !== undefined) updated.markedByUserId = input.markedByUserId;
  if (input.markedByModel !== undefined) updated.markedByModel = input.markedByModel;
  if (input.markedByPromptVersion !== undefined) {
    updated.markedByPromptVersion = input.markedByPromptVersion;
  }
  state.relations.set(input.id, updated);
  return updated;
}

// B5 — see `ResolveConflictInput`'s doc comment (ports.ts) for why this is
// one composite method rather than 4-6 chained calls. In-memory fake has no
// real transaction boundary to test (that's `FactRepository`'s job via a
// real Postgres integration test) — this exists purely so callers relying
// on `InMemoryStorageAdapter` (e.g. unit tests unrelated to B5 itself) see
// correct end-state behavior.
export async function resolveConflict(
  state: InMemoryStorageState,
  input: ResolveConflictInput
): Promise<ResolveConflictResult> {
  const now = new Date();
  const closeFact = (id: string) => {
    const f = state.facts.get(id);
    if (f && f.workspaceId === input.workspaceId && f.validTo === undefined) {
      state.facts.set(id, { ...f, status: "forgotten", validTo: now, updatedAt: now });
    }
  };
  const judgeNotConflict = (reason: string) => {
    const r = state.relations.get(input.relationId);
    if (r && r.workspaceId === input.workspaceId) {
      state.relations.set(input.relationId, {
        ...r,
        verb: "not_conflict",
        judgmentStatus: "judged",
        markedByKind: "llm_judge",
        reason,
      });
    }
  };
  const insertSupersedes = (
    sourceType: string,
    sourceId: string,
    targetType: string,
    targetId: string,
    reason: string
  ) => {
    const relation: MnemoRelation = {
      id: uuid(),
      workspaceId: input.workspaceId,
      sourceId,
      sourceType: sourceType as MnemoRelation["sourceType"],
      targetId,
      targetType: targetType as MnemoRelation["targetType"],
      verb: "supersedes",
      weight: 1,
      coRecallCount: 0,
      directionality: 0,
      createdAt: now,
      updatedAt: now,
      validFrom: now,
      validTo: null,
      judgmentStatus: "judged",
      reason,
      evidence: null,
      confidence: null,
      markedByUserId: null,
      markedByKind: "llm_judge",
      markedByModel: null,
      markedByPromptVersion: null,
      provenance: null,
      conversationId: null,
      supersededByRelationId: null,
      actorId: input.actorId,
      userId: input.userId ?? undefined,
      actorType: input.actorType,
    };
    state.relations.set(relation.id, relation);
  };

  let mergedFactId: string | null = null;

  switch (input.action) {
    case "supersede_a":
      closeFact(input.sourceId);
      judgeNotConflict("Resolved via memory_judge: supersede_a");
      insertSupersedes(
        input.targetKind,
        input.targetId,
        input.sourceKind,
        input.sourceId,
        "Resolved via memory_judge: supersede_a (factB supersedes factA)"
      );
      break;
    case "supersede_b":
      closeFact(input.targetId);
      judgeNotConflict("Resolved via memory_judge: supersede_b");
      insertSupersedes(
        input.sourceKind,
        input.sourceId,
        input.targetKind,
        input.targetId,
        "Resolved via memory_judge: supersede_b (factA supersedes factB)"
      );
      break;
    case "keep_both":
      judgeNotConflict("Resolved via memory_judge: keep_both");
      break;
    case "merge": {
      closeFact(input.sourceId);
      closeFact(input.targetId);
      const id = uuid();
      const fact: MnemoFact = {
        id,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        userId: input.userId ?? undefined,
        actorType: input.actorType,
        scope: "global",
        scopeOwner: `workspace:${input.workspaceId}`,
        statement: input.mergedStatement ?? "",
        subject: "workspace",
        kind: "other",
        confidence: 0.7,
        relevance: 1.0,
        hitCount: 0,
        worthSuccess: 0,
        worthFailure: 0,
        worthAlpha: 2,
        worthBeta: 2,
        worth: 0.5,
        memoryType: "semantic",
        memoryStrength: 1,
        memoryStability: 1,
        attribution: "inferred",
        sourceMessageIds: [],
        linkedMemoryIds: [],
        revisionCount: 1,
        protocolVersion: "3.0",
        status: "active",
        pinned: false,
        canonical: false,
        sensitivity: "internal",
        validFrom: now,
        embeddingStale: true,
        createdAt: now,
        updatedAt: now,
        metadata: { mergedFrom: [input.sourceId, input.targetId], mergedBy: "llm_judge" },
      };
      state.facts.set(id, fact);
      mergedFactId = id;
      judgeNotConflict(`Resolved via memory_judge: merge → ${mergedFactId}`);
      insertSupersedes(
        "fact",
        mergedFactId,
        input.sourceKind,
        input.sourceId,
        `Resolved via memory_judge: merge → ${mergedFactId} (supersedes factA)`
      );
      insertSupersedes(
        "fact",
        mergedFactId,
        input.targetKind,
        input.targetId,
        `Resolved via memory_judge: merge → ${mergedFactId} (supersedes factB)`
      );
      break;
    }
  }

  return { mergedFactId };
}

/**
 * D4 override — reads `relations` only, a pure `derived_from`/`part_of`
 * graph walk that never touches `facts`. Canonical port is `FactPort`
 * (segregate-storage-ports D4), but state coupling wins here (design.md D4).
 */
export async function getProvenanceCredit(
  state: InMemoryStorageState,
  workspaceId: string,
  terminalIds: string[],
  lambda: number,
  maxHops: number
): Promise<Array<{ factId: string; credit: number }>> {
  const cap = Math.min(maxHops, 5);
  const best = new Map<string, number>();
  for (const start of terminalIds) {
    const queue: Array<{ id: string; credit: number; depth: number; path: Set<string> }> = [
      { id: start, credit: 1, depth: 0, path: new Set([start]) },
    ];
    while (queue.length) {
      const { id, credit, depth, path } = queue.shift()!;
      if (depth >= cap) continue;
      const preds = [...state.relations.values()].filter(
        (r) =>
          r.workspaceId === workspaceId &&
          r.sourceId === id &&
          (r.verb === "derived_from" || r.verb === "part_of")
      );
      for (const r of preds) {
        if (path.has(r.targetId)) continue; // cycle guard
        const c = credit * lambda;
        if ((best.get(r.targetId) ?? -1) < c) best.set(r.targetId, c);
        queue.push({
          id: r.targetId,
          credit: c,
          depth: depth + 1,
          path: new Set([...path, r.targetId]),
        });
      }
    }
  }
  return [...best.entries()].map(([factId, credit]) => ({ factId, credit }));
}
