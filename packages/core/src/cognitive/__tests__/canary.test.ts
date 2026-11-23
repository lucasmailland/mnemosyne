/**
 * AB4 — Canary deploy decision function tests.
 * spec §35 lines 4443–4472 + "Canary Deployment Strategy" 2086–2110.
 */
import { describe, it, expect } from "vitest";
import { evaluateCanary, DEFAULT_CANARY_CONFIG } from "../canary.js";

describe("evaluateCanary — spec §35 lines 2086–2110", () => {
  it("promotes when canary error rate is better than baseline", () => {
    const result = evaluateCanary(
      { errorRate: 0.01, p99: 200 },
      { errorRate: 0.005, p99: 220 },
      DEFAULT_CANARY_CONFIG,
    );
    expect(result).toBe("promote");
  });

  it("rolls back when error rate delta exceeds 1% threshold", () => {
    const result = evaluateCanary(
      { errorRate: 0.01, p99: 200 },
      { errorRate: 0.03, p99: 200 },
      DEFAULT_CANARY_CONFIG,
    );
    expect(result).toBe("rollback");
  });

  it("rolls back when p99 latency delta exceeds 100ms threshold", () => {
    const result = evaluateCanary(
      { errorRate: 0.01, p99: 200 },
      { errorRate: 0.01, p99: 320 },
      DEFAULT_CANARY_CONFIG,
    );
    expect(result).toBe("rollback");
  });

  it("holds when no canary data available (undefined metrics)", () => {
    const result = evaluateCanary(null, null, DEFAULT_CANARY_CONFIG);
    expect(result).toBe("hold");
  });

  it("DEFAULT_CANARY_CONFIG has the correct promotion steps", () => {
    expect(DEFAULT_CANARY_CONFIG.promotionSteps).toEqual([5, 25, 50, 100]);
  });

  it("DEFAULT_CANARY_CONFIG has correct error rate and p99 deltas", () => {
    expect(DEFAULT_CANARY_CONFIG.errorRateDelta).toBe(0.01);
    expect(DEFAULT_CANARY_CONFIG.p99LatencyDelta).toBe(100);
  });
});
