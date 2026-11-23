import { describe, it, expect } from "vitest";
import {
  DECAY_HALF_LIVES,
  decayClassForKind,
  decayFactor,
  decayEvidence,
} from "../neuro-dynamics.js";

describe("DECAY_HALF_LIVES — spec §25.2", () => {
  it("matches the spec table exactly (days)", () => {
    expect(DECAY_HALF_LIVES).toEqual({
      procedural: 173,
      semantic: 58,
      episodic: 35,
      entity: 0,
      reasoning: 90,
    });
  });

  it("maps every PrimitiveKind to a decay class", () => {
    expect(decayClassForKind("strategy")).toBe("procedural");
    expect(decayClassForKind("workflow")).toBe("procedural");
    expect(decayClassForKind("skill")).toBe("procedural");
    expect(decayClassForKind("fact")).toBe("semantic");
    expect(decayClassForKind("decision")).toBe("semantic");
    expect(decayClassForKind("episode")).toBe("episodic");
    expect(decayClassForKind("event")).toBe("episodic");
    expect(decayClassForKind("entity")).toBe("entity");
    expect(decayClassForKind("reasoning")).toBe("reasoning");
  });
});

describe("decayFactor — exponential half-life", () => {
  it("is 1.0 at Δd=0", () => {
    expect(decayFactor(0, 58)).toBeCloseTo(1, 10);
  });
  it("is 0.5 at exactly one half-life", () => {
    expect(decayFactor(58, 58)).toBeCloseTo(0.5, 10);
  });
  it("is 0.25 at two half-lives", () => {
    expect(decayFactor(116, 58)).toBeCloseTo(0.25, 10);
  });
  it("never decays when half-life is 0 (entity)", () => {
    expect(decayFactor(9999, 0)).toBe(1);
  });
});

describe("decayEvidence — Beta evidence reverts toward the prior", () => {
  it("leaves evidence untouched at Δd=0", () => {
    expect(decayEvidence(10, 4, 0, 58)).toEqual({ alpha: 10, beta: 4 });
  });
  it("pulls excess-over-prior halfway at one half-life", () => {
    const r = decayEvidence(10, 4, 58, 58);
    expect(r.alpha).toBeCloseTo(5.5, 6);
    expect(r.beta).toBeCloseTo(2.5, 6);
  });
  it("never pushes evidence below the prior (1,1)", () => {
    const r = decayEvidence(1, 1, 1000, 35);
    expect(r.alpha).toBeGreaterThanOrEqual(1);
    expect(r.beta).toBeGreaterThanOrEqual(1);
  });
  it("entity (half-life 0) is a no-op", () => {
    expect(decayEvidence(10, 4, 1000, 0)).toEqual({ alpha: 10, beta: 4 });
  });
});
