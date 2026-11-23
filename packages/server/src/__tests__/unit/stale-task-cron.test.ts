/**
 * T4.5 — stale-task cron: flags tasks inactive for >14 days to the review queue.
 *
 * RDD-3: the cron no longer auto-archives; it calls enqueueReview so a human
 * or automated reviewer decides. Threshold is 14 days (not the original 7).
 */
import { describe, it, expect, vi } from "vitest";
import { runStaleTaskCron, STALE_TASK_THRESHOLD_MS } from "../../cron/staleTask.js";
import type { StorageAdapter } from "@mnemo-ai/types";

function staleTask(id: string) {
  return {
    id,
    title: `Task ${id}`,
    status: "pending",
    updatedAt: new Date(Date.now() - STALE_TASK_THRESHOLD_MS - 1000), // determinism-ok: throwaway fixture date, not asserted
  };
}

function makeStorage(staleTasks: ReturnType<typeof staleTask>[] = []): Partial<StorageAdapter> {
  return {
    listStaleTasks: vi.fn().mockResolvedValue(staleTasks),
    enqueueReview: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runStaleTaskCron — auto-archives inactive tasks", () => {
  it("returns 0 when there are no stale tasks", async () => {
    const storage = makeStorage([]);
    const count = await runStaleTaskCron("ws-1", storage as StorageAdapter);
    expect(count).toBe(0);
    expect(storage.enqueueReview).not.toHaveBeenCalled();
  });

  it("flags each stale task to review queue and returns the count", async () => {
    const storage = makeStorage([staleTask("t1"), staleTask("t2"), staleTask("t3")]);
    const count = await runStaleTaskCron("ws-1", storage as StorageAdapter);
    expect(count).toBe(3);
    expect(storage.enqueueReview).toHaveBeenCalledTimes(3);
    expect(storage.enqueueReview).toHaveBeenCalledWith(
      expect.objectContaining({ primitiveId: "t1", reason: "stale_task", workspaceId: "ws-1" })
    );
  });

  it("gracefully skips if listStaleTasks is not implemented", async () => {
    const storage: Partial<StorageAdapter> = {
      enqueueReview: vi.fn(),
    };
    const count = await runStaleTaskCron("ws-1", storage as StorageAdapter);
    expect(count).toBe(0);
    expect(storage.enqueueReview).not.toHaveBeenCalled();
  });

  it("STALE_TASK_THRESHOLD_MS is exported and equals 14 days", () => {
    expect(STALE_TASK_THRESHOLD_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});
