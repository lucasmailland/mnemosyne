// =============================================================================
// SECURITY WARNING — In-process plugin execution
// =============================================================================
// Plugins loaded by PluginLoader run INSIDE the Mnemosyne server process with
// FULL access to all server resources: memory, file system, network, database
// connections, environment variables (including secrets), and every imported
// module. There is NO sandbox, NO capability restriction, and NO isolation.
//
// Loading a plugin is equivalent to granting that package unconditional access
// as the server process user. Treat plugin packages with the same scrutiny as
// production server code. Only load plugins from sources you unconditionally
// trust. Never set MNEMO_PLUGINS to packages you have not audited.
// =============================================================================

import { SENSITIVITY_ORDER, type Sensitivity } from "@mnemo-ai/types";
import { BUILTIN_FACTORIES } from "./builtins/index.js";

// ─── Sensitivity ceiling (plugin write-path) ────────────────────────────────────
//
// A plugin must not be able to write — or, combined with recall, surface —
// memory above the station it was granted. Each PluginContext carries a
// `maxSensitivity` ceiling; the write path caps every fact's sensitivity to it.
//
// We compare via SENSITIVITY_ORDER (the integer tier map), NEVER string
// equality/alphabetic comparison (MED-23: "confidential" > "internal" is
// alphabetically true but semantically inverted). SENSITIVITY_ORDER is imported
// from @mnemo-ai/types — we deliberately do NOT import the server's rbac.ts
// (that would invert the hexagonal layering).

/** Conservative default ceiling when a plugin has no explicit grant. */
export const DEFAULT_PLUGIN_MAX_SENSITIVITY: Sensitivity = "internal";

/**
 * Clamp a requested sensitivity down to the plugin's ceiling.
 *
 * Returns `ceiling` whenever the request exceeds it (downgrade), otherwise
 * the request unchanged. When `requested` is undefined the fact carries no
 * explicit sensitivity, so there is nothing to clamp and we return undefined
 * (the storage layer applies its own default).
 *
 * Comparison is via SENSITIVITY_ORDER — never string comparison (MED-23).
 */
export function clampSensitivity(
  requested: Sensitivity | undefined,
  ceiling: Sensitivity
): Sensitivity | undefined {
  if (requested === undefined) return undefined;
  return SENSITIVITY_ORDER[requested] > SENSITIVITY_ORDER[ceiling] ? ceiling : requested;
}

/**
 * The ceiling a plugin's own config grants: `config.maxSensitivity` when it is
 * a valid tier (`MNEMO_PLUGIN_<ID>__MAX_SENSITIVITY` on the server), else
 * {@link DEFAULT_PLUGIN_MAX_SENSITIVITY}.
 */
