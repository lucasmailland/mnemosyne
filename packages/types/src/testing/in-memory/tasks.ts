// in-memory/tasks.ts — InMemoryStorageAdapter's Task port methods.
// decompose-inmemory-storage-adapter Batch B3 (design.md Module Map row 14).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type { CreateTaskInput, UpdateTaskInput, TaskFilter } from "../../ports.js";
import { TERMINAL_TASK_STATUSES } from "../../ports.js";
import type { MnemoTask } from "../../primitives.js";
import type { PaginatedResult } from "../../common.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid, paginate } from "./support.js";
import { projectPrimitiveText } from "../../indexing.js";

export async function createTask(
  state: InMemoryStorageState,
  input: CreateTaskInput
): Promise<MnemoTask> {
  const now = new Date();
  const task = {
    id: uuid(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    userId: input.userId,
    actorType: input.actorType,
    title: input.title,
    description: input.description,
    priority: input.priority ?? "medium",
    assignedTo: input.assignedTo,
    sessionId: input.sessionId,
    parentTaskId: input.parentTaskId,
    dueAt: input.dueAt,
    status: "pending" as const,
    delegatedBy: input.delegatedBy,
    relatedFacts: input.relatedFacts ?? [],
    relatedEntities: input.relatedEntities ?? [],
    sensitivity: input.sensitivity ?? "internal",
    blockedBy: [],
    subtaskIds: [],
    // P18: initialize bitemporal columns
    validFrom: now,
    validTo: undefined,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata ?? {},
  } as unknown as MnemoTask;
  state.tasks.set(task.id, task);
  // P65: mirrors the real adapter's in-transaction text-form vector_upsert.
  // Deliberately kept in step: a double that indexes nothing while Postgres
  // does (or vice versa) makes every unit test agree with the wrong thing —
  // the shape P116 hid behind for as long as it did.
  state.outbox.push({
    id: uuid(),
    workspaceId: task.workspaceId,
    eventType: "vector_upsert",
    payload: {
      id: task.id,
      kind: "task",
      text: projectPrimitiveText("task", task as unknown as Record<string, unknown>),
    },
    createdAt: new Date(),
    attempts: 0,
  });
  return task;
}

export async function getTask(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoTask | null> {
  const t = state.tasks.get(id);
  return t && t.workspaceId === workspaceId ? t : null;
}

export async function updateTask(
  state: InMemoryStorageState,
  id: string,
  input: UpdateTaskInput
): Promise<MnemoTask> {
  const t = state.tasks.get(id);
  if (!t) throw new Error(`Task ${id} not found`);
  const updated = { ...t, ...input, updatedAt: new Date() };
  state.tasks.set(id, updated);
  return updated;
}

export async function archiveTask(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const t = state.tasks.get(id);
  if (t && t.workspaceId === workspaceId) {
    // P18 + B7: close the bitemporal interval unconditionally, but only
    // force status='cancelled' when the task is NOT already terminal —
    // mirrors TaskRepository.archiveTask's terminal-aware SQL. Preserves
    // a `completed` task's terminal status instead of silently
    // overwriting it on archive.
    const isTerminal = (TERMINAL_TASK_STATUSES as readonly string[]).includes(t.status);
    state.tasks.set(id, {
      ...t,
      status: isTerminal ? t.status : ("cancelled" as const),
      validTo: new Date(),
      updatedAt: new Date(),
    });
  }
}

export async function listTasksForSession(
  state: InMemoryStorageState,
  workspaceId: string,
  sessionId: string
): Promise<Array<{ id: string; status: string }>> {
  return [...state.tasks.values()]
    .filter((t) => t.workspaceId === workspaceId && t.sessionId === sessionId)
    .map((t) => ({ id: t.id, status: t.status }));
}

export async function delegateTask(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  input: { assignedTo: string; delegatedBy: string }
): Promise<MnemoTask> {
  const task = [...state.tasks.values()].find((t) => t.id === id && t.workspaceId === workspaceId);
  if (!task) throw new Error(`Task not found: ${id}`);
  const updated: MnemoTask = {
    ...task,
    status: "delegated" as const,
    assignedTo: input.assignedTo,
    delegatedBy: input.delegatedBy,
    delegatedAt: new Date(),
    updatedAt: new Date(),
  };
  state.tasks.set(id, updated);
  return updated;
}

export async function queryTasks(
  state: InMemoryStorageState,
  filter: TaskFilter
): Promise<PaginatedResult<MnemoTask>> {
  const items = [...state.tasks.values()].filter((t) => {
    if (t.workspaceId !== filter.workspaceId) return false;
    // Same predicates as TaskRepository.queryTasks.
    if (filter.status && t.status !== filter.status) return false;
    if (filter.assignedTo && t.assignedTo !== filter.assignedTo) return false;
    if (filter.parentTaskId && t.parentTaskId !== filter.parentTaskId) return false;
    // P18: validAt predicate — open-interval semantics (validTo > validAt, NOT >=)
    if (filter.validAt) {
      if (t.validFrom > filter.validAt) return false;
      if (t.validTo != null && t.validTo <= filter.validAt) return false;
    }
    if (filter.openOnly && t.validTo != null) return false;
    return true;
  });
  return paginate(items, filter.offset, filter.limit);
}
