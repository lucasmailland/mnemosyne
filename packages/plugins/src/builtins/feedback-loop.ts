import type { MnemoPlugin, PluginContext } from "../index.js";

/** Translate a UI worth signal into a bounded per-fact history, persisted in state. */
export function createFeedbackLoopPlugin(): MnemoPlugin {
  return {
    id: "feedback-loop", name: "Feedback Loop", version: "1.0.0",
    description: "Fold explicit user feedback into memory worth.",
    onWorthChanged: async (memoryId, newWorth, ctx: PluginContext) => {
      const history = (await ctx.state.get<number[]>(`worth:${memoryId}`)) ?? [];
      history.push(newWorth);
      await ctx.state.set(`worth:${memoryId}`, history.slice(-20));
    },
  };
}
