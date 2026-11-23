import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

// P68 — L3 query-cache eviction, the fast-follow P59 registered when it chose
// Option A (insert-only, no eviction). Every eligible recall that resolves from
// facts appended a row and nothing removed it except replaceFact's
// whole-workspace bust, so storage grew without bound.
//
// The property that matters beyond "it deletes": pruning is anchored on
// createdAt, not lastUsedAt. They are identical under today's insert-only
// writes, but P59 design.md D6 warns a future touch-on-hit would let a hot
// entry keep refreshing itself and never expire. Pinning the anchor here means
// that change cannot silently defeat eviction.

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";

async function seed(adapter: InMemoryStorageAdapter, workspaceId: string) {
  await adapter.insertQueryCache!({
    workspaceId,
    embedding: new Float32Array([0.1, 0.2]),
    resultIds: ["f-1"],
    resultKinds: ["fact"],
    topK: 5,
  } as never);
}

/** Backdate every row of a workspace, standing in for the passage of time. */
function backdate(adapter: InMemoryStorageAdapter, workspaceId: string, ageMs: number) {
  const state = (adapter as unknown as { state: { queryCache: Array<Record<string, unknown>> } })
    .state;
  for (const row of state.queryCache) {
    if (row.workspaceId === workspaceId) row.createdAt = Date.now() - ageMs; // determinism-ok: relative ageing of a fixture row, the instant is never asserted
  }
}

function rows(adapter: InMemoryStorageAdapter): Array<{ workspaceId: string }> {
  return (adapter as unknown as { state: { queryCache: Array<{ workspaceId: string }> } }).state
    .queryCache;
}

describe("pruneQueryCache (P68)", () => {
  it("removes rows older than the retention window", async () => {
    const adapter = new InMemoryStorageAdapter();
    await seed(adapter, WS);
    backdate(adapter, WS, 2 * 3_600_000);

    expect(await adapter.pruneQueryCache!(WS, 3_600_000)).toBe(1);
    expect(rows(adapter)).toHaveLength(0);
  });

  it("keeps rows inside the window — a fresh entry must stay servable", async () => {
    const adapter = new InMemoryStorageAdapter();
    await seed(adapter, WS);

    expect(await adapter.pruneQueryCache!(WS, 3_600_000)).toBe(0);
    expect(rows(adapter)).toHaveLength(1);
  });

  it("does not touch another workspace's rows", async () => {
    const adapter = new InMemoryStorageAdapter();
    await seed(adapter, OTHER_WS);
    backdate(adapter, OTHER_WS, 2 * 3_600_000);

    expect(await adapter.pruneQueryCache!(WS, 3_600_000)).toBe(0);
    expect(rows(adapter)).toHaveLength(1);
  });

  it("reports zero on an empty cache rather than throwing", async () => {
    const adapter = new InMemoryStorageAdapter();
    expect(await adapter.pruneQueryCache!(WS, 3_600_000)).toBe(0);
  });
});
