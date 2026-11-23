/**
 * W4: Core cognitive validation — worth-gate + TD(λ) integration
 *
 * Proves:
 *   - passesWorthGate boundary conditions (spec §11)
 *   - wilsonLowerBound at Beta(2,2) prior (new fact → fails gate)
 *   - propagateTdCredit backward-credit with exponential time-decay
 */
import { describe, it, expect, vi } from "vitest";
import { passesWorthGate, wilsonLowerBound, propagateTdCredit } from "../../cognitive/worth.js";
import type { CoreContext } from "../../cognitive/context.js";

const noop = { end: () => {} };
const telemetry = { startSpan: () => noop } as unknown as CoreContext["telemetry"];
const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as CoreContext["logger"];

// ─── passesWorthGate — serving gate (spec §11) ───────────────────────────────

describe("passesWorthGate — serving gate boundary conditions (spec §11)", () => {
  it("fact at exactly worth=0.5 fails (gate requires strictly > 0.5)", () => {
    expect(passesWorthGate({ primitive: "fact", worth: 0.5, worthLowerBound: 0.3 })).toBe(false);
  });

  it("fact at worth=0.5001 with lb=0.3 passes", () => {
    expect(passesWorthGate({ primitive: "fact", worth: 0.5001, worthLowerBound: 0.3 })).toBe(true);
  });

  it("fact with high worth but lb just below 0.3 fails (lb is the binding constraint)", () => {
    expect(passesWorthGate({ primitive: "fact", worth: 0.9, worthLowerBound: 0.2999 })).toBe(false);
  });

  it("entity passes regardless of worth (non-fact primitives bypass gate)", () => {
    expect(passesWorthGate({ primitive: "entity", worth: 0, worthLowerBound: 0 })).toBe(true);
  });

  it("decision passes regardless of worth", () => {
    expect(passesWorthGate({ primitive: "decision", worth: 0.1, worthLowerBound: 0.0 })).toBe(true);
  });

  it("episode passes regardless of worth", () => {
    expect(passesWorthGate({ primitive: "episode", worth: 0, worthLowerBound: 0 })).toBe(true);
  });

  it("fact with missing worth/worthLowerBound defaults to zero (fails gate)", () => {
    expect(passesWorthGate({ primitive: "fact" })).toBe(false);
  });

  it("fact with worth and lb both at gate floor passes exactly", () => {
    expect(passesWorthGate({ primitive: "fact", worth: 0.6, worthLowerBound: 0.3 })).toBe(true);
  });
});

// ─── wilsonLowerBound — Beta(α,β) confidence (spec §11) ─────────────────────

