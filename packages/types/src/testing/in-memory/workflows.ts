// in-memory/workflows.ts — InMemoryStorageAdapter's Workflow port methods.
// decompose-inmemory-storage-adapter Batch B2 (design.md Module Map row 12).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type { CreateWorkflowInput, UpdateWorkflowInput, WorkflowFilter } from "../../ports.js";
import type { MnemoWorkflow } from "../../primitives.js";
import type { PaginatedResult } from "../../common.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid, paginate } from "./support.js";
import { projectPrimitiveText } from "../../indexing.js";
import { scopeRefMatches } from "../../scope-ref.js";

export async function createWorkflow(
  state: InMemoryStorageState,
  input: CreateWorkflowInput
): Promise<MnemoWorkflow> {
  const now = new Date();
  const workflow = {
    id: uuid(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    userId: input.userId,
    actorType: input.actorType,
    name: input.name,
    description: input.description,
    steps: input.steps ?? [],
    scopeRef: input.scopeRef,
    sensitivity: input.sensitivity ?? "internal",
    avgDurationMs: 0,
    successRate: 0,
    worth: 0.5,
    executionCount: 0,
    version: 1,
    // P18: initialize bitemporal columns
    validFrom: now,
    validTo: undefined,
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata ?? {},
  } as unknown as MnemoWorkflow;
  state.workflows.set(workflow.id, workflow);
  // P65: an in-transaction (here: synchronous, same-call) text-form
  // vector_upsert, mirroring the decision reference implementation. Without it
  // a workflow is "persisted but not indexed" — written, and invisible to recall
  // forever. StorageAdapterContract's per-RECALLABLE_KIND test is what makes
  // that impossible to forget: adding the kind to the registry made the
  // contract demand this write, before any of it shipped.
  state.outbox.push({
    id: uuid(),
    workspaceId: workflow.workspaceId,
    eventType: "vector_upsert",
    payload: {
      id: workflow.id,
      kind: "workflow",
      text: projectPrimitiveText("workflow", workflow as unknown as Record<string, unknown>),
    },
    createdAt: new Date(),
    attempts: 0,
  });
  return workflow;
}

export async function getWorkflow(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoWorkflow | null> {
  const w = state.workflows.get(id);
  return w && w.workspaceId === workspaceId ? w : null;
}

export async function updateWorkflow(
  state: InMemoryStorageState,
  id: string,
  input: UpdateWorkflowInput
): Promise<MnemoWorkflow> {
  const w = state.workflows.get(id);
  if (!w) throw new Error(`Workflow ${id} not found`);
  const updated = { ...w, ...input, updatedAt: new Date() };
  state.workflows.set(id, updated);
  return updated;
}

export async function archiveWorkflow(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const w = state.workflows.get(id);
  if (w && w.workspaceId === workspaceId) {
    // P18: close bitemporal interval alongside status change
    state.workflows.set(id, {
      ...w,
      status: "deprecated" as const,
      validTo: new Date(),
      updatedAt: new Date(),
    });
  }
}

export async function queryWorkflows(
  state: InMemoryStorageState,
  filter: WorkflowFilter
): Promise<PaginatedResult<MnemoWorkflow>> {
  let items = [...state.workflows.values()].filter((w) => {
    if (w.workspaceId !== filter.workspaceId) return false;
    if (filter.status && w.status !== filter.status) return false;
    // P18: validAt predicate — open-interval semantics (validTo > validAt, NOT >=)
    if (filter.validAt) {
      if (w.validFrom > filter.validAt) return false;
      if (w.validTo != null && w.validTo <= filter.validAt) return false;
    }
    if (filter.openOnly && w.validTo != null) return false;
    return true;
  });
  if (filter.scopeRef)
    items = items.filter((w) => !w.scopeRef || scopeRefMatches(w.scopeRef, filter));
  return paginate(items, filter.offset, filter.limit);
}
