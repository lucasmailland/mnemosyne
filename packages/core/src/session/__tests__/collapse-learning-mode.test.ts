/**
 * RDD-5 — Verify worth updates are frozen during learning mode.
 *
 * This test ensures that the collapse logic respects the worthUpdates gate
 * and does NOT propagate worth deltas when the workspace is in learning mode.
 *
 * Note: This is a lightweight unit test that verifies the gate logic, not an
 * integration test. Full integration tests would run against a real adapter.
 */
import { describe, it, expect } from "vitest";
import { gatesFor, isLearningMode } from "../../cognitive/learningMode.js";
import type { WorkspaceModeRecord } from "../../cognitive/learningMode.js";

describe("collapse: learning mode worth freeze (RDD-5)", () => {
  it("worthUpdates gate is FALSE in learning mode", () => {
    const learningMode: WorkspaceModeRecord = {
      workspaceId: "ws-1",
      mode: "learning",
      sessionCount: 5,
      promoteAt: 10,
      factCount: 20,
      entityCount: 2,
    };

    expect(isLearningMode(learningMode)).toBe(true);

    const gates = gatesFor(learningMode);
    expect(gates.worthUpdates).toBe(false);
  });

  it("worthUpdates gate is TRUE in production mode", () => {
    const productionMode: WorkspaceModeRecord = {
      workspaceId: "ws-1",
      mode: "production",
      sessionCount: 50,
      promoteAt: 10,
      factCount: 200,
      entityCount: 15,
    };

    expect(isLearningMode(productionMode)).toBe(false);

    const gates = gatesFor(productionMode);
    expect(gates.worthUpdates).toBe(true);
  });

  it("worthUpdates gate defaults to FALSE for null record (new workspace)", () => {
    expect(isLearningMode(null)).toBe(true);

    const gates = gatesFor(null);
    expect(gates.worthUpdates).toBe(false);
  });

  it("all 5 subsystems are disabled in learning mode", () => {
    const learningMode: WorkspaceModeRecord = {
      workspaceId: "ws-1",
      mode: "learning",
      sessionCount: 2,
      promoteAt: 10,
      factCount: 10,
      entityCount: 1,
    };

    const gates = gatesFor(learningMode);

    // RDD-5: these 5 subsystems must be disabled in learning mode
    expect(gates.hotTier).toBe(false);
    expect(gates.anticipation).toBe(false);
    expect(gates.composition).toBe(false);
    expect(gates.worthUpdates).toBe(false);
    expect(gates.consolidation).toBe(false);

    // extractionAggressive is enabled to gather more signal
    expect(gates.extractionAggressive).toBe(true);
  });

  it("all subsystems are enabled in production mode", () => {
    const productionMode: WorkspaceModeRecord = {
      workspaceId: "ws-1",
      mode: "production",
      sessionCount: 50,
      promoteAt: 10,
      factCount: 200,
      entityCount: 15,
    };

    const gates = gatesFor(productionMode);

    // All 5 subsystems enabled in production
    expect(gates.hotTier).toBe(true);
    expect(gates.anticipation).toBe(true);
    expect(gates.composition).toBe(true);
    expect(gates.worthUpdates).toBe(true);
    expect(gates.consolidation).toBe(true);

    // extractionAggressive is disabled (normal prefilter)
    expect(gates.extractionAggressive).toBe(false);
  });
});
