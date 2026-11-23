import { describe, it, expect, vi } from "vitest";
import { propagateTdCredit } from "../worth.js";
import type { CoreContext } from "../context.js";
import type { WorthDelta } from "@mnemo-ai/types";

describe("propagateTdCredit", () => {
  function makeCtx(
    overrides: Partial<{
      getTdPredecessors: ReturnType<typeof vi.fn>;
      updateWorth: ReturnType<typeof vi.fn>;
    }> = {},
  ) {
    return {
      storage: {
        getTdPredecessors: vi.fn().mockResolvedValue([]),
        updateWorth: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      },
      logger: {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    } as unknown as CoreContext;
  }

  const delta: WorthDelta = { success: 1, failure: 0, creditWeight: 1.0 };

  it("calls updateWorth for each predecessor with decayed credit", async () => {
    const ctx = makeCtx({
      getTdPredecessors: vi.fn().mockResolvedValue([
        { factId: "f-1", tdCredit: 0.7, recalledAt: new Date() }, // determinism-ok: throwaway fixture date, not asserted
        { factId: "f-2", tdCredit: 0.49, recalledAt: new Date() }, // determinism-ok: throwaway fixture date, not asserted
      ]),
    });

    await propagateTdCredit(ctx, "ws-1", "sess-1", "f-primary", delta);

    expect(ctx.storage.updateWorth).toHaveBeenCalledTimes(2);
    // Use closeTo because time decay exp(-Δt/τ) with Δt≈0ms gives ≈1.0 (not exactly)
    const call1 = (ctx.storage.updateWorth as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "f-1")!;
    const call2 = (ctx.storage.updateWorth as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => c[0] === "f-2")!;
    expect(call1[3].success).toBe(1);
    expect(call1[3].failure).toBe(0);
    expect(call1[3].creditWeight).toBeCloseTo(0.7, 4);
    expect(call2[3].success).toBe(1);
    expect(call2[3].failure).toBe(0);
    expect(call2[3].creditWeight).toBeCloseTo(0.49, 4);
  });

  it("no-ops when sessionId is empty string", async () => {
    const ctx = makeCtx();
    await propagateTdCredit(ctx, "ws-1", "", "f-primary", delta);
    expect(ctx.storage.updateWorth).not.toHaveBeenCalled();
    expect(ctx.storage.getTdPredecessors).not.toHaveBeenCalled();
  });

  it("skips predecessors with tdCredit = 0", async () => {
    const ctx = makeCtx({
      getTdPredecessors: vi.fn().mockResolvedValue([{ factId: "f-zero", tdCredit: 0, recalledAt: new Date() }]), // determinism-ok: throwaway fixture date, not asserted
    });
    await propagateTdCredit(ctx, "ws-1", "sess-1", "f-primary", delta);
    expect(ctx.storage.updateWorth).not.toHaveBeenCalled();
  });

  it("continues if getTdPredecessors throws", async () => {
    const ctx = makeCtx({
      getTdPredecessors: vi.fn().mockRejectedValue(new Error("db down")),
    });
    await expect(
      propagateTdCredit(ctx, "ws-1", "sess-1", "f-primary", delta),
    ).resolves.toBeUndefined();
    expect(ctx.storage.updateWorth).not.toHaveBeenCalled();
  });

  it("scales creditWeight proportionally to predecessor tdCredit", async () => {
    const partialDelta: WorthDelta = { success: 1, failure: 0, creditWeight: 0.5 };
    const ctx = makeCtx({
      getTdPredecessors: vi.fn().mockResolvedValue([{ factId: "f-x", tdCredit: 0.7, recalledAt: new Date() }]), // determinism-ok: throwaway fixture date, not asserted
    });
    await propagateTdCredit(ctx, "ws-1", "sess-1", "f-primary", partialDelta);
    expect(ctx.storage.updateWorth).toHaveBeenCalledWith("f-x", "ws-1", "fact", {
      success: 1,
      failure: 0,
      creditWeight: expect.closeTo(0.35, 5), // 0.5 * 0.7 * ~1.0 (near-zero time decay)
    });
  });
});

describe("propagateTdCredit — λ-drift time decay (spec §11)", () => {
  it("gives an older predecessor exponentially less credit than a recent one", async () => {
    const updateWorth = vi.fn().mockResolvedValue(undefined);
    const now = 1_750_000_000_000;
    const ctx = {
      storage: {
        updateWorth,
        getTdPredecessors: vi.fn().mockResolvedValue([
          { factId: "recent", tdCredit: 1, recalledAt: new Date(now - 10_000) },     // 10s ago
          { factId: "old",    tdCredit: 1, recalledAt: new Date(now - 5 * 86_400_000) }, // 5 days ago
        ]),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } },
    } as unknown as import("../context.js").CoreContext;

    await propagateTdCredit(ctx, "ws1", "sess1", "trigger", { success: 1, failure: 0, creditWeight: 1 });

    const recentCall = updateWorth.mock.calls.find((c) => c[0] === "recent")!;
    const oldCall = updateWorth.mock.calls.find((c) => c[0] === "old")!;
    expect(recentCall[3].creditWeight).toBeGreaterThan(oldCall[3].creditWeight * 5);
  });
});
