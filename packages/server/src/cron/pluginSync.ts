/**
 * Plugin crons: `mnemo.plugin.sync:<id>` and `mnemo.plugin.verify`.
 *
 * Sync: one cron job per plugin that implements `sync()`, every
 * `syncInterval` ms the plugin declares (at least {@link PLUGIN_SYNC_MIN_MS}),
 * or every `MNEMO_PLUGIN_SYNC_INTERVAL_MS` (1 h) without one. A job per plugin
 * gives each its own schedule and its own advisory lock, so with several
 * replicas each plugin still syncs once per period. Its context is the
 * workspace in the plugin's config (`MNEMO_PLUGIN_<ID>__WORKSPACE_ID`):
 * without one the sync is skipped, since there is no workspace to write to.
 * `MNEMO_CRON_DISABLE=mnemo.plugin.sync` turns them all off.
 *
 * Verify: daily, each plugin that implements `verify()` gets the code, config
 * and infrastructure facts (the same candidates as `mnemo.verify.codebase`)
 * of its own workspace (`MNEMO_PLUGIN_<ID>__WORKSPACE_ID`, skipped with a
 * warning without one, like sync), only those at or below its sensitivity
 * ceiling (`MNEMO_PLUGIN_<ID>__MAX_SENSITIVITY`, default `internal`), in
 * batches, as `{ id, content, metadata }`. A fact returned with
 * `valid: false` lands in that workspace's review queue
 * (`plugin_verification_failed`). Flagging rather than closing the fact keeps
 * a misconfigured verifier from invalidating memory on its own.
 *
 * Dependencies are duck-typed so the cron module stays decoupled from the
 * optional @mnemo-ai/plugins peer dependency.
 */
import { SENSITIVITY_ORDER, type Sensitivity, type StorageAdapter } from "@mnemo-ai/types";
import type { CronJob } from "./registry.js";

/** Minimal duck-typed PluginContext shape the loader expects. */
export interface PluginContextLike {
  workspaceId: string;
}

/** Duck-typed PluginLoader: only the methods the plugin crons need. */
export interface PluginLoaderLike {
  runSync(ctx: PluginContextLike, pluginId?: string): Promise<void>;
  runVerify(
    facts: Array<{ id: string; [k: string]: unknown }>,
    ctx: PluginContextLike,
    pluginId?: string
  ): Promise<Array<{ factId: string; valid: boolean; reason?: string }>>;
  syncPlugins(): Array<{ id: string; syncInterval?: number; workspaceId?: string }>;
  verifyPlugins(): Array<{ id: string; workspaceId?: string; maxSensitivity: Sensitivity }>;
}

export interface PluginCronDeps {
  /** Absent when the plugin system is not loaded: the crons no-op. */
  pluginLoader?: PluginLoaderLike;
  /** Factory for PluginContext instances. Absent: the crons warn and no-op. */
  buildPluginContext?: (opts: {
    pluginId: string;
    config: Record<string, string | undefined>;
    workspaceId: string;
    deps: unknown;
    logger: {
      info(obj: Record<string, unknown>, msg?: string): void;
      warn(obj: Record<string, unknown>, msg?: string): void;
      error(obj: Record<string, unknown>, msg?: string): void;
    };
  }) => PluginContextLike;
  /** Server deps forwarded into buildPluginContext. */
  serverDeps?: unknown;
  logger: {
    info(o: object, m?: string): void;
    warn(o: object, m?: string): void;
  };
}

/** Floor for a plugin's declared `syncInterval`, so a tiny value cannot spin the cron. */
export const PLUGIN_SYNC_MIN_MS = 60_000;
const VERIFY_BATCH = 50;

function contextFor(deps: PluginCronDeps, pluginId: string, workspaceId: string) {
  return deps.buildPluginContext!({
    pluginId,
    config: {},
    workspaceId,
    deps: deps.serverDeps,
    logger: {
      info: (o, m) => deps.logger.info(o, m),
      warn: (o, m) => deps.logger.warn(o, m),
      error: (o, m) => deps.logger.warn(o, m),
    },
  });
}

