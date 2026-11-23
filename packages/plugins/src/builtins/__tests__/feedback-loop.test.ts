import { describe, it, expect } from "vitest";
import { createFeedbackLoopPlugin } from "../feedback-loop.js";
import { InMemoryPluginStateStore } from "../../state.js";
import type { PluginContext } from "../../index.js";

function makeCtx(): PluginContext {
  const state = new InMemoryPluginStateStore();
  return { workspaceId: "ws", config: {}, state, log: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as PluginContext;
}

describe("feedback-loop", () => {
  it("onWorthChanged records the rating into ctx.state and keeps a bounded history", async () => {
    const p = createFeedbackLoopPlugin();
    const ctx = makeCtx();
    await p.onWorthChanged!("m-1", 0.8, ctx);
    await p.onWorthChanged!("m-1", 0.9, ctx);
    const history = await ctx.state.get<number[]>("worth:m-1");
    expect(history).toEqual([0.8, 0.9]);
  });

  it("keeps history bounded to last 20 entries", async () => {
    const p = createFeedbackLoopPlugin();
    const ctx = makeCtx();
    for (let i = 0; i < 25; i++) {
      await p.onWorthChanged!("m-2", i / 25, ctx);
    }
    const history = await ctx.state.get<number[]>("worth:m-2");
    expect(history!.length).toBe(20);
  });
});