export function resolvePluginMaxSensitivity(
  config: Record<string, string | undefined> | undefined
): Sensitivity {
  const raw = config?.["maxSensitivity"];
  return raw !== undefined && Object.hasOwn(SENSITIVITY_ORDER, raw)
    ? (raw as Sensitivity)
    : DEFAULT_PLUGIN_MAX_SENSITIVITY;
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * Minimal structured logger passed to plugins. Intentionally simpler than
 * pino so plugins do not need to depend on the server's logging library.
 */
export interface PluginLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

// Domain shapes are intentionally structural (subset of @mnemo-ai/types) so
// @mnemo-ai/plugins keeps a single dependency. The server passes the real types.
export interface PluginKnowledgeUnit {
  content: string;
  subject?: string;
  kind?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Requested sensitivity tier. Capped to the context's `maxSensitivity` on write. */
  sensitivity?: Sensitivity;
}
export interface PluginRecallInput {
  query: string;
  topK?: number;
  vector?: number[];
}
export interface PluginRecallHit {
  id: string;
  content: string;
  score: number;
  [k: string]: unknown;
}
export interface PluginFact {
  id: string;
  [k: string]: unknown;
}
export interface PluginTask {
  id: string;
  [k: string]: unknown;
}
export interface PluginEvent {
  id: string;
  [k: string]: unknown;
}
export interface PluginCreateFactInput {
  content: string;
  subject?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  sensitivity?: Sensitivity;
}
export interface PluginCreateEventInput {
  type: string;
  payload?: Record<string, unknown>;
  sessionId?: string;
}
export interface PluginCreateTaskInput {
  title: string;
  description?: string;
  assignedTo?: string;
  metadata?: Record<string, unknown>;
}
export interface PluginCreateEpisodeInput {
  title: string;
  narrative?: string;
  metadata?: Record<string, unknown>;
}
export interface PluginEpisode {
  id: string;
  [k: string]: unknown;
}
export interface SessionCollapseSummary {
  sessionId: string;
  summary: string;
  [k: string]: unknown;
}
export interface FactConflict {
  factAId: string;
  factBId: string;
  reason?: string;
  [k: string]: unknown;
}
export interface PluginHealth {
  healthy: boolean;
  detail?: string;
}
export interface SyncResult {
  itemsSynced: number;
  cursor?: string;
}
export interface VerificationResult {
  factId: string;
  valid: boolean;
  reason?: string;
}

/** Constrained per-plugin key-value store, persisted in mnemo_plugin_state.state. */
export interface PluginStateStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * Constrained context handed to every hook. The server builds this; the methods
 * present here are the ENTIRE surface a plugin gets. There is intentionally NO
 * raw DB connection, NO cross-workspace access, NO admin op, NO peek at other
 * plugins' state. (spec §21 lines 1665–1687)
 */
export interface PluginContext {
  readonly workspaceId: string;
  readonly logger: PluginLogger;
  readonly config: Record<string, string | undefined>;
  /**
   * Sensitivity ceiling granted to this plugin. The write path MUST cap the
   * sensitivity of any fact it creates to this tier via {@link clampSensitivity}
   * (compared with SENSITIVITY_ORDER, never string equality — MED-23). Defaults
   * to {@link DEFAULT_PLUGIN_MAX_SENSITIVITY} ("internal") when the server grants
   * no explicit per-plugin ceiling.
   */
  readonly maxSensitivity: Sensitivity;
  // Read (RBAC-scoped to workspaceId)
  recall(query: string): Promise<PluginRecallHit[]>;
  getFact(id: string): Promise<PluginFact | null>;
  // Write (rate-limited + audited; actorId = "plugin:<id>"; sensitivity clamped to maxSensitivity)
  createFact(input: PluginCreateFactInput): Promise<PluginFact>;
  createEvent(input: PluginCreateEventInput): Promise<PluginEvent>;
  createTask(input: PluginCreateTaskInput): Promise<PluginTask>;
  createEpisode(input: PluginCreateEpisodeInput): Promise<PluginEpisode>;
  // Plugin-private state + logging
  readonly state: PluginStateStore;
  readonly log: PluginLogger;
}

/**
 * Full plugin contract (spec §21 lines 1614–1646). All hooks optional.
 * onBoot/onShutdown are retained as deprecated aliases of onInit/onShutdown so
 * the existing server boot wiring keeps compiling.
 */
export interface MnemoPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;

  // Lifecycle
  onInit?(ctx: PluginContext): Promise<void> | void;
  onShutdown?(ctx?: PluginContext): Promise<void> | void;
  /** Reported by the server in the `plugins` block of `GET /health/deep`. */
  onHealthCheck?(): Promise<PluginHealth> | PluginHealth;
  /** @deprecated alias of onInit — kept for back-compat with the old loader. */
  onBoot?(ctx: PluginContext): Promise<void> | void;

  // Write-path (sync, can modify pipeline; null = reject the write)
  onBeforeWrite?(
    unit: PluginKnowledgeUnit,
    ctx: PluginContext
  ): PluginKnowledgeUnit | null | Promise<PluginKnowledgeUnit | null>;
  onAfterWrite?(unit: PluginKnowledgeUnit, ctx: PluginContext): void | Promise<void>;

  // Read-path (sync, can modify)
  onBeforeRecall?(
    input: PluginRecallInput,
    ctx: PluginContext
  ): PluginRecallInput | Promise<PluginRecallInput>;
  onAfterRecall?(
    hits: PluginRecallHit[],
    ctx: PluginContext
  ): PluginRecallHit[] | Promise<PluginRecallHit[]>;

  // Event hooks (async, non-blocking — fired off the Q bus)
  onFactCreated?(fact: PluginFact, ctx: PluginContext): Promise<void>;
  onTaskCompleted?(task: PluginTask, ctx: PluginContext): Promise<void>;
  onSessionCollapsed?(summary: SessionCollapseSummary, ctx: PluginContext): Promise<void>;
  onConflictDetected?(conflict: FactConflict, ctx: PluginContext): Promise<void>;
  onWorthChanged?(memoryId: string, newWorth: number, ctx: PluginContext): Promise<void>;
  onEventRecorded?(
    event: {
      id: string;
      name: string;
      type: string;
      source?: string;
      metadata?: Record<string, unknown>;
      workspaceId: string;
    },
    ctx: PluginContext
  ): Promise<void>;

  // Sync (polling). The server runs sync() every `syncInterval` ms (at least
  // 60 000), or every MNEMO_PLUGIN_SYNC_INTERVAL_MS (1 h) without one.
  syncInterval?: number;
  sync?(ctx: PluginContext): Promise<SyncResult>;

  // Verification. The server passes, daily, the code, config and
  // infrastructure facts of the plugin's workspace (MNEMO_PLUGIN_<ID>__WORKSPACE_ID)
  // up to its sensitivity ceiling, as { id, content, metadata }; a fact
  // returned with `valid: false` goes to that workspace's review queue.
  verify?(facts: PluginFact[], ctx: PluginContext): Promise<VerificationResult[]>;
}

