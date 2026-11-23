/**
 * LIFECYCLE-14 — a sweep whose collapses all failed logged `cron.tick_ok`.
 *
 * Measured on the eval stack: both P116 sessions failed their collapse (LLM
 * 404), the sweep logged one warn per session, and the registry then reported
 * the tick as `cron.tick_ok` with an `ok` run counter. Anyone reading the cron
 * metrics saw a healthy sweep.
 */
import { describe, it, expect, vi } from "vitest";
import { buildCronJobs } from "../jobs.js";
import { startCronRegistry } from "../registry.js";
import { isLastCollapseAttempt } from "../../session-sweep.js";

function deps(collapseStaleSessions: () => Promise<unknown>) {
  return {
    storage: {} as never,
    listWorkspaceIds: vi.fn().mockResolvedValue([]),
    collapseStaleSessions: collapseStaleSessions as () => Promise<void>,
    logger: { info: vi.fn(), warn: vi.fn() },
    telemetry: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() } as never,
  };
}

const sweepJob = (d: ReturnType<typeof deps>) =>
  buildCronJobs(d as never).find((j) => j.key === "mnemo.session.collapse")!;

describe("session sweep tick outcome", () => {
  it("fails the tick when any collapse in it failed", async () => {
    const job = sweepJob(
      deps(async () => ({ total: 2, collapsed: 0, skipped: 0, failed: 2, abandoned: 0 }))
    );

    await expect(job.handler()).rejects.toThrow(/2 of 2 session collapses failed/);
  });

  it("stays ok when every collapse succeeded or was skipped", async () => {
    const job = sweepJob(
      deps(async () => ({ total: 3, collapsed: 2, skipped: 1, failed: 0, abandoned: 0 }))
    );

    await expect(job.handler()).resolves.toBeUndefined();
  });

  it("fails the tick when legacy discovery fails, after the managed worker still ran", async () => {
    const d = deps(async () => {
      throw new Error("discovery: database unavailable");
    });
    const runManagedSessions = vi.fn(async () => {});
    const job = buildCronJobs({ ...d, runManagedSessions } as never).find(
      (j) => j.key === "mnemo.session.collapse"
    )!;

    await expect(job.handler()).rejects.toThrow(/legacy session sweep failed/);
    expect(runManagedSessions).toHaveBeenCalledOnce();
  });

  it("fails the tick when the managed worker rejects, after the legacy sweep still ran", async () => {
    const sweep = vi.fn(async () => ({
      total: 1,
      collapsed: 1,
      skipped: 0,
      failed: 0,
      abandoned: 0,
    }));
    const d = deps(sweep);
    const job = buildCronJobs({
      ...d,
      runManagedSessions: async () => {
        throw new Error("managed worker down");
      },
    } as never).find((j) => j.key === "mnemo.session.collapse")!;

    await expect(job.handler()).rejects.toThrow(/managed session worker failed/);
    expect(sweep).toHaveBeenCalledOnce();
  });

  it("the registry then records the tick as an error, not tick_ok", async () => {
    vi.useFakeTimers();
    const d = deps(async () => ({ total: 1, collapsed: 0, skipped: 0, failed: 1, abandoned: 0 }));
    const handle = startCronRegistry([sweepJob(d)], {
      logger: d.logger,
      telemetry: d.telemetry as never,
    });
    await vi.advanceTimersByTimeAsync(300_000);
    handle.stop();
    vi.useRealTimers();

    expect(d.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cron: "mnemo.session.collapse" }),
      "cron.tick_error"
    );
    expect(d.logger.info).not.toHaveBeenCalledWith(expect.anything(), "cron.tick_ok");
  });
});

describe("isLastCollapseAttempt", () => {
  it("is true only for the attempt the sweep will not repeat", () => {
    // The sweep selects sessions with fewer than 8 recorded attempts.
    expect(isLastCollapseAttempt(6)).toBe(false);
    expect(isLastCollapseAttempt(7)).toBe(true);
  });
});
