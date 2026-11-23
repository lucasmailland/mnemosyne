import { describe, it, expect } from "vitest";
import { passesTopicKeyResolveGate } from "../reasoning.js";

// §8c: the O(1) topic-key fast-path must enforce the SAME gate as the vector
// path — active|golden ∧ worth > 0.5 ∧ wilsonLB > 0.3 — not worth > 0.5 alone.

describe("passesTopicKeyResolveGate (§8c)", () => {
  it("serves a well-evidenced active row (worth>0.5, many successes)", () => {
    expect(
      passesTopicKeyResolveGate({ status: "active", worth: 0.9, successCount: 40, failureCount: 2 }),
    ).toBe(true);
  });

  it("REJECTS a high-worth row that fails the Wilson bar (single lucky success)", () => {
    // worth 0.9 alone would pass the old gate; Wilson LB of Beta(1+1,0+1) ≈ 0.29 < 0.3.
    expect(
      passesTopicKeyResolveGate({ status: "active", worth: 0.9, successCount: 1, failureCount: 0 }),
    ).toBe(false);
  });

  it("rejects a row with worth ≤ 0.5 even with lots of evidence", () => {
    expect(
      passesTopicKeyResolveGate({ status: "active", worth: 0.5, successCount: 100, failureCount: 80 }),
    ).toBe(false);
  });

  it("rejects quarantined rows regardless of worth/evidence", () => {
    expect(
      passesTopicKeyResolveGate({ status: "quarantined", worth: 0.95, successCount: 100, failureCount: 1 }),
    ).toBe(false);
  });

  it("serves a golden row that clears worth + Wilson", () => {
    expect(
      passesTopicKeyResolveGate({ status: "golden", worth: 0.95, successCount: 100, failureCount: 1 }),
    ).toBe(true);
  });
});
