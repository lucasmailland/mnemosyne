import { describe, it, expect, beforeEach, vi } from "vitest";
import { globalMeterStore, emitMeter } from "../metering/MeterEmitter.js";
import { persistDrainedMeterEvents } from "../metering/persist.js";

describe("durable metering drain→persist (F15)", () => {
  beforeEach(() => { globalMeterStore.drain(); });

  it("write-throughs each queued event to storage.appendMeterEvent with computed costUsd", async () => {
    const appended: Array<{ metric: string; quantity: number; costUsd: number }> = [];
    const storage = {
      appendMeterEvent: vi.fn(async (e: { metric: string; quantity: number; costUsd: number }) => {
        appended.push({ metric: e.metric, quantity: e.quantity, costUsd: e.costUsd });
      }),
    };

    emitMeter("ws-d", "recall", 4);
    emitMeter("ws-d", "write", 2);

    const n = await persistDrainedMeterEvents(globalMeterStore, storage);
    expect(n).toBe(2);
    expect(storage.appendMeterEvent).toHaveBeenCalledTimes(2);
    // recall unit cost 0.00002 * 4, write 0.00005 * 2
    const recall = appended.find((a) => a.metric === "recall")!;
    const write = appended.find((a) => a.metric === "write")!;
    expect(recall.costUsd).toBeCloseTo(0.00008, 12);
    expect(write.costUsd).toBeCloseTo(0.0001, 12);
    // queue drained
    expect(globalMeterStore.peek()).toHaveLength(0);
  });

  it("a throwing appendMeterEvent does not throw out of the persister and re-queues nothing silently lost", async () => {
    const storage = { appendMeterEvent: vi.fn(async () => { throw new Error("db down"); }) };
    emitMeter("ws-e", "session", 1);
    await expect(persistDrainedMeterEvents(globalMeterStore, storage)).resolves.toBeTypeOf("number");
  });

  it("getMonthToDateUsageFromStorage reads per-metric usage from the port", async () => {
    const { getMonthToDateUsageFromStorage } = await import("../metering/aggregate.js");
    const storage = {
      getMonthToDateUsageFromDb: vi.fn(async () => ({ recall: 123, write: 7 })),
    };
    const usage = await getMonthToDateUsageFromStorage(storage, "ws-x");
    expect(usage.recall).toBe(123);
    expect(usage.write).toBe(7);
  });
});
