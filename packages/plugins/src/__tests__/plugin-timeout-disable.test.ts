import { describe, it, expect, vi } from "vitest";
import { PluginLoader } from "../index.js";
import type { PluginContext, PluginLogger } from "../index.js";

const sink: { lvl: string; msg: string }[] = [];
const logger: PluginLogger = {
  info: (m) => sink.push({ lvl: "info", msg: m }),
  warn: (m) => sink.push({ lvl: "warn", msg: m }),
  error: (m) => sink.push({ lvl: "error", msg: m }),
};
const ctx = { workspaceId: "ws", logger, config: {}, recall: async () => [], getFact: async () => null,
  createFact: async () => ({ id: "" }), createEvent: async () => ({ id: "" }),
  state: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
  log: logger } as unknown as PluginContext;

describe("plugin timeout -> auto-disable (MNEMO_010)", () => {
  it("disables a plugin whose hook exceeds the timeout and logs MNEMO_010", async () => {
    vi.useFakeTimers();
    const loader = new PluginLoader(logger);
    loader.register({ id: "slow", name: "slow", version: "1.0.0",
      onBeforeWrite: () => new Promise(() => {/* never resolves */}) });
    const before = loader.runBeforeWrite({ content: "x" } as never, ctx);
    await vi.advanceTimersByTimeAsync(2_001);
    await before;
    vi.useRealTimers();
    expect(sink.some((e) => e.lvl === "error" && e.msg === "MNEMO_010")).toBe(true);
    // Second call: plugin is disabled, hook is skipped, write passes through unchanged.
    const out = await loader.runBeforeWrite({ content: "y", tags: [] } as never, ctx);
    expect(out).toEqual({ content: "y", tags: [] });
  });

  it("disables after 3 consecutive throws", async () => {
    sink.length = 0;
    const loader = new PluginLoader(logger);
    loader.register({ id: "throwy", name: "throwy", version: "1.0.0",
      onAfterRecall: () => { throw new Error("boom"); } });
    for (let i = 0; i < 3; i++) await loader.runAfterRecall([{ id: "a", content: "", score: 1 }] as never, ctx);
    sink.length = 0;
    await loader.runAfterRecall([{ id: "a", content: "", score: 1 }] as never, ctx);
    expect(sink.some((e) => e.msg === "plugin.hook_failed")).toBe(false); // skipped, not re-run
  });
});
