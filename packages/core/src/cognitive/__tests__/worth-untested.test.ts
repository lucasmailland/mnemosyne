import { describe, expect, it } from "vitest";
import type { MnemoFact } from "@mnemo-ai/types";
import { isUntestedWorth, passesWorthGate, wilsonLowerBound } from "../worth.js";
import { viewFact } from "../recall-cold.js";

// Production, 2026-11-19: the decay job relaxes worth_alpha/worth_beta toward
// (1,1) as facts age. An unjudged fact decayed from (2,2) to (1.9988, 1.9988)
// stopped counting as untested under an exact `=== 2` check, kept worth 0.5,
// failed `worth > 0.5` and disappeared from recall — 764 of 849 active facts.
describe("isUntestedWorth", () => {
  it("is true for an unjudged fact whose prior was decayed", () => {
    expect(
      isUntestedWorth({ worthSuccess: 0, worthFailure: 0, worthAlpha: 1.9988, worthBeta: 1.9988 })
    ).toBe(true);
  });

  it("is false once the fact has been judged either way", () => {
    expect(isUntestedWorth({ worthSuccess: 0, worthFailure: 3, worthAlpha: 2, worthBeta: 5 })).toBe(
      false
    );
    expect(isUntestedWorth({ worthSuccess: 1, worthFailure: 0, worthAlpha: 3, worthBeta: 2 })).toBe(
      false
    );
  });

  it("falls back to the (2,2) prior when the counters are absent", () => {
    expect(isUntestedWorth({ worthAlpha: 2, worthBeta: 2 })).toBe(true);
    expect(isUntestedWorth({ worthAlpha: 1.9988, worthBeta: 1.9988 })).toBe(false);
    expect(isUntestedWorth({})).toBe(true);
  });
});

describe("cold recall worth gate on a decayed, unjudged fact", () => {
  const decayed = {
    worth: 0.5,
    worthAlpha: 1.9988,
    worthBeta: 1.9988,
    worthSuccess: 0,
    worthFailure: 0,
  };

  it("lets the decayed unjudged fact through", () => {
    const view = viewFact(decayed as unknown as MnemoFact);
    expect(view.isUntested).toBe(true);
    expect(
      passesWorthGate(
        { primitive: "fact", worth: view.worth, worthLowerBound: view.worthLowerBound },
        view.isUntested
      )
    ).toBe(true);
  });

  it("still drops a fact judged unhelpful", () => {
    const judged = { worth: 2 / 7, worthAlpha: 2, worthBeta: 5, worthSuccess: 0, worthFailure: 3 };
    const view = viewFact(judged as unknown as MnemoFact);
    expect(view.isUntested).toBe(false);
    expect(
      passesWorthGate(
        { primitive: "fact", worth: view.worth, worthLowerBound: wilsonLowerBound(2, 5) },
        view.isUntested
      )
    ).toBe(false);
  });
});
