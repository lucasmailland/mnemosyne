import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

const NOW = new Date("2026-01-01");

describe("InMemoryStorageAdapter.getEpisodeTreeNeighbors", () => {
  it("returns parent + siblings + children, excludes self, workspace-scoped", async () => {
    const store = new InMemoryStorageAdapter();
    const ws = "00000000-0000-0000-0000-000000000001";
    const ws2 = "00000000-0000-0000-0000-000000000002";

    // Create root episode R
    const R = await store.createEpisode({ workspaceId: ws, title: "Root", narrative: "Root narrative", occurredAt: NOW });
    // Create two children of R
    const C1 = await store.createEpisode({ workspaceId: ws, title: "Child1", narrative: "C1 narrative", occurredAt: NOW, parentEpisodeId: R.id });
    const C2 = await store.createEpisode({ workspaceId: ws, title: "Child2", narrative: "C2 narrative", occurredAt: NOW, parentEpisodeId: R.id });

    // Create an episode in another workspace — must not appear
    // Note: ws2 episode cannot use R.id as parentEpisodeId across workspaces — create independently
    await store.createEpisode({ workspaceId: ws2, title: "Other", narrative: "Other narrative", occurredAt: NOW });

    const neighbors = await store.getEpisodeTreeNeighbors(C1.id, ws);
    const ids = neighbors.map((e) => e.id);

    expect(ids).toContain(R.id);   // parent
    expect(ids).toContain(C2.id);  // sibling
    expect(ids).not.toContain(C1.id); // self excluded
    expect(neighbors.every((e) => e.workspaceId === ws)).toBe(true); // workspace-scoped
  });

  it("returns children of the queried episode", async () => {
    const store = new InMemoryStorageAdapter();
    const ws = "00000000-0000-0000-0000-000000000001";
    const R = await store.createEpisode({ workspaceId: ws, title: "Root", narrative: "Root narrative", occurredAt: NOW });
    const C = await store.createEpisode({ workspaceId: ws, title: "Child", narrative: "Child narrative", occurredAt: NOW, parentEpisodeId: R.id });
    await store.createEpisode({ workspaceId: ws, title: "Grandchild", narrative: "GC narrative", occurredAt: NOW, parentEpisodeId: C.id });

    const neighbors = await store.getEpisodeTreeNeighbors(R.id, ws);
    const ids = neighbors.map((e) => e.id);
    expect(ids).toContain(C.id); // child of R
    expect(ids).not.toContain(R.id); // self excluded
  });

  it("returns empty array when episode has no tree neighbors", async () => {
    const store = new InMemoryStorageAdapter();
    const ws = "00000000-0000-0000-0000-000000000001";
    const solo = await store.createEpisode({ workspaceId: ws, title: "Solo", narrative: "Solo narrative", occurredAt: NOW });
    const neighbors = await store.getEpisodeTreeNeighbors(solo.id, ws);
    expect(neighbors).toHaveLength(0);
  });

  it("respects the limit parameter", async () => {
    const store = new InMemoryStorageAdapter();
    const ws = "00000000-0000-0000-0000-000000000001";
    const R = await store.createEpisode({ workspaceId: ws, title: "Root", narrative: "Root narrative", occurredAt: NOW });
    // Create 15 children
    for (let i = 0; i < 15; i++) {
      await store.createEpisode({ workspaceId: ws, title: `Child${i}`, narrative: `C${i} narrative`, occurredAt: NOW, parentEpisodeId: R.id });
    }
    const A = await store.createEpisode({ workspaceId: ws, title: "A", narrative: "A narrative", occurredAt: NOW, parentEpisodeId: R.id });
    // getEpisodeTreeNeighbors on A: parent R + 15 siblings = 16 total, limit to 5
    const neighbors = await store.getEpisodeTreeNeighbors(A.id, ws, 5);
    expect(neighbors.length).toBeLessThanOrEqual(5);
  });
});