/** @deprecated use MnemoPlugin. Retained so old code/tests still type. */
export type Plugin = MnemoPlugin;

/** Builds the context one plugin gets, from its id, its config and the caller's shared context. */
export type PluginContextFactory = (
  pluginId: string,
  config: Record<string, string | undefined>,
  shared: PluginContext
) => PluginContext;

/** The async event-hook names the bus drives. */
export type PluginEventHookName =
  | "onFactCreated"
  | "onTaskCompleted"
  | "onSessionCollapsed"
  | "onConflictDetected"
  | "onWorthChanged"
  | "onEventRecorded";

/**
 * Describes how to locate and instantiate a plugin. Currently only the
 * `'package'` type is supported (dynamic import of an npm package name).
 */
export interface PluginRegistration {
  type: "package";
  /** npm package name resolved via Node's standard module resolution. */
  packageName: string;
  /**
   * Optional config map passed to the plugin's PluginContext. When absent,
   * `load()` reads it from the environment with {@link pluginConfigFromEnv}.
   */
  config?: Record<string, string | undefined>;
}

/**
 * Result returned by {@link PluginLoader.load} for each registration attempt.
 * Callers can inspect status/error without needing to catch exceptions.
 */
export interface PluginLoadResult {
  id: string;
  name: string;
  version: string;
  status: "loaded" | "failed";
  error?: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const SHUTDOWN_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Plugin hook timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// ─── PluginLoader ─────────────────────────────────────────────────────────────

/**
 * Loads, tracks, and orchestrates lifecycle hooks for Mnemosyne plugins.
 *
 * **SECURITY**: All plugins run in-process. See the top-of-file warning.
 */
export class PluginLoader {
  readonly _logger: PluginLogger;
  private readonly _entries: Array<{
    plugin: MnemoPlugin;
    config: Record<string, string | undefined>;
    disabled: boolean;
    consecutiveFailures: number;
  }> = [];

  private static readonly HOOK_TIMEOUT_MS = 2_000;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;

  /**
   * @param contextFor - Builds the context ONE plugin gets from the caller's
   *   shared one. The server passes its buildPluginContext so each plugin has
   *   its own state store, rate limit, actor id and sensitivity ceiling. Without
   *   it, a plugin gets the caller's context with its own config and ceiling
   *   but the caller's state store.
   */
  constructor(
    logger: PluginLogger,
    private readonly contextFor?: PluginContextFactory
  ) {
    this._logger = logger;
  }

