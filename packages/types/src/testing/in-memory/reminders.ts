// in-memory/reminders.ts — InMemoryStorageAdapter's Reminders (prospective
// memory) port methods.
// decompose-inmemory-storage-adapter Batch B8b (design.md Module Map row 31).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type { CreateReminderInput, MnemoReminder } from "../../ports.js";
import type { InMemoryStorageState } from "./state.js";

export async function createReminder(
  state: InMemoryStorageState,
  input: CreateReminderInput
): Promise<MnemoReminder> {
  const now = new Date();
  const reminder: MnemoReminder = {
    id: input.id,
    workspaceId: input.workspaceId,
    content: input.content,
    condition: input.condition ?? null,
    triggerAt: input.triggerAt ?? null,
    status: "pending",
    conditionEmbedding: input.conditionEmbedding ?? null,
    triggeredAt: null,
    dismissedAt: null,
    deliveredAt: null,
    createdByAgentId: input.createdByAgentId ?? null,
    actorId: input.actorId ?? undefined,
    userId: input.userId ?? null,
    actorType: input.actorType,
    createdAt: now,
    updatedAt: now,
  };
  state.reminders.push(reminder);
  return reminder;
}

export async function listDueReminderWorkspaceIds(state: InMemoryStorageState): Promise<string[]> {
  const now = new Date();
  return [
    ...new Set(
      state.reminders
        .filter(
          (r) =>
            r.status === "pending" &&
            r.triggerAt !== null &&
            r.triggerAt <= now &&
            (r.condition === null || /^ *$/.test(r.condition))
        )
        .map((r) => r.workspaceId)
    ),
  ];
}

export async function getReminder(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoReminder | null> {
  return state.reminders.find((r) => r.id === id && r.workspaceId === workspaceId) ?? null;
}

export async function listPendingReminders(
  state: InMemoryStorageState,
  workspaceId: string,
  asOf: Date
): Promise<MnemoReminder[]> {
  return state.reminders.filter(
    (r) =>
      r.workspaceId === workspaceId &&
      r.status === "pending" &&
      (r.triggerAt === null || r.triggerAt <= asOf)
  );
}

export async function dismissReminder(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string,
  newStatus: "triggered" | "dismissed"
): Promise<void> {
  const reminder = state.reminders.find((r) => r.id === id && r.workspaceId === workspaceId);
  if (!reminder) return;
  const now = new Date();
  reminder.status = newStatus;
  reminder.updatedAt = now;
  if (newStatus === "triggered") reminder.triggeredAt = now;
  if (newStatus === "dismissed") reminder.dismissedAt = now;
}

export async function listReminders(
  state: InMemoryStorageState,
  workspaceId: string,
  status: "pending" | "triggered" | "dismissed" | "all",
  limit: number
): Promise<MnemoReminder[]> {
  return state.reminders
    .filter((r) => r.workspaceId === workspaceId && (status === "all" || r.status === status))
    .slice(-limit)
    .reverse();
}

export async function claimUndeliveredReminders(
  state: InMemoryStorageState,
  workspaceId: string,
  input: { ids: string[]; limit: number }
): Promise<MnemoReminder[]> {
  // Synchronous from the first read to the last write: no await in between,
  // so two concurrent claims cannot interleave — the in-memory row lock.
  const now = new Date();
  const claimable = (r: MnemoReminder) =>
    r.workspaceId === workspaceId && r.status === "triggered" && r.deliveredAt == null;
  const wanted = new Set(input.ids);
  const own = state.reminders.filter((r) => wanted.has(r.id) && claimable(r));
  const backlog = state.reminders
    .filter((r) => !wanted.has(r.id) && claimable(r))
    .sort((a, b) => (a.triggeredAt?.getTime() ?? 0) - (b.triggeredAt?.getTime() ?? 0))
    .slice(0, Math.max(0, input.limit));
  const claimed = [...own, ...backlog];
  for (const r of claimed) r.deliveredAt = now;
  return claimed;
}
