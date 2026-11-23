import { describe, it, expect } from "vitest";
import { extractionBiasHint } from "../knowledge-scheduler.js";

describe("extractionBiasHint", () => {
  it("returns empty string when distribution matches target proportions", () => {
    // Distribution at DEFAULT_TARGET proportions → no type is under-represented
    const hint = extractionBiasHint({
      fact: 30,
      decision: 15,
      strategy: 15,
      workflow: 10,
      skill: 5,
      episode: 10,
      entity: 5,
      task: 5,
      event: 3,
      reasoning: 2,
      hyperedge: 0,
    });
    expect(hint).toBe("");
  });

  it("mentions under-represented types in the hint", () => {
    // fact-heavy: strategy and workflow are at 0 → both are under-represented
    const hint = extractionBiasHint({ fact: 100, strategy: 0, workflow: 0 });
    expect(hint.length).toBeGreaterThan(0);
    // Must contain at least one of the under-represented type names
    const mentionsUnder = hint.includes("strategy") || hint.includes("workflow");
    expect(mentionsUnder).toBe(true);
  });

  it("returns empty string when distribution is empty", () => {
    const hint = extractionBiasHint({});
    expect(hint).toBe("");
  });

  it("includes the KNOWLEDGE-TYPE BIAS marker when skewed", () => {
    const hint = extractionBiasHint({ fact: 1000, decision: 0 });
    // All other types are at 0 → several types are under-represented
    expect(hint).toContain("KNOWLEDGE-TYPE BIAS");
  });

});

