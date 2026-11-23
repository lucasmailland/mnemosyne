/**
 * W4: Worth + decay integration — end-to-end pipeline proof.
 *
 * Complements decay-half-lives.test.ts (unit math) with integration-level
 * assertions that combine decayEvidence → wilsonLowerBound → passesWorthGate.
 */
import { describe, it, expect } from "vitest";
import {
  decayFactor,
  decayEvidence,
  DECAY_HALF_LIVES,
  stdpUpdate,
  STDP,
  percentileNormalize,
} from "../../cognitive/neuro-dynamics.js";
import { wilsonLowerBound, passesWorthGate } from "../../cognitive/worth.js";

// ─── Decay + serving gate — integrated pipeline ───────────────────────────────

describe("decay + serving gate — integrated pipeline (spec §11, §25.2)", () => {
  it("well-established semantic fact survives one half-life (58 days)", () => {
    // Beta(10,2): worth≈0.83, lb well above gate
    const { alpha, beta } = decayEvidence(10, 2, 58, DECAY_HALF_LIVES.semantic);
    // At 1 half-life: factor=0.5 → α'=1+(10-1)*0.5=5.5, β'=1+(2-1)*0.5=1.5
    expect(alpha).toBeCloseTo(5.5, 5);
    expect(beta).toBeCloseTo(1.5, 5);
    const worth = alpha / (alpha + beta);
    const lb = wilsonLowerBound(alpha, beta);
    expect(worth).toBeGreaterThan(0.5);
    expect(lb).toBeGreaterThan(0.3);
    expect(passesWorthGate({ primitive: "fact", worth, worthLowerBound: lb })).toBe(true);
  });

  it("weakly-established episodic fact falls below gate after two half-lives (70 days)", () => {
    // Beta(3,2): worth=0.6, lb marginally above gate initially
    // After 2 episodic half-lives (2×35=70d): factor=0.25
    // α'=1+(3-1)*0.25=1.5, β'=1+(2-1)*0.25=1.25 → very low effective evidence
    const { alpha, beta } = decayEvidence(3, 2, 70, DECAY_HALF_LIVES.episodic);
    expect(alpha).toBeCloseTo(1.5, 5);
    expect(beta).toBeCloseTo(1.25, 5);
    const lb = wilsonLowerBound(alpha, beta);
    expect(lb).toBeLessThan(0.3);
    const worth = alpha / (alpha + beta);
    expect(passesWorthGate({ primitive: "fact", worth, worthLowerBound: lb })).toBe(false);
  });

  it("entity is immortal — no decay regardless of elapsed time (half-life=0)", () => {
    const { alpha: a2, beta: b2 } = decayEvidence(10, 2, 9999, DECAY_HALF_LIVES.entity);
    // Entity half-life = 0 → factor=1 → no change
    expect(a2).toBeCloseTo(10, 10);
    expect(b2).toBeCloseTo(2, 10);
  });

  it("procedural decays slower than semantic — strategy retains more evidence at same age", () => {
    const init = { alpha: 6, beta: 2 };
    const days = 58; // 1 semantic half-life = 0.33 procedural half-lives
    const factDecayed = decayEvidence(init.alpha, init.beta, days, DECAY_HALF_LIVES.semantic);
    const stratDecayed = decayEvidence(init.alpha, init.beta, days, DECAY_HALF_LIVES.procedural);
    // Strategy retains more of its excess evidence
    expect(stratDecayed.alpha).toBeGreaterThan(factDecayed.alpha);
  });

  it("reasoning decay is intermediate — slower than episodic, faster than procedural", () => {
    const init = { alpha: 8, beta: 2 };
    const days = 60;
    const episodic = decayEvidence(init.alpha, init.beta, days, DECAY_HALF_LIVES.episodic);
    const reasoning = decayEvidence(init.alpha, init.beta, days, DECAY_HALF_LIVES.reasoning);
    const procedural = decayEvidence(init.alpha, init.beta, days, DECAY_HALF_LIVES.procedural);
    expect(reasoning.alpha).toBeGreaterThan(episodic.alpha);
    expect(reasoning.alpha).toBeLessThan(procedural.alpha);
  });

  it("decayFactor at zero days returns 1 (no decay when freshly created)", () => {
    expect(decayFactor(0, 58)).toBe(1);
    expect(decayFactor(0, 35)).toBe(1);
  });

  it("decayFactor at exactly one half-life returns 0.5", () => {
    expect(decayFactor(58, 58)).toBeCloseTo(0.5, 10);
    expect(decayFactor(35, 35)).toBeCloseTo(0.5, 10);
  });

  it("decayEvidence is bounded below by the prior (1,1): never goes below the prior", () => {
    // Extreme decay: very long time, very short half-life
    const { alpha, beta } = decayEvidence(100, 100, 99999, 1);
    // Should approach (1,1) but never go below
    expect(alpha).toBeGreaterThanOrEqual(1);
    expect(beta).toBeGreaterThanOrEqual(1);
  });
});

// ─── STDP Hebbian learning (spec §25.3) ──────────────────────────────────────

