import { describe, it, expect } from "vitest";
import { runConsolidationGate } from "../ConsolidationGate.js";
import type { GateFact } from "../ConsolidationGate.js";

// Three near-identical low-worth, stale, low-confidence facts that SHOULD merge.
let _mkFactSeq = 0;
function mkFact(over: Partial<GateFact> = {}): GateFact {
  return {
    id: `f-${++_mkFactSeq}`,
    worth: 0.3,
    worthAlpha: 2,
    worthBeta: 5,            // wilsonLowerBound(2,5) ≈ 0.12 → confidence well below 0.7
    pinned: false,
    canonical: false,
    contested: false,
    sensitivity: "internal",
    hitCount: 2,
    lastRecalledAt: new Date("2025-11-22T00:00:00Z"), // 40 days before 2026-01-01 (stale, always outside 14-day window)
    embedding: [1, 0, 0],
    ...over,
  };
}

const EMB = { e1: [1, 0, 0], e2: [0.99, 0.01, 0], e3: [0.98, 0.02, 0] };

describe("runConsolidationGate — spec §12 six conditions", () => {
  it("passes when 3+ low-worth, stale, low-confidence, similar members align", () => {
    const r = runConsolidationGate({
      members: [
        mkFact({ embedding: EMB.e1 }),
        mkFact({ embedding: EMB.e2 }),
        mkFact({ embedding: EMB.e3 }),
      ],
    });
    expect(r.passed).toBe(true);
  });

  it("rejects a cluster smaller than 3 (no pairwise merges)", () => {
    const r = runConsolidationGate({ members: [mkFact(), mkFact()] });
    expect(r.passed).toBe(false);
    expect(r.failedCondition).toBe("cluster_too_small");
  });

  it("rejects when ANY member has worth >= 0.5 (condition 1, not inverted)", () => {
    const r = runConsolidationGate({
      members: [mkFact({ embedding: EMB.e1 }), mkFact({ embedding: EMB.e2 }), mkFact({ worth: 0.6, embedding: EMB.e3 })],
    });
    expect(r.passed).toBe(false);
    expect(r.failedCondition).toBe("high_worth");
  });

  it("rejects when a member was recalled within 14 days (condition 3)", () => {
    const recentDate = new Date(Date.now() - 2 * 86_400_000); // determinism-ok: must be relative to gate's internal Date.now(); 2 days ago is always within the 14-day recency window
    const r = runConsolidationGate({
      members: [
        mkFact({ embedding: EMB.e1 }),
        mkFact({ embedding: EMB.e2 }),
        mkFact({ embedding: EMB.e3, lastRecalledAt: recentDate }),
      ],
    });
    expect(r.passed).toBe(false);
    expect(r.failedCondition).toBe("recently_recalled");
  });

  it("rejects when a member's Wilson confidence exceeds 0.7 (condition 4)", () => {
    const r = runConsolidationGate({
      members: [
        mkFact({ embedding: EMB.e1 }),
        mkFact({ embedding: EMB.e2 }),
        mkFact({ embedding: EMB.e3, worthAlpha: 90, worthBeta: 10 }), // wilsonLB ≈ 0.83 > 0.7
      ],
    });
    expect(r.passed).toBe(false);
    expect(r.failedCondition).toBe("high_confidence");
  });

  it("rejects on low pairwise similarity (condition 5)", () => {
    const r = runConsolidationGate({
      members: [mkFact({ embedding: [1, 0, 0] }), mkFact({ embedding: [0, 1, 0] }), mkFact({ embedding: [0, 0, 1] })],
    });
    expect(r.passed).toBe(false);
    expect(r.failedCondition).toBe("low_similarity");
  });

  it("rejects when any member is pinned or contested", () => {
    expect(runConsolidationGate({ members: [mkFact({ pinned: true }), mkFact(), mkFact()] }).failedCondition).toBe("pinned");
    expect(runConsolidationGate({ members: [mkFact({ contested: true }), mkFact(), mkFact()] }).failedCondition).toBe("contested");
  });
});
