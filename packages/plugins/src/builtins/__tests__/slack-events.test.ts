import { describe, it, expect, vi } from "vitest";
import { handleSlackEvent } from "../slack-events.js";
import type { PluginContext } from "../../index.js";

describe("slack-events handleSlackEvent", () => {
  it("maps a message event to ctx.createEvent", async () => {
    const createEvent = vi.fn(async () => ({ id: "e-1" }));
    const ctx = {
      workspaceId: "ws",
      config: {},
      createEvent,
      log: { info: vi.fn() },
    } as unknown as PluginContext;

    await handleSlackEvent(
      { type: "event_callback", event: { type: "message", text: "Hello!", user: "U123", channel: "C456", ts: "1234567890.000001" } },
      ctx,
    );
    expect(createEvent).toHaveBeenCalledOnce();
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "slack.message" }));
  });

  it("skips unknown event types without error", async () => {
    const createEvent = vi.fn();
    const ctx = {
      workspaceId: "ws", config: {},
      createEvent,
      log: { info: vi.fn() },
    } as unknown as PluginContext;

    await handleSlackEvent({ type: "event_callback", event: { type: "app_mention" } }, ctx);
    expect(createEvent).not.toHaveBeenCalled();
  });
});
