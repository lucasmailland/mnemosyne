// in-memory/audit.ts — InMemoryStorageAdapter's Audit port methods.
// decompose-inmemory-storage-adapter Batch B6 (design.md Module Map row 28).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type { AuditLogEntry } from "../../audit.js";
import { resolveAuditActorType } from "../../audit.js";
import type { AuditActivity } from "../../ports.js";
import { tallyAuditActivity, utcDayKeys } from "../../dashboard-aggregates.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid } from "./support.js";

export async function appendAuditEntry(
  state: InMemoryStorageState,
  entry: Omit<AuditLogEntry, "id" | "createdAt">
): Promise<void> {
  // Parity with DrizzleStorageAdapter: resolve the real actor_type rather than
  // storing it raw, so consumers reading the in-memory log see the same value
  // the persistent adapter would write.
  state.auditLog.push({
    id: uuid(),
    createdAt: new Date(),
    ...entry,
    actorType: resolveAuditActorType(entry),
  } as AuditLogEntry);
}

export async function listAuditLog(
  state: InMemoryStorageState,
  workspaceId: string,
  limit: number
): Promise<AuditLogEntry[]> {
  const all = state.auditLog.filter((e) => e.workspaceId === workspaceId);
  return all.slice(-limit);
}

/** Mirrors AuditRepository.getAuditActivity through the shared tally. */
export async function getAuditActivity(
  state: InMemoryStorageState,
  input: { workspaceId: string; days: number; actorIds: string[] }
): Promise<AuditActivity> {
  const actors = new Set(input.actorIds);
  const window = new Set(utcDayKeys(input.days));
  const mine = state.auditLog.filter(
    (e) => e.workspaceId === input.workspaceId && e.actorId != null && actors.has(e.actorId)
  );
  const groups = new Map<string, { day: string; action: string; n: number }>();
  const lastAt: Record<string, string> = {};
  for (const e of mine) {
    const at = e.createdAt.toISOString();
    if (!lastAt[e.actorId!] || lastAt[e.actorId!]! < at) lastAt[e.actorId!] = at;
    const day = at.slice(0, 10);
    if (!window.has(day)) continue;
    const key = `${day}|${e.action}`;
    const g = groups.get(key) ?? { day, action: e.action, n: 0 };
    g.n += 1;
    groups.set(key, g);
  }
  return tallyAuditActivity(input.days, [...groups.values()], lastAt);
}
