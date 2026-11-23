import { describe, it, expect, vi } from "vitest";
import { createOutlineSyncPlugin } from "../outline-sync.js";
import { InMemoryPluginStateStore } from "../../state.js";
import type { PluginContext } from "../../index.js";

describe("outline-sync", () => {
  it("creates facts for each document with namespace kb", async () => {
    const createFact = vi.fn(async () => ({ id: "f-1" }));
    const state = new InMemoryPluginStateStore();
    const ctx = {
      workspaceId: "ws",
      config: { outlineApiUrl: "https://outline.test", apiToken: "tok" },
      createFact, state,
      log: { info: vi.fn() },
    } as unknown as PluginContext;

    vi.stubGlobal("fetch", vi.fn(async () => ({
      json: async () => ({
        data: [
          { id: "doc-1", title: "Design Doc", text: "body 1" },
          { id: "doc-2", title: "API Guide", text: "body 2" },
        ],
      }),
    } as Response)));

    const p = createOutlineSyncPlugin();
    const result = await p.sync!(ctx);
    expect(result.itemsSynced).toBe(2);
    expect(createFact).toHaveBeenCalledTimes(2);
    expect(createFact).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ namespace: "kb" }) }));
    vi.unstubAllGlobals();
  });

  it("returns {itemsSynced:0} when no outlineApiUrl configured", async () => {
    const ctx = { workspaceId: "ws", config: {}, log: { info: vi.fn() } } as unknown as PluginContext;
    const p = createOutlineSyncPlugin();
    const result = await p.sync!(ctx);
    expect(result.itemsSynced).toBe(0);
  });
});
