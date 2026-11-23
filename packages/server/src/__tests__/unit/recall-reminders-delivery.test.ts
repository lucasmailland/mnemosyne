/**
 * LIFECYCLE-6 — a time reminder the background poller fired never reached the
 * agent.
 *
 * The poller marks a due time-only reminder `triggered` and emits an event and
 * a webhook; recall only evaluated `pending` reminders, so a reminder the
 * poller got to first was never returned by `memory_recall` (and
 * `GET /reminders` lists `pending` by default). Whether an MCP agent learned
 * about it was a race against the 30-second poller.
 *
 * Now a triggered reminder carries `deliveredAt` until a recall returns it:
 * the next recall delivers every fired-but-undelivered reminder once,
 * whichever path fired it.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { evaluatePendingReminders } from "@mnemo-ai/core";
import type { ServerDeps } from "../../deps.js";
import {
  evaluateRemindersForRecall,
  RECALL_UNDELIVERED_REMINDER_LIMIT,
} from "../../recall/reminders.js";

const WS = "00000000-0000-4000-8000-0000000000a6";

function setup() {
  const storage = new InMemoryStorageAdapter();
  const deps = { storage } as unknown as Pick<ServerDeps, "storage" | "llm" | "embedModel">;
  const recall = (query = "an unrelated query") => evaluateRemindersForRecall(deps, WS, query);
  /** What the 30-second poller does: a time-only sweep with no query. */
  const poll = () => evaluatePendingReminders({ storage, workspaceId: WS, queryText: "" });
  const create = (input: { content: string; condition?: string; triggerAt?: Date }) =>
    storage.createReminder({ id: randomUUID(), workspaceId: WS, ...input });
  return { storage, recall, poll, create };
}

const past = () => new Date(Date.now() - 60_000); // determinism-ok: relative to now, not asserted

describe("LIFECYCLE-6 — poller-fired reminders reach the next recall", () => {
  it("delivers a reminder the poller fired, exactly once", async () => {
    const { recall, poll, create } = setup();
    const reminder = await create({
      content: "check the orders-api error budget",
      triggerAt: past(),
    });

    expect((await poll()).map((r) => r.id)).toEqual([reminder.id]);

    const first = await recall();
    expect(first.map((r) => r.id)).toEqual([reminder.id]);
    expect(first[0]!.triggeredBy).toBe("time");
    expect(await recall()).toEqual([]);
  });

  it("does not return a recall-fired reminder twice", async () => {
    const { recall, create } = setup();
    const reminder = await create({ content: "ping on-call", triggerAt: past() });

    const first = await recall();
    expect(first.map((r) => r.id)).toEqual([reminder.id]);
    expect(await recall()).toEqual([]);
  });

  it("never delivers a dismissed reminder", async () => {
    const { storage, recall, poll, create } = setup();
    const reminder = await create({ content: "rotate the key", triggerAt: past() });
    await poll();
    await storage.dismissReminder(reminder.id, WS, "dismissed");

    expect(await recall()).toEqual([]);
  });

  it("delivers a backlog in bounded batches", async () => {
    const { recall, poll, create } = setup();
    for (let i = 0; i < RECALL_UNDELIVERED_REMINDER_LIMIT + 3; i++) {
      await create({ content: `reminder ${i}`, triggerAt: past() });
    }
    await poll();

    expect(await recall()).toHaveLength(RECALL_UNDELIVERED_REMINDER_LIMIT);
    expect(await recall()).toHaveLength(3);
    expect(await recall()).toHaveLength(0);
  });
});

describe("Review round — once-only under concurrency", () => {
  it("concurrent recalls never hand out the same reminder twice", async () => {
    const { recall, poll, create } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push((await create({ content: `due ${i}`, triggerAt: past() })).id);
    }
    await poll();

    const responses = await Promise.all([recall(), recall(), recall()]);
    const delivered = responses.flat().map((r) => r.id);

    expect(new Set(delivered).size).toBe(delivered.length);
    expect([...delivered].sort()).toEqual([...ids].sort());
  });

  it("concurrent recalls that both fire a pending reminder deliver it once", async () => {
    const { recall, create } = setup();
    const reminder = await create({ content: "fires on recall", triggerAt: past() });

    const responses = await Promise.all([recall(), recall()]);

    expect(responses.flat().filter((r) => r.id === reminder.id)).toHaveLength(1);
  });
});
