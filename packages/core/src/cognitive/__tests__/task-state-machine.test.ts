import { describe, it, expect } from "vitest";
import { TASK_TRANSITIONS, assertValidTransition, isValidTransition } from "../tasks.js";
import { TERMINAL_TASK_STATUSES } from "@mnemo-ai/types";
import type { TaskStatus } from "../tasks.js";

describe("TASK_TRANSITIONS (spec §18 state machine)", () => {
  it("allows the documented happy-path edges", () => {
    expect(isValidTransition("pending", "in_progress")).toBe(true);
    expect(isValidTransition("in_progress", "blocked")).toBe(true);
    expect(isValidTransition("in_progress", "completed")).toBe(true);
    expect(isValidTransition("in_progress", "delegated")).toBe(true);
    expect(isValidTransition("blocked", "in_progress")).toBe(true);
    expect(isValidTransition("delegated", "completed")).toBe(true);
  });

  it("allows cancellation from ANY non-terminal state", () => {
    for (const from of ["pending", "in_progress", "blocked", "delegated"] as const) {
      expect(isValidTransition(from, "cancelled")).toBe(true);
    }
  });

  it("treats completed and cancelled as terminal", () => {
    expect(TASK_TRANSITIONS.completed).toEqual([]);
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
    expect(isValidTransition("completed", "in_progress")).toBe(false);
    expect(isValidTransition("cancelled", "pending")).toBe(false);
  });

  it("F25: 'Any state → cancelled' means any NON-terminal state — terminal stays terminal", () => {
    // Non-terminal → cancelled is allowed (already covered above) ...
    for (const from of ["pending", "in_progress", "blocked", "delegated"] as const) {
      expect(isValidTransition(from, "cancelled")).toBe(true);
    }
    // ... but a completed task may NOT be cancelled (cannot un-complete) and an
    // already-cancelled task may not be re-cancelled to a non-terminal state.
    expect(isValidTransition("completed", "cancelled")).toBe(false);
    expect(isValidTransition("cancelled", "in_progress")).toBe(false);
  });

  it("allows a same-state no-op (idempotent PATCH)", () => {
    expect(isValidTransition("in_progress", "in_progress")).toBe(true);
  });

  it("rejects illegal jumps", () => {
    expect(isValidTransition("pending", "completed")).toBe(false);
    expect(isValidTransition("blocked", "completed")).toBe(false);
    expect(isValidTransition("pending", "delegated")).toBe(false);
  });

  it("assertValidTransition throws a typed error on an illegal edge", () => {
    expect(() => assertValidTransition("pending", "completed")).toThrowError(/pending.*completed/);
    expect(() => assertValidTransition("in_progress", "completed")).not.toThrow();
  });

  it("B7: TERMINAL_TASK_STATUSES equals exactly the statuses whose TASK_TRANSITIONS entry is empty", () => {
    const derivedTerminalStatuses = (Object.keys(TASK_TRANSITIONS) as TaskStatus[])
      .filter((status) => TASK_TRANSITIONS[status].length === 0)
      .sort();
    expect([...TERMINAL_TASK_STATUSES].sort()).toEqual(derivedTerminalStatuses);
  });
});
