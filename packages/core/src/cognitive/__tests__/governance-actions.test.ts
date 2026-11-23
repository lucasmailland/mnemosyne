import { describe, it, expect } from "vitest";
import { classifyGovernance } from "../governance.js";
import { wilsonLowerBound, wilsonUpperBound } from "../worth.js";

/** Classify straight from Beta(α,β) counts, the way applyGovernance does. */
function classify(alpha: number, beta: number) {
  return classifyGovernance(
    alpha / (alpha + beta),
    wilsonLowerBound(alpha, beta),
    wilsonUpperBound(alpha, beta)
  );
}

describe("classifyGovernance — spec §11 decision rule (lines 1004-1007, 1045)", () => {
  it("returns 'canonical' when worth>0.8 AND confLower>0.7 (checked first)", () => {
    expect(classifyGovernance(0.85, 0.75, 0.95)).toBe("canonical");
  });
  it("returns 'promote' when worth>0.7 AND confLower>0.5 but not canonical", () => {
    expect(classifyGovernance(0.75, 0.55, 0.9)).toBe("promote");
  });
  it("returns 'demote' when the Wilson upper bound is below 0.3", () => {
    expect(classifyGovernance(0.1, 0.02, 0.25)).toBe("demote");
  });
  it("returns 'neutral' when worth is low but a higher worth is still plausible", () => {
    expect(classifyGovernance(0.2, 0.05, 0.45)).toBe("neutral");
  });
  it("returns 'neutral' when confLower is too low to promote, regardless of worth", () => {
    expect(classifyGovernance(0.95, 0.25, 0.99)).toBe("neutral");
  });
  it("returns 'neutral' in the mid-band (0.3<=worth<=0.7)", () => {
    expect(classifyGovernance(0.5, 0.4, 0.6)).toBe("neutral");
  });
  it("does not promote a high-worth fact whose confidence is only 0.5 (strict >)", () => {
    expect(classifyGovernance(0.72, 0.5, 0.9)).toBe("neutral");
  });

  it("demote is reachable from real counts: many failures, no successes", () => {
    expect(classify(2, 40)).toBe("demote");
  });
  it("a single failure does not demote (1 of 1 failed)", () => {
    expect(classify(2, 3)).toBe("neutral");
  });
  it("a fresh fact at the Beta(2,2) prior is neutral", () => {
    expect(classify(2, 2)).toBe("neutral");
  });
});
