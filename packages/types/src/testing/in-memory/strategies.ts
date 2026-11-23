// in-memory/strategies.ts — InMemoryStorageAdapter's Strategy port methods.
// decompose-inmemory-storage-adapter Batch B2 (design.md Module Map row 11).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type { CreateStrategyInput, UpdateStrategyInput, StrategyFilter } from "../../ports.js";
import type { MnemoStrategy } from "../../primitives.js";
import type { PaginatedResult } from "../../common.js";
import type { InMemoryStorageState } from "./state.js";
import { closeAt, uuid, paginate } from "./support.js";
import { StorageConflictError, StorageNotFoundError } from "../../storage-errors.js";
import { projectPrimitiveText } from "../../indexing.js";
import { scopeRefMatches } from "../../scope-ref.js";

export async function createStrategy(
  state: InMemoryStorageState,
  input: CreateStrategyInput
): Promise<MnemoStrategy> {
  const now = new Date();
  // PRIM-11: supersedesId is a lifecycle transition — validate and close the
  // predecessor in the same step (the Postgres adapter does it in one transaction).
  let predecessor: MnemoStrategy | undefined;
  if (input.supersedesId) {
    predecessor = state.strategies.get(input.supersedesId);
    if (!predecessor || predecessor.workspaceId !== input.workspaceId) {
      throw new StorageNotFoundError(`Strategy ${input.supersedesId} not found`);
    }
    if (predecessor.status !== "active" || predecessor.validTo != null) {
      throw new StorageConflictError(
        `Strategy ${input.supersedesId} is ${predecessor.status} and cannot be superseded`
      );
    }
  }
  const strategy = {
    id: uuid(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    userId: input.userId,
    actorType: input.actorType,
    agentId: input.agentId,
    trigger: input.trigger,
    action: input.action,
    context: input.context,
    // Same default as KnowledgeRepository.createStrategy.
    scopeOwner: input.scopeOwner ?? `workspace:${input.workspaceId}`,
    scopeRef: input.scopeRef,
    sensitivity: input.sensitivity ?? "internal",
    status: "active" as const,
    ...(input.supersedesId !== undefined ? { supersedesId: input.supersedesId } : {}),
    validFrom: input.validFrom ?? now,
    hitCount: 0,
    worth: 0.5,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata ?? {},
  } as unknown as MnemoStrategy;
  state.strategies.set(strategy.id, strategy);
  if (predecessor) {
    state.strategies.set(predecessor.id, {
      ...predecessor,
      status: "superseded",
      validTo: now,
      updatedAt: now,
    });
    const relationId = uuid();
    state.relations.set(relationId, {
      id: relationId,
      workspaceId: input.workspaceId,
      sourceId: strategy.id,
      sourceType: "strategy",
      targetId: predecessor.id,
      targetType: "strategy",
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
    });
  }
  // P65: an in-transaction (here: synchronous, same-call) text-form
  // vector_upsert, mirroring the decision reference implementation. Without it
  // a strategy is "persisted but not indexed" — written, and invisible to recall
  // forever. StorageAdapterContract's per-RECALLABLE_KIND test is what makes
  // that impossible to forget: adding the kind to the registry made the
  // contract demand this write, before any of it shipped.
  state.outbox.push({
    id: uuid(),
    workspaceId: strategy.workspaceId,
    eventType: "vector_upsert",
    payload: {
      id: strategy.id,
      kind: "strategy",
      text: projectPrimitiveText("strategy", strategy as unknown as Record<string, unknown>),
    },
    createdAt: new Date(),
    attempts: 0,
  });
  return strategy;
}

export async function getStrategy(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoStrategy | null> {
  const s = state.strategies.get(id);
  return s && s.workspaceId === workspaceId ? s : null;
}

export async function updateStrategy(
  state: InMemoryStorageState,
  id: string,
  input: UpdateStrategyInput
): Promise<MnemoStrategy> {
  const s = state.strategies.get(id);
  if (!s) throw new Error(`Strategy ${id} not found`);
  const updated = {
    ...s,
    ...input,
    ...(input.validTo ? { validTo: closeAt(input.validTo, s.validFrom) } : {}),
    updatedAt: new Date(),
  };
  state.strategies.set(id, updated);
  return updated;
}

export async function archiveStrategy(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const s = state.strategies.get(id);
  if (s && s.workspaceId === workspaceId) {
    state.strategies.set(id, { ...s, status: "archived" as const, validTo: new Date() });
  }
}

export async function queryStrategies(
  state: InMemoryStorageState,
  filter: StrategyFilter
): Promise<PaginatedResult<MnemoStrategy>> {
  let items = [...state.strategies.values()].filter((s) => s.workspaceId === filter.workspaceId);
  if (filter.status) items = items.filter((s) => s.status === filter.status);
  if (filter.validAt) {
    const at = filter.validAt;
    items = items.filter(
      (s) => (s.validFrom ?? s.createdAt) <= at && (s.validTo == null || s.validTo > at)
    );
  }
  if (filter.openOnly) items = items.filter((s) => s.validTo == null);
  if (filter.scopeRef)
    items = items.filter((s) => !s.scopeRef || scopeRefMatches(s.scopeRef, filter));
  return paginate(items, filter.offset, filter.limit);
}

/** PRIM-18 — mirrors DuplicateLookupRepository.createStrategyUnlessDuplicate. */
export async function createStrategyUnlessDuplicate(
  state: InMemoryStorageState,
  input: CreateStrategyInput
): Promise<{ strategy: MnemoStrategy; reused: boolean }> {
  const scopeOwner = input.scopeOwner ?? `workspace:${input.workspaceId}`;
  const sensitivity = input.sensitivity ?? "internal";
  for (const st of state.strategies.values()) {
    if (
      st.workspaceId === input.workspaceId &&
      st.status === "active" &&
      st.validTo == null &&
      st.trigger === input.trigger &&
      st.action === input.action &&
      (st.scopeOwner ?? `workspace:${st.workspaceId}`) === scopeOwner &&
      (st.scopeRef ?? null) === (input.scopeRef ?? null) &&
      st.sensitivity === sensitivity
    ) {
      return { strategy: st, reused: true };
    }
  }
  return { strategy: await createStrategy(state, input), reused: false };
}
