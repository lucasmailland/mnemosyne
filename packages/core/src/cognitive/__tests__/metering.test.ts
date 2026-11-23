/**
 * AB3 — Pure metering math tests.
 * spec §35 "Billing & Usage Metering" lines 4197–4256.
 */
import { describe, it, expect } from "vitest";
import {
  computeUsageStatus,
  crossedThresholds,
  METER_METRICS,
  PLAN_LIMITS,
} from "../metering.js";

describe("METER_METRICS — spec §35 lines 4205–4213", () => {
  it("contains the 7 spec-defined metric types", () => {
    expect(METER_METRICS).toContain("recall");
    expect(METER_METRICS).toContain("write");
    expect(METER_METRICS).toContain("session");
    expect(METER_METRICS).toContain("reasoning_hit");
    expect(METER_METRICS).toContain("embedding");
    expect(METER_METRICS).toContain("storage_gb");
    expect(METER_METRICS).toContain("federation_sync");
    expect(METER_METRICS).toHaveLength(7);
  });
});

describe("computeUsageStatus — spec §35 lines 4220–4252", () => {
  it("returns ok state when usage is below limit", () => {
    const result = computeUsageStatus({ recall: 500 }, PLAN_LIMITS.free);
    expect(result.recall.state).toBe("ok");
    expect(result.recall.pct).toBeCloseTo(50, 0);
  });

  it("returns grace state when usage is between 100–110% (1000–1100 for free)", () => {
    const result = computeUsageStatus({ recall: 1050 }, PLAN_LIMITS.free);
    expect(result.recall.pct).toBeCloseTo(105, 0);
    expect(result.recall.state).toBe("grace");
  });

  it("returns throttle state when usage is >110% (>1100 for free)", () => {
    const result = computeUsageStatus({ recall: 1101 }, PLAN_LIMITS.free);
    expect(result.recall.state).toBe("throttle");
  });
});

describe("crossedThresholds — spec §35 lines 4220–4254", () => {
  it("returns [70] when crossing from 0 to 70%", () => {
    expect(crossedThresholds(0, 70)).toEqual([70]);
  });

  it("returns [70, 90] when crossing from 69 to 91%", () => {
    expect(crossedThresholds(69, 91)).toEqual([70, 90]);
  });

  it("returns [] when not crossing any threshold", () => {
    expect(crossedThresholds(50, 60)).toEqual([]);
  });

  it("returns [70, 90, 100] when crossing from 0 to 100%", () => {
    expect(crossedThresholds(0, 100)).toEqual([70, 90, 100]);
  });
});
