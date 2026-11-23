// Unit tests for the shared two-direction, verb-parameterised relation
// lookup extracted for design.md D2 (used by both the write-time scoped
// conflict check and the scheduler's deep-mode classification memo).

import { describe, it, expect, vi } from "vitest";
import type { MnemoRelation } from "@mnemo-ai/types";
import { loadLinkedFactIds } from "../relation-memo.js";
import type { RelationLookupStorage } from "../relation-memo.js";

function makeRelation(overrides: Partial<MnemoRelation>): MnemoRelation {
  return {
    id: `rel_${Math.random().toString(36).slice(2)}`, // determinism-ok: throwaway fixture id, never asserted
    workspaceId: "ws-1",
    sourceId: "",
    sourceType: "fact",
    targetId: "",
    targetType: "fact",
    verb: "conflicts_with",
    weight: 1,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as unknown as MnemoRelation;
}

function makeFakeStorage(relations: MnemoRelation[]): RelationLookupStorage & {
  getRelations: ReturnType<typeof vi.fn>;
} {
  const getRelations = vi.fn(
    async (filter: { sourceId?: string; targetId?: string; verb?: string }) =>
      relations.filter(
        (r) =>
          r.verb === filter.verb &&
          (filter.sourceId === undefined || r.sourceId === filter.sourceId) &&
          (filter.targetId === undefined || r.targetId === filter.targetId)
      )
  );
  return { getRelations };
}

describe("loadLinkedFactIds", () => {
  it("finds the far-side id when factId is the source", async () => {
    const storage = makeFakeStorage([
      makeRelation({ sourceId: "fact-a", targetId: "fact-b", verb: "conflicts_with" }),
    ]);

    const linked = await loadLinkedFactIds(storage, "ws-1", "fact-a", ["conflicts_with"]);

    expect(linked).toEqual(new Set(["fact-b"]));
  });

  it("finds the far-side id when factId is the target (other direction)", async () => {
    const storage = makeFakeStorage([
      makeRelation({ sourceId: "fact-c", targetId: "fact-a", verb: "conflicts_with" }),
    ]);

    const linked = await loadLinkedFactIds(storage, "ws-1", "fact-a", ["conflicts_with"]);

    expect(linked).toEqual(new Set(["fact-c"]));
  });

  it("unions far-side ids across multiple verbs and both directions", async () => {
    const storage = makeFakeStorage([
      makeRelation({ sourceId: "fact-a", targetId: "fact-b", verb: "conflicts_with" }),
      makeRelation({ sourceId: "fact-c", targetId: "fact-a", verb: "conflicts_with" }),
      makeRelation({ sourceId: "fact-a", targetId: "fact-d", verb: "not_conflict" }),
      makeRelation({ sourceId: "fact-e", targetId: "fact-a", verb: "not_conflict" }),
      // A different fact pair — must not leak into fact-a's linked set.
      makeRelation({ sourceId: "fact-x", targetId: "fact-y", verb: "conflicts_with" }),
    ]);

    const linked = await loadLinkedFactIds(storage, "ws-1", "fact-a", [
      "conflicts_with",
      "not_conflict",
    ]);

    expect(linked).toEqual(new Set(["fact-b", "fact-c", "fact-d", "fact-e"]));
  });

  it("issues exactly two getRelations calls per verb (source direction + target direction)", async () => {
    const storage = makeFakeStorage([]);

    await loadLinkedFactIds(storage, "ws-1", "fact-a", ["conflicts_with", "not_conflict"]);

    expect(storage.getRelations).toHaveBeenCalledTimes(4);
    expect(storage.getRelations).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sourceId: "fact-a",
      verb: "conflicts_with",
      openOnly: false,
    });
    expect(storage.getRelations).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      targetId: "fact-a",
      verb: "conflicts_with",
      openOnly: false,
    });
    expect(storage.getRelations).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sourceId: "fact-a",
      verb: "not_conflict",
      openOnly: false,
    });
    expect(storage.getRelations).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      targetId: "fact-a",
      verb: "not_conflict",
      openOnly: false,
    });
  });

  it("returns an empty set when no relations exist", async () => {
    const storage = makeFakeStorage([]);

    const linked = await loadLinkedFactIds(storage, "ws-1", "fact-a", ["conflicts_with"]);

    expect(linked.size).toBe(0);
  });
});
