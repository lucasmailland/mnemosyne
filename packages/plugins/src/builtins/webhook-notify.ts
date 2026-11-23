import type { MnemoPlugin, PluginContext, PluginFact, PluginTask } from "../index.js";

export function createWebhookNotifyPlugin(): MnemoPlugin {
  async function post(ctx: PluginContext, type: string, payload: unknown): Promise<void> {
    const url = ctx.config.url;
    if (!url) { ctx.log?.info?.("webhook-notify: no url configured, skipping", { type }); return; }
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, workspaceId: ctx.workspaceId, payload, at: new Date().toISOString() }),
    });
  }
  return {
    id: "webhook-notify", name: "Webhook Notify", version: "1.0.0",
    description: "Push memory events to an external HTTP endpoint.",
    onFactCreated: (fact: PluginFact, ctx) => post(ctx, "fact.created", fact),
    onTaskCompleted: (task: PluginTask, ctx) => post(ctx, "task.completed", task),
    onWorthChanged: (memoryId, newWorth, ctx) => post(ctx, "worth.changed", { memoryId, newWorth }),
  };
}
