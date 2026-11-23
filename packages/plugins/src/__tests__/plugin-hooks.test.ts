import { describe, it, expect, vi } from "vitest";
import { PluginLoader } from "../index.js";
import type { MnemoPlugin, PluginContext, PluginLogger } from "../index.js";

const noopLogger: PluginLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fakeCtx(over: Partial<PluginContext> = {}): PluginContext {
  return {
    workspaceId: "ws-1",
    maxSensitivity: "internal",
    logger: noopLogger,
    config: {},
    recall: async () => [],
    getFact: async () => null,
    createFact: async () => ({ id: "f-1" }) as never,
    createEvent: async () => ({ id: "e-1" }) as never,
    createTask: async () => ({ id: "t-1" }) as never,
    createEpisode: async () => ({ id: "ep-1" }) as never,
    state: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      keys: async () => [],
    },
    log: noopLogger,
    ...over,
  };
}

describe("MnemoPlugin full hook surface (spec §21)", () => {
  it("runBeforeWrite chains plugins and a null return rejects the write", async () => {
    const loader = new PluginLoader(noopLogger);
    const p1: MnemoPlugin = {
      id: "p1",
      name: "p1",
      version: "1.0.0",
      onBeforeWrite: (u) => ({ ...u, tags: [...(u.tags ?? []), "p1"] }),
    };
    const rejecter: MnemoPlugin = {
      id: "p2",
      name: "p2",
      version: "1.0.0",
      onBeforeWrite: () => null,
    };
    loader.register(p1);
    loader.register(rejecter);
    const ctx = fakeCtx();
    const kept = await loader.runBeforeWrite({ content: "x", tags: [] } as never, ctx);
    expect(kept).toBeNull(); // p2 rejected
  });

  it("runAfterRecall lets a plugin reorder/annotate hits", async () => {
    const loader = new PluginLoader(noopLogger);
    const tagger: MnemoPlugin = {
      id: "tag",
      name: "tag",
      version: "1.0.0",
      onAfterRecall: (hits) => hits.map((h) => ({ ...h, score: h.score + 1 })),
    };
    loader.register(tagger);
    const out = await loader.runAfterRecall(
      [{ id: "a", content: "", score: 0 } as never],
      fakeCtx()
    );
    expect(out[0]!.score).toBe(1);
  });

  it("runEventHook dispatches an async event hook by name without blocking", async () => {
    const loader = new PluginLoader(noopLogger);
    const seen = vi.fn();
    const listener: MnemoPlugin = {
      id: "ev",
      name: "ev",
      version: "1.0.0",
      onFactCreated: async (fact) => {
        seen(fact.id);
      },
    };
    loader.register(listener);
    await loader.runEventHook("onFactCreated", { id: "f-9" } as never, fakeCtx());
    expect(seen).toHaveBeenCalledWith("f-9");
  });

  it("onHealthCheck is collected across plugins", async () => {
    const loader = new PluginLoader(noopLogger);
    loader.register({
      id: "h",
      name: "h",
      version: "1.0.0",
      onHealthCheck: async () => ({ healthy: true }),
    });
    const health = await loader.runHealthChecks();
    expect(health).toEqual([{ id: "h", health: { healthy: true } }]);
  });

  it("syncPlugins lists each syncing plugin's interval and workspace; runSync can target one", async () => {
    const loader = new PluginLoader(noopLogger);
    const synced: string[] = [];
    const mk = (id: string, syncInterval?: number) => ({
      id,
      name: id,
      version: "1.0.0",
      ...(syncInterval !== undefined ? { syncInterval } : {}),
      sync: async () => (synced.push(id), { itemsSynced: 0 }),
    });
    loader.register(mk("fast", 300_000), { workspaceId: "ws-1" });
    loader.register(mk("plain"));
    const verified: string[] = [];
    const verifier = (id: string) => ({
      id,
      name: id,
      version: "1.0.0",
      verify: async () => (verified.push(id), []),
    });
    loader.register(verifier("nosync"), { workspaceId: "ws-2", maxSensitivity: "confidential" });
    loader.register(verifier("other"));
    expect(loader.syncPlugins()).toEqual([
      { id: "fast", syncInterval: 300_000, workspaceId: "ws-1" },
      { id: "plain" },
    ]);
    expect(loader.verifyPlugins()).toEqual([
      { id: "nosync", workspaceId: "ws-2", maxSensitivity: "confidential" },
      { id: "other", maxSensitivity: "internal" },
    ]);
    await loader.runVerify([], fakeCtx(), "other");
    expect(verified).toEqual(["other"]);
    await loader.runSync(fakeCtx(), "plain");
    expect(synced).toEqual(["plain"]);
  });
});