  /** Direct registration (used by tests and the built-in registry). */
  register(plugin: MnemoPlugin, config: Record<string, string | undefined> = {}): void {
    this._entries.push({ plugin, config, disabled: false, consecutiveFailures: 0 });
  }

  private activeEntries() {
    return this._entries.filter((e) => !e.disabled);
  }

  /** The context for THIS plugin: callers build one shared context for all plugins. */
  private ctxFor(entry: (typeof this._entries)[number], ctx: PluginContext): PluginContext {
    if (this.contextFor) return this.contextFor(entry.plugin.id, entry.config, ctx);
    return {
      ...ctx,
      config: entry.config,
      maxSensitivity: resolvePluginMaxSensitivity(entry.config),
    };
  }

  /** Wrap a hook call with timeout + auto-disable (MNEMO_010). Returns sentinel on failure. */
  private async guard<T>(
    entry: (typeof this._entries)[number],
    label: string,
    fn: () => Promise<T> | T,
    fallback: T
  ): Promise<T> {
    try {
      const result = await withTimeout(Promise.resolve(fn()), PluginLoader.HOOK_TIMEOUT_MS);
      entry.consecutiveFailures = 0;
      return result;
    } catch (err) {
      entry.consecutiveFailures += 1;
      const timedOut = err instanceof Error && err.message.includes("timed out");
      this._logger.warn(timedOut ? "MNEMO_010" : "plugin.hook_failed", {
        id: entry.plugin.id,
        hook: label,
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures: entry.consecutiveFailures,
      });
      if (timedOut || entry.consecutiveFailures >= PluginLoader.MAX_CONSECUTIVE_FAILURES) {
        entry.disabled = true;
        this._logger.error("MNEMO_010", {
          id: entry.plugin.id,
          reason: timedOut ? "timeout" : "repeated_failure",
        });
      }
      return fallback;
    }
  }

  /** Write-path: chain onBeforeWrite. A null from any plugin rejects the write. */
  async runBeforeWrite(
    unit: PluginKnowledgeUnit,
    ctx: PluginContext
  ): Promise<PluginKnowledgeUnit | null> {
    let current: PluginKnowledgeUnit | null = unit;
    for (const entry of this.activeEntries()) {
      if (current === null || typeof entry.plugin.onBeforeWrite !== "function") continue;
      const prev: PluginKnowledgeUnit = current;
      // guard returns the fallback (prev) on timeout/throw; explicit null return from a plugin propagates
      const guardResult = await this.guard<PluginKnowledgeUnit | null>(
        entry,
        "onBeforeWrite",
        () => entry.plugin.onBeforeWrite!(prev, this.ctxFor(entry, ctx)),
        prev
      );
      current = guardResult;
    }
    // Sensitivity ceiling: a plugin must not write above its granted station.
    // Applied AFTER the hook chain so a plugin can't re-escalate post-clamp.
    // Compared via SENSITIVITY_ORDER inside clampSensitivity — never string compare (MED-23).
    if (current !== null && current.sensitivity !== undefined) {
      const clamped = clampSensitivity(current.sensitivity, ctx.maxSensitivity);
      if (clamped !== current.sensitivity) {
        this._logger.warn("plugin.sensitivity_clamped", {
          workspaceId: ctx.workspaceId,
          requested: current.sensitivity,
          ceiling: ctx.maxSensitivity,
        });
        current = { ...current, ...(clamped !== undefined ? { sensitivity: clamped } : {}) };
      }
    }
    return current;
  }

  async runAfterWrite(unit: PluginKnowledgeUnit, ctx: PluginContext): Promise<void> {
    for (const entry of this.activeEntries()) {
      if (typeof entry.plugin.onAfterWrite !== "function") continue;
      await this.guard(
        entry,
        "onAfterWrite",
        () => entry.plugin.onAfterWrite!(unit, this.ctxFor(entry, ctx)),
        undefined
      );
    }
  }

