/**
 * Unit tests for InMemoryStorageAdapter hyperedge methods (Wave D).
 * All tests run without a DB.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

describe("InMemoryStorageAdapter — hyperedge CRUD (Wave D)", () => {
  let adapter: InMemoryStorageAdapter;
  const workspaceId = "00000000-0000-0000-0000-0000000000d4";

  beforeEach(() => {
    adapter = new InMemoryStorageAdapter();
  });

  it("rejects createHyperedge with fewer than 3 members", async () => {
    await expect(adapter.createHyperedge({ workspaceId, memberIds: ["a", "b"] })).rejects.toThrow(
      /at least 3/i
    );
  });

  it("creates a hyperedge with valid memberIds", async () => {
    const h = await adapter.createHyperedge({
      workspaceId,
      memberIds: ["m1", "m2", "m3"],
      label: "trio",
    });
    expect(h.id).toBeTruthy();
    expect(h.memberIds).toEqual(["m1", "m2", "m3"]);
    expect(h.label).toBe("trio");
    expect(h.activationCount).toBe(0);
    expect(h.worth).toBe(0.5);
  });

  it("getHyperedge returns the created hyperedge", async () => {
    const created = await adapter.createHyperedge({
      workspaceId,
      memberIds: ["m1", "m2", "m3"],
      label: "trio",
    });
    const got = await adapter.getHyperedge(created.id, workspaceId);
    expect(got?.id).toBe(created.id);
    expect(got?.label).toBe("trio");
  });

  it("getHyperedge returns null for wrong workspace", async () => {
    const created = await adapter.createHyperedge({
      workspaceId,
      memberIds: ["m1", "m2", "m3"],
    });
    const got = await adapter.getHyperedge(created.id, "wrong-workspace");
    expect(got).toBeNull();
  });

  it("queryHyperedges filters by memberId", async () => {
    await adapter.createHyperedge({ workspaceId, memberIds: ["m1", "m2", "m3"] });
    await adapter.createHyperedge({ workspaceId, memberIds: ["x1", "x2", "x3"] });

    const page = await adapter.queryHyperedges({ workspaceId, memberId: "m2" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].memberIds).toContain("m2");
  });

  it("queryHyperedges filters by label", async () => {
    await adapter.createHyperedge({ workspaceId, memberIds: ["m1", "m2", "m3"], label: "alpha" });
    await adapter.createHyperedge({ workspaceId, memberIds: ["x1", "x2", "x3"], label: "beta" });

    const page = await adapter.queryHyperedges({ workspaceId, label: "alpha" });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].label).toBe("alpha");
  });

  it("updateHyperedge changes the label", async () => {
    const created = await adapter.createHyperedge({
      workspaceId,
      memberIds: ["m1", "m2", "m3"],
      label: "original",
    });
    const updated = await adapter.updateHyperedge(created.id, { label: "renamed" });
    expect(updated.label).toBe("renamed");

    // Verify via get
    const got = await adapter.getHyperedge(created.id, workspaceId);
    expect(got?.label).toBe("renamed");
  });

  it("updateHyperedge throws for missing hyperedge", async () => {
    await expect(adapter.updateHyperedge("nonexistent-id", { label: "x" })).rejects.toThrow(
      /not found/i
    );
  });

  it("archiveHyperedge sets validTo", async () => {
    const created = await adapter.createHyperedge({
      workspaceId,
      memberIds: ["m1", "m2", "m3"],
    });
    expect(created.validTo).toBeUndefined();

    await adapter.archiveHyperedge(created.id, workspaceId);
    // PRIM-12: a closed hyperedge reads as gone unless history is requested.
    expect(await adapter.getHyperedge(created.id, workspaceId)).toBeNull();
    const closed = await adapter.getHyperedge(created.id, workspaceId, { includeClosed: true });
    expect(closed?.validTo).not.toBeUndefined();
    expect(closed?.validTo).toBeInstanceOf(Date);
  });

  it("bumpHyperedgeActivation increments activationCount", async () => {
    const h = await adapter.createHyperedge({ workspaceId, memberIds: ["x1", "x2", "x3"] });
    expect(h.activationCount).toBe(0);

    await adapter.bumpHyperedgeActivation(h.id, workspaceId);
    await adapter.bumpHyperedgeActivation(h.id, workspaceId);
    const got = await adapter.getHyperedge(h.id, workspaceId);
    expect(got?.activationCount).toBe(2);
  });

  it("queryHyperedges sorts by activationCount descending", async () => {
    const h1 = await adapter.createHyperedge({ workspaceId, memberIds: ["a1", "a2", "a3"] });
    const h2 = await adapter.createHyperedge({ workspaceId, memberIds: ["b1", "b2", "b3"] });

    await adapter.bumpHyperedgeActivation(h2.id, workspaceId);
    await adapter.bumpHyperedgeActivation(h2.id, workspaceId);

    const page = await adapter.queryHyperedges({ workspaceId });
    expect(page.items[0].id).toBe(h2.id);
    expect(page.items[1].id).toBe(h1.id);
  });
});
