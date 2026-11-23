import { describe, it, expect } from "vitest";
import { hybridRecallWeights } from "../embedMigration.js";

describe("WP14.7 — hybridRecallWeights (spec §36 lines 4642-4643)", () => {
  it("returns normal weights (fts 0.4 / vector 0.6) when migration is NOT active", () => {
    expect(hybridRecallWeights(false)).toEqual({ fts: 0.4, vector: 0.6 });
  });

  it("returns migration weights (fts 0.7 / vector 0.3) when migration IS active", () => {
    expect(hybridRecallWeights(true)).toEqual({ fts: 0.7, vector: 0.3 });
  });

  it("weights always sum to 1.0 in both modes", () => {
    for (const active of [true, false]) {
      const w = hybridRecallWeights(active);
      expect(w.fts + w.vector).toBeCloseTo(1.0, 10);
    }
  });
});
