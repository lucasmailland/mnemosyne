import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

// P111 — relations were creatable and removable through no surface at all.
//
// That gap had a concrete consequence: P74's dangling-write path created
// relations against ids matching no row (`createRelation` is a blind INSERT with
// no FK), and there was no way to take one back.
//
// The exposed operation CLOSES the interval rather than deleting the row. Every
// other primitive works that way — forget() "closes validity — does NOT delete
// rows" — and a relation carries an explicit human judgment (markedByKind,
// reason, evidence, confidence) that an audit needs to keep. The port's
// `deleteRelation` still does a physical DELETE and is deliberately not the
// method behind the route; these guards pin the difference.

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";

async function seedRelation(adapter: InMemoryStorageAdapter, workspaceId = WS) {
  return adapter.createRelation({
    workspaceId,
    sourceKind: "fact",
    sourceId: "f-1",
    targetKind: "fact",
    targetId: "f-2",
    relation: "related",
  } as never);
}

describe("closeRelation (P111)", () => {
  it("closes the interval and keeps the row", async () => {
    const adapter = new InMemoryStorageAdapter();
    const rel = await seedRelation(adapter);

    expect(await adapter.closeRelation(rel.id, WS)).toBe(true);

    // The row survives — this is the whole difference from deleteRelation.
    const all = await adapter.getRelations({ workspaceId: WS, openOnly: false });
    const found = all.find((r) => r.id === rel.id);
    expect(found).toBeDefined();
    expect(found!.validTo).toBeInstanceOf(Date);
  });

  it("reports false for an already-closed relation instead of re-stamping it", async () => {
    const adapter = new InMemoryStorageAdapter();
    const rel = await seedRelation(adapter);

    await adapter.closeRelation(rel.id, WS);
    const first = (await adapter.getRelations({ workspaceId: WS, openOnly: false })).find(
      (r) => r.id === rel.id
    )!.validTo;

    expect(await adapter.closeRelation(rel.id, WS)).toBe(false);

    const second = (await adapter.getRelations({ workspaceId: WS, openOnly: false })).find(
      (r) => r.id === rel.id
    )!.validTo;
    expect(second).toEqual(first);
  });

  it("reports false for an id that matches nothing, so the route can 404", async () => {
    const adapter = new InMemoryStorageAdapter();
    expect(await adapter.closeRelation("no-such-relation", WS)).toBe(false);
  });

  it("does not cross workspaces", async () => {
    const adapter = new InMemoryStorageAdapter();
    const rel = await seedRelation(adapter, OTHER_WS);

    expect(await adapter.closeRelation(rel.id, WS)).toBe(false);
  });

  it("deleteRelation still removes the row — the two are not the same operation", async () => {
    const adapter = new InMemoryStorageAdapter();
    const rel = await seedRelation(adapter);

    await adapter.deleteRelation(rel.id, WS);

    const all = await adapter.getRelations({ workspaceId: WS, openOnly: false });
    expect(all.find((r) => r.id === rel.id)).toBeUndefined();
  });
});
