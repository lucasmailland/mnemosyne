import { describe, it, expect, vi } from "vitest";
import { createCalendarSyncPlugin } from "../calendar-sync.js";
import type { PluginContext } from "../../index.js";

const icsFixture = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:Team meeting
DTSTART:20260601T100000Z
DTEND:20260601T110000Z
UID:uid-1@example.com
END:VEVENT
BEGIN:VEVENT
SUMMARY:Sprint review
DTSTART:20260607T140000Z
UID:uid-2@example.com
END:VEVENT
END:VCALENDAR`;

describe("calendar-sync", () => {
  it("creates events from ICS text (2 events)", async () => {
    const createEvent = vi.fn(async () => ({ id: "e-1" }));
    const ctx = {
      workspaceId: "ws",
      config: { icsUrl: "https://example.test/cal.ics" },
      createEvent,
      log: { info: vi.fn() },
    } as unknown as PluginContext;

    vi.stubGlobal("fetch", vi.fn(async () => ({ text: async () => icsFixture } as Response)));
    const p = createCalendarSyncPlugin();
    const result = await p.sync!(ctx);
    expect(result.itemsSynced).toBe(2);
    expect(createEvent).toHaveBeenCalledTimes(2);
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "calendar" }));
    vi.unstubAllGlobals();
  });

  it("returns {itemsSynced:0} when no icsUrl configured", async () => {
    const ctx = { workspaceId: "ws", config: {}, log: { info: vi.fn() } } as unknown as PluginContext;
    const p = createCalendarSyncPlugin();
    const result = await p.sync!(ctx);
    expect(result.itemsSynced).toBe(0);
  });
});
