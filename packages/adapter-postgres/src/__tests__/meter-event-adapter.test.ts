import { describe, it, expect, vi } from "vitest";
import { DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";

/** Minimal fake DrizzleClient capturing execute() calls and a transaction shim. */
function fakeDb(executeImpl: (q: unknown) => Promise<unknown>) {
  const tx = { execute: vi.fn(executeImpl) };
  return {
    execute: vi.fn(executeImpl),
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    _tx: tx,
  } as unknown as ConstructorParameters<typeof DrizzleStorageAdapter>[0] & {
    execute: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
    _tx: { execute: ReturnType<typeof vi.fn> };
  };
}

describe("DrizzleStorageAdapter meter event methods (F15)", () => {
  it("appendMeterEvent inserts into mnemo_meter_event inside a workspace tx", async () => {
    const db = fakeDb(async () => []);
    const a = new DrizzleStorageAdapter(db);
    await a.appendMeterEvent({
      workspaceId: "11111111-1111-1111-1111-111111111111",
      metric: "recall",
      quantity: 3,
      occurredAt: new Date("2026-06-01T00:00:00Z"),
      costUsd: 0.00006,
      idempotencyKey: "idem-1",
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    // first tx.execute = mnemo_set_workspace, second = the INSERT
    expect(db._tx.execute).toHaveBeenCalledTimes(2);
  });

  it("getWorkspaceMonthlySpendUsd returns the summed cost_usd as a number", async () => {
    const db = fakeDb(async () => [{ spend: "1.50" }]);
    const a = new DrizzleStorageAdapter(db);
    const spend = await a.getWorkspaceMonthlySpendUsd("11111111-1111-1111-1111-111111111111");
    expect(spend).toBe(1.5);
  });

  it("getWorkspaceMonthlySpendUsd returns 0 when no rows", async () => {
    const db = fakeDb(async () => [{ spend: null }]);
    const a = new DrizzleStorageAdapter(db);
    const spend = await a.getWorkspaceMonthlySpendUsd("11111111-1111-1111-1111-111111111111");
    expect(spend).toBe(0);
  });

  it("getMonthToDateUsageFromDb folds rows into a per-metric map", async () => {
    const db = fakeDb(async () => [
      { operation: "recall", units: "100" },
      { operation: "write", units: "5" },
    ]);
    const a = new DrizzleStorageAdapter(db);
    const usage = await a.getMonthToDateUsageFromDb("11111111-1111-1111-1111-111111111111");
    expect(usage).toEqual({ recall: 100, write: 5 });
  });
});