  async runBeforeRecall(input: PluginRecallInput, ctx: PluginContext): Promise<PluginRecallInput> {
    let current = input;
    for (const entry of this.activeEntries()) {
      if (typeof entry.plugin.onBeforeRecall !== "function") continue;
      current = await this.guard(
        entry,
        "onBeforeRecall",
        () => entry.plugin.onBeforeRecall!(current, this.ctxFor(entry, ctx)),
        current
      );
    }
    return current;
  }

  async runAfterRecall(hits: PluginRecallHit[], ctx: PluginContext): Promise<PluginRecallHit[]> {
    let current = hits;
    for (const entry of this.activeEntries()) {
      if (typeof entry.plugin.onAfterRecall !== "function") continue;
      current = await this.guard(
        entry,
        "onAfterRecall",
        () => entry.plugin.onAfterRecall!(current, this.ctxFor(entry, ctx)),
        current
      );
    }
    return current;
  }

  /** Async event dispatch — one hook name, fire-and-forget across all plugins. */
  async runEventHook(
    name: PluginEventHookName,
    payload: unknown,
    ctx: PluginContext
  ): Promise<void> {
    await Promise.all(
      this.activeEntries().map(async (entry) => {
        const pctx = this.ctxFor(entry, ctx);
        // onWorthChanged has a (memoryId, newWorth, ctx) signature; others are (payload, ctx).
        const call =
          name === "onWorthChanged"
            ? () =>
                entry.plugin.onWorthChanged!(
                  (payload as { memoryId: string }).memoryId,
                  (payload as { newWorth: number }).newWorth,
                  pctx
                )
            : () => {
                const hook = entry.plugin[name] as
                  ((p: unknown, c: PluginContext) => Promise<void>) | undefined;
                if (typeof hook !== "function") return Promise.resolve();
                return hook.call(entry.plugin, payload, pctx);
              };
        const fn =
          name === "onWorthChanged"
            ? typeof entry.plugin.onWorthChanged === "function"
              ? call
              : null
            : typeof entry.plugin[name] === "function"
              ? call
              : null;
        if (fn === null) return;
        await this.guard(entry, name, fn, undefined);
      })
    );
  }

  /**
   * The active plugins that implement verify(), with the workspace they verify
   * (`workspaceId` in their config) and their sensitivity ceiling.
   */
  verifyPlugins(): Array<{ id: string; workspaceId?: string; maxSensitivity: Sensitivity }> {
    return this.activeEntries()
      .filter((e) => typeof e.plugin.verify === "function")
      .map((e) => ({
        id: e.plugin.id,
        ...(e.config["workspaceId"] ? { workspaceId: e.config["workspaceId"] } : {}),
        maxSensitivity: resolvePluginMaxSensitivity(e.config),
      }));
  }

  /**
   * The active plugins that implement sync(), with their declared
   * `syncInterval` and the workspace their sync writes to (`workspaceId` in
   * their config, `MNEMO_PLUGIN_<ID>__WORKSPACE_ID` on the server).
   */
  syncPlugins(): Array<{ id: string; syncInterval?: number; workspaceId?: string }> {
    return this.activeEntries()
      .filter((e) => typeof e.plugin.sync === "function")
      .map((e) => ({
        id: e.plugin.id,
        ...(e.plugin.syncInterval !== undefined ? { syncInterval: e.plugin.syncInterval } : {}),
        ...(e.config["workspaceId"] ? { workspaceId: e.config["workspaceId"] } : {}),
      }));
  }

  async runHealthChecks(): Promise<Array<{ id: string; health: PluginHealth }>> {
    const out: Array<{ id: string; health: PluginHealth }> = [];
    for (const entry of this.activeEntries()) {
      if (typeof entry.plugin.onHealthCheck !== "function") continue;
      const health = await this.guard(entry, "onHealthCheck", () => entry.plugin.onHealthCheck!(), {
        healthy: false,
        detail: "health check failed",
      });
      out.push({ id: entry.plugin.id, health });
    }
    return out;
  }

