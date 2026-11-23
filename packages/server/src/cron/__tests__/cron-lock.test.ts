import { describe, expect, it, vi } from "vitest";
import { ALL_CRON_KEYS } from "../jobs.js";
import {
  type CronJob,
  type CronLock,
  cronScope,
  lockHoldMs,
  startCronRegistry,
} from "../registry.js";

const makeDeps = () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
  telemetry: {
    counter: vi.fn(),
    histogram: vi.fn(),
    startSpan: vi.fn(),
    gauge: vi.fn(),
    shutdown: vi.fn(),
  } as any,
});

describe("cron scope per job", () => {
  it("runs only the in-process meter drain on every replica", () => {
    expect(cronScope("mnemo.meter.persist")).toBe("replica");
  });

  it.each(ALL_CRON_KEYS)("%s touches shared state, so one replica takes each run", (key) => {
    expect(cronScope(key)).toBe("cluster");
  });

  it("holds the lock for half a short period and at most 10 s", () => {
    expect(lockHoldMs({ kind: "interval", ms: 60_000 })).toBe(10_000);
    expect(lockHoldMs({ kind: "interval", ms: 4_000 })).toBe(2_000);
    expect(lockHoldMs({ kind: "dailyUtc", hour: 3, minute: 0 })).toBe(10_000);
  });
});

describe("startCronRegistry with a lock", () => {
  const job = (key: string, handler: () => Promise<void>): CronJob => ({
    key,
    schedule: { kind: "interval", ms: 100 },
    handler,
  });

  it("runs cluster jobs through the lock and skips the tick when another replica holds it", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue(undefined);
    const lock: CronLock = { runExclusive: vi.fn().mockResolvedValue(false) };
    const deps = makeDeps();
    const reg = startCronRegistry([job("mnemo.webhook.deliver", handler)], { ...deps, lock });

    await vi.advanceTimersByTimeAsync(150);
    expect(lock.runExclusive).toHaveBeenCalledWith("mnemo.webhook.deliver", 50, handler);
    expect(handler).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      { cron: "mnemo.webhook.deliver" },
      "cron.lock_skipped"
    );
    expect(deps.telemetry.counter).not.toHaveBeenCalled();

    reg.stop();
    vi.useRealTimers();
  });

  it("runs per-replica jobs without the lock", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue(undefined);
    const lock: CronLock = { runExclusive: vi.fn() };
    const reg = startCronRegistry([job("mnemo.meter.persist", handler)], { ...makeDeps(), lock });

    await vi.advanceTimersByTimeAsync(150);
    expect(handler).toHaveBeenCalled();
    expect(lock.runExclusive).not.toHaveBeenCalled();

    reg.stop();
    vi.useRealTimers();
  });
});
