import type { StorageAdapter, OutboxAdapter, Logger } from "@mnemo-ai/types";
import { shouldGraduate, type WorkspaceModeRecord } from "./learningMode.js";

export interface GraduationTickResult {
  workspaceId: string;
  graduated: boolean;
  reason?: string;
  eventName?: string;
}

export async function runGraduationTick(
  storage: StorageAdapter,
  outbox: OutboxAdapter,
  logger: Logger,
  workspaceId: string,
): Promise<GraduationTickResult> {
  if (!storage.getWorkspaceMode || !storage.setWorkspaceMode) {
    return { workspaceId, graduated: false, reason: "adapter_unsupported" };
  }
  const row = await storage.getWorkspaceMode(workspaceId);
  if (!row || row.mode !== "learning") {
    return { workspaceId, graduated: false, reason: "not_learning" };
  }
  const record: WorkspaceModeRecord = {
    workspaceId,
    mode: row.mode,
    sessionCount: row.sessionCount,
    promoteAt: row.promoteAt,
    startedAt: row.startedAt,
    factCount: row.factCount,
    entityCount: row.entityCount,
  };
  if (!shouldGraduate(record)) {
    return { workspaceId, graduated: false, reason: "criteria_not_met" };
  }
  await storage.setWorkspaceMode(workspaceId, { mode: "production" });
  await outbox.append({
    workspaceId,
    eventType: "queue_job",
    payload: { job: "mnemo.hot.rebuild", data: { workspaceId } },
  }).catch(() => undefined);
  logger.info("workspace.graduated_learning_mode", { operation: "graduation.tick", workspaceId });
  return { workspaceId, graduated: true, eventName: "workspace.graduated_learning_mode" };
}
