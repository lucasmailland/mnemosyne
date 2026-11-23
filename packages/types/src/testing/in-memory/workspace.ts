// in-memory/workspace.ts — Workspace domain module for InMemoryStorageAdapter.
// decompose-inmemory-storage-adapter Batch B12a/B12b (design.md Module Map row 7).
// Move-only: bodies are verbatim transplants, `this.` -> `state.` is the only edit (D7).

import type {
  WorkspaceVitals,
  AuditFeedFilter,
  AuditFeedEntry,
  GetHealthSnapshotInput,
  HealthSnapshot,
  HealthSnapshotDay,
  AuditFeedStats,
} from "../../ports.js";
import type { Sensitivity } from "../../common.js";
import { tallyAuditFeedStats, tallyHealthSnapshots } from "../../dashboard-aggregates.js";
import type { InMemoryStorageState } from "./state.js";
import { SENSITIVITY_ORDER } from "../../security.js";

export async function getWorkspaceVitals(
  state: InMemoryStorageState,
  workspaceId: string
): Promise<WorkspaceVitals> {
  const facts = [...state.facts.values()].filter((f) => f.workspaceId === workspaceId);
  const live = facts.filter((f) => f.validTo == null && f.status === "active");
  const closed = facts.filter((f) => f.validTo != null || f.status === "forgotten");
  const scopeCounts = new Map<string, number>();
  for (const f of live) {
    if (f.scopeRef) scopeCounts.set(f.scopeRef, (scopeCounts.get(f.scopeRef) ?? 0) + 1);
  }
  const lastRecallAt = facts.reduce<Date | null>(
    (max, f) => (f.lastRecalledAt && (!max || f.lastRecalledAt > max) ? f.lastRecalledAt : max),
    null
  );
  const lastWriteAt = facts.reduce<Date | null>(
    (max, f) => (!max || f.updatedAt > max ? f.updatedAt : max),
    null
  );
  return {
    workspaceId,
    factsLive: live.length,
    factsClosed: closed.length,
    pinnedCount: facts.filter((f) => f.pinned).length,
    lastRecallAt: lastRecallAt ? lastRecallAt.toISOString() : null,
    lastWriteAt: lastWriteAt ? lastWriteAt.toISOString() : null,
    embeddings: {
      indexed: facts.filter((f) => f.embedding).length,
      pending: facts.filter((f) => !f.embedding && f.status === "active").length,
    },
    factsByScopeRef: [...scopeCounts.entries()]
      .map(([scopeRef, count]) => ({ scopeRef, count }))
      .sort((a, b) => b.count - a.count),
  };
}

// In-memory has no separate `mnemo_fact_archive` concept (archiveFact just
// flips status in place — see above), so the audit feed here is built
// entirely from forgotten facts, all reported as actorKind "user" /
// revertible true. Real archive-sourced entries only exist against Postgres
// (StorageAdapterContract/Tier B cover that shape).
export async function getAuditFeed(
  state: InMemoryStorageState,
  filter: AuditFeedFilter
): Promise<AuditFeedEntry[]> {
  let items = [...state.facts.values()].filter(
    (f) => f.workspaceId === filter.workspaceId && f.status === "forgotten"
  );
  if (filter.actorKind && filter.actorKind !== "user") items = [];
  if (filter.maxSensitivity) {
    const max = SENSITIVITY_ORDER[filter.maxSensitivity];
    items = items.filter((f) => SENSITIVITY_ORDER[f.sensitivity ?? "internal"] <= max);
  }
  if (filter.from) {
    const from = new Date(filter.from);
    items = items.filter((f) => f.updatedAt >= from);
  }
  if (filter.to) {
    const to = new Date(filter.to);
    items = items.filter((f) => f.updatedAt <= to);
  }
  if (filter.q && filter.q.trim().length > 0) {
    const q = filter.q.toLowerCase();
    items = items.filter(
      (f) => f.statement.toLowerCase().includes(q) || f.subject.toLowerCase().includes(q)
    );
  }
  items = [...items].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const limit = Math.min(Math.max(filter.limit, 1), 100);
  return items.slice(0, limit).map((f) => ({
    id: `forget_${f.id}`,
    factId: f.id,
    factStatement: f.statement,
    factSubject: f.subject,
    factKind: f.kind,
    action: "forgotten" as const,
    actorKind: "user" as const,
    actorName: null,
    timestamp: f.updatedAt.toISOString(),
    revertible: true,
  }));
}

