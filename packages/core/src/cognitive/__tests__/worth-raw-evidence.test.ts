import { describe, expect, it } from "vitest";
import type { MnemoFact } from "@mnemo-ai/types";
import { passesWorthGate, worthGateLowerBound } from "../worth.js";
import { viewFact } from "../recall-cold.js";

// Ruling 1 (follow-up of PR #258): decay relaxes worth_alpha/worth_beta toward
// (1,1). It keeps the mean on its side of 0.5 but erodes the Wilson lower bound
// computed from them, so every fact judged useful long ago became unservable.
// The gate's lower bound is Wilson(2 + worth_success, 2 + worth_failure): the
// raw evidence, which decay does not touch. The decayed mean still has to
// exceed 0.5.
const usefulDecayed = {
  worth: 1.3 / (1.3 + 1.03),
  worthAlpha: 1.3,
  worthBeta: 1.03,
  worthSuccess: 20,
  worthFailure: 2,
};
const uselessDecayed = {
  worth: 1.03 / (1.3 + 1.03),
  worthAlpha: 1.03,
  worthBeta: 1.3,
  worthSuccess: 2,
  worthFailure: 20,
};

function gate(f: typeof usefulDecayed): boolean {
  const view = viewFact(f as unknown as MnemoFact);
  return passesWorthGate(
    { primitive: "fact", worth: view.worth, worthLowerBound: view.worthLowerBound },
    view.isUntested
  );
}

describe("worth gate lower bound from raw evidence", () => {
  it("serves a fact judged useful 20/2 whose alpha/beta decayed to (1.3, 1.03)", () => {
    expect(worthGateLowerBound(usefulDecayed)).toBeGreaterThanOrEqual(0.3);
    expect(gate(usefulDecayed)).toBe(true);
  });

  it("does not serve a fact judged useless 2/20", () => {
    expect(worthGateLowerBound(uselessDecayed)).toBeLessThan(0.3);
    expect(gate(uselessDecayed)).toBe(false);
  });

  it("still requires the decayed mean above 0.5", () => {
    // Strong positive evidence, but the posterior mean sits below 0.5.
    expect(gate({ ...usefulDecayed, worth: 0.49, worthAlpha: 1.0, worthBeta: 1.04 })).toBe(false);
  });

  it("falls back to alpha/beta when the counters are absent", () => {
    expect(worthGateLowerBound({ worthAlpha: 1.3, worthBeta: 1.03 })).toBeLessThan(0.3);
  });
});
