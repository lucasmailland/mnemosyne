import { describe, it, expect } from "vitest";
import { wilsonLowerBound, wilsonUpperBound } from "../worth.js";

describe("wilsonUpperBound", () => {
  it("brackets the mean together with the lower bound", () => {
    const [lo, hi] = [wilsonLowerBound(3, 7), wilsonUpperBound(3, 7)];
    expect(lo).toBeLessThan(0.3);
    expect(hi).toBeGreaterThan(0.3);
  });
  it("mirrors the lower bound: upper(a,b) = 1 - lower(b,a)", () => {
    expect(wilsonUpperBound(2, 9)).toBeCloseTo(1 - wilsonLowerBound(9, 2), 10);
  });
  it("returns 1 for zero counts (no evidence rules nothing out)", () => {
    expect(wilsonUpperBound(0, 0)).toBe(1);
  });
});

describe("wilsonLowerBound", () => {
  it("returns 0 for zero counts", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it("is strictly less than posterior mean for small samples", () => {
    // Beta(2,2) prior: mean = 0.5, but LB should be < 0.5 due to uncertainty
    const mean = 2 / (2 + 2);
    const lb = wilsonLowerBound(2, 2);
    expect(lb).toBeLessThan(mean);
    expect(lb).toBeGreaterThan(0);
  });

  it("converges toward posterior mean for large samples", () => {
    // With 2000 observations balanced at 50/50, LB should be near 0.5
    const lb = wilsonLowerBound(1000, 1000);
    expect(lb).toBeCloseTo(0.5, 1);
  });

  it("returns near 1 for all successes with large N", () => {
    const lb = wilsonLowerBound(10000, 0);
    expect(lb).toBeGreaterThan(0.99);
  });

  it("handles asymmetric Beta", () => {
    // Beta(3,1): mean = 0.75, LB should be between 0.3 and 0.75
    const lb = wilsonLowerBound(3, 1);
    expect(lb).toBeLessThan(0.75);
    expect(lb).toBeGreaterThan(0.3);
  });

  it("respects custom z-score", () => {
    // Higher z (99% CI) gives a lower lower-bound than default 95% CI
    const lb95 = wilsonLowerBound(5, 5);
    const lb99 = wilsonLowerBound(5, 5, 2.576);
    expect(lb99).toBeLessThan(lb95);
  });

  it("returns value in [0, 1] for extreme inputs", () => {
    // Pathological: all failures
    const lb = wilsonLowerBound(0, 1);
    expect(lb).toBeGreaterThanOrEqual(0);
    expect(lb).toBeLessThanOrEqual(1);
  });
});

describe("WP14.1 — worth is the Beta posterior mean α/(α+β), not success/(success+failure)", () => {
  it("Beta(2,2) prior yields a Wilson lower bound below the 0.3 serving floor (regularised, not 0.5-naive)", () => {
    // A fact with the bare Beta(2,2) prior (no evidence) must NOT pass the
    // serving gate's 0.3 lower-bound floor — proving worth is the regularised
    // posterior, not a raw ratio that would read 0.5 with infinite confidence.
    const lb = wilsonLowerBound(2, 2);
    expect(lb).toBeGreaterThan(0);
    expect(lb).toBeLessThan(0.3);
  });

  it("accumulating successes raises the lower bound monotonically", () => {
    const few = wilsonLowerBound(5, 2);
    const many = wilsonLowerBound(50, 2);
    expect(many).toBeGreaterThan(few);
  });
});
