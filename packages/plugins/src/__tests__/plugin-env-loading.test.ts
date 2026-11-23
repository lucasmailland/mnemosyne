import { afterEach, describe, it, expect, vi } from "vitest";
import { createPluginLoaderFromEnv, pluginConfigFromEnv, PluginLoader } from "../index.js";
import type { MnemoPlugin, PluginContext, PluginLogger } from "../index.js";

function spyLogger(): PluginLogger & {
  calls: Array<[string, string, Record<string, unknown> | undefined]>;
} {
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
  return {
    calls,
    info: (msg, ctx) => calls.push(["info", msg, ctx]),
    warn: (msg, ctx) => calls.push(["warn", msg, ctx]),
    error: (msg, ctx) => calls.push(["error", msg, ctx]),
  };
}

// The server builds ONE context with an empty config for every plugin.
const sharedCtx = {
  workspaceId: "ws-1",
  config: {},
  maxSensitivity: "internal",
} as unknown as PluginContext;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("pluginConfigFromEnv", () => {
  it("maps MNEMO_PLUGIN_<ID>__<KEY> to camelCase keys of that plugin only", () => {
    const env = {
      MNEMO_PLUGIN_OUTLINE_SYNC__OUTLINE_API_URL: "https://outline.acme.test",
      MNEMO_PLUGIN_OUTLINE_SYNC__API_TOKEN: "tok",
      MNEMO_PLUGIN_OUTLINE__URL: "other-plugin",
      MNEMO_PLUGINS: "builtin:outline-sync",
    };
    expect(pluginConfigFromEnv("outline-sync", env)).toEqual({
      outlineApiUrl: "https://outline.acme.test",
      apiToken: "tok",
    });
  });
});

describe("createPluginLoaderFromEnv with built-ins", () => {
  it("loads a built-in by name and its hook receives its env config", async () => {
    vi.stubEnv("MNEMO_PLUGINS", "builtin:webhook-notify");
    vi.stubEnv("MNEMO_PLUGIN_WEBHOOK_NOTIFY__URL", "https://hooks.acme.test/mnemo");
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const logger = spyLogger();

    const loader = await createPluginLoaderFromEnv(logger);
    expect(loader.list().map((p) => p.id)).toEqual(["webhook-notify"]);

    await loader.runEventHook("onFactCreated", { id: "f-1" }, sharedCtx);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.acme.test/mnemo",
      expect.objectContaining({ method: "POST" })
    );
    // Config values (possibly secrets) never reach the logs.
    expect(JSON.stringify(logger.calls)).not.toContain("hooks.acme.test");
  });

  it("an unknown built-in fails with a readable error and the rest still load", async () => {
    vi.stubEnv("MNEMO_PLUGINS", "builtin:nope, builtin:feedback-loop");
    const logger = spyLogger();

    const loader = await createPluginLoaderFromEnv(logger);
    expect(loader.list().map((p) => p.id)).toEqual(["feedback-loop"]);
    const failure = logger.calls.find(
      ([lvl, msg]) => lvl === "error" && msg === "plugin.load_failed"
    );
    expect(failure?.[2]).toMatchObject({ package: "builtin:nope" });
    expect(String(failure?.[2]?.["error"])).toMatch(
      /unknown built-in plugin "nope".*webhook-notify/
    );
  });
});

describe("PluginLoader per-plugin config", () => {
  it("every run* hands each plugin its own config, not the caller's", async () => {
    const seen: Record<string, unknown[]> = {};
    const mk = (id: string): MnemoPlugin => {
      const rec = (ctx: PluginContext) => (seen[id] ??= []).push(ctx.config["key"]);
      return {
        id,
        name: id,
        version: "1.0.0",
        onBeforeWrite: (u, ctx) => (rec(ctx), u),
        onAfterWrite: (_u, ctx) => void rec(ctx),
        onBeforeRecall: (i, ctx) => (rec(ctx), i),
        onAfterRecall: (h, ctx) => (rec(ctx), h),
        onTaskCompleted: async (_t, ctx) => void rec(ctx),
        sync: async (ctx) => (rec(ctx), { itemsSynced: 0 }),
        verify: async (_f, ctx) => (rec(ctx), []),
      };
    };
    const loader = new PluginLoader(spyLogger());
    loader.register(mk("a"), { key: "A" });
    loader.register(mk("b"), { key: "B" });

    await loader.runBeforeWrite({ content: "x" }, sharedCtx);
    await loader.runAfterWrite({ content: "x" }, sharedCtx);
    await loader.runBeforeRecall({ query: "q" }, sharedCtx);
    await loader.runAfterRecall([], sharedCtx);
    await loader.runEventHook("onTaskCompleted", { id: "t" }, sharedCtx);
    await loader.runSync({
      ...sharedCtx,
      state: { set: async () => {} },
    } as unknown as PluginContext);
    await loader.runVerify([], sharedCtx);

    expect(seen).toEqual({ a: Array(7).fill("A"), b: Array(7).fill("B") });
  });
});

describe("PluginLoader per-plugin context", () => {
  it("without a factory, the ceiling comes from each plugin's config", async () => {
    const seen: Record<string, string> = {};
    const mk = (id: string): MnemoPlugin => ({
      id,
      name: id,
      version: "1.0.0",
      onTaskCompleted: async (_t, ctx) => void (seen[id] = ctx.maxSensitivity),
    });
    const loader = new PluginLoader(spyLogger());
    loader.register(mk("granted"), { maxSensitivity: "confidential" });
    loader.register(mk("bogus"), { maxSensitivity: "top-secret" });
    await loader.runEventHook("onTaskCompleted", { id: "t" }, {
      ...sharedCtx,
      maxSensitivity: "restricted",
    } as PluginContext);
    expect(seen).toEqual({ granted: "confidential", bogus: "internal" });
  });

  it("with a factory, each plugin's sync cursor lands in its own state", async () => {
    const cursors: Record<string, unknown> = {};
    const loader = new PluginLoader(
      spyLogger(),
      (pluginId, config, shared) =>
        ({
          ...shared,
          config,
          state: { set: async (_k: string, v: unknown) => void (cursors[pluginId] = v) },
        }) as unknown as PluginContext
    );
    for (const id of ["a", "b"]) {
      loader.register({
        id,
        name: id,
        version: "1.0.0",
        sync: async () => ({ itemsSynced: 1, cursor: `${id}-cursor` }),
      });
    }
    await loader.runSync(sharedCtx);
    expect(cursors).toEqual({ a: "a-cursor", b: "b-cursor" });
  });
});
