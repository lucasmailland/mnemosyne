import type { StorageAdapter } from "@mnemo-ai/types";

/** One page. The storage layer locks and skips rows it cannot take, so a page
 * that comes back full means there is probably more due work behind it. */
const BATCH_LIMIT = 500;

/** Ceiling per workspace per tick. A workspace with a huge backlog drains over
 * several nights rather than holding one tick — and the rest of the estate — open. */
const MAX_PAGES_PER_WORKSPACE = 20;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ManagedSessionRetentionDeps {
  storage: Pick<StorageAdapter, "purgeManagedTurns">;
  listWorkspaceIds(): Promise<string[]>;
  /** Effective managed-transcript window for one workspace, in days. */
  resolveTranscriptDays(workspaceId: string): Promise<number>;
  now?: () => Date;
  logger: {
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
  };
}

export interface ManagedSessionRetentionResult {
  workspaces: number;
  deleted: number;
  failedWorkspaces: number;
}

/**
 * Nightly purge of managed raw transcripts past their retention window.
 *
 * Deliberately per-workspace: the window is workspace-configurable, so one global
 * cutoff would either over-retain for a strict workspace or over-delete for a
 * lenient one.
 *
 * Never throws. Retention that stops running because one workspace is broken is
 * a compliance problem, not a resilience one — so a failure is counted, logged
 * without detail, and the sweep moves on.
 */
export async function managedSessionRetentionHandler(
  deps: ManagedSessionRetentionDeps
): Promise<ManagedSessionRetentionResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result: ManagedSessionRetentionResult = {
    workspaces: 0,
    deleted: 0,
    failedWorkspaces: 0,
  };

  const purgeManagedTurns = deps.storage.purgeManagedTurns;
  // Optional on the port: an adapter without it cannot honour the window, and
  // silently "succeeding" would misreport transcripts as retained-and-purged.
  if (typeof purgeManagedTurns !== "function") {
    deps.logger.warn({ operation: "managed_retention.unsupported_adapter" });
    return result;
  }

  let workspaceIds: string[];
  try {
    workspaceIds = await deps.listWorkspaceIds();
  } catch {
    deps.logger.warn({ operation: "managed_retention.enumerate_failed" });
    return result;
  }

  for (const workspaceId of workspaceIds) {
    result.workspaces += 1;
    try {
      // Resolved first and separately: without a window there is no defensible
      // cutoff, and defaulting here would delete data on a config outage.
      const transcriptDays = await deps.resolveTranscriptDays(workspaceId);
      if (!Number.isFinite(transcriptDays) || transcriptDays <= 0) {
        throw new Error("unusable retention window");
      }
      const terminalBefore = new Date(now.getTime() - transcriptDays * MS_PER_DAY);

      for (let page = 0; page < MAX_PAGES_PER_WORKSPACE; page += 1) {
        const deleted = await purgeManagedTurns.call(deps.storage, {
          workspaceId,
          terminalBefore,
          limit: BATCH_LIMIT,
        });
        result.deleted += deleted;
        if (deleted < BATCH_LIMIT) break;
      }
    } catch {
      result.failedWorkspaces += 1;
      // No error message and no workspace-scoped identifiers: a purge failure must
      // not become the place a transcript or a session id shows up in the logs.
      deps.logger.warn({ operation: "managed_retention.workspace_failed" });
    }
  }

  deps.logger.info({
    operation: "managed_retention.tick",
    workspaces: result.workspaces,
    deleted: result.deleted,
    failed_workspaces: result.failedWorkspaces,
  });
  return result;
}