  /**
   * Run sync() on every plugin that opts in, or only on `pluginId` when given
   * (the server schedules each plugin on its own `syncInterval`). Persists the
   * cursor via ctx.state.
   */
  async runSync(ctx: PluginContext, pluginId?: string): Promise<void> {
    for (const entry of this.activeEntries()) {
      if (typeof entry.plugin.sync !== "function") continue;
      if (pluginId !== undefined && entry.plugin.id !== pluginId) continue;
      const pctx = this.ctxFor(entry, ctx);
      const res = await this.guard(entry, "sync", () => entry.plugin.sync!(pctx), {
        itemsSynced: 0,
      } as SyncResult);
      if (res.cursor !== undefined) await pctx.state.set("__sync_cursor", res.cursor);
    }
  }

  /** Run verify() on every plugin that opts in, or only on `pluginId` when given. */
  async runVerify(
    facts: PluginFact[],
    ctx: PluginContext,
    pluginId?: string
  ): Promise<VerificationResult[]> {
    const all: VerificationResult[] = [];
    for (const entry of this.activeEntries()) {
      if (typeof entry.plugin.verify !== "function") continue;
      if (pluginId !== undefined && entry.plugin.id !== pluginId) continue;
      const results = await this.guard(
        entry,
        "verify",
        () => entry.plugin.verify!(facts, this.ctxFor(entry, ctx)),
        []
      );
      all.push(...results);
    }
    return all;
  }

  /**
   * Dynamically imports `reg.packageName` and registers it as a plugin.
   * The package's default export or named `plugin` export must satisfy {@link MnemoPlugin}.
   *
   * **Never throws** — failures are captured in the returned {@link PluginLoadResult}.
   */
  async load(reg: PluginRegistration): Promise<PluginLoadResult> {
    const placeholder: PluginLoadResult = {
      id: reg.packageName,
      name: reg.packageName,
      version: "unknown",
      status: "failed",
    };

    try {
      // Dynamic import with a string literal so bundlers (tsup) keep it external.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: Record<string, unknown> = (await import(reg.packageName)) as Record<
        string,
        unknown
      >;

      const candidate = mod["default"] ?? mod["plugin"];

      if (candidate === null || candidate === undefined || typeof candidate !== "object") {
        throw new Error(
          `${reg.packageName} does not export a Plugin as 'default' or named 'plugin'`
        );
      }

      const plugin = candidate as Record<string, unknown>;
      const missing: string[] = [];
      if (typeof plugin["id"] !== "string") missing.push("id");
      if (typeof plugin["name"] !== "string") missing.push("name");
      if (typeof plugin["version"] !== "string") missing.push("version");
      if (missing.length > 0) {
        throw new Error(
          `${reg.packageName}: Plugin is missing required fields: ${missing.join(", ")}`
        );
      }

      const p = plugin as unknown as MnemoPlugin;
      const config = reg.config ?? pluginConfigFromEnv(p.id);
      this._entries.push({ plugin: p, config, disabled: false, consecutiveFailures: 0 });

      const result: PluginLoadResult = {
        id: p.id,
        name: p.name,
        version: p.version,
        status: "loaded",
      };

      this._logger.info("plugin.loaded", {
        id: p.id,
        name: p.name,
        version: p.version,
        package: reg.packageName,
        // Keys only: values can be secrets (tokens, webhook URLs).
        configKeys: Object.keys(config),
      });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      this._logger.error("plugin.load_failed", {
        package: reg.packageName,
        error: message,
      });

      return { ...placeholder, error: message };
    }
  }

