import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "../InMemoryStorageAdapter.js";

describe("InMemoryStorageAdapter.listDueReminderWorkspaceIds", () => {
  it("returns distinct workspaces with pending, due, condition-less reminders", async () => {
    const storage = new InMemoryStorageAdapter();
    const past = new Date(Date.now() - 60_000); // determinism-ok: listDue compares against the adapter clock
    const future = new Date(Date.now() + 60_000); // determinism-ok: listDue compares against the adapter clock
    for (const [id, workspaceId, triggerAt, condition] of [
      ["due-1", "ws-due", past, null],
      ["due-2", "ws-due", past, "  "],
      ["future", "ws-future", future, null],
      ["conditioned", "ws-conditioned", past, "when relevant"],
      ["tab-conditioned", "ws-tab", past, "\t"],
      ["semantic", "ws-semantic", null, null],
      ["dismissed", "ws-dismissed", past, null],
    ] as const) {
      await storage.createReminder({ id, workspaceId, content: id, triggerAt, condition });
    }
    await storage.dismissReminder("dismissed", "ws-dismissed", "dismissed");

    expect(await storage.listDueReminderWorkspaceIds()).toEqual(["ws-due"]);
  });
});