describe("wilsonLowerBound — Beta posterior lower bound (spec §11)", () => {
  it("Beta(2,2) — prior-only fact (no evidence yet): lb ≈ 0.15, below gate threshold 0.3", () => {
    const lb = wilsonLowerBound(2, 2);
    expect(lb).toBeCloseTo(0.15, 1);
    expect(lb).toBeLessThan(0.3);
  });

  it("Beta(10,2) — established fact with 8 successes: lb > 0.5 → well above gate", () => {
    const lb = wilsonLowerBound(10, 2);
    expect(lb).toBeGreaterThan(0.5);
  });

  it("Beta(4,4) — symmetric uncertain fact: lb < 0.3 (borderline, below gate)", () => {
    const lb = wilsonLowerBound(4, 4);
    // 4+4=8 observations, mean=0.5 → Wilson lb ≈ 0.28
    expect(lb).toBeLessThan(0.3);
  });

  it("Beta(5,2) — 3 successes above prior: lb > 0.3, passes gate", () => {
    const lb = wilsonLowerBound(5, 2);
    expect(lb).toBeGreaterThan(0.3);
  });

  it("Beta(0,0) — degenerate (guard): returns 0", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it("lower bound is monotonically increasing with more successes (Beta(2+k,2) for k=0..5)", () => {
    const lbs = [0, 1, 2, 3, 4, 5].map((k) => wilsonLowerBound(2 + k, 2));
    for (let i = 1; i < lbs.length; i++) {
      expect(lbs[i]).toBeGreaterThan(lbs[i - 1]!);
    }
  });
});

// ─── propagateTdCredit — backward credit with time decay (spec §11 λ-drift) ──

describe("propagateTdCredit — TD(λ) backward propagation", () => {
  it("propagates credit to a predecessor recalled 5s ago with correct tdCredit × time-decay", async () => {
    const updateWorth = vi.fn(async () => {});
    const recalledAt = new Date(Date.now() - 5_000); // determinism-ok: relative offset drives time-decay assertion
    const ctx = {
      telemetry,
      logger,
      storage: {
        getTdPredecessors: async () => [{ factId: "pred-1", tdCredit: 0.7, recalledAt }],
        updateWorth,
      },
    } as unknown as CoreContext;

    await propagateTdCredit(ctx, "ws-1", "sess-1", "triggered-fact", {
      success: 1,
      failure: 0,
      creditWeight: 1.0,
    });

    const expectedCredit = 0.7 * Math.exp(-5 / 86_400);
    expect(updateWorth).toHaveBeenCalledOnce();
    expect(updateWorth).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ creditWeight: expect.closeTo(expectedCredit, 4) }),
    );
  });

  it("applies exponential time-decay: predecessor recalled 1 day ago receives ~37% credit", async () => {
    const updateWorth = vi.fn(async () => {});
    const oneDayAgo = new Date(Date.now() - 86_400_000); // determinism-ok: relative offset; exp(-1) assertion is decay-rate, not wall-clock
    const ctx = {
      telemetry,
      logger,
      storage: {
        getTdPredecessors: async () => [{ factId: "pred-old", tdCredit: 1.0, recalledAt: oneDayAgo }],
        updateWorth,
      },
    } as unknown as CoreContext;

    await propagateTdCredit(ctx, "ws-1", "sess-1", "triggered-fact", {
      success: 1,
      failure: 0,
      creditWeight: 1.0,
    });

    // exp(-86400 / 86400) = exp(-1) ≈ 0.368
    expect(updateWorth).toHaveBeenCalledOnce();
    expect(updateWorth).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ creditWeight: expect.closeTo(Math.exp(-1), 2) }),
    );
  });

  it("no-ops when sessionId is empty (guard)", async () => {
    const updateWorth = vi.fn(async () => {});
    const getTdPredecessors = vi.fn(async () => []);
    const ctx = {
      telemetry,
      logger,
      storage: { getTdPredecessors, updateWorth },
    } as unknown as CoreContext;

    await propagateTdCredit(ctx, "ws-1", "" /* empty sessionId */, "triggered-fact", {
      success: 1,
      failure: 0,
      creditWeight: 1.0,
    });

    expect(getTdPredecessors).not.toHaveBeenCalled();
    expect(updateWorth).not.toHaveBeenCalled();
  });

  it("skips predecessors with tdCredit=0 (no credit to propagate)", async () => {
    const updateWorth = vi.fn(async () => {});
    const ctx = {
      telemetry,
      logger,
      storage: {
        getTdPredecessors: async () => [
          { factId: "zero-credit", tdCredit: 0, recalledAt: new Date() }, // determinism-ok: any timestamp works; tdCredit=0 skips all time-decay math
        ],
        updateWorth,
      },
    } as unknown as CoreContext;

    await propagateTdCredit(ctx, "ws-1", "sess-1", "triggered-fact", {
      success: 1,
      failure: 0,
      creditWeight: 1.0,
    });

    expect(updateWorth).not.toHaveBeenCalled();
  });

  it("swallows getTdPredecessors failure gracefully — never throws", async () => {
    const ctx = {
      telemetry,
      logger,
      storage: {
        getTdPredecessors: async () => {
          throw new Error("DB unreachable");
        },
        updateWorth: vi.fn(async () => {}),
      },
    } as unknown as CoreContext;

    await expect(
      propagateTdCredit(ctx, "ws-1", "sess-1", "triggered-fact", {
        success: 1,
        failure: 0,
        creditWeight: 1.0,
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates to multiple predecessors, each with independent time-decay (recent > stale)", async () => {
    // Capture deltas via a typed closure to avoid vi.fn() tuple-type inference issues
    const captured: Array<{ creditWeight: number }> = [];
    const updateWorth = vi.fn(
      async (_fid: string, _ws: string, _kind: string, d: { creditWeight: number }) => { captured.push(d); },
    );
    const now = Date.now(); // determinism-ok: captures reference point for relative ordering assertions
    const ctx = {
      telemetry,
      logger,
      storage: {
        getTdPredecessors: async () => [
          { factId: "pred-recent", tdCredit: 0.7, recalledAt: new Date(now - 1_000) },
          { factId: "pred-stale", tdCredit: 0.7, recalledAt: new Date(now - 3_600_000) },
        ],
        updateWorth,
      },
    } as unknown as CoreContext;

    await propagateTdCredit(ctx, "ws-1", "sess-1", "triggered-fact", {
      success: 1,
      failure: 0,
      creditWeight: 1.0,
    });

    expect(updateWorth).toHaveBeenCalledTimes(2);
    // Recent predecessor (1s ago) must receive more credit than stale (1h ago)
    expect(captured[0]!.creditWeight).toBeGreaterThan(captured[1]!.creditWeight);
  });
});
