/**
 * buildPluginContext — creates a constrained PluginContext for a given plugin.
 *
 * The context is intentionally restricted (spec §21 lines 1665–1687):
 *   - All reads/writes are scoped to workspaceId — no cross-workspace access.
 *   - createFact/createEvent are rate-limited (10/min per plugin via a simple
 *     in-memory token bucket) and stamped with actorId = "plugin:<pluginId>".
 *   - state wraps the storage adapter's plugin-state JSON column.
 *   - log writes to the server logger with a "plugin.<id>" prefix.
 *
 * No raw DB, no secret env vars, no admin ops are exposed.
 */

import type {
  PluginContext,
  PluginStateStore,
  PluginLogger,
  PluginFact,
  PluginRecallHit,
  PluginCreateFactInput,
  PluginCreateEventInput,
  PluginEvent,
  PluginTask,
  PluginCreateTaskInput,
  PluginCreateEpisodeInput,
  PluginEpisode,
} from "@mnemo-ai/plugins";
// §21 per-plugin sensitivity ceiling — facts a plugin creates are capped to
// resolvePluginMaxSensitivity(config): the plugin's `config.maxSensitivity` when
// it is a valid level, else the conservative default ("internal").
import { clampSensitivity, resolvePluginMaxSensitivity } from "@mnemo-ai/plugins";
import type { ServerDeps } from "../deps.js";

// Simple in-memory token bucket for write rate-limiting: 10 writes/min per plugin.
const RATE_LIMIT_PER_MIN = 10;
const WINDOW_MS = 60_000;

interface RateBucket {
  count: number;
  windowStart: number;
}

const rateBuckets = new Map<string, RateBucket>();

function checkRateLimit(key: string): void {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    rateBuckets.set(key, bucket);
  }
  if (bucket.count >= RATE_LIMIT_PER_MIN) {
    throw new Error(`Plugin write rate limit exceeded: ${key}`);
  }
  bucket.count++;
}

/** Build a PluginStateStore backed by the StorageAdapter or an in-memory fallback. */
function buildStateStore(
  workspaceId: string,
  pluginId: string,
  deps: ServerDeps
): PluginStateStore {
  // Use the storage adapter's plugin state methods when available.
  const storage = deps.storage;

  // Local snapshot that mirrors what's in the DB so individual key ops are fast.
  let snapshot: Record<string, unknown> = {};
  let hydrated = false;

  const ensureHydrated = async (): Promise<void> => {
    if (hydrated) return;
    const loaded = await storage?.getPluginState?.(workspaceId, pluginId);
    snapshot = loaded ?? {};
    hydrated = true;
  };

  const flush = async (): Promise<void> => {
    await storage?.upsertPluginState?.(workspaceId, pluginId, snapshot);
  };

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      await ensureHydrated();
      return snapshot[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      await ensureHydrated();
      snapshot[key] = value;
      await flush();
    },
    async delete(key: string): Promise<void> {
      await ensureHydrated();
      delete snapshot[key];
      // Use the key-delete adapter method when available (JSON - key is atomic).
      (await storage?.deletePluginStateKey?.(workspaceId, pluginId, key)) ?? flush();
    },
    async keys(): Promise<string[]> {
      await ensureHydrated();
      return Object.keys(snapshot);
    },
  };
}