export async function getHealthSnapshot(
  state: InMemoryStorageState,
  input: GetHealthSnapshotInput
): Promise<HealthSnapshot | null> {
  const { workspaceId, fresh } = input;
  if (!fresh) {
    const history = state.healthSnapshots.get(workspaceId) ?? [];
    return history.length > 0 ? (history[history.length - 1] ?? null) : null;
  }

  const facts = [...state.facts.values()].filter((f) => f.workspaceId === workspaceId);
  const activeFacts = facts.filter((f) => f.status === "active");
  const factCountActive = activeFacts.length;
  const factCountArchived = facts.filter(
    (f) => f.status === "forgotten" || f.status === "merged"
  ).length;
  const factCountEmbedded = activeFacts.filter((f) => f.embedding != null).length;
  const factCountUnembedded = activeFacts.filter((f) => f.embedding == null).length;
  const factsWithZeroHits = activeFacts.filter((f) => f.hitCount === 0).length;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
  const recalled30d = activeFacts.filter(
    (f) => f.lastRecalledAt != null && f.lastRecalledAt > thirtyDaysAgo
  ).length;
  const recallHitRate30d = factCountActive > 0 ? recalled30d / factCountActive : null;

  const decisionCountActive = [...state.decisions.values()].filter(
    (d) => d.workspaceId === workspaceId && d.status === "active"
  ).length;

  const relationCountConflicts = [...state.relations.values()].filter(
    (r) => r.workspaceId === workspaceId && r.verb === "conflicts_with"
  ).length;

  const snapshot: HealthSnapshot = {
    workspaceId,
    snapshotAt: new Date(),
    factCountActive,
    factCountArchived,
    factCountEmbedded,
    factCountUnembedded,
    decisionCountActive,
    relationCountConflicts,
    factsWithZeroHits,
    recallHitRate30d,
    // No in-memory model for mnemo_extraction_job — see the field's
    // declaration comment above.
    extractionJobsFailed7d: 0,
    extractionJobsDeferred: 0,
    computedInMs: 0,
  };
  const history = state.healthSnapshots.get(workspaceId) ?? [];
  history.push(snapshot);
  state.healthSnapshots.set(workspaceId, history);
  return snapshot;
}

export async function getKnowledgeDistribution(
  state: InMemoryStorageState,
  workspaceId: string
): Promise<Partial<Record<import("../../recall.js").RememberKind, number>>> {
  const inWs = <V extends { workspaceId: string }>(m: Map<string, V>) =>
    [...m.values()].filter((v) => v.workspaceId === workspaceId).length;
  return {
    fact: inWs(state.facts),
    decision: inWs(state.decisions),
    strategy: inWs(state.strategies),
    episode: inWs(state.episodes),
    entity: inWs(state.entities),
    task: inWs(state.tasks),
    event: inWs(state.events),
    skill: inWs(state.skills),
    workflow: inWs(state.workflows),
    reasoning: inWs(state.reasonings),
    hyperedge: inWs(state.hyperedges),
  };
}

export async function getWorkspaceMode(state: InMemoryStorageState, workspaceId: string) {
  const r = state.workspaceModes.get(workspaceId);
  if (!r) return null;
  // Mirrors WorkspaceRepository: the entity criterion counts live entities, not a stored counter.
  let entityCount = 0;
  for (const e of state.entities.values())
    if (e.workspaceId === workspaceId && e.validTo == null) entityCount++;
  return { ...r, entityCount };
}

