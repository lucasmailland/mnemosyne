/**
 * wirePlugins hands every plugin its OWN context, built from the shared one a
 * caller passes: state keyed by the plugin's id (not the caller's synthetic
 * `__bus_*__` / `__cron_sync__` id) and a sensitivity ceiling from that
 * plugin's config.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import type { MnemoPlugin, PluginContext } from "@mnemo-ai/plugins";
import { wirePlugins } from "../../boot/plugins.js";
import { buildPluginContext } from "../../plugins/context.js";
import type { ServerDeps } from "../../deps.js";

const WS = "ws-per-plugin";
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeDeps() {
  const states = new Map<string, Record<string, unknown>>();
  const storage = {
    getPluginState: vi.fn(async (ws: string, id: string) => states.get(`${ws}/${id}`)),
    upsertPluginState: vi.fn(async (ws: string, id: string, s: Record<string, unknown>) => {
      states.set(`${ws}/${id}`, structuredClone(s));
    }),
    createFact: vi.fn(async (input: { statement: string }) => ({
      id: "f-1",
      statement: input.statement,
    })),
  };
  return { deps: { storage } as unknown as ServerDeps, states, storage };
}

function sharedCtx(deps: ServerDeps, pluginId: string): PluginContext {
  return buildPluginContext({ pluginId, config: {}, workspaceId: WS, deps, logger: noopLogger });
}

afterEach(() => vi.unstubAllEnvs());

describe("per-plugin context (boot wiring)", () => {
  it("keys each plugin's state by its own id, not the caller's", async () => {
    vi.stubEnv("MNEMO_PLUGINS", "builtin:feedback-loop");
    const { deps, states } = makeDeps();
    const loader = (await wirePlugins({ deps }))!;
    const peeker: MnemoPlugin = {
      id: "peeker",
      name: "peeker",
      version: "1.0.0",
      onWorthChanged: async (_id, _w, ctx) => {
        await ctx.state.set("seen", await ctx.state.keys());
      },
    };
    loader.register(peeker);

    await loader.runEventHook(
      "onWorthChanged",
      { memoryId: "m-1", newWorth: 0.7 },
      sharedCtx(deps, "__bus_onWorthChanged__")
    );

    expect(states.get(`${WS}/feedback-loop`)).toEqual({ "worth:m-1": [0.7] });
    // The other plugin sees none of feedback-loop's keys.
    expect(states.get(`${WS}/peeker`)).toEqual({ seen: [] });
    expect(states.has(`${WS}/__bus_onWorthChanged__`)).toBe(false);
  });

  it("caps ctx.maxSensitivity and createFact with each plugin's own config", async () => {
    vi.stubEnv("MNEMO_PLUGINS", "");
    const { deps, storage } = makeDeps();
    const loader = (await wirePlugins({ deps }))!;
    const ceilings: Record<string, string> = {};
    const writer = (id: string): MnemoPlugin => ({
      id,
      name: id,
      version: "1.0.0",
      onTaskCompleted: async (_t, ctx) => {
        ceilings[id] = ctx.maxSensitivity;
        await ctx.createFact({ content: id, sensitivity: "restricted" });
      },
    });
    loader.register(writer("granted"), { maxSensitivity: "confidential" });
    loader.register(writer("default"));

    await loader.runEventHook("onTaskCompleted", { id: "t-1" }, sharedCtx(deps, "__bus__"));

    expect(ceilings).toEqual({ granted: "confidential", default: "internal" });
    const written = Object.fromEntries(
      storage.createFact.mock.calls.map(([i]) => [
        (i as { statement: string }).statement,
        (i as { sensitivity?: string }).sensitivity,
      ])
    );
    expect(written).toEqual({ granted: "confidential", default: "internal" });
  });
});
