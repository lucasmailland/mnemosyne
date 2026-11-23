import { describe, it, expect, vi } from "vitest";
import { applyGovernance, type GovernanceDeps } from "../index.js";

function makeFact(
  over: Partial<{ worth: number; worthAlpha: number; worthBeta: number; pinned: boolean }>
) {
  return {
    id: "f1",
    workspaceId: "ws1",
    scope: "global",
    statement: "x",
    subject: "s",
    kind: "other",
    confidence: 0.8,
    relevance: 0.5,
    hitCount: 0,
    worthSuccess: 0,
    worthFailure: 0,
    worthAlpha: 2,
    worthBeta: 2,
    worth: 0.5,
    memoryType: "semantic",
    memoryStrength: 1,
    memoryStability: 1,
    attribution: "inferred",
    sourceMessageIds: [],
    revisionCount: 0,
    protocolVersion: "3",
    status: "active",
    pinned: false,
    canonical: false,
    sensitivity: "internal",
    validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
    embeddingStale: false,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    metadata: {},
    ...over,
  } as any;
}

function makeDeps(fact: ReturnType<typeof makeFact> | null) {
  const calls = {
    setCanonical: 0,
    updateFact: [] as any[],
    enqueueReview: [] as any[],
    zincrby: [] as any[],
  };
  const deps: GovernanceDeps = {
    storage: {
      getFact: vi.fn(async () => fact),
      setCanonical: vi.fn(async () => {
        calls.setCanonical++;
      }),
      updateFact: vi.fn(async (_id: string, _workspaceId: string, input: any) => {
        calls.updateFact.push(input);
        return fact;
      }),
      enqueueReview: vi.fn(async (i: any) => {
        calls.enqueueReview.push(i);
      }),
    },
    cache: {
      zincrby: vi.fn(async (k: string, d: number, m: string) => {
        calls.zincrby.push([k, d, m]);
        return d;
      }),
      zrangeByScore: vi.fn(async () => []),
    },
    maxHotTierSize: 1000,
  };
  return { deps, calls };
}

describe("applyGovernance action executor (§11 lines 1004-1046)", () => {
  it("canonical: worth>0.8 ∧ confLower>0.7 → setCanonical + pin + hot bump", async () => {
    const fact = makeFact({ worth: 0.95, worthAlpha: 40, worthBeta: 2 }); // confLower > 0.7
    const { deps, calls } = makeDeps(fact);
    expect(await applyGovernance(deps, "ws1", "f1")).toBe("canonical");
    expect(calls.setCanonical).toBe(1);
    expect(calls.updateFact).toEqual([{ pinned: true }]);
    expect(calls.zincrby[0]).toEqual(["mnemo:ws1:hot:facts", 1, "f1"]);
  });
  it("promote: worth>0.7 ∧ mid confidence → pin + hot bump, no setCanonical", async () => {
    // worthAlpha=20, worthBeta=8 → worth≈0.714, wilsonLower≈0.529 (satisfies promote but not canonical)
    const fact = makeFact({ worth: 0.714, worthAlpha: 20, worthBeta: 8 });
    const { deps, calls } = makeDeps(fact);
    expect(await applyGovernance(deps, "ws1", "f1")).toBe("promote");
    expect(calls.setCanonical).toBe(0);
    expect(calls.updateFact).toEqual([{ pinned: true }]);
  });
  it("neutral: low confidence → no writes", async () => {
    const fact = makeFact({ worth: 0.9, worthAlpha: 2, worthBeta: 2 }); // confLower ≈ 0.15 < 0.3
    const { deps, calls } = makeDeps(fact);
    expect(await applyGovernance(deps, "ws1", "f1")).toBe("neutral");
    expect(calls.setCanonical).toBe(0);
    expect(calls.updateFact).toEqual([]);
  });
  it("demote: Wilson upper bound < 0.3 → hot-tier decrease + archive-candidate review", async () => {
    const fact = makeFact({ worth: 2 / 42, worthAlpha: 2, worthBeta: 40 }); // upper ≈ 0.16
    const { deps, calls } = makeDeps(fact);
    expect(await applyGovernance(deps, "ws1", "f1")).toBe("demote");
    expect(calls.zincrby[0]).toEqual(["mnemo:ws1:hot:facts", -10, "f1"]);
    expect(calls.enqueueReview).toEqual([
      expect.objectContaining({ primitiveId: "f1", reason: "low_worth_archive_candidate" }),
    ]);
    expect(calls.updateFact).toEqual([]);
  });
  it("missing fact → neutral, no writes", async () => {
    const { deps, calls } = makeDeps(null);
    expect(await applyGovernance(deps, "ws1", "missing")).toBe("neutral");
    expect(calls.setCanonical).toBe(0);
  });
});
