/**
 * kekRotate — quarterly KEK rotation cron handler.
 *
 * Gated behind MNEMO_KEK_ROTATE_ENABLED=true — no-ops when unset or false.
 *
 * The actual per-workspace rotation logic lives in
 * @mnemo-ai/adapter-postgres (rotateWorkspaceKek). The handler here iterates
 * all workspaces via the CronDeps.listWorkspaceIds() port and delegates to an
 * optional `rotateWorkspaceKek(workspaceId)` method on the storage adapter.
 * Per-workspace errors are caught non-fatally so one broken workspace cannot
 * abort the rotation of the rest.
 */

export interface KekRotateDeps {
  /** Direct port — same source used by all per-workspace crons. */
  listWorkspaceIds: () => Promise<string[]>;
  /**
   * Storage adapter — may optionally expose rotateWorkspaceKek().
   * Guarded with typeof === "function" so in-memory / test adapters that lack
   * the method are handled gracefully (the cron no-ops for that workspace).
   */
  storage: {
    rotateWorkspaceKek?: (workspaceId: string) => Promise<void>;
  };
  logger: {
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
  };
}

/**
 * Rotates the KEK for all workspaces.
 * No-ops when MNEMO_KEK_ROTATE_ENABLED is absent or not "true".
 */
export async function kekRotateHandler(deps: KekRotateDeps): Promise<void> {
  if (process.env["MNEMO_KEK_ROTATE_ENABLED"] !== "true") {
    deps.logger.info(
      { flag: "MNEMO_KEK_ROTATE_ENABLED" },
      "mnemo.kek.rotate: skipped (MNEMO_KEK_ROTATE_ENABLED not set)",
    );
    return;
  }

  if (typeof deps.storage.rotateWorkspaceKek !== "function") {
    deps.logger.warn(
      { adapter: deps.storage.constructor?.name ?? "unknown" },
      "mnemo.kek.rotate: rotateWorkspaceKek not implemented on storage adapter — skipping",
    );
    return;
  }

  const workspaceIds = await deps.listWorkspaceIds();
  let rotated = 0;
  let failed = 0;

  for (const workspaceId of workspaceIds) {
    try {
      // Re-check inside loop in case adapter shape changes (defensive).
      await (deps.storage.rotateWorkspaceKek as (ws: string) => Promise<void>)(workspaceId);
      rotated++;
    } catch (err) {
      failed++;
      deps.logger.warn(
        { workspaceId, error: String(err) },
        "mnemo.kek.rotate: workspace rotation failed (non-fatal)",
      );
    }
  }

  deps.logger.info({ rotated, failed, total: workspaceIds.length }, "mnemo.kek.rotate: completed");
}
