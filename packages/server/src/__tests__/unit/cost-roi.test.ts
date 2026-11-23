import { describe, it, expect } from "vitest";
import { computeRoiMultiplier } from "../../metrics/cost.js";

describe("computeRoiMultiplier", () => {
  it("ROI = saved$ / spent$", () => {
    expect(computeRoiMultiplier({ tokensSavedUsd: 3, llmCostUsd: 1 })).toBe(3);
  });
  it("returns 0 when there is no spend (no claim without denominator)", () => {
    expect(computeRoiMultiplier({ tokensSavedUsd: 0, llmCostUsd: 0 })).toBe(0);
    expect(computeRoiMultiplier({ tokensSavedUsd: 5, llmCostUsd: 0 })).toBe(0);
  });
});
