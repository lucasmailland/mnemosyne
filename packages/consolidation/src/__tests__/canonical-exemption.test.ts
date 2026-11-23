import { describe, it, expect } from "vitest";
import { runConsolidationGate } from "../ConsolidationGate.js";
import type { GateFact } from "../ConsolidationGate.js";

// Post-K GateFact factory — three otherwise-mergeable members.
let _mkFactSeq = 0;
function mkFact(over: Partial<GateFact> = {}): GateFact {
  return {
    id: `f-${++_mkFactSeq}`,
    worth: 0.3,
    worthAlpha: 2,
    worthBeta: 5,
    pinned: false,
    canonical: false,
    contested: false,
    sensitivity: "internal",
    hitCount: 2,
    lastRecalledAt: new Date("2025-11-22T00:00:00Z"), // 40 days before 2026-01-01
    embedding: [1, 0, 0],
    ...over,
  };
}

const EMB = { e1: [1, 0, 0], e2: [0.99, 0.01, 0], e3: [0.98, 0.02, 0] };

describe("consolidation gate — canonical exemption (spec line 1045)", () => {
  it("rejects merge when ANY member is canonical, even if all other conditions pass", () => {
    const r = runConsolidationGate({
      members: [
        mkFact({ embedding: EMB.e1 }),
        mkFact({ embedding: EMB.e2 }),
        mkFact({ embedding: EMB.e3, canonical: true }),
      ],
    });
    expect(r.passed).toBe(false);
    expect(r.failedCondition).toBe("canonical");
  });

  it("rejects when the FIRST member is canonical (early-exit order)", () => {
    const r = runConsolidationGate({
      members: [
        mkFact({ embedding: EMB.e1, canonical: true }),
        mkFact({ embedding: EMB.e2 }),
        mkFact({ embedding: EMB.e3 }),
      ],
    });
    expect(r.passed).toBe(false);
    expect(r.failedCondition).toBe("canonical");
  });

  it("still passes when no member is canonical (regression guard for K conditions)", () => {
    const r = runConsolidationGate({
      members: [
        mkFact({ embedding: EMB.e1 }),
        mkFact({ embedding: EMB.e2 }),
        mkFact({ embedding: EMB.e3 }),
      ],
    });
    expect(r.passed).toBe(true);
  });
});
