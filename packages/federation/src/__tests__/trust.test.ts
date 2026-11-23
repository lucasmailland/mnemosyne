import { describe, it, expect } from "vitest";
import { TRUST_ANCHORS, baseWeightFor, effectiveWeight } from "../trust.js";

describe("TRUST_ANCHORS", () => {
  it("has 9 entries matching spec §12.2", () => {
    expect(TRUST_ANCHORS.codebase_verified).toBe(100);
    expect(TRUST_ANCHORS.user_stated).toBe(90);
    expect(TRUST_ANCHORS.federation_received).toBe(20);
    expect(Object.keys(TRUST_ANCHORS)).toHaveLength(9);
  });

  it("is frozen — properties cannot be added", () => {
    expect(() => {
      (TRUST_ANCHORS as Record<string, number>)["bogus"] = 999;
    }).toThrow();
  });
});

describe("baseWeightFor", () => {
  it("returns the correct anchor for known attributions", () => {
    expect(baseWeightFor("user_stated")).toBe(90);
    expect(baseWeightFor("agent_inferred")).toBe(40);
  });

  it("defaults to federation_received (20) for unknown attribution", () => {
    expect(baseWeightFor("totally_unknown")).toBe(20);
  });
});

describe("effectiveWeight", () => {
  it("multiplies anchor by local trust weight", () => {
    expect(effectiveWeight("user_stated", 0.5)).toBe(45);
    expect(effectiveWeight("federation_received", 1.0)).toBe(20);
  });
});
