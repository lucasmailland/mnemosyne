/**
 * retentionPurgeHandler — daily SOC2 CF3 retention purge cron.
 *
 * Soft-closes facts past their tier retention window for every workspace,
 * then destroys actor DEKs when all encrypted facts for that actor have
 * expired (crypto-erasure for confidential + restricted tiers).
 *
 * Env vars:
 *   MNEMO_RETENTION_INTERNAL_DAYS     — default 730
 *   MNEMO_RETENTION_CONFIDENTIAL_DAYS — default 365
 *   MNEMO_RETENTION_RESTRICTED_DAYS   — default 90
 *   MNEMO_RETENTION_DRY_RUN           — default false
 *
 * Follows the same narrow-deps + typeof-guard pattern as kekRotate.ts.
 */

export interface RetentionConfig {
  internalDays: number;
  confidentialDays: number;
  restrictedDays: number;
  /**
   * How long a managed session's raw transcript is kept after the session
   * reaches a terminal state. Separate from the sensitivity tiers above: those
   * govern extracted knowledge, this governs the verbatim host conversation,
   * which is the most sensitive thing the harness stores and the shortest-lived.
   */
  transcriptDays: number;
  dryRun: boolean;
}

export interface RetentionPurgeDeps {
  /** Port — same source as all per-workspace crons. */
  listWorkspaceIds: () => Promise<string[]>;
  /**
   * Storage adapter — uses optional purgeFacts?(), appendDeletionLog?(), and
   * destroyActorDek?(). All guarded with typeof === "function" so InMemory /
   * test adapters that lack the methods are handled gracefully.
   */
  storage: {
    purgeFacts?: (filter: {
      workspaceId: string;
      sensitivity: string;
      olderThanDays: number;
      dryRun?: boolean;
      limit?: number;
    }) => Promise<{
      softClosed: number;
      eraseCandidateActorIds: string[];
      eraseCandidateUserIds: string[];
    }>;
    appendDeletionLog?: (input: {
      workspaceId: string;
      deletedItemId: string;
      deletedItemType: string;
      deletionType: "soft" | "hard" | "gdpr_erasure" | "federation_tombstone" | "retention_purge";
      actorId: string;
      reason?: string;
    }) => Promise<void>;
    destroyActorDek?: (workspaceId: string, actorId: string) => Promise<boolean>;
    /**
     * Person-scoped crypto-erasure — destroys EVERY DEK belonging to a
     * platform user across every actor_id/key they've used. Returns the
     * count destroyed. Additive alongside destroyActorDek: a service/agent
     * actor's DEK can still be destroyed via the actor-id loop below when
     * that actor's own data qualifies; a person's DEKs ALSO get destroyed
     * via this loop when their user_id qualifies.
     */
    destroyUserDeks?: (workspaceId: string, userId: string) => Promise<number>;
  };
  logger: {
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
  };
  telemetry: {
    counter(name: string, value: number, labels: Record<string, string>): void;
  };
  /**
   * Optional per-workspace retention config resolver.
   * When present, resolve(workspaceId) is called once per workspace to obtain
   * the effective retention windows (3-tier: workspace → global sentinel → env).
   * When absent, the handler falls back to the global env-based `config` below.
   */
  retentionConfigResolver?: import("../config/RetentionConfigResolver.js").RetentionConfigResolver;
}

/**
 * Parse retention configuration from environment variables.
 * Exported for unit testing.
 */
export function parseRetentionConfig(env: NodeJS.ProcessEnv): RetentionConfig {
  const parseDays = (key: string, defaultDays: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === "") return defaultDays;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultDays;
  };

  return {
    internalDays: parseDays("MNEMO_RETENTION_INTERNAL_DAYS", 730),
    confidentialDays: parseDays("MNEMO_RETENTION_CONFIDENTIAL_DAYS", 365),
    restrictedDays: parseDays("MNEMO_RETENTION_RESTRICTED_DAYS", 90),
    transcriptDays: parseDays("MNEMO_RETENTION_TRANSCRIPT_DAYS", 30),
    dryRun: env["MNEMO_RETENTION_DRY_RUN"] === "true",
  };
}

// Tiers that require DEK destruction on full expiry.
const ENCRYPTED_TIERS = new Set(["confidential", "restricted"]);

/**
 * Retention purge cron tick.
 *
 * Iterates all workspaces × tiers. For each (workspace, tier) pair:
 * 1. Calls purgeFacts() in a paginated loop (max 20 iterations/tick,
 *    bounded by the storage layer's own LIMIT 500).
 * 2. For confidential/restricted tiers, destroys DEKs for actors whose
 *    last active encrypted facts were just soft-closed.
 * 3. Appends one summary deletion-log row per workspace (skipped on dry-run).
 */
