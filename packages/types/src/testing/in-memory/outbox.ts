// in-memory/outbox.ts — InMemoryStorageAdapter's Outbox port methods.
// decompose-inmemory-storage-adapter Batch B8a (design.md Module Map row 17).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type { OutboxEntry } from "../../outbox.js";
import { uuid } from "./support.js";
import type { InMemoryStorageState } from "./state.js";

export async function appendOutbox(
  state: InMemoryStorageState,
  entry: Omit<OutboxEntry, "id" | "createdAt" | "attempts">
): Promise<void> {
  state.outbox.push({
    id: uuid(),
    createdAt: new Date(),
    attempts: 0,
    ...entry,
  } as OutboxEntry);
}

export async function claimOutbox(
  state: InMemoryStorageState,
  limit: number
): Promise<OutboxEntry[]> {
  return state.outbox
    .filter((e) => (e as OutboxEntry & { processed?: boolean }).processed !== true)
    .slice(0, limit);
}

export async function markOutboxProcessed(
  state: InMemoryStorageState,
  ids: string[]
): Promise<void> {
  for (const e of state.outbox) {
    if (ids.includes(e.id)) (e as OutboxEntry & { processed: boolean }).processed = true;
  }
}

export async function markOutboxFailed(
  state: InMemoryStorageState,
  id: string,
  error: string
): Promise<void> {
  for (const e of state.outbox) {
    if (e.id === id)
      (e as OutboxEntry & { lastError?: string; attempts: number }).lastError = error;
  }
}

export async function reapDeadLetters(
  state: InMemoryStorageState,
  maxAttempts: number
): Promise<number> {
  let count = 0;
  for (const e of state.outbox) {
    const entry = e as OutboxEntry & { processed?: boolean };
    if (!entry.processed && e.attempts >= maxAttempts) {
      entry.processed = true;
      count++;
    }
  }
  return count;
}

/**
 * A `staging_evaluation` queue job the P74 backfill has not replayed yet. Its
 * `content` exists nowhere else, so it outlives any retention window.
 */
function isUnrecoveredDiscardedWrite(entry: { eventType?: string; payload?: unknown }): boolean {
  if (entry.eventType !== "queue_job") return false;
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload || payload["job"] !== "staging_evaluation") return false;
  return !("p74BackfilledAt" in payload);
}

export async function purgeOutbox(
  state: InMemoryStorageState,
  olderThanMs: number
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const before = state.outbox.length;
  state.outbox = state.outbox.filter((e) => {
    const entry = e as OutboxEntry & { processed?: boolean; processedAt?: Date };
    if (!entry.processed) return true;
    // P74/P111 — mirrors AuditRepository: a discarded write that has not been
    // recovered yet is never purged, however old it looks. See that method for
    // why these rows are marked processed despite having gone nowhere.
    if (isUnrecoveredDiscardedWrite(entry)) return true;
    const processedAt = entry.processedAt ?? new Date(0);
    return processedAt >= cutoff;
  });
  return before - state.outbox.length;
}

export async function countPendingOutbox(state: InMemoryStorageState): Promise<number> {
  return state.outbox.filter((e) => (e as OutboxEntry & { processed?: boolean }).processed !== true)
    .length;
}
