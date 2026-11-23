import type { MnemoPlugin, PluginContext } from "../index.js";

interface SlackEventBody {
  type?: string;
  event?: {
    type?: string;
    text?: string;
    user?: string;
    channel?: string;
    ts?: string;
  };
}

/** Handle a Slack Events API payload, mapping supported events to memory events. */
export async function handleSlackEvent(body: SlackEventBody, ctx: PluginContext): Promise<void> {
  const ev = body.event;
  if (!ev) return;
  if (ev.type === "message") {
    await ctx.createEvent({
      type: "slack.message",
      payload: { text: ev.text, user: ev.user, channel: ev.channel, ts: ev.ts },
    });
  } else {
    ctx.log?.info?.(`slack-events: unhandled event type ${ev.type ?? "unknown"}, skipping`);
  }
}

export function createSlackEventsPlugin(): MnemoPlugin {
  return {
    id: "slack-events",
    name: "Slack Events",
    version: "1.0.0",
    description: "Map Slack Events API payloads to memory events.",
    async onInit(ctx: PluginContext) {
      const webhookUrl = ctx.config.webhookUrl;
      if (!webhookUrl) {
        ctx.log?.info?.(
          "slack-events: no webhookUrl configured — register your Slack Events URL to activate"
        );
      } else {
        ctx.log?.info?.("slack-events: ready to receive Slack events");
      }
    },
  };
}