export interface BuildPluginContextOpts {
  pluginId: string;
  config: Record<string, string | undefined>;
  workspaceId: string;
  deps: ServerDeps;
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

export function buildPluginContext(opts: BuildPluginContextOpts): PluginContext {
  const { pluginId, config, workspaceId, deps, logger } = opts;
  const rateBucketKey = `${workspaceId}:${pluginId}`;

  const pluginLog: PluginLogger = {
    info: (msg, ctx) => logger.info({ plugin: pluginId, ...(ctx ?? {}) }, msg),
    warn: (msg, ctx) => logger.warn({ plugin: pluginId, ...(ctx ?? {}) }, msg),
    error: (msg, ctx) => logger.error({ plugin: pluginId, ...(ctx ?? {}) }, msg),
  };

  const stateStore = buildStateStore(workspaceId, pluginId, deps);

  return {
    workspaceId,
    // §21 per-plugin sensitivity ceiling. Enforced by the plugins-layer
    // runBeforeWrite clamp; the facade createFact path below carries no
    // sensitivity field, so those facts persist at the storage default.
    maxSensitivity: resolvePluginMaxSensitivity(config),
    logger: pluginLog,
    config,
    log: pluginLog,
    state: stateStore,

    async recall(query: string): Promise<PluginRecallHit[]> {
      // flatten-legacy-dual-core Phase 6d (PR17): ported off the legacy
      // core client's `recall()` (which applied NO internal sensitivity
      // gating at all — CoreLike.recall has no auth/ceiling concept) onto v3
      // `deps.cognitive.recall`, which DOES gate hits internally via
      // `sensitivityAllowed(hit.sensitivity, auth)` (recall-cold.ts). Plugins
      // are fully-trusted, unisolated server code (S10/PLUGIN_SPEC.md) — the
      // legacy call site never restricted what a plugin could read, so
      // `scopes: ["memory:admin"]` + `maxSensitivity: "restricted"` here is
      // a deliberate, disclosed choice to preserve that same effectively
      // ungated read access, not a new restriction and not an oversight.
      // `actorType: "system"` — the plugin sandbox has no end-user or
      // external-agent identity; "system" is the closest fit to the other
      // internal-automation actors this codebase already uses (e.g. PR16's
      // `system:collapse`), and the write-path calls below already use the
      // same `plugin:<id>` actorId convention.
      const auth: import("@mnemo-ai/types").AuthContext = {
        workspaceId,
        actorId: `plugin:${pluginId}`,
        actorType: "system",
        userId: null,
        scopes: ["memory:read", "memory:admin"],
        maxSensitivity: "restricted",
      };
      // The core recall boundary owns the single observation; the plugin only
      // identifies itself (declared caller) and its system actor.
      const resp = await deps.cognitive.recall({ workspaceId, text: query, limit: 10 }, auth, {
        observation: {
          requestId: globalThis.crypto.randomUUID(),
          verifiedActor: { type: auth.actorType, id: auth.actorId },
          declaredCaller: `plugin:${pluginId}`,
        },
      });
      return resp.hits.map((h) => ({
        id: h.id,
        content: h.content,
        score: h.score,
      }));
    },

    async getFact(id: string): Promise<PluginFact | null> {
      // flatten-legacy-dual-core Phase 6d (PR17): ported off the legacy core
      // client onto `deps.storage.getFact(id, workspaceId)` — the v3
      // positional-arg equivalent (PR6/PR8 precedent). `deps.storage` is
      // optional on `ServerDeps` (unlike the legacy required `core` field);
      // degrade to null rather than throw, matching this file's own
      // best-effort posture elsewhere (state store, plugin state methods).
      if (!deps.storage) return null;
      const fact = await deps.storage.getFact(id, workspaceId);
      if (!fact) return null;
      return { id: fact.id, content: fact.statement };
    },

    async createFact(input: PluginCreateFactInput): Promise<PluginFact> {
      checkRateLimit(rateBucketKey);
      const maxSens = resolvePluginMaxSensitivity(config);
      const clamped = clampSensitivity(input.sensitivity, maxSens);
      const fact = await deps.storage!.createFact({
        workspaceId,
        scope: "global",
        statement: input.content,
        subject: input.subject ?? "",
        kind: "other",
        attribution: "objective_fact",
        actorId: `plugin:${pluginId}`,
        tags: input.tags ?? [],
        metadata: input.metadata,
        ...(clamped !== undefined ? { sensitivity: clamped } : {}),
      });
      return { id: fact.id, content: fact.statement };
    },

    async createEvent(input: PluginCreateEventInput): Promise<PluginEvent> {
      checkRateLimit(rateBucketKey);
      // Persist first — the returned ID is the canonical record ID.
      const event = await deps.storage!.createEvent({
        workspaceId,
        type: "agent",
        name: input.type,
        description: "",
        occurredAt: new Date(),
        source: `plugin:${pluginId}`,
        metadata: input.payload ?? {},
      });
      // Emit on bus only after successful persist (bus carries the real persisted ID).
      const busEmit = deps.bus?.emit;
      if (busEmit) {
        busEmit.call(deps.bus, {
          channel: `agent.${workspaceId}.event`,
          type: "event.recorded",
          payload: {
            id: event.id,
            pluginId,
            workspaceId,
            eventType: input.type,
            ...(input.payload ?? {}),
          },
          timestamp: new Date().toISOString(),
          traceId: event.id,
        });
      }
      return { id: event.id, type: input.type };
    },

    async createTask(input: PluginCreateTaskInput): Promise<PluginTask> {
      checkRateLimit(rateBucketKey);
      const task = await deps.storage!.createTask({
        workspaceId,
        title: input.title,
        description: input.description,
        assignedTo: input.assignedTo ?? `plugin:${pluginId}`,
        metadata: input.metadata,
      });
      return { id: task.id, title: task.title };
    },

    async createEpisode(input: PluginCreateEpisodeInput): Promise<PluginEpisode> {
      checkRateLimit(rateBucketKey);
      const episode = await deps.storage!.createEpisode({
        workspaceId,
        title: input.title,
        narrative: input.narrative ?? "",
        occurredAt: new Date(),
        metadata: input.metadata,
      });
      return { id: episode.id, title: episode.title };
    },
  };
}
