import { describe, it, expect } from "vitest";
import { passesWorthGate } from "../worth.js";

describe("passesWorthGate (spec §11 serving rule)", () => {
  it("drops a fact with worth <= 0.5", () => {
    expect(passesWorthGate({ primitive: "fact", worth: 0.4, worthLowerBound: 0.5 })).toBe(false);
  });
  it("drops a low-evidence fact whose Wilson bound < 0.3", () => {
    // Default Beta(2,2): worth 0.5, wilsonLowerBound ≈ 0.15
    expect(passesWorthGate({ primitive: "fact", worth: 0.5, worthLowerBound: 0.15 })).toBe(false);
  });
  it("keeps a high-worth, well-evidenced fact", () => {
    expect(passesWorthGate({ primitive: "fact", worth: 0.8, worthLowerBound: 0.45 })).toBe(true);
  });
  it("never filters non-fact primitives", () => {
    expect(passesWorthGate({ primitive: "decision", worth: 0.1 })).toBe(true);
    expect(passesWorthGate({ primitive: "episode" })).toBe(true);
  });
});
