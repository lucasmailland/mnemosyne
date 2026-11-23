/**
 * RDD-5 — Cold-start learning mode: workspace operational mode logic.
 *
 * In learning mode, worthUpdates is DISABLED (spec: worthUpdatesDisabled=true).
 * Graduation happens when ANY of 4 criteria is met (factCount/sessionCount/entityCount/daysElapsed).
 */
import { describe, it, expect } from "vitest";
import {
  shouldGraduate,
  shouldAutoPromote,
  isLearningMode,
  gatesFor,
  GRADUATION,
  type WorkspaceModeRecord,
} from "../learningMode.js";

function mode(
  m: "learning" | "production",
  sessionCount: number,
  promoteAt: number | null = null,
  overrides: Partial<WorkspaceModeRecord> = {},
): WorkspaceModeRecord {
  return { workspaceId: "ws-1", mode: m, sessionCount, promoteAt, ...overrides };
}

describe("isLearningMode — cold-start detection", () => {
  it("returns true for learning mode", () => {
    expect(isLearningMode(mode("learning", 5))).toBe(true);
  });

  it("returns false for production mode", () => {
    expect(isLearningMode(mode("production", 100))).toBe(false);
  });

  it("returns true when record is null (default: new workspaces start in learning mode)", () => {
    expect(isLearningMode(null)).toBe(true);
  });
});

describe("gatesFor — subsystem gates", () => {
  it("RDD-5: worthUpdates is FALSE in learning mode (spec: worthUpdatesDisabled)", () => {
    const gates = gatesFor(mode("learning", 5));
    expect(gates.worthUpdates).toBe(false);
  });

  it("RDD-5: worthUpdates is TRUE in production mode", () => {
    const gates = gatesFor(mode("production", 100));
    expect(gates.worthUpdates).toBe(true);
  });

  it("hotTier, anticipation, composition, consolidation disabled in learning mode", () => {
    const gates = gatesFor(mode("learning", 5));
    expect(gates.hotTier).toBe(false);
    expect(gates.anticipation).toBe(false);
    expect(gates.composition).toBe(false);
    expect(gates.consolidation).toBe(false);
  });

  it("extractionAggressive is TRUE in learning mode", () => {
    const gates = gatesFor(mode("learning", 5));
    expect(gates.extractionAggressive).toBe(true);
  });

  it("extractionAggressive is FALSE in production mode", () => {
    const gates = gatesFor(mode("production", 100));
    expect(gates.extractionAggressive).toBe(false);
  });

  it("returns safe learning-mode gates for null record", () => {
    const gates = gatesFor(null);
    expect(gates.worthUpdates).toBe(false);
    expect(gates.extractionAggressive).toBe(true);
  });
});

describe("shouldGraduate — multi-criteria graduation (RDD-5)", () => {
  it("returns false when already in production mode", () => {
    expect(shouldGraduate(mode("production", 50))).toBe(false);
  });

  it("graduates on factCount >= 50 even at sessionCount=0", () => {
    expect(shouldGraduate(mode("learning", 0, null, { factCount: 50 }))).toBe(true);
  });

  it("graduates on sessionCount >= 10 (spec default)", () => {
    expect(shouldGraduate(mode("learning", 10))).toBe(true);
    expect(shouldGraduate(mode("learning", 9))).toBe(false);
  });

  it("graduates on sessionCount >= custom promoteAt", () => {
    expect(shouldGraduate(mode("learning", 5, 5))).toBe(true);
  });

  it("graduates on entityCount >= 5", () => {
    expect(shouldGraduate(mode("learning", 0, null, { entityCount: 5 }))).toBe(true);
    expect(shouldGraduate(mode("learning", 0, null, { entityCount: 4 }))).toBe(false);
  });

  it("graduates on daysElapsed >= 14", () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000); // determinism-ok: self-consistent relative to production Date.now() call inside shouldGraduate
    expect(shouldGraduate(mode("learning", 0, null, { startedAt: fifteenDaysAgo }))).toBe(true);
  });

  it("does NOT graduate before any criterion is met", () => {
    const recentDate = new Date(Date.now() - 2 * 86_400_000); // determinism-ok: self-consistent relative to production Date.now() call inside shouldGraduate
    const rec = mode("learning", 2, null, { factCount: 10, entityCount: 1, startedAt: recentDate });
    expect(shouldGraduate(rec)).toBe(false);
  });

  it("GRADUATION constants match spec values", () => {
    expect(GRADUATION.factCount).toBe(50);
    expect(GRADUATION.sessionCount).toBe(10);
    expect(GRADUATION.entityCount).toBe(5);
    expect(GRADUATION.daysElapsed).toBe(14);
  });
});

describe("shouldAutoPromote — legacy backward-compat", () => {
  it("returns false when promoteAt is null (manual promotion only)", () => {
    expect(shouldAutoPromote(mode("learning", 50, null))).toBe(false);
  });

  it("returns false when sessionCount < promoteAt", () => {
    expect(shouldAutoPromote(mode("learning", 9, 10))).toBe(false);
  });

  it("returns true when sessionCount >= promoteAt", () => {
    expect(shouldAutoPromote(mode("learning", 10, 10))).toBe(true);
    expect(shouldAutoPromote(mode("learning", 15, 10))).toBe(true);
  });

  it("returns false if already in production mode", () => {
    expect(shouldAutoPromote(mode("production", 50, 10))).toBe(false);
  });
});
