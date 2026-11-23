// in-memory/reasoning.ts — InMemoryStorageAdapter's Reasoning port methods.
// decompose-inmemory-storage-adapter Batch B4 (design.md Module Map row 16).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type { CreateReasoningInput, UpdateReasoningInput, ReasoningFilter } from "../../ports.js";
import type { MnemoReasoning } from "../../primitives.js";
import type { PaginatedResult } from "../../common.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid, paginate } from "./support.js";
import { projectPrimitiveText } from "../../indexing.js";

export async function createReasoning(
  state: InMemoryStorageState,
  input: CreateReasoningInput
): Promise<MnemoReasoning> {
  const now = new Date();
  const reasoning = {
    id: uuid(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    userId: input.userId,
    actorType: input.actorType,
    agentId: input.agentId,
    question: input.question,
    chain: input.chain,
    conclusion: input.conclusion,
    topicKey: input.topicKey,
    sensitivity: input.sensitivity ?? "internal",
    successCount: 0,
    failureCount: 0,
    worth: 0.5,
    usageCount: 0,
    embeddingStale: true,
    status: "active" as const,
    // P64: initialize bitemporal columns
    validFrom: now,
    validTo: undefined,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata ?? {},
  } as unknown as MnemoReasoning;
  state.reasonings.set(reasoning.id, reasoning);
  // P65: mirrors the real adapter's in-transaction text-form vector_upsert.
  // Deliberately kept in step: a double that indexes nothing while Postgres
  // does (or vice versa) makes every unit test agree with the wrong thing —
  // the shape P116 hid behind for as long as it did.
  state.outbox.push({
    id: uuid(),
    workspaceId: reasoning.workspaceId,
    eventType: "vector_upsert",
    payload: {
      id: reasoning.id,
      kind: "reasoning",
      text: projectPrimitiveText("reasoning", reasoning as unknown as Record<string, unknown>),
    },
    createdAt: new Date(),
    attempts: 0,
  });
  return reasoning;
}

export async function getReasoning(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoReasoning | null> {
  const r = state.reasonings.get(id);
  return r && r.workspaceId === workspaceId ? r : null;
}

export async function updateReasoning(
  state: InMemoryStorageState,
  id: string,
  input: UpdateReasoningInput
): Promise<MnemoReasoning> {
  const r = state.reasonings.get(id);
  if (!r) throw new Error(`Reasoning ${id} not found`);
  const updated = { ...r, ...input, updatedAt: new Date() };
  state.reasonings.set(id, updated);
  return updated;
}

export async function archiveReasoning(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const r = state.reasonings.get(id);
  if (r && r.workspaceId === workspaceId) {
    // P64: close bitemporal interval (forget()-equivalence, do NOT delete)
    state.reasonings.set(id, {
      ...r,
      status: "archived" as const,
      validTo: new Date(),
      updatedAt: new Date(),
    });
  }
}

export async function queryReasoning(
  state: InMemoryStorageState,
  filter: ReasoningFilter
): Promise<PaginatedResult<MnemoReasoning>> {
  let items = [...state.reasonings.values()].filter((r) => r.workspaceId === filter.workspaceId);
  if (filter.status) items = items.filter((r) => r.status === filter.status);
  if (filter.topicKey) items = items.filter((r) => r.topicKey === filter.topicKey);
  if (filter.validAt) {
    const at = filter.validAt;
    items = items.filter((r) => r.validFrom <= at && (r.validTo == null || r.validTo > at));
  }
  if (filter.openOnly) items = items.filter((r) => r.validTo == null);
  return paginate(items, filter.offset, filter.limit);
}

// Wave M1 — CoT cache adapter methods (spec §8)

export async function searchReasoning(
  state: InMemoryStorageState,
  input: {
    workspaceId: string;
    vector: number[];
    limit: number;
    includeAllStatuses?: boolean;
  }
): Promise<
  Array<{
    id: string;
    cosine: number;
    worth: number;
    successCount: number;
    failureCount: number;
    status: MnemoReasoning["status"];
  }>
> {
  const servable = new Set(["active", "golden"]);
  const rows = [...state.reasonings.values()]
    .filter((r) => r.workspaceId === input.workspaceId)
    .filter((r) => input.includeAllStatuses || servable.has(r.status));
  return rows.slice(0, input.limit).map((r) => ({
    id: r.id,
    cosine: 1,
    worth: r.worth,
    successCount: r.successCount,
    failureCount: r.failureCount,
    status: r.status,
  }));
}

export async function recordReasoningUse(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const r = state.reasonings.get(id);
  if (!r || r.workspaceId !== workspaceId) return;
  state.reasonings.set(id, {
    ...r,
    usageCount: r.usageCount + 1,
    lastUsedAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function setReasoningStatus(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  status: MnemoReasoning["status"]
): Promise<void> {
  const r = state.reasonings.get(id);
  if (!r || r.workspaceId !== workspaceId) return;
  state.reasonings.set(id, { ...r, status, updatedAt: new Date() });
}