  /**
   * Calls `onInit` (or deprecated `onBoot`) on every loaded plugin in order.
   * Errors are caught and logged per-plugin; remaining plugins still boot.
   *
   * **Never throws.**
   */
  async runBoot(ctx: PluginContext): Promise<void> {
    for (const entry of this._entries) {
      if (entry.disabled) continue;
      // Prefer onInit, fall back to deprecated onBoot
      const initFn = entry.plugin.onInit ?? entry.plugin.onBoot;
      if (typeof initFn !== "function") continue;
      try {
        await initFn.call(entry.plugin, this.ctxFor(entry, ctx));
      } catch (err) {
        this._logger.error("plugin.boot_failed", {
          id: entry.plugin.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Calls `onShutdown` on every loaded plugin, each with a timeout.
   * Errors and timeouts are caught and logged per-plugin; remaining plugins still shut down.
   *
   * **Never throws.**
   */
  async runShutdown(ctx: PluginContext): Promise<void> {
    for (const entry of this._entries) {
      if (typeof entry.plugin.onShutdown !== "function") continue;
      try {
        await withTimeout(
          Promise.resolve(entry.plugin.onShutdown(this.ctxFor(entry, ctx))),
          SHUTDOWN_TIMEOUT_MS
        );
      } catch (err) {
        this._logger.warn("plugin.shutdown_failed", {
          id: entry.plugin.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Returns a snapshot array of all successfully loaded plugins.
   */
  list(): Array<{ id: string; name: string; version: string; disabled?: boolean }> {
    return this._entries.map(({ plugin, disabled }) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      disabled,
    }));
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Prefix that names a built-in plugin in `MNEMO_PLUGINS`, e.g. `builtin:webhook-notify`. */
export const BUILTIN_PREFIX = "builtin:";

/**
 * Per-plugin config from the environment: `MNEMO_PLUGIN_<ID>__<KEY>=value`.
 * `<ID>` is the plugin id upper-cased with every non-alphanumeric character as
 * `_` (`webhook-notify` → `WEBHOOK_NOTIFY`); the double underscore ends the id,
 * and `<KEY>` in UPPER_SNAKE becomes the camelCase config key
 * (`OUTLINE_API_URL` → `outlineApiUrl`).
 */
export function pluginConfigFromEnv(
  pluginId: string,
  env: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const prefix = `MNEMO_PLUGIN_${pluginId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}__`;
  const config: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(prefix) || value === undefined) continue;
    const key = name
      .slice(prefix.length)
      .toLowerCase()
      .replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    if (key) config[key] = value;
  }
  return config;
}

/**
 * Convenience factory: reads the `MNEMO_PLUGINS` environment variable, loads
 * each entry, and returns the populated {@link PluginLoader}. Entries are
 * comma-separated npm package names or `builtin:<id>` for one of the
 * {@link BUILTIN_FACTORIES}. Each plugin gets its config from
 * {@link pluginConfigFromEnv}. An entry that fails to load (unknown built-in,
 * missing package, bad export) is logged as `plugin.load_failed` and skipped.
 *
 * **SECURITY**: Every package listed in `MNEMO_PLUGINS` runs in-process as
 * fully trusted server code. See the top-of-file warning.
 *
 * @param logger - Structured logger used for load/boot/shutdown events.
 * @param contextFor - Per-plugin context builder, see {@link PluginLoader}.
 */
export async function createPluginLoaderFromEnv(
  logger: PluginLogger,
  contextFor?: PluginContextFactory
): Promise<PluginLoader> {
  const loader = new PluginLoader(logger, contextFor);

  const raw = process.env["MNEMO_PLUGINS"];
  if (!raw || raw.trim() === "") {
    return loader;
  }

  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const name of names) {
    if (!name.startsWith(BUILTIN_PREFIX)) {
      await loader.load({ type: "package", packageName: name });
      continue;
    }
    const id = name.slice(BUILTIN_PREFIX.length);
    const factory = Object.hasOwn(BUILTIN_FACTORIES, id) ? BUILTIN_FACTORIES[id] : undefined;
    if (!factory) {
      logger.error("plugin.load_failed", {
        package: name,
        error: `unknown built-in plugin "${id}"; known: ${Object.keys(BUILTIN_FACTORIES).join(", ")}`,
      });
      continue;
    }
    const config = pluginConfigFromEnv(id);
    loader.register(factory(), config);
    logger.info("plugin.loaded", { id, package: name, configKeys: Object.keys(config) });
  }

  return loader;
}

// Re-export InMemoryPluginStateStore from state.ts
export * from "./state.js";
// Re-export config from config.ts
export * from "./config.js";
// Re-export builtins
export * from "./builtins/index.js";