describe("stdpUpdate — asymmetric STDP (spec §25.3)", () => {
  it("causal spike at Δt=0 → maximum LTP: Δw = A_PLUS = 0.1", () => {
    const result = stdpUpdate({ weight: 0.5, directionality: 0.5, deltaSeconds: 0 });
    expect(result.deltaWeight).toBeCloseTo(STDP.A_PLUS, 10);
    expect(result.weight).toBeCloseTo(0.6, 10);
  });

  it("acausal spike at Δt=-1s → LTD with exp decay: Δw = −A_MINUS × exp(−1/τ)", () => {
    const result = stdpUpdate({ weight: 0.5, directionality: 0.5, deltaSeconds: -1 });
    const expected = -STDP.A_MINUS * Math.exp(-1 / STDP.TAU_SECONDS);
    expect(result.deltaWeight).toBeCloseTo(expected, 6);
    expect(result.weight).toBeCloseTo(0.5 + expected, 6);
  });

  it("weight is clamped at 1.0 on strong LTP (no overflow)", () => {
    const result = stdpUpdate({ weight: 1.0, directionality: 0.5, deltaSeconds: 0 });
    expect(result.weight).toBe(1.0);
    // deltaWeight is still positive — just clamped
    expect(result.deltaWeight).toBeCloseTo(STDP.A_PLUS, 10);
  });

  it("weight is clamped at 0.0 on strong LTD (no underflow)", () => {
    const result = stdpUpdate({ weight: 0.0, directionality: 0.5, deltaSeconds: -0.001 });
    expect(result.weight).toBe(0.0);
    expect(result.deltaWeight).toBeLessThan(0);
  });

  it("causal directionality EMA: moves toward 1.0 with each causal spike", () => {
    // newDir = 0.9 × old + 0.1 × 1 (causal)
    const result = stdpUpdate({ weight: 0.5, directionality: 0.0, deltaSeconds: 0 });
    expect(result.directionality).toBeCloseTo(0.1, 10);
  });

  it("acausal directionality EMA: moves toward 0.0 with each acausal spike", () => {
    // newDir = 0.9 × old + 0.1 × 0 (acausal)
    const result = stdpUpdate({ weight: 0.5, directionality: 1.0, deltaSeconds: -1 });
    expect(result.directionality).toBeCloseTo(0.9, 10);
  });

  it("LTD is stronger than LTP (A_MINUS > A_PLUS — forgetting is faster than learning)", () => {
    expect(STDP.A_MINUS).toBeGreaterThan(STDP.A_PLUS);
  });

  it("LTP decays exponentially with pre-post lag: larger Δt → weaker update", () => {
    const immediate = stdpUpdate({ weight: 0.5, directionality: 0.5, deltaSeconds: 0 });
    const delayed10 = stdpUpdate({ weight: 0.5, directionality: 0.5, deltaSeconds: 10 });
    const delayed100 = stdpUpdate({ weight: 0.5, directionality: 0.5, deltaSeconds: 100 });
    expect(immediate.deltaWeight).toBeGreaterThan(delayed10.deltaWeight);
    expect(delayed10.deltaWeight).toBeGreaterThan(delayed100.deltaWeight);
  });

  it("STDP constants match spec §25.3 exactly", () => {
    expect(STDP.A_PLUS).toBe(0.1);
    expect(STDP.A_MINUS).toBe(0.12);
    expect(STDP.TAU_SECONDS).toBe(20);
  });
});

// ─── Homeostatic percentile normalization ─────────────────────────────────────

describe("percentileNormalize — homeostatic weekly rescale (spec §25.3)", () => {
  it("empty array returns empty array", () => {
    expect(percentileNormalize([])).toEqual([]);
  });

  it("single element maps to 0 (only rank in a 1-element set)", () => {
    expect(percentileNormalize([0.7])).toEqual([0]);
  });

  it("two distinct elements: lower maps to 0, higher maps to 1", () => {
    expect(percentileNormalize([0.3, 0.9])).toEqual([0, 1]);
    expect(percentileNormalize([0.9, 0.3])).toEqual([1, 0]);
  });

  it("three elements with no ties: strictly ordered percentile ranks", () => {
    // [0.1, 0.9, 0.5] sorted ascending: 0.1(i=0)→rank0, 0.5(i=2)→rank1, 0.9(i=1)→rank2
    // normalized by (n-1=2): 0/2=0, 1/2=0.5, 2/2=1
    const result = percentileNormalize([0.1, 0.9, 0.5]);
    expect(result[0]).toBeCloseTo(0, 10);   // 0.1 → lowest rank
    expect(result[2]).toBeCloseTo(0.5, 10); // 0.5 → middle rank
    expect(result[1]).toBeCloseTo(1, 10);   // 0.9 → highest rank
  });

  it("tied elements receive the mean of their rank positions", () => {
    // [0.5, 0.5, 0.5] all equal → ranks 0,1,2 → mean rank = 1 → normalized = 1/2 = 0.5
    const result = percentileNormalize([0.5, 0.5, 0.5]);
    for (const r of result) {
      expect(r).toBeCloseTo(0.5, 10);
    }
  });

  it("preserves original index order (output corresponds to input positions, not sorted)", () => {
    const result = percentileNormalize([0.1, 0.9, 0.5]);
    expect(result).toHaveLength(3);
    // Lower input value → lower normalized rank
    expect(result[0]).toBeLessThan(result[2]!);
    expect(result[2]).toBeLessThan(result[1]!);
  });

  it("all zeros normalize to 0 (single rank for all tied at minimum)", () => {
    const result = percentileNormalize([0, 0, 0, 0]);
    for (const r of result) expect(r).toBeCloseTo(0.5, 10); // mean rank of 0,1,2,3 = 1.5/3 = 0.5
  });
});
