import { describe, it, expect, vi } from "vitest";
import { runStaleTaskCron, STALE_TASK_THRESHOLD_MS } from "../staleTask.js";

describe("runStaleTaskCron", () => {
  it("threshold is 14 days", () => {
    expect(STALE_TASK_THRESHOLD_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("flags stale tasks via enqueueReview, does NOT archive", async () => {
    const archiveTask = vi.fn();
    const enqueueReview = vi.fn().mockResolvedValue({ id: "rv1", inserted: true });
    const listStaleTasks = vi.fn().mockResolvedValue([{ id: "task-1" }]);

    const storage = { listStaleTasks, archiveTask, enqueueReview } as any;
    const count = await runStaleTaskCron("ws-1", storage, 14 * 24 * 60 * 60 * 1000);

    expect(count).toBe(1);
    expect(archiveTask).not.toHaveBeenCalled();
    expect(enqueueReview).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      primitiveKind: "task",
      primitiveId: "task-1",
      reason: "stale_task",
      priority: 4,
    });
  });

  it("only flags tasks exceeding the threshold", async () => {
    const enqueueReview = vi.fn().mockResolvedValue({ id: "rv1", inserted: true });
    const listStaleTasks = vi.fn().mockResolvedValue([]); // none stale

    const storage = { listStaleTasks, enqueueReview } as any;
    const count = await runStaleTaskCron("ws-1", storage, 14 * 24 * 60 * 60 * 1000);

    expect(count).toBe(0);
    expect(enqueueReview).not.toHaveBeenCalled();
  });

  it("returns 0 and skips gracefully if listStaleTasks not implemented", async () => {
    const count = await runStaleTaskCron("ws-1", {} as any);
    expect(count).toBe(0);
  });
});
