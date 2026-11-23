// in-memory/decisions.ts — InMemoryStorageAdapter's Decision port methods.
// decompose-inmemory-storage-adapter Batch B1 (design.md Module Map row 8).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type {
  CreateDecisionInput,
  UpdateDecisionInput,
  DecisionFilter,
  MergeDecisionByTopicKeyInput,
  SupersedeDecisionInput,
} from "../../ports.js";
import {
  StorageConflictError,
  StorageNotFoundError,
  StorageValidationError,
} from "../../storage-errors.js";
import type { MnemoRelation } from "../../relations.js";
import type { MnemoDecision } from "../../primitives.js";
import { SENSITIVITY_ORDER } from "../../security.js";
import type { PaginatedResult } from "../../common.js";
import { PRIMITIVE_TEXT_PROJECTION } from "../../indexing.js";
import type { InMemoryStorageState } from "./state.js";
import { closeAt, uuid, paginate } from "./support.js";
import { scopeRefMatches } from "../../scope-ref.js";

// make-primitives-recallable (PR1, design.md D1/tasks.md 2.4): mirrors
// DecisionRepository's projectDecisionText — derives the outbox `text`
// payload from the shared registry instead of a hardcoded `title + " " +
// body` concat, so InMemory and Drizzle stay behaviourally identical.
function projectDecisionText(title: string, body: string): string {
  const projection = PRIMITIVE_TEXT_PROJECTION.decision;
  const row: Record<string, string> = { title, body };
  return projection.fields
    .map((field) => row[field])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(projection.separator);
}

