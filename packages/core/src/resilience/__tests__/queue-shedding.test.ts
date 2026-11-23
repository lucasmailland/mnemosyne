import { describe, it, expect } from "vitest";
import {
  JOB_PRIORITY,
  priorityOf,
  decideShed,
  isPaused,
  type ShedState,
} from "../queue-shedding.js";

const fresh: ShedState = { stage: 0, paused: new Set() };

describe("§34.8 queue priority map", () => {
  it("maps the four named tiers", () => {
    expect(JOB_PRIORITY.critical).toBe(1);
    expect(JOB_PRIORITY.low).toBe(4);
    expect(priorityOf("session.collapse")).toBe(1);
    expect(priorityOf("embed.fact")).toBe(2);
    expect(priorityOf("consolidation")).toBe(3);
    expect(priorityOf("anticipate.mine")).toBe(4);
    expect(priorityOf("scoped_semantic_conflict_check")).toBe(4);
    expect(priorityOf("unknown.job")).toBe(3);
  });
});

describe("§34.8 3-stage shedding with hysteresis", () => {
  it("stage 0 below 70% pauses nothing", () => {
    const s = decideShed(0.5, fresh);
    expect(s.stage).toBe(0);
    expect(s.paused.size).toBe(0);
  });
  it("stage 1 at 70% pauses low (4)", () => {
    expect([...decideShed(0.71, fresh).paused]).toEqual([4]);
  });
  it("stage 2 at 85% pauses medium+low (3,4)", () => {
    expect([...decideShed(0.86, fresh).paused].sort()).toEqual([3, 4]);
  });
  it("stage 3 at 95% pauses all non-critical (2,3,4)", () => {
    expect([...decideShed(0.96, fresh).paused].sort()).toEqual([2, 3, 4]);
  });
  it("recovery hysteresis: stage 1 stays until util < 60%", () => {
    const atStage1: ShedState = { stage: 1, paused: new Set([4]) };
    expect(decideShed(0.65, atStage1).stage).toBe(1);
    expect(decideShed(0.59, atStage1).stage).toBe(0);
  });
  it("isPaused gates a priority against the state", () => {
    const s2 = decideShed(0.86, fresh);
    expect(isPaused(s2, JOB_PRIORITY.critical)).toBe(false);
    expect(isPaused(s2, JOB_PRIORITY.medium)).toBe(true);
  });
});
