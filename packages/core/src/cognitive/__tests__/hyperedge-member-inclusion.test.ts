import { describe, it, expect } from "vitest";
import { expandHyperedgeMembers } from "../recall-cold.js";
import type { RecallHit, AuthContext } from "@mnemo-ai/types";

const auth = { workspaceId: "ws1", scopes: [] } as unknown as AuthContext;

function ctxWith(facts: Record<string, { id: string; statement: string; sensitivity?: string; worth?: number; worthAlpha?: number; worthBeta?: number; attribution?: string; createdAt?: Date }>) {
  return {
    storage: { getFact: async (id: string) => {
      const fact = facts[id];
      return fact ? { status: "active", validFrom: fact.createdAt ?? new Date(0), validTo: null, ...fact } : null;
    } },
    logger: { debug() {}, warn() {}, child() { return this; } },
  } as any;
}

describe("expandHyperedgeMembers (spec §15)", () => {
  it("includes co-members of a worth>0.5 hyperedge, scored by hyperedge worth", async () => {
    const parent: RecallHit = {
      id: "f-a", primitive: "fact", content: "A", score: 1.0, sensitivity: "internal",
      injectionScore: 0, provenance: "user_stated", origin: "local", contested: false,
      validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
      validTo: null, tags: [], relations: [],
      hyperedges: [
        { id: "h1", coMembers: ["f-b"], label: "x", worth: 0.8 },
        { id: "h2", coMembers: ["f-c"], label: "y", worth: 0.4 },
      ],
    } as unknown as RecallHit;
    const ctx = ctxWith({
      "f-b": { id: "f-b", statement: "B", worth: 0.9, worthAlpha: 20, worthBeta: 2, attribution: "user_stated", createdAt: new Date() }, // determinism-ok: throwaway fixture date, not asserted
      "f-c": { id: "f-c", statement: "C", attribution: "user_stated", createdAt: new Date() }, // determinism-ok: throwaway fixture date, not asserted
    });

    const extra = await expandHyperedgeMembers(ctx, "ws1", [parent], auth);
    const ids = extra.map((h) => h.id);
    expect(ids).toContain("f-b");
    expect(ids).not.toContain("f-c"); // worth 0.4 <= 0.5: must not be included
    const fb = extra.find((h) => h.id === "f-b")!;
    expect(fb.score).toBeCloseTo(0.8, 5); // parentScore(1.0) * hyperedge.worth(0.8)
  });

  it("does not duplicate a member already in the hits set", async () => {
    const alreadyInHits: RecallHit = {
      id: "f-b", primitive: "fact", content: "B", score: 0.9, sensitivity: "internal",
      injectionScore: 0, provenance: "user_stated", origin: "local", contested: false,
      validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
      validTo: null, tags: [], relations: [],
    } as unknown as RecallHit;
    const parent: RecallHit = {
      id: "f-a", primitive: "fact", content: "A", score: 1.0, sensitivity: "internal",
      injectionScore: 0, provenance: "user_stated", origin: "local", contested: false,
      validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
      validTo: null, tags: [], relations: [],
      hyperedges: [{ id: "h1", coMembers: ["f-b"], label: "x", worth: 0.8 }],
    } as unknown as RecallHit;
    const ctx = ctxWith({ "f-b": { id: "f-b", statement: "B", attribution: "user_stated", createdAt: new Date() } }); // determinism-ok: throwaway fixture date, not asserted

    const extra = await expandHyperedgeMembers(ctx, "ws1", [parent, alreadyInHits], auth);
    // f-b was already in hits → should not appear in extra (no duplicate)
    expect(extra.map((h) => h.id)).not.toContain("f-b");
  });
});
