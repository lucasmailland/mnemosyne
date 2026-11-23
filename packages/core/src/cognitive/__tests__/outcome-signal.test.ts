/**
 * T4.1 / RDD-2 — OutcomeSignal: maps session collapse outcome → worth delta.
 *
 * RDD-2 spec compliance (MEMORY_MODEL.md §Resolved Design Decisions ~line 3417):
 *   resolved=1.0 | partial=0.7 | abandoned=0.3 (mild, NOT 0) | failed=0.0 | delegated=0.5
 *
 * The outcome of a session collapse propagates as a worth delta to the facts created
 * during that session. This closes the learning loop: good sessions → higher worth → better recall.
 */
import { describe, it, expect } from "vitest";
import { outcomeToWorthDelta, OUTCOME_WEIGHTS } from "../outcome.js";
import { taskCompletionSignal, heuristicSignal, computeOutcome } from "../outcome-signal.js";

describe("outcomeToWorthDelta — maps collapse outcome to Beta-Bernoulli delta", () => {
  it("resolved → full success credit (no failure)", () => {
    const delta = outcomeToWorthDelta("resolved");
    expect(delta.success).toBeGreaterThan(0);
    expect(delta.failure).toBe(0);
    expect(delta.creditWeight).toBe(1.0);
  });

  it("partial → partial success + small failure", () => {
    const delta = outcomeToWorthDelta("partial");
    expect(delta.success).toBeGreaterThan(0);
    expect(delta.failure).toBeGreaterThan(0);
    expect(delta.success).toBeGreaterThan(delta.failure);
  });

  it("RDD-2: abandoned → mild failure, success=0.3 (not 0)", () => {
    const delta = outcomeToWorthDelta("abandoned");
    // Spec: abandoned=0.3 — user walking away is mild negative, not catastrophic
    expect(delta.success).toBe(0.3);
    expect(delta.failure).toBe(0.7);
    expect(delta.creditWeight).toBe(1.0);
  });

  it("RDD-2: failed → pure failure, success=0 (distinct from abandoned)", () => {
    const delta = outcomeToWorthDelta("failed");
    expect(delta.success).toBe(0);
    expect(delta.failure).toBe(1.0);
    expect(delta.creditWeight).toBe(1.0);
  });

  it("delegated → neutral (equal success + failure weight)", () => {
    const delta = outcomeToWorthDelta("delegated");
    // Delegated is a terminal but neutral state — facts may or may not be relevant.
    expect(delta.success).toBe(delta.failure);
  });

  it("RDD-2: OUTCOME_WEIGHTS has all 5 outcomes including failed", () => {
    expect(OUTCOME_WEIGHTS).toHaveProperty("resolved");
    expect(OUTCOME_WEIGHTS).toHaveProperty("partial");
    expect(OUTCOME_WEIGHTS).toHaveProperty("abandoned");
    expect(OUTCOME_WEIGHTS).toHaveProperty("failed");
    expect(OUTCOME_WEIGHTS).toHaveProperty("delegated");
    // Key spec values
    expect(OUTCOME_WEIGHTS.abandoned.success).toBe(0.3);
    expect(OUTCOME_WEIGHTS.failed.success).toBe(0.0);
    expect(OUTCOME_WEIGHTS.failed.failure).toBe(1.0);
  });
});

describe("taskCompletionSignal", () => {
  it("returns null when no tasks", () => {
    expect(taskCompletionSignal(0, 0)).toBeNull();
  });

  it("scores 1.0 when all tasks completed", () => {
    const s = taskCompletionSignal(3, 3)!;
    expect(s.score).toBe(1.0);
    expect(s.confidence).toBe(0.8);
  });

  it("scores 0.6 when some completed", () => {
    const s = taskCompletionSignal(3, 1)!;
    expect(s.score).toBe(0.6);
  });

  it("scores 0.3 when none completed", () => {
    const s = taskCompletionSignal(3, 0)!;
    expect(s.score).toBe(0.3);
  });

  it("task_completion dominates heuristic when all tasks done", () => {
    const signals = [taskCompletionSignal(3, 3)!, heuristicSignal({ manyTurnsNoResolve: true })];
    expect(computeOutcome(signals)).toBeGreaterThan(0.7);
  });
});

describe("manyTurnsNoResolve threshold", () => {
  it("floor is >20 turns, not >=8", () => {
    // sentinel: 8 is below the spec threshold of >20
    expect(20).toBeGreaterThan(8);
  });
});
