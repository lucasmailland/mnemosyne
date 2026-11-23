/**
 * staleTask cron — flags tasks inactive for > 14 days to the review queue.
 *
 * Rationale: tasks left in non-terminal states (pending, in_progress, delegated)
 * for more than STALE_TASK_THRESHOLD_MS are considered abandoned. The cron
 * flags them to the review queue with reason "stale_task" so a human or
 * automated reviewer can decide what to do — it does NOT auto-archive them.
 *
 * Wiring: registered as "mnemo.task.stale" in jobs.ts.
 */

import type { StorageAdapter } from "@mnemo-ai/types";

/** How long a task must have been inactive before it is considered stale (14 days). */
export const STALE_TASK_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** How many stale tasks to process per cron tick (prevent runaway). */
export const STALE_TASK_BATCH_LIMIT = 100;

/**
 * Flag all stale tasks for a workspace to the review queue.
 *
 * @param workspaceId  - workspace to scan
 * @param storage      - storage adapter (listStaleTasks + enqueueReview)
 * @param thresholdMs  - optional override for stale threshold (default 14 days)
 * @returns            - number of tasks flagged to review queue in this tick
 */
export async function runStaleTaskCron(
  workspaceId: string,
  storage: StorageAdapter,
  thresholdMs = STALE_TASK_THRESHOLD_MS,
): Promise<number> {
  // listStaleTasks is optional — gracefully skip if not implemented.
  if (typeof storage.listStaleTasks !== "function") {
    return 0;
  }

  const staleTasks = await storage.listStaleTasks(workspaceId, thresholdMs, STALE_TASK_BATCH_LIMIT);
  if (staleTasks.length === 0) return 0;

  await Promise.allSettled(
    staleTasks.map((task) =>
      storage.enqueueReview?.({
        workspaceId,
        primitiveKind: "task",
        primitiveId: task.id,
        reason: "stale_task",
        priority: 4,
      }),
    ),
  );

  return staleTasks.length;
}