export async function retentionPurgeHandler(deps: RetentionPurgeDeps): Promise<void> {
  if (typeof deps.storage.purgeFacts !== "function") {
    deps.logger.warn(
      {
        adapter:
          (deps.storage as { constructor?: { name?: string } }).constructor?.name ?? "unknown",
      },
      "mnemo.retention.purge: purgeFacts not implemented on storage adapter — skipping"
    );
    return;
  }

  // config supplies dryRun (env-global) and acts as env fallback when no resolver is present.
  const config = parseRetentionConfig(process.env);

  const MAX_ITERATIONS_PER_TICK = 20;
  const BATCH_LIMIT = 500;

  const workspaceIds = await deps.listWorkspaceIds();

  for (const workspaceId of workspaceIds) {
    let workspaceSoftClosed = 0;
    let workspaceDekDestroyed = 0;
    let workspaceUserDeksDestroyed = 0;

    // Resolve per-workspace windows: resolver → env fallback.
    const win = deps.retentionConfigResolver
      ? await deps.retentionConfigResolver.resolve(workspaceId)
      : config;

    const tiers: Array<{ sensitivity: string; olderThanDays: number }> = [
      { sensitivity: "internal", olderThanDays: win.internalDays },
      { sensitivity: "confidential", olderThanDays: win.confidentialDays },
      { sensitivity: "restricted", olderThanDays: win.restrictedDays },
    ];

    for (const { sensitivity, olderThanDays } of tiers) {
      let tierSoftClosed = 0;
      const allEraseCandidates = new Set<string>();
      const allUserErasureCandidates = new Set<string>();

      // Paginated loop — each purgeFacts call handles at most BATCH_LIMIT rows.
      // Loop terminates when softClosed < BATCH_LIMIT (nothing left) or we hit
      // the MAX_ITERATIONS_PER_TICK hard bound.
      let iterations = 0;
      for (;;) {
        if (iterations >= MAX_ITERATIONS_PER_TICK) {
          deps.logger.warn(
            { workspaceId, sensitivity, iterations },
            "mnemo.retention.purge: hit max iterations per tick — will resume next day"
          );
          break;
        }

        let result: {
          softClosed: number;
          eraseCandidateActorIds: string[];
          eraseCandidateUserIds: string[];
        };
        try {
          result = await (deps.storage.purgeFacts as NonNullable<typeof deps.storage.purgeFacts>)({
            workspaceId,
            sensitivity,
            olderThanDays,
            dryRun: config.dryRun,
            limit: BATCH_LIMIT,
          });
        } catch (err) {
          deps.logger.warn(
            { workspaceId, sensitivity, error: String(err) },
            "mnemo.retention.purge: purgeFacts failed (non-fatal)"
          );
          break;
        }

        tierSoftClosed += result.softClosed;
        for (const actorId of result.eraseCandidateActorIds) {
          allEraseCandidates.add(actorId);
        }
        for (const userId of result.eraseCandidateUserIds) {
          allUserErasureCandidates.add(userId);
        }

        iterations++;

        // Stop if we soft-closed fewer than BATCH_LIMIT — means no more to do.
        if (result.softClosed < BATCH_LIMIT) break;
      }

      workspaceSoftClosed += tierSoftClosed;

      // DEK destruction — only for encrypted tiers and not in dry-run.
      if (ENCRYPTED_TIERS.has(sensitivity) && !config.dryRun && allEraseCandidates.size > 0) {
        for (const actorId of allEraseCandidates) {
          if (typeof deps.storage.destroyActorDek !== "function") break;
          try {
            const destroyed = await deps.storage.destroyActorDek(workspaceId, actorId);
            if (destroyed) {
              workspaceDekDestroyed++;
              deps.logger.info(
                { workspaceId, actorId, sensitivity },
                "mnemo.retention.purge: DEK destroyed"
              );
            }
          } catch (err) {
            deps.logger.warn(
              { workspaceId, actorId, sensitivity, error: String(err) },
              "mnemo.retention.purge: destroyActorDek failed (non-fatal)"
            );
          }
        }
      }

      // Person-scoped DEK destruction — additive alongside the actor-id loop
      // above, not a replacement. A person with multiple keys has multiple
      // actor-keyed DEKs; this destroys ALL of them in one call per qualifying
      // user, which is what makes erasure actually per-person. Their DEKs may
      // still individually qualify via the actor-id loop too — both running is
      // fine, destroyUserDeks/destroyActorDek are idempotent (a destroyed DEK
      // simply isn't matched by the 'active' status filter a second time).
      if (ENCRYPTED_TIERS.has(sensitivity) && !config.dryRun && allUserErasureCandidates.size > 0) {
        for (const userId of allUserErasureCandidates) {
          if (typeof deps.storage.destroyUserDeks !== "function") break;
          try {
            const destroyedCount = await deps.storage.destroyUserDeks(workspaceId, userId);
            if (destroyedCount > 0) {
              workspaceUserDeksDestroyed += destroyedCount;
              deps.logger.info(
                { workspaceId, userId, sensitivity, destroyedCount },
                "mnemo.retention.purge: user DEKs destroyed"
              );
            }
          } catch (err) {
            deps.logger.warn(
              { workspaceId, userId, sensitivity, error: String(err) },
              "mnemo.retention.purge: destroyUserDeks failed (non-fatal)"
            );
          }
        }
      }

      deps.logger.info(
        { workspaceId, sensitivity, softClosed: tierSoftClosed, dryRun: config.dryRun },
        "mnemo.retention.purge: tier complete"
      );
      deps.telemetry.counter("mnemo_retention_purged_total", tierSoftClosed, {
        ws: workspaceId,
        tier: sensitivity,
      });
    }

    // One summary deletion-log row per workspace run (skipped on dry-run).
    if (!config.dryRun && workspaceSoftClosed > 0) {
      try {
        await deps.storage.appendDeletionLog?.({
          workspaceId,
          deletedItemId: workspaceId,
          deletedItemType: "fact_batch",
          deletionType: "retention_purge",
          actorId: "system",
          reason: `retention_purge: softClosed=${workspaceSoftClosed} dekDestroyed=${workspaceDekDestroyed} userDeksDestroyed=${workspaceUserDeksDestroyed}`,
        });
      } catch (err) {
        deps.logger.warn(
          { workspaceId, error: String(err) },
          "mnemo.retention.purge: appendDeletionLog failed (non-fatal)"
        );
      }
    }

    deps.logger.info(
      {
        workspaceId,
        softClosed: workspaceSoftClosed,
        dekDestroyed: workspaceDekDestroyed,
        userDeksDestroyed: workspaceUserDeksDestroyed,
        dryRun: config.dryRun,
      },
      "mnemo.retention.purge: workspace complete"
    );
  }
}
