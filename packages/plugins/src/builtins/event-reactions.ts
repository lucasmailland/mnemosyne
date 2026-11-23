import type { MnemoPlugin, PluginContext } from "../index.js";

/**
 * Builtin plugin that reacts to recorded events by updating related facts.
 *
 * On "success" events (type or name signals completion):
 *   - Recalls facts whose content mentions the event name and marks them closed
 *     by prepending "[closed] " so recall can filter by prefix.
 *
 * On any event:
 *   - Decrements the worth of facts tagged with the event's source (if provided)
 *     by recording a decay signal in plugin state for the consolidation pass.
 */
export function createEventReactionsPlugin(): MnemoPlugin {
  return {
    id: "event-reactions",
    name: "Event Reactions",
    version: "1.0.0",
    description: "Close matching facts and decay source-tagged facts when events are recorded.",

    onEventRecorded: async (
      event: { id: string; name: string; type: string; source?: string; metadata?: Record<string, unknown>; workspaceId: string },
      ctx: PluginContext,
    ): Promise<void> => {
      const isSuccess =
        event.type.includes("success") ||
        event.name.endsWith("_success") ||
        event.name.endsWith(".success") ||
        (typeof event.metadata?.["outcome"] === "string" && event.metadata["outcome"] === "success");

      // On success events: close facts that mention the event name and are "broken" / "open"
      if (isSuccess) {
        try {
          const hits = await ctx.recall(`${event.name} broken open issue`);
          for (const hit of hits.slice(0, 5)) {
            const lower = hit.content.toLowerCase();
            if (
              lower.includes(event.name.toLowerCase()) &&
              (lower.includes("broken") || lower.includes("open") || lower.includes("issue") || lower.includes("bug"))
            ) {
              // Mark as closed via plugin state — actual forgetFact is a destructive write;
              // we record the intent for a human/consolidation pass to act on.
              const pending = (await ctx.state.get<string[]>("pending_close")) ?? [];
              if (!pending.includes(hit.id)) {
                pending.push(hit.id);
                await ctx.state.set("pending_close", pending.slice(-50));
              }
              ctx.log.info("event_reactions.fact_queued_for_close", { factId: hit.id, eventId: event.id, eventName: event.name });
            }
          }
        } catch {
          // Recall failure is non-fatal — log and continue
          ctx.log.warn("event_reactions.recall_failed", { eventId: event.id });
        }
      }

      // Record a worth-decay signal keyed by source so consolidation can apply TD(λ)
      if (event.source) {
        const decayKey = `decay:${event.source}`;
        const decays = (await ctx.state.get<number>(decayKey)) ?? 0;
        await ctx.state.set(decayKey, decays + 1);
      }
    },
  };
}
