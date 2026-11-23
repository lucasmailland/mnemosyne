import type { MnemoPlugin, PluginContext, SyncResult } from "../index.js";

/** Parse VEVENT blocks from ICS text. Returns array of event objects. */
function parseIcsEvents(icsText: string): Array<{ summary: string; dtstart: string; dtend?: string; uid?: string }> {
  const events: Array<{ summary: string; dtstart: string; dtend?: string; uid?: string }> = [];
  const blocks = icsText.split("BEGIN:VEVENT");
  for (const block of blocks.slice(1)) {
    const get = (key: string) => {
      const m = block.match(new RegExp(`^${key}[^:]*:(.+)$`, "m"));
      return m ? m[1]!.trim() : undefined;
    };
    const summary = get("SUMMARY");
    const dtstart = get("DTSTART");
    if (!summary || !dtstart) continue;
    events.push({ summary, dtstart, dtend: get("DTEND"), uid: get("UID") });
  }
  return events;
}

export function createCalendarSyncPlugin(): MnemoPlugin {
  return {
    id: "calendar-sync", name: "Calendar Sync", version: "1.0.0",
    description: "Sync ICS calendar entries to memory episodes.",
    syncInterval: 3_600_000, // 1 hour
    sync: async (ctx: PluginContext): Promise<SyncResult> => {
      const icsUrl = ctx.config.icsUrl;
      if (!icsUrl) { ctx.log?.info?.("calendar-sync: no icsUrl configured, skipping"); return { itemsSynced: 0 }; }
      const res = await fetch(icsUrl);
      const text = await res.text();
      const calEvents = parseIcsEvents(text);
      for (const ev of calEvents) {
        await ctx.createEvent({ type: "calendar", payload: { summary: ev.summary, dtstart: ev.dtstart, dtend: ev.dtend, uid: ev.uid } });
      }
      return { itemsSynced: calEvents.length };
    },
  };
}
