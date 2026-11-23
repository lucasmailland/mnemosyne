// in-memory/lifecycle.ts — InMemoryStorageAdapter's Lifecycle port methods.
// decompose-inmemory-storage-adapter Batch B6 (design.md Module Map row 35).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).
// `listWorkspaceIds` reads `facts` per D4 — a 2-method module would otherwise
// be too thin to justify.

import type { HealthStatus } from "../../common.js";
import type { InMemoryStorageState } from "./state.js";

export async function healthCheck(_state: InMemoryStorageState): Promise<HealthStatus> {
  return { status: "ok", latencyMs: 0 };
}

export async function close(_state: InMemoryStorageState): Promise<void> {
  // Nothing to close in memory
}

export async function listWorkspaceIds(state: InMemoryStorageState): Promise<string[]> {
  const ids = new Set<string>();
  for (const f of state.facts.values()) {
    if (f.status === "active") ids.add(f.workspaceId);
  }
  return [...ids];
}
