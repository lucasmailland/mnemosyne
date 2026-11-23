import { describe, it, expect } from "vitest";
import { createReplayBuffer } from "../../resilience/replayBuffer.js";
import type { MnemoBusEvent } from "@mnemo-ai/types";

function fakeCache() {
  const lists = new Map<string, string[]>();
  return {
    lists,
    async lpushCapped(k: string, v: string, max: number) {
      const arr = lists.get(k) ?? [];
      arr.unshift(v);
      lists.set(k, arr.slice(0, max));
    },
    async lrange(k: string, start: number, stop: number) {
      const arr = lists.get(k) ?? [];
      const end = stop === -1 ? arr.length : stop + 1;
      return arr.slice(start, end);
    },
  };
}

type StampedBusEvent = MnemoBusEvent & { id: string };

function ev(id: string, n: number, channel = "fact.created"): StampedBusEvent {
  return {
    id,
    channel,
    type: channel,
    payload: { workspaceId: "w", n },
    timestamp: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
    traceId: "t",
  };
}

const ns = (events: StampedBusEvent[]) => events.map((e) => (e.payload as { n: number }).n);

describe("§35 replay buffer", () => {
  it("records every channel newest-first in one per-workspace list", async () => {
    const c = fakeCache();
    const rb = createReplayBuffer(c as never, { maxEvents: 100, ttlSeconds: 3600 });
    await rb.record("w", ev("evt_w_1_0000", 1, "fact.created"));
    await rb.record("w", ev("evt_w_2_0000", 2, "task.updated"));
    const list = c.lists.get("mnemo:w:ws_buffer")!;
    expect(list.map((r) => JSON.parse(r).id)).toEqual(["evt_w_2_0000", "evt_w_1_0000"]);
  });

  it("catchUp replays only events AFTER lastEventId, oldest-first", async () => {
    const c = fakeCache();
    const rb = createReplayBuffer(c as never, { maxEvents: 100, ttlSeconds: 3600 });
    for (const e of [ev("evt_w_1_0000", 1), ev("evt_w_2_0000", 2), ev("evt_w_3_0000", 3)]) {
      await rb.record("w", e);
    }
    const res = await rb.catchUp("w", "fact.created", "evt_w_1_0000");
    expect(res.type).toBe("replay");
    if (res.type === "replay") expect(ns(res.events)).toEqual([2, 3]);
  });

  it("returns gap when lastEventId is not in the buffer", async () => {
    const c = fakeCache();
    const rb = createReplayBuffer(c as never, { maxEvents: 100, ttlSeconds: 3600 });
    await rb.record("w", ev("evt_w_5_0000", 5));
    const res = await rb.catchUp("w", "fact.created", "evt_w_1_0000");
    expect(res.type).toBe("gap");
    if (res.type === "gap") expect(res.oldestAvailable).toBe("evt_w_5_0000");
  });

  it("returns gap when lastEventId was evicted by the size cap", async () => {
    const rb = createReplayBuffer(fakeCache() as never, { maxEvents: 2, ttlSeconds: 3600 });
    for (const e of [ev("a", 1), ev("b", 2, "task.created"), ev("c", 3)]) await rb.record("w", e);
    const res = await rb.catchUp("w", "*", "a");
    expect(res).toMatchObject({ type: "gap", oldestAvailable: "b" });
  });

  describe("patterns", () => {
    async function seeded() {
      const rb = createReplayBuffer(fakeCache() as never, { maxEvents: 100, ttlSeconds: 3600 });
      for (const e of [
        ev("e0", 0, "fact.created"),
        ev("e1", 1, "task.created"),
        ev("e2", 2, "fact.updated"),
        ev("e3", 3, "session.closed"),
        ev("e4", 4, "task.updated"),
      ])
        await rb.record("w", e);
      return rb;
    }

    it("'*' replays every channel after lastEventId", async () => {
      const res = await (await seeded()).catchUp("w", "*", "e0");
      if (res.type !== "replay") throw new Error(res.type);
      expect(ns(res.events)).toEqual([1, 2, 3, 4]);
    });

    it("a trailing-wildcard pattern replays its prefix only", async () => {
      const res = await (await seeded()).catchUp("w", "session.*", "e0");
      if (res.type !== "replay") throw new Error(res.type);
      expect(ns(res.events)).toEqual([3]);
    });

    it("a domain alias ('tasks.*' → 'task.') replays the aliased channels", async () => {
      const res = await (await seeded()).catchUp("w", "tasks.*", "e0");
      if (res.type !== "replay") throw new Error(res.type);
      expect(ns(res.events)).toEqual([1, 4]);
    });

    it("finds lastEventId even when it came from a channel not requested", async () => {
      // The client's last event was a fact; it now resubscribes to tasks only.
      const res = await (await seeded()).catchUp("w", ["tasks.*"], "e2");
      if (res.type !== "replay") throw new Error(res.type);
      expect(ns(res.events)).toEqual([4]);
    });

    it("overlapping patterns replay each event once, in emit order", async () => {
      const res = await (
        await seeded()
      ).catchUp("w", ["tasks.*", "task.updated", "*", "facts.*"], "e0");
      if (res.type !== "replay") throw new Error(res.type);
      expect(res.events.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
    });

    it("never reads another workspace's buffer", async () => {
      const rb = await seeded();
      await rb.record("other", ev("x1", 99, "task.created"));
      expect((await rb.catchUp("other", "*", "e0")).type).toBe("gap");
      const res = await rb.catchUp("w", "*", "e3");
      if (res.type !== "replay") throw new Error(res.type);
      expect(ns(res.events)).toEqual([4]);
    });
  });
});

it("deduplicates redelivered durable event IDs during replay", async () => {
  const rb = createReplayBuffer(fakeCache() as never, { maxEvents: 100, ttlSeconds: 3600 });
  for (const e of [ev("before", 0), ev("managed-event", 1), ev("next", 2), ev("managed-event", 1)])
    await rb.record("w", e);
  const result = await rb.catchUp("w", "fact.created", "before");
  if (result.type !== "replay") throw new Error(result.type);
  expect(result.events.map((e) => e.id)).toEqual(["managed-event", "next"]);
});
