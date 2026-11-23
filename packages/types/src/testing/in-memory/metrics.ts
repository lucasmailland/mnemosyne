// in-memory/metrics.ts — InMemoryStorageAdapter's Metrics port methods.
// decompose-inmemory-storage-adapter Batch B6 (design.md Module Map row 33).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).
// D4: `countActiveSessions` reads `sessions` (Prometheus scrape path, not
// session lifecycle); `countFactsByTypeStatus`/`worthHistogram` read `facts`;
// `listStaleTasks`/`countTasksByStatus`/`countStaleTasks` read `tasks`.

import type { InMemoryStorageState } from "./state.js";

export async function listStaleTasks(
  state: InMemoryStorageState,
  workspaceId: string,
  staleSinceMs: number,
  limit: number
): Promise<Array<{ id: string; title: string; status: string; updatedAt: Date }>> {
  const cutoff = new Date(Date.now() - staleSinceMs);
  const excluded = new Set(["done", "cancelled", "archived"]);
  return [...state.tasks.values()]
    .filter((t) => t.workspaceId === workspaceId && !excluded.has(t.status) && t.updatedAt < cutoff)
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
    .slice(0, limit)
    .map((t) => ({ id: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt }));
}

// ── §3.5 snapshot count methods ───────────────────────────────────────────────

export async function countFactsByTypeStatus(
  state: InMemoryStorageState
): Promise<Array<{ type: string; status: string; count: number }>> {
  const counts = new Map<string, number>();
  for (const f of state.facts.values()) {
    if (f.status !== "forgotten") {
      const key = `${f.kind}::${f.status}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries()).map(([k, count]) => {
    const sep = k.indexOf("::");
    const type = k.slice(0, sep);
    const status = k.slice(sep + 2);
    return { type, status, count };
  });
}

export async function worthHistogram(
  state: InMemoryStorageState
): Promise<Array<{ bucket: string; count: number }>> {
  const buckets: Record<string, number> = {
    "0.0-0.2": 0,
    "0.2-0.4": 0,
    "0.4-0.6": 0,
    "0.6-0.8": 0,
    "0.8-1.0": 0,
  };
  for (const f of state.facts.values()) {
    if (f.status !== "forgotten" && typeof f.worth === "number") {
      const w = f.worth;
      if (w < 0.2) buckets["0.0-0.2"]!++;
      else if (w < 0.4) buckets["0.2-0.4"]!++;
      else if (w < 0.6) buckets["0.4-0.6"]!++;
      else if (w < 0.8) buckets["0.6-0.8"]!++;
      else buckets["0.8-1.0"]!++;
    }
  }
  return Object.entries(buckets).map(([bucket, count]) => ({ bucket, count }));
}

export async function countActiveSessions(state: InMemoryStorageState): Promise<number> {
  let n = 0;
  for (const s of state.sessions.values()) {
    if (s.status === "active") n++;
  }
  return n;
}

export async function countTasksByStatus(
  state: InMemoryStorageState
): Promise<Array<{ status: string; count: number }>> {
  const counts = new Map<string, number>();
  for (const t of state.tasks.values()) {
    counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([status, count]) => ({ status, count }));
}

export async function countStaleTasks(state: InMemoryStorageState): Promise<number> {
  const staleSinceMs = 7 * 24 * 60 * 60 * 1000;
  const excluded = new Set(["done", "cancelled", "archived"]);
  const cutoff = new Date(Date.now() - staleSinceMs);
  let n = 0;
  for (const t of state.tasks.values()) {
    if (!excluded.has(t.status) && t.updatedAt < cutoff) n++;
  }
  return n;
}
