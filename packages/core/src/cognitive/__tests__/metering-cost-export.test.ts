import { describe, it, expect } from "vitest";
import * as v3 from "../index.js";

describe("core/v3 barrel re-exports meter cost API", () => {
  it("exposes METER_UNIT_COST_USD and meterEventCostUsd", () => {
    expect(v3).toHaveProperty("METER_UNIT_COST_USD");
    expect(typeof (v3 as { meterEventCostUsd?: unknown }).meterEventCostUsd).toBe("function");
  });
});