export async function setWorkspaceMode(
  state: InMemoryStorageState,
  workspaceId: string,
  patch: {
    mode?: "learning" | "production";
    sessionCount?: number;
    promoteAt?: number | null;
    factCount?: number;
    entityCount?: number;
  }
) {
  const prev = state.workspaceModes.get(workspaceId) ?? {
    mode: "learning" as const,
    sessionCount: 0,
    promoteAt: null,
    startedAt: new Date(),
    factCount: 0,
    entityCount: 0,
  };
  state.workspaceModes.set(workspaceId, {
    ...prev,
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.sessionCount !== undefined ? { sessionCount: patch.sessionCount } : {}),
    ...(patch.promoteAt !== undefined ? { promoteAt: patch.promoteAt } : {}),
    ...(patch.factCount !== undefined ? { factCount: patch.factCount } : {}),
    ...(patch.entityCount !== undefined ? { entityCount: patch.entityCount } : {}),
  });
}

export async function incrementWorkspaceModeCounters(
  state: InMemoryStorageState,
  workspaceId: string,
  delta: {
    factCount?: number;
    entityCount?: number;
    sessionCount?: number;
  }
) {
  const prev = state.workspaceModes.get(workspaceId) ?? {
    mode: "learning" as const,
    sessionCount: 0,
    promoteAt: null,
    startedAt: new Date(),
    factCount: 0,
    entityCount: 0,
  };
  state.workspaceModes.set(workspaceId, {
    ...prev,
    sessionCount: prev.sessionCount + (delta.sessionCount ?? 0),
    factCount: (prev.factCount ?? 0) + (delta.factCount ?? 0),
    entityCount: (prev.entityCount ?? 0) + (delta.entityCount ?? 0),
  });
}

/** Mirrors FactRepository.getWritesPerDay: `days` UTC days ending today, zero-filled, oldest first. */
export async function getWritesPerDay(
  state: InMemoryStorageState,
  workspaceId: string,
  days: number
): Promise<Array<{ day: string; count: number }>> {
  const counts = new Map<string, number>();
  for (const f of state.facts.values()) {
    if (f.workspaceId !== workspaceId) continue;
    const d = f.createdAt.toISOString().slice(0, 10);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { day, count: counts.get(day) ?? 0 };
  });
}

/** Mirrors HealthRepository.getHealthSnapshots: each UTC day's latest persisted snapshot. */
export async function getHealthSnapshots(
  state: InMemoryStorageState,
  input: { workspaceId: string; days: number }
): Promise<HealthSnapshotDay[]> {
  const latest = new Map<string, HealthSnapshot>();
  for (const s of state.healthSnapshots.get(input.workspaceId) ?? []) {
    const day = s.snapshotAt.toISOString().slice(0, 10);
    const prev = latest.get(day);
    if (!prev || prev.snapshotAt <= s.snapshotAt) latest.set(day, s);
  }
  return tallyHealthSnapshots(input.days, latest);
}

/** Mirrors FactRepository.getAuditFeedStats over the twin's feed (forgets; it keeps no archive). */
export async function getAuditFeedStats(
  state: InMemoryStorageState,
  input: { workspaceId: string; days: number; maxSensitivity?: Sensitivity }
): Promise<AuditFeedStats> {
  const max = SENSITIVITY_ORDER[input.maxSensitivity ?? "restricted"];
  const groups = new Map<string, { day: string; actorKind: "user"; n: number }>();
  for (const f of state.facts.values()) {
    if (f.workspaceId !== input.workspaceId || f.status !== "forgotten") continue;
    if (SENSITIVITY_ORDER[f.sensitivity ?? "internal"] > max) continue;
    const day = f.updatedAt.toISOString().slice(0, 10);
    const g = groups.get(day) ?? { day, actorKind: "user" as const, n: 0 };
    g.n += 1;
    groups.set(day, g);
  }
  return tallyAuditFeedStats(input.days, [...groups.values()]);
}
