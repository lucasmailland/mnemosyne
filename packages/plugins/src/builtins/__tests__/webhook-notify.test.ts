import { describe, it, expect, vi } from "vitest";
import { createWebhookNotifyPlugin } from "../webhook-notify.js";
import type { PluginContext } from "../../index.js";

const ctx = { workspaceId: "ws", config: { url: "https://example.test/hook" } } as unknown as PluginContext;

describe("webhook-notify", () => {
  it("POSTs the fact payload on onFactCreated", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = createWebhookNotifyPlugin();
    await p.onFactCreated!({ id: "f-1" }, ctx);
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/hook", expect.objectContaining({ method: "POST" }));
    vi.unstubAllGlobals();
  });

  it("no-ops without a url configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const p = createWebhookNotifyPlugin();
    await p.onFactCreated!({ id: "f-1" }, { workspaceId: "ws", config: {}, log: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as PluginContext);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
