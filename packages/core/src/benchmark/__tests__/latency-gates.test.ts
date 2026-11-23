import { describe, it, expect } from "vitest";
import { V3_LATENCY_TARGETS_MS, evaluateLatencyGate } from "../quality-gates.js";

describe("evaluateLatencyGate", () => {
  it("passes when all tiers within budget", () => {
    const r = evaluateLatencyGate({ hot: 4.2, warm: 12, cold: 180, write: 25 }, V3_LATENCY_TARGETS_MS);
    expect(r.passed).toBe(true);
    expect(r.failures).toHaveLength(0);
  });
  it("fails and names the breaching tier", () => {
    const r = evaluateLatencyGate({ hot: 6, warm: 12, cold: 180, write: 25 }, V3_LATENCY_TARGETS_MS);
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => /hot/.test(f))).toBe(true);
  });
  it("exposes the spec budgets", () => {
    expect(V3_LATENCY_TARGETS_MS).toEqual({ hot: 5, warm: 15, cold: 200, write: 30 });
  });
});
