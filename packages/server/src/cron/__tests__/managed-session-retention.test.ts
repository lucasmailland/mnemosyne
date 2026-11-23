import { describe, expect, it, vi } from "vitest";
import { managedSessionRetentionHandler } from "../managed-session-retention.js";

function deps(overrides: Record<string, unknown> = {}) {
  const purgeManagedTurns = vi.fn(async () => 0);
  return {
    purgeManagedTurns,
    handler: {
      storage: { purgeManagedTurns },
      listWorkspaceIds: vi.fn(async () => ["ws-a", "ws-b"]),
      resolveTranscriptDays: vi.fn(async () => 30),
      now: () => new Date("2026-09-10T00:00:00.000Z"),
      logger: { info: vi.fn(), warn: vi.fn() },
      ...overrides,
    },
  };
}

describe("managed session retention cron", () => {
  it("purges every workspace using its own resolved window", async () => {
    const { purgeManagedTurns, handler } = deps({
      resolveTranscriptDays: vi.fn(async (workspaceId: string) =>
        workspaceId === "ws-a" ? 30 : 7
      ),
    });

    await managedSessionRetentionHandler(handler as never);

    expect(purgeManagedTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-a",
        terminalBefore: new Date("2026-08-11T00:00:00.000Z"),
      })
    );
    expect(purgeManagedTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-b",
        terminalBefore: new Date("2026-09-03T00:00:00.000Z"),
      })
    );
  });

  it("keeps paging one workspace while it is still returning full batches", async () => {
    const purgeManagedTurns = vi
      .fn()
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(12)
      .mockResolvedValue(0);
    const { handler } = deps({
      storage: { purgeManagedTurns },
      listWorkspaceIds: vi.fn(async () => ["ws-a"]),
    });

    const result = await managedSessionRetentionHandler(handler as never);

    // Stops on the first short page: a full batch means there may be more.
    expect(purgeManagedTurns).toHaveBeenCalledTimes(3);
    expect(result.deleted).toBe(1012);
  });

  it("stops a runaway workspace at the per-tick ceiling instead of holding the tick open", async () => {
    const purgeManagedTurns = vi.fn(async () => 500);
    const { handler } = deps({
      storage: { purgeManagedTurns },
      listWorkspaceIds: vi.fn(async () => ["ws-a"]),
    });

    await managedSessionRetentionHandler(handler as never);

    expect(purgeManagedTurns.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it("carries on to the next workspace when one fails", async () => {
    const purgeManagedTurns = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
      if (workspaceId === "ws-a") throw new Error("workspace a is unavailable");
      return 3;
    });
    const { handler } = deps({ storage: { purgeManagedTurns } });

    const result = await managedSessionRetentionHandler(handler as never);

    expect(result).toMatchObject({ deleted: 3, failedWorkspaces: 1 });
    expect(handler.logger.warn).toHaveBeenCalled();
  });

  it("never logs a transcript, a session id, or an error message body", async () => {
    const purgeManagedTurns = vi.fn(async () => {
      throw new Error("SECRET-TRANSCRIPT leaked into an error");
    });
    const { handler } = deps({ storage: { purgeManagedTurns } });

    await managedSessionRetentionHandler(handler as never);

    expect(JSON.stringify(handler.logger.warn.mock.calls)).not.toContain("SECRET-TRANSCRIPT");
  });

  it("skips a workspace whose window could not be resolved rather than guessing", async () => {
    const purgeManagedTurns = vi.fn(async () => 0);
    const { handler } = deps({
      storage: { purgeManagedTurns },
      resolveTranscriptDays: vi.fn(async () => {
        throw new Error("config unavailable");
      }),
    });

    await managedSessionRetentionHandler(handler as never);

    // Guessing a window here would delete transcripts the operator never agreed to lose.
    expect(purgeManagedTurns).not.toHaveBeenCalled();
  });
});

describe("degraded adapter", () => {
  it("reports rather than pretends when the adapter cannot purge", async () => {
    const listWorkspaceIds = vi.fn(async () => ["ws-a"]);
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await managedSessionRetentionHandler({
      storage: {},
      listWorkspaceIds,
      resolveTranscriptDays: vi.fn(async () => 30),
      logger,
    } as never);

    expect(result).toMatchObject({ deleted: 0, workspaces: 0 });
    expect(listWorkspaceIds).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
