import { describe, it, expect, beforeEach } from "vitest";
import {
  setAnticipationAccuracy,
  getAnticipationAccuracy,
  getMetricsSnapshot,
} from "../../metrics.js";

const WS = "ws-anticipation-1";

describe("anticipation accuracy gauge (F1 — non-zero round-trip)", () => {
  beforeEach(() => {
    // Reset by overwriting to a known state; the gauge map is module-global.
    setAnticipationAccuracy(WS, 0);
  });

  it("stores and reads back a real non-zero fraction", () => {
    setAnticipationAccuracy(WS, 0.5);
    expect(getAnticipationAccuracy(WS)).toBe(0.5);
    expect(getMetricsSnapshot().anticipation_accuracy_by_workspace[WS]).toBe(0.5);
  });

  it("clamps out-of-range inputs into [0,1]", () => {
    setAnticipationAccuracy(WS, 1.7);
    expect(getAnticipationAccuracy(WS)).toBe(1);
    setAnticipationAccuracy(WS, -0.3);
    // stored as 0; getAnticipationAccuracy reports null for 0 by design (metrics.ts:39).
    expect(getAnticipationAccuracy(WS)).toBeNull();
  });

  it("reports null (no measurement) for a genuine 0 accuracy", () => {
    setAnticipationAccuracy(WS, 0);
    expect(getAnticipationAccuracy(WS)).toBeNull();
    // ...but the raw snapshot still carries the 0 for Prometheus/debug visibility.
    expect(getMetricsSnapshot().anticipation_accuracy_by_workspace[WS]).toBe(0);
  });
});
