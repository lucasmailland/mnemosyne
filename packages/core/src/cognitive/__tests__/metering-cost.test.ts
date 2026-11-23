import { describe, it, expect } from "vitest";
import { METER_UNIT_COST_USD, meterEventCostUsd, METER_METRICS } from "../metering.js";
import type { MeterEvent } from "../metering.js";

describe("meter cost math (pure, §35)", () => {
  it("defines a unit cost for every metric in METER_METRICS", () => {
    for (const metric of METER_METRICS) {
      expect(typeof METER_UNIT_COST_USD[metric]).toBe("number");
      expect(METER_UNIT_COST_USD[metric]).toBeGreaterThanOrEqual(0);
    }
  });

  it("cost = unit_cost * quantity", () => {
    const ev: MeterEvent = {
      workspaceId: "ws-1",
      metric: "recall",
      quantity: 10,
      occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    };
    expect(meterEventCostUsd(ev)).toBeCloseTo(METER_UNIT_COST_USD.recall * 10, 12);
  });

  it("never returns NaN for negative or zero quantity", () => {
    expect(meterEventCostUsd({ workspaceId: "w", metric: "write", quantity: 0, occurredAt: new Date() })).toBe(0); // determinism-ok: throwaway fixture date, not asserted
    expect(Number.isNaN(meterEventCostUsd({ workspaceId: "w", metric: "write", quantity: -5, occurredAt: new Date() }))).toBe(false); // determinism-ok: throwaway fixture date, not asserted
  });
});
