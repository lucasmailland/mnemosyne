import { logger } from "../logging.js";
import type { MnemoBusEvent } from "@mnemo-ai/types";
import { MNEMO_SPAN_NAMES } from "@mnemo-ai/types";

export async function wirePlugins(ctx: {
  deps: import("../deps.js").ServerDeps;
}): Promise<import("@mnemo-ai/plugins").PluginLoader | undefined> {
  const { deps } = ctx;
  // ---- Plugin loader (optional peer dep) ----
  // SECURITY: Plugins run in-process with full server privileges.
  // Every package listed in MNEMO_PLUGINS has unconditional access to all
  // server resources (memory, fs, network, secrets). No sandbox. No isolation.
  // Only load plugins from sources you unconditionally trust.
  let pluginLoader: import("@mnemo-ai/plugins").PluginLoader | undefined;
  try {
    const pluginsMod = await import("@mnemo-ai/plugins");
    const pLogger: import("@mnemo-ai/plugins").PluginLogger = {
      info: (msg, ctx) => logger.info(ctx ?? {}, msg),
      warn: (msg, ctx) => logger.warn(ctx ?? {}, msg),
      error: (msg, ctx) => logger.error(ctx ?? {}, msg),
    };
    const { buildPluginContext: bpcBoot } = await import("../plugins/context.js");
    // Every caller builds ONE shared context (`pluginId: "__boot__"`, `config: {}`
    // here and below); the loader turns it into each plugin's own context with
    // this factory: its own state, rate limit, actor id, config
    // (MNEMO_PLUGIN_<ID>__<KEY>) and sensitivity ceiling.
    pluginLoader = await pluginsMod.createPluginLoaderFromEnv(pLogger, (pluginId, config, shared) =>
      bpcBoot({
        pluginId,
        config,
        workspaceId: shared.workspaceId,
        deps,
        logger: {
          info: (o, m) => logger.info(o, m),
          warn: (o, m) => logger.warn(o, m),
          error: (o, m) => logger.error(o, m),
        },
      })
    );
    // Build a boot PluginContext; state/recall are no-ops during boot.
    const bootCtx = bpcBoot({
      pluginId: "__boot__",
      config: {},
      workspaceId: "default",
      deps,
      logger: {
        info: (o, m) => logger.info(o, m),
        warn: (o, m) => logger.warn(o, m),
        error: (o, m) => logger.error(o, m),
      },
    });
    await pluginLoader.runBoot(bootCtx);
    const loadedPlugins = pluginLoader.list();
    if (loadedPlugins.length > 0) {
      logger.info({ plugins: loadedPlugins }, "plugins.booted");
    }

    // Assign to deps so route handlers can access the loader.
    deps.pluginLoader = pluginLoader;

    // Subscribe async event hooks to the Q bus (fire-and-forget, non-blocking).
    // Each event is dispatched to all active plugins via runEventHook().
    if (deps.bus) {
      const { buildPluginContext } = await import("../plugins/context.js");
      const eventHookNames: import("@mnemo-ai/plugins").PluginEventHookName[] = [
        "onFactCreated",
        "onTaskCompleted",
        "onSessionCollapsed",
        "onConflictDetected",
        "onWorthChanged",
        "onEventRecorded",
      ];
      for (const hookName of eventHookNames) {
        // Map bus event type names to plugin hook names.
        // bus event types follow "fact.created", "task.completed", etc.
        const busEventType = hookName
          .replace(/^on/, "")
          .replace(/([A-Z])/g, ".$1")
          .toLowerCase()
          .slice(1); // "fact.created", "task.completed", etc.
        deps.bus.subscribe(busEventType, (event: MnemoBusEvent<unknown>) => {
          const workspaceId =
            (event as MnemoBusEvent<unknown> & { workspaceId?: string }).workspaceId ?? "default";
          const ctx = buildPluginContext({
            pluginId: `__bus_${hookName}__`,
            config: {},
            workspaceId,
            deps,
            logger: {
              info: (o, m) => logger.info(o, m),
              warn: (o, m) => logger.warn(o, m),
              error: (o, m) => logger.error(o, m),
            },
          });
          const span = deps.telemetry.startSpan(MNEMO_SPAN_NAMES.plugin(hookName), {
            attributes: { "mnemo.plugin.hook": hookName, "mnemo.workspace_id": workspaceId },
          });
          pluginLoader!
            .runEventHook(hookName, event, ctx)
            .then(() => {
              span.end();
            })
            .catch((err) => {
              span.setStatus("error", String(err));
              span.end();
              logger.warn({ err, hookName }, "plugins.event_hook_error");
            });
        });
      }
      logger.info({ count: eventHookNames.length }, "plugins.bus_hooks_subscribed");
    }

    // NOTE: plugin sync is now registered as mnemo.plugin.sync in the cron
    // registry (see packages/server/src/cron/pluginSync.ts). The raw setInterval
    // that was here (~lines 1096-1115) has been removed to prevent double-firing.

    return pluginLoader;
  } catch (err) {
    logger.warn({ err }, "plugins.loader_unavailable");
    return undefined;
  }
}
