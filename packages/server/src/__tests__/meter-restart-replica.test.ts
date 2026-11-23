import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryMeterStore, emitMeter } from "../metering/MeterEmitter.js";
import { persistDrainedMeterEvents } from "../metering/persist.js";
import { getMonthToDateUsageFromStorage } from "../metering/aggregate.js";
import { meterEventCostUsd } from "@mnemo-ai/core/cognitive";
import type { MeterEvent } from "@mnemo-ai/core/cognitive";

/** Fake durable table: idempotency_key UNIQUE enforced via a Map. */
function fakeDurableStorage() {
  const rows = new Map<string, { workspaceId: string; metric: string; units: number; costUsd: number }>();
  return {
    rows,
    async appendMeterEvent(e: { workspaceId: string; metric: string; quantity: number; occurredAt: Date; costUsd: number; idempotencyKey: string }) {
      if (rows.has(e.idempotencyKey)) return; // ON CONFLICT DO NOTHING
      rows.set(e.idempotencyKey, { workspaceId: e.workspaceId, metric: e.metric, units: e.quantity, costUsd: e.costUsd });
    },
    async getMonthToDateUsageFromDb(workspaceId: string): Promise<Record<string, number>> {
      const out: Record<string, number> = {};
      for (const r of rows.values()) {
        if (r.workspaceId !== workspaceId) continue;
        out[r.metric] = (out[r.metric] ?? 0) + r.units;
      }
      return out;
    },
    async getWorkspaceMonthlySpendUsd(workspaceId: string): Promise<number> {
      let s = 0;
      for (const r of rows.values()) if (r.workspaceId === workspaceId) s += r.costUsd;
      return s;
    },
  };
}

describe("durable metering: restart + multi-replica (F15)", () => {
  let storage: ReturnType<typeof fakeDurableStorage>;
  beforeEach(() => { storage = fakeDurableStorage(); });

  it("usage/spend come from DB after a simulated restart (fresh in-memory state)", async () => {
    // Replica A: emit + persist.
    const storeA = new InMemoryMeterStore();
    emitMeter("ws-1", "recall", 300, storeA);
    emitMeter("ws-1", "write", 10, storeA);
    await persistDrainedMeterEvents(storeA, storage);

    // Simulate restart: brand-new process state (no in-memory accumulator, fresh store).
    const usage = await getMonthToDateUsageFromStorage(storage, "ws-1");
    expect(usage.recall).toBe(300);
    expect(usage.write).toBe(10);

    const spend = await storage.getWorkspaceMonthlySpendUsd("ws-1");
    expect(spend).toBeCloseTo(meterEventCostUsd({ workspaceId: "ws-1", metric: "recall", quantity: 300, occurredAt: new Date() }) // determinism-ok: throwaway fixture date, not asserted
      + meterEventCostUsd({ workspaceId: "ws-1", metric: "write", quantity: 10, occurredAt: new Date() }), 10); // determinism-ok: throwaway fixture date, not asserted
  });

  it("re-persisting the SAME events (cross-replica duplicate) does not double-count", async () => {
    const fixed: MeterEvent[] = [
      { workspaceId: "ws-2", metric: "recall", quantity: 5, occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
        idempotencyKey: "dup-k" },
    ];
    // Two replicas each drain a store seeded with the SAME idempotency key.
    const storeA = new InMemoryMeterStore();
    const storeB = new InMemoryMeterStore();
    for (const e of fixed) { storeA.appendEvent({ ...e }); storeB.appendEvent({ ...e }); }
    await persistDrainedMeterEvents(storeA, storage);
    await persistDrainedMeterEvents(storeB, storage);

    const usage = await getMonthToDateUsageFromStorage(storage, "ws-2");
    expect(usage.recall).toBe(5); // NOT 10 — idempotency key de-dups
    expect(storage.rows.size).toBe(1);
  });
});
