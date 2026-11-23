import { describe, it, expect } from "vitest";
import { stdpUpdate, percentileNormalize, STDP } from "../neuro-dynamics.js";

describe("stdpUpdate — spec §25.3 asymmetric window", () => {
  it("max potentiation at Δt=0 (first co-recall)", () => {
    const r = stdpUpdate({ weight: 0.5, directionality: 0.5, deltaSeconds: 0 });
    expect(r.weight).toBeCloseTo(0.5 + STDP.A_PLUS, 6);
    expect(r.directionality).toBeCloseTo(0.9 * 0.5 + 0.1, 6);
  });

  it("potentiates (positive Δw) when A precedes B (Δt > 0)", () => {
    const r = stdpUpdate({ weight: 0.5, directionality: 0.5, deltaSeconds: 5 });
    expect(r.weight).toBeGreaterThan(0.5);
    expect(r.weight).toBeLessThan(0.5 + STDP.A_PLUS);
  });

  it("depresses (negative Δw) when B precedes A (Δt < 0), and harder than it potentiates", () => {
    const up = stdpUpdate({ weight: 0.5, directionality: 0.5, deltaSeconds: 5 });
    const down = stdpUpdate({ weight: 0.5, directionality: 0.5, deltaSeconds: -5 });
    expect(down.weight).toBeLessThan(0.5);
    expect(0.5 - down.weight).toBeGreaterThan(up.weight - 0.5);
  });

  it("clamps weight to [0,1]", () => {
    expect(stdpUpdate({ weight: 0.99, directionality: 0.5, deltaSeconds: 0 }).weight).toBeLessThanOrEqual(1);
    expect(stdpUpdate({ weight: 0.01, directionality: 0.5, deltaSeconds: -1 }).weight).toBeGreaterThanOrEqual(0);
  });

  it("directionality is an EMA toward 1 for causal, 0 for acausal", () => {
    const causal = stdpUpdate({ weight: 0.5, directionality: 0.5, deltaSeconds: 3 });
    const acausal = stdpUpdate({ weight: 0.5, directionality: 0.5, deltaSeconds: -3 });
    expect(causal.directionality).toBeGreaterThan(0.5);
    expect(acausal.directionality).toBeLessThan(0.5);
  });
});

describe("percentileNormalize — homeostatic weekly rescale", () => {
  it("maps sorted weights to evenly spaced percentiles in [0,1]", () => {
    expect(percentileNormalize([5, 1, 3])).toEqual([1, 0, 0.5]);
  });
  it("handles a single weight (no division by zero)", () => {
    expect(percentileNormalize([7])).toEqual([0]);
  });
  it("gives tied weights the same averaged percentile", () => {
    const r = percentileNormalize([2, 2, 8]);
    expect(r[0]).toBeCloseTo(r[1]!, 10);
    expect(r[2]).toBe(1);
  });
  it("returns [] for []", () => {
    expect(percentileNormalize([])).toEqual([]);
  });
});
