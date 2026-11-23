import { describe, it, expect, vi } from "vitest";
import { startCronRegistry } from "../registry.js";
import type { CronJob } from "../registry.js";

const makeDeps = () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
  telemetry: {
    counter: vi.fn(), histogram: vi.fn(),
    startSpan: vi.fn(), gauge: vi.fn(), shutdown: vi.fn(),
  } as any,
});

describe("startCronRegistry with shedGate", () => {
  it("shedGate.isShed is called with job key and handler skipped when true", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue(undefined);
    const isShed = vi.fn().mockReturnValue(true);
    const job: CronJob = {
      key: "anticipate.mine",
      schedule: { kind: "interval", ms: 100 },
      handler,
    };
    const deps = makeDeps();
    const reg = startCronRegistry([job], { ...deps, shedGate: { isShed } });

    await vi.advanceTimersByTimeAsync(200);
    expect(isShed).toHaveBeenCalledWith("anticipate.mine");
    expect(handler).not.toHaveBeenCalled();

    reg.stop();
    vi.useRealTimers();
  });

  it("handler IS called when shedGate reports isShed=false", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue(undefined);
    const isShed = vi.fn().mockReturnValue(false);
    const job: CronJob = {
      key: "anticipate.mine",
      schedule: { kind: "interval", ms: 100 },
      handler,
    };
    const deps = makeDeps();
    const reg = startCronRegistry([job], { ...deps, shedGate: { isShed } });

    await vi.advanceTimersByTimeAsync(200);
    expect(handler).toHaveBeenCalled();

    reg.stop();
    vi.useRealTimers();
  });

  it("handler is called when no shedGate is provided (backward compat)", async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue(undefined);
    const job: CronJob = {
      key: "anticipate.mine",
      schedule: { kind: "interval", ms: 100 },
      handler,
    };
    const deps = makeDeps();
    const reg = startCronRegistry([job], deps);

    await vi.advanceTimersByTimeAsync(200);
    expect(handler).toHaveBeenCalled();

    reg.stop();
    vi.useRealTimers();
  });
});
