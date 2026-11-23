/**
 * AB4 — SloRollbackMonitor tests.
 * spec §35 lines 4467 + 2094–2099.
 */
import { describe, it, expect, vi } from "vitest";
import { SloRollbackMonitor } from "../deploy/SloRollbackMonitor.js";

describe("SloRollbackMonitor — spec §35 lines 4467, 2094–2099", () => {
  it("calls onRollback when metrics indicate rollback", async () => {
    const onRollback = vi.fn();
    const monitor = new SloRollbackMonitor({
      getMetrics: async () => ({
        baseline: { errorRate: 0.01, p99: 200 },
        canary: { errorRate: 0.03, p99: 200 }, // delta 0.02 > 0.01 threshold
      }),
      onRollback,
    });

    await monitor.poll();
    expect(onRollback).toHaveBeenCalledOnce();
  });

  it("does NOT call onRollback when metrics are healthy", async () => {
    const onRollback = vi.fn();
    const monitor = new SloRollbackMonitor({
      getMetrics: async () => ({
        baseline: { errorRate: 0.01, p99: 200 },
        canary: { errorRate: 0.005, p99: 210 }, // within thresholds
      }),
      onRollback,
    });

    await monitor.poll();
    expect(onRollback).not.toHaveBeenCalled();
  });

  it("holds when metrics return null (no data)", async () => {
    const onRollback = vi.fn();
    const monitor = new SloRollbackMonitor({
      getMetrics: async () => ({ baseline: null, canary: null }),
      onRollback,
    });

    await monitor.poll();
    expect(onRollback).not.toHaveBeenCalled();
  });

  it("only calls onRollback once even if polled multiple times after rollback", async () => {
    const onRollback = vi.fn();
    const monitor = new SloRollbackMonitor({
      getMetrics: async () => ({
        baseline: { errorRate: 0.01, p99: 200 },
        canary: { errorRate: 0.05, p99: 500 },
      }),
      onRollback,
    });

    await monitor.poll();
    await monitor.poll();
    await monitor.poll();
    expect(onRollback).toHaveBeenCalledOnce();
  });

  it("logs cron: mnemo.canary.monitor label", async () => {
    const monitor = new SloRollbackMonitor({
      getMetrics: async () => ({ baseline: null, canary: null }),
      onRollback: vi.fn(),
      label: "mnemo.canary.monitor",
    });
    // Just verify no errors thrown
    await monitor.poll();
  });
});
