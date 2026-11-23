import { describe, it, expect, vi } from "vitest";
import { DrizzleStorageAdapter } from "../../DrizzleStorageAdapter.js";

describe("updateSessionSummary (C5)", () => {
  it("is implemented on DrizzleStorageAdapter", () => {
    expect(typeof DrizzleStorageAdapter.prototype.updateSessionSummary).toBe("function");
  });

  it("writes context_snapshot + fact_count inside a workspace-scoped tx", async () => {
    const executed: string[] = [];
    const tx = {
      execute: vi.fn(async (q: { toString?: () => string }) => {
        executed.push(String((q as { strings?: string[] }).strings?.join("?") ?? q));
        return [{ m: true }] as unknown[];
      }),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    };
    const db = { transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const adapter = new DrizzleStorageAdapter(db as never);
    await adapter.updateSessionSummary!({
      sessionId: "s-1",
      workspaceId: "11111111-1111-1111-1111-111111111111",
      summary: { goal: "g", outcome: "resolved" },
      factCount: 3,
    });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(tx.execute).toHaveBeenCalledTimes(5); // role check + downgrade/search path + both GUCs
    expect(tx.update).toHaveBeenCalledOnce();
  });
});