/** One cron job per plugin that implements `sync()`, on that plugin's own interval. */
export function pluginSyncJobs(deps: PluginCronDeps): CronJob[] {
  const fallbackMs = Number(process.env["MNEMO_PLUGIN_SYNC_INTERVAL_MS"]) || 3_600_000;
  return (deps.pluginLoader?.syncPlugins() ?? []).map((p) => ({
    key: `mnemo.plugin.sync:${p.id}`,
    schedule: {
      kind: "interval" as const,
      ms: Math.max(PLUGIN_SYNC_MIN_MS, p.syncInterval ?? fallbackMs),
    },
    handler: () => pluginSyncHandler(deps, p.id, p.workspaceId),
  }));
}

/** Runs one plugin's `sync()` in its configured workspace. */
export async function pluginSyncHandler(
  deps: PluginCronDeps,
  pluginId: string,
  workspaceId: string | undefined
): Promise<void> {
  if (!deps.pluginLoader) return;
  if (!workspaceId) {
    deps.logger.warn(
      { plugin: pluginId },
      "mnemo.plugin.sync: no workspace for this plugin (MNEMO_PLUGIN_<ID>__WORKSPACE_ID), skipping"
    );
    return;
  }
  if (!deps.buildPluginContext) {
    deps.logger.warn({ plugin: pluginId }, "mnemo.plugin.sync: buildPluginContext unavailable");
    return;
  }
  await deps.pluginLoader.runSync(contextFor(deps, "__cron_sync__", workspaceId), pluginId);
  deps.logger.info({ plugin: pluginId, workspaceId }, "mnemo.plugin.sync: completed");
}

/**
 * Runs each verifying plugin over its own workspace's drift candidates, up to
 * its sensitivity ceiling. Returns the facts flagged. One plugin failing does
 * not stop the others.
 */
export async function pluginVerifyHandler(
  deps: PluginCronDeps & {
    storage: Pick<StorageAdapter, "queryDriftCandidates" | "enqueueReviewItem">;
  }
): Promise<number> {
  const loader = deps.pluginLoader;
  if (!loader || !deps.buildPluginContext) return 0;
  let flagged = 0;
  for (const p of loader.verifyPlugins()) {
    if (!p.workspaceId) {
      deps.logger.warn(
        { plugin: p.id },
        "mnemo.plugin.verify: no workspace for this plugin (MNEMO_PLUGIN_<ID>__WORKSPACE_ID), skipping"
      );
      continue;
    }
    try {
      flagged += await verifyOne(deps, loader, p.id, p.workspaceId, p.maxSensitivity);
    } catch (err) {
      deps.logger.warn({ plugin: p.id, err }, "mnemo.plugin.verify: plugin run failed");
    }
  }
  return flagged;
}

async function verifyOne(
  deps: PluginCronDeps & {
    storage: Pick<StorageAdapter, "queryDriftCandidates" | "enqueueReviewItem">;
  },
  loader: PluginLoaderLike,
  pluginId: string,
  workspaceId: string,
  ceiling: Sensitivity
): Promise<number> {
  const candidates = (await deps.storage.queryDriftCandidates(workspaceId)).filter(
    (f) => SENSITIVITY_ORDER[f.sensitivity] <= SENSITIVITY_ORDER[ceiling]
  );
  const ctx = contextFor(deps, "__cron_verify__", workspaceId);
  let flagged = 0;
  for (let i = 0; i < candidates.length; i += VERIFY_BATCH) {
    const batch = candidates.slice(i, i + VERIFY_BATCH);
    const ids = new Set(batch.map((f) => f.id));
    // Only what a verifier needs; never the whole row.
    const facts = batch.map((f) => ({ id: f.id, content: f.statement, metadata: f.metadata }));
    for (const r of await loader.runVerify(facts, ctx, pluginId)) {
      // Only facts of this batch: a plugin cannot file reviews for ids it was not given.
      if (r.valid || !ids.has(r.factId)) continue;
      await deps.storage.enqueueReviewItem({
        workspaceId,
        primitiveId: r.factId,
        primitiveKind: "fact",
        reason: "plugin_verification_failed",
        detail: {
          plugin: pluginId,
          ...(r.reason ? { reason: String(r.reason).slice(0, 500) } : {}),
        },
      });
      flagged++;
    }
  }
  if (flagged > 0)
    deps.logger.info(
      { plugin: pluginId, workspaceId, flagged },
      "mnemo.plugin.verify: facts sent to review"
    );
  return flagged;
}