export async function createDecision(
  state: InMemoryStorageState,
  input: CreateDecisionInput
): Promise<MnemoDecision> {
  const now = new Date();
  const decision: MnemoDecision = {
    id: uuid(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    userId: input.userId,
    actorType: input.actorType,
    agentId: input.agentId,
    conversationId: input.conversationId,
    // Same default as DecisionRepository.createDecision.
    scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
    scopeRef: input.scopeRef,
    kind: input.kind,
    title: input.title,
    body: input.body,
    topicKey: input.topicKey,
    revisionCount: 1,
    normalizedHash: "",
    status: "active",
    sensitivity: input.sensitivity ?? "internal",
    validFrom: input.validFrom ?? now,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata ?? {},
  } as unknown as MnemoDecision;
  state.decisions.set(decision.id, decision);
  // Mirror DecisionRepository.createDecision: an in-transaction (here:
  // synchronous, same-call) text-form vector_upsert outbox entry, so
  // "persisted but not indexed" can never happen for decisions — the exact
  // contract StorageAdapterContract.ts's per-RECALLABLE_KIND test enforces.
  state.outbox.push({
    id: uuid(),
    workspaceId: decision.workspaceId,
    eventType: "vector_upsert",
    payload: {
      id: decision.id,
      kind: "decision",
      text: projectDecisionText(input.title, input.body),
    },
    createdAt: new Date(),
    attempts: 0,
  });
  return decision;
}

export async function mergeDecisionByTopicKey(
  state: InMemoryStorageState,
  input: MergeDecisionByTopicKeyInput
): Promise<MnemoDecision | null> {
  const normalizedKey = input.topicKey.toLowerCase().trim();
  const decision = [...state.decisions.values()].find(
    (candidate) =>
      candidate.workspaceId === input.workspaceId &&
      candidate.topicKey != null &&
      candidate.topicKey.toLowerCase().trim() === normalizedKey &&
      candidate.status === "active" &&
      candidate.validTo == null
  );
  if (!decision) return null;
  const updated: MnemoDecision = {
    ...decision,
    title: input.title,
    body: input.body,
    kind: input.kind,
    metadata: {
      ...decision.metadata,
      ...(input.metadata ?? {}),
      // Mirrors DecisionRepository: the replaced text is kept, newest last, capped at 50.
      revisions: [
        ...(Array.isArray(decision.metadata?.["revisions"])
          ? (decision.metadata["revisions"] as unknown[])
          : []),
        {
          revision: decision.revisionCount,
          title: decision.title,
          body: decision.body,
          kind: decision.kind,
          current_from: decision.updatedAt.toISOString(),
          replaced_at: new Date().toISOString(),
        },
      ].slice(-50),
    },
    ...(input.scopeRef !== undefined ? { scopeRef: input.scopeRef } : {}),
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    revisionCount: decision.revisionCount + 1,
    embeddingModel: undefined,
    embeddingStale: true,
    updatedAt: new Date(),
  };
  state.decisions.set(decision.id, updated);
  // Mirror DecisionRepository.mergeDecisionByTopicKey: re-enqueue with the
  // revised text so a superseded decision's stale text is never what's
  // indexed (spec.md Requirement 1, "a decision is revised via topic-key
  // upsert" scenario).
  state.outbox.push({
    id: uuid(),
    workspaceId: updated.workspaceId,
    eventType: "vector_upsert",
    payload: {
      id: updated.id,
      kind: "decision",
      text: projectDecisionText(input.title, input.body),
    },
    createdAt: new Date(),
    attempts: 0,
  });
  return updated;
}

export async function getDecision(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoDecision | null> {
  const d = state.decisions.get(id);
  return d && d.workspaceId === workspaceId ? d : null;
}

export async function updateDecision(
  state: InMemoryStorageState,
  id: string,
  input: UpdateDecisionInput
): Promise<MnemoDecision> {
  const d = state.decisions.get(id);
  if (!d) throw new Error(`Decision ${id} not found`);
  const updated = {
    ...d,
    ...input,
    ...(input.validTo ? { validTo: closeAt(input.validTo, d.validFrom) } : {}),
    updatedAt: new Date(),
  };
  // PRIM-18: closing a decision always closes its validity interval.
  if (
    input.validTo === undefined &&
    (input.status === "superseded" || input.status === "withdrawn") &&
    d.validTo == null
  ) {
    updated.validTo = new Date();
  }
  state.decisions.set(id, updated);
  return updated;
}

/** WP-6 / PRIM-18 — in-memory twin of `DecisionRepository.supersedeDecision`. */
export async function supersedeDecision(
  state: InMemoryStorageState,
  input: SupersedeDecisionInput
): Promise<MnemoDecision> {
  if (input.id === input.supersededById) {
    throw new StorageValidationError("A decision cannot supersede itself");
  }
  const old = state.decisions.get(input.id);
  if (!old || old.workspaceId !== input.workspaceId) {
    throw new StorageNotFoundError(`Decision ${input.id} not found`);
  }
  const next = state.decisions.get(input.supersededById);
  if (!next || next.workspaceId !== input.workspaceId) {
    throw new StorageNotFoundError(`Decision ${input.supersededById} not found`);
  }
  if (old.status === "superseded") {
    if (old.supersededById === next.id) return old;
    throw new StorageConflictError(`Decision ${old.id} was already superseded by another decision`);
  }
  if (old.status !== "active") {
    throw new StorageConflictError(`Decision ${old.id} is ${old.status} and cannot be superseded`);
  }
  if (next.status !== "active" || next.validTo != null) {
    throw new StorageConflictError(`Decision ${next.id} is not active and cannot replace another`);
  }
  const now = new Date();
  const updated: MnemoDecision = {
    ...old,
    status: "superseded",
    supersededById: next.id,
    validTo: now,
    updatedAt: now,
  };
  state.decisions.set(old.id, updated);
  const relation: MnemoRelation = {
    id: uuid(),
    workspaceId: input.workspaceId,
    sourceId: next.id,
    sourceType: "decision",
    targetId: old.id,
    targetType: "decision",
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
  return updated;
}

/** `metadata.subject` as remember() stores it; part of a decision's identity. */
function metadataSubject(metadata: unknown): string | null {
  const subject = (metadata as { subject?: unknown } | null | undefined)?.subject;
  return typeof subject === "string" ? subject : null;
}

/**
 * PRIM-18 — mirrors DuplicateLookupRepository.createDecisionUnlessDuplicate.
 * Atomic here by construction: no await between the lookup and the insert's
 * synchronous `state.decisions.set`.
 */
export async function createDecisionUnlessDuplicate(
  state: InMemoryStorageState,
  input: CreateDecisionInput
): Promise<{ decision: MnemoDecision; reused: boolean }> {
  const scopeOwner = input.scopeOwner ?? `workspace:${input.workspaceId}`;
  const sensitivity = input.sensitivity ?? "internal";
  for (const d of state.decisions.values()) {
    if (
      d.workspaceId === input.workspaceId &&
      d.status === "active" &&
      d.validTo == null &&
      d.kind === input.kind &&
      d.title === input.title &&
      d.body === input.body &&
      (d.scopeOwner ?? `workspace:${d.workspaceId}`) === scopeOwner &&
      (d.scopeRef ?? null) === (input.scopeRef ?? null) &&
      d.sensitivity === sensitivity &&
      metadataSubject(d.metadata) === metadataSubject(input.metadata)
    ) {
      return { decision: d, reused: true };
    }
  }
  return { decision: await createDecision(state, input), reused: false };
}

export async function archiveDecision(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const d = state.decisions.get(id);
  if (d && d.workspaceId === workspaceId) {
    // Same as DecisionRepository.archiveDecision: validTo and updatedAt move together.
    const now = new Date();
    state.decisions.set(id, { ...d, status: "withdrawn" as const, validTo: now, updatedAt: now });
  }
}

export async function queryDecisions(
  state: InMemoryStorageState,
  filter: DecisionFilter
): Promise<PaginatedResult<MnemoDecision>> {
  let items = [...state.decisions.values()].filter((d) => d.workspaceId === filter.workspaceId);
  if (filter.status) items = items.filter((d) => d.status === filter.status);
  if (filter.kind) items = items.filter((d) => d.kind === filter.kind);
  if (filter.topicKey) items = items.filter((d) => d.topicKey === filter.topicKey);
  if (filter.validAt) {
    const at = filter.validAt;
    items = items.filter((d) => d.validFrom <= at && (d.validTo == null || d.validTo > at));
  }
  if (filter.openOnly) items = items.filter((d) => d.validTo == null);
  if (filter.scopeRef)
    items = items.filter((d) => !d.scopeRef || scopeRefMatches(d.scopeRef, filter));
  if (filter.statuses) {
    const statuses = filter.statuses;
    items = items.filter((d) => statuses.includes(d.status));
  }
  if (filter.maxSensitivity) {
    const ceiling = SENSITIVITY_ORDER[filter.maxSensitivity];
    items = items.filter((d) => SENSITIVITY_ORDER[d.sensitivity] <= ceiling);
  }
  const closedAt = (d: MnemoDecision) => (d.validTo ?? d.updatedAt).getTime();
  if (filter.createdSince) {
    const since = filter.createdSince.getTime();
    items = items.filter((d) => d.createdAt.getTime() >= since);
  }
  if (filter.closedSince) {
    const since = filter.closedSince.getTime();
    items = items.filter((d) => closedAt(d) > since);
  }
  if (filter.orderBy) {
    const key =
      filter.orderBy === "createdAt" ? (d: MnemoDecision) => d.createdAt.getTime() : closedAt;
    // Newest first: (key, id) descending, ids in byte order like the SQL COLLATE "C".
    const cmp = (at: number, id: string, b: MnemoDecision) =>
      key(b) - at || (id < b.id ? 1 : id > b.id ? -1 : 0);
    items.sort((a, b) => cmp(key(a), a.id, b));
    const before = filter.before;
    if (before) items = items.filter((d) => cmp(before.at.getTime(), before.id, d) < 0);
  }
  if (filter.skipTotal) {
    const offset = filter.offset ?? 0;
    const page = paginate(items, offset, filter.limit);
    return {
      ...page,
      total: offset + page.items.length,
      hasMore: page.items.length === page.limit,
    };
  }
  return paginate(items, filter.offset, filter.limit);
}
