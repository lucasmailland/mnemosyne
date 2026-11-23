import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBinding } from "../binding.js";
import { enqueueVisibleMessage, enqueueTurnRetraction, readPendingEvents } from "../outbox.js";
import { planReconciliation } from "../reconcile.js";
import { readSessionState } from "../state.js";
import { flushOutbox, readDeliveryState, type DeliveryTransport } from "../delivery.js";

const MAX_BACKOFF_MS = 30 * 60 * 1000;

const roots: string[] = [];

function temporaryHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "mnemo-harness-test-")));
  roots.push(home);
  return home;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const BINDING = {
  serverUrl: "https://memory.example.com",
  workspaceId: "workspace-a",
  apiKey: "mns_live_deliverytestkey00000001",
};

function message(hostMessageId: string, sessionId = "session-1") {
  return {
    host: "codex" as const,
    hostSessionId: sessionId,
    clientInstanceId: "client-a",
    sourceGeneration: 0,
    hostMessageId,
    role: "user" as const,
    content: `content for ${hostMessageId}`,
    occurredAt: "2026-09-10T00:00:00.000Z",
  };
}

/** A transport that replies with whatever the test scripts, in order. */
function scripted(
  ...replies: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>
) {
  const sent: Array<{ url: string; body: any }> = [];
  const queue = [...replies];
  const transport: DeliveryTransport = {
    async post(input) {
      sent.push({ url: input.url, body: JSON.parse(input.body) });
      const reply = queue.shift() ?? replies[replies.length - 1]!;
      return {
        status: reply.status,
        headers: reply.headers ?? {},
        text: typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}),
      };
    },
  };
  return { transport, sent };
}

function accepted(eventIds: string[], extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    workspaceId: BINDING.workspaceId,
    acknowledgements: eventIds.map((eventId) => ({
      eventId,
      status: "accepted",
      retryable: false,
      ...extra,
    })),
  };
}

async function seed(home: string, ids: string[]) {
  await resolveBinding(BINDING, { home });
  const events = [];
  for (const id of ids) events.push((await enqueueVisibleMessage(message(id), { home })).event);
  return events;
}

const flush = (
  home: string,
  transport: DeliveryTransport,
  overrides: Record<string, unknown> = {}
) =>
  flushOutbox({
    home,
    apiKey: BINDING.apiKey,
    transport,
    random: () => 0.5,
    ...overrides,
  } as never);

describe("delivering the outbox", () => {
  it("posts pending events and removes only what the server acknowledged", async () => {
    const home = temporaryHome();
    const events = await seed(home, ["m1", "m2"]);
    const { transport, sent } = scripted({ status: 200, body: accepted([events[0]!.eventId]) });

    const result = await flush(home, transport);

    expect(result).toMatchObject({ status: "delivered", delivered: 1 });
    expect(sent[0]!.body).toMatchObject({ protocolVersion: 1, expectedWorkspaceId: "workspace-a" });
    // The unacknowledged event stays queued rather than being assumed delivered.
    const pending = await readPendingEvents({ home });
    expect(pending.map((p) => p.event.eventId)).toEqual([events[1]!.eventId]);
  });

  it("keeps an overall bound on one flush even while every batch succeeds", async () => {
    const home = temporaryHome();
    await seed(home, ["m1", "m2", "m3", "m4", "m5"]);
    const sent: string[] = [];
    const transport: DeliveryTransport = {
      async post(input) {
        const ids = (JSON.parse(input.body) as { events: Array<{ eventId: string }> }).events.map(
          (event) => event.eventId
        );
        sent.push(...ids);
        return { status: 200, headers: {}, text: JSON.stringify(accepted(ids)) };
      },
    };

    const byBatches = await flush(home, transport, { batchEvents: 1, maxBatches: 2 });
    expect(byBatches).toMatchObject({ status: "delivered", delivered: 2 });
    expect(await readPendingEvents({ home })).toHaveLength(3);

    let clock = Date.parse("2026-09-10T00:00:00.000Z");
    const slow: DeliveryTransport = {
      async post(input) {
        clock += 2_000;
        return transport.post(input);
      },
    };
    const byTime = await flush(home, slow, {
      batchEvents: 1,
      budgetMs: 3_000,
      now: () => new Date(clock),
    });
    expect(byTime).toMatchObject({ status: "delivered", delivered: 2 });
    expect(await readPendingEvents({ home })).toHaveLength(1);
  });

  it("does nothing at all when the queue is empty", async () => {
    const home = temporaryHome();
    await resolveBinding(BINDING, { home });
    const { transport, sent } = scripted({ status: 200, body: accepted([]) });

    expect(await flush(home, transport)).toMatchObject({ status: "idle", delivered: 0 });
    expect(sent).toHaveLength(0);
  });

  it("records the generation mapping before it acknowledges the event", async () => {
    const home = temporaryHome();
    const [event] = await seed(home, ["m1"]);
    const { transport } = scripted({
      status: 200,
      body: accepted([event!.eventId], { sessionId: "server-session", effectiveGeneration: 4 }),
    });

    await flush(home, transport);

    const state = await readSessionState(
      event!.host,
      event!.clientInstanceId,
      event!.hostSessionId,
      { home }
    );
    // A later event depends on this mapping, so it must be durable before the
    // event that carried it is considered delivered.
    expect(state.generationMappings).toMatchObject({ "0": 4 });
    expect(state.acknowledgedEvents[event!.eventId]).toBeDefined();
    expect(Object.values(state.acknowledgedMessages)).toMatchObject([
      { hostMessageId: "m1", sourceGeneration: 4 },
    ]);
  });

  it("keeps earlier occurrences in place when a later ACK redirects the same requested generation", async () => {
    const home = temporaryHome();
    const events = await seed(home, ["earlier", "successor"]);
    const { transport } = scripted({
      status: 200,
      body: {
        ...accepted([]),
        acknowledgements: events.map((event, index) => ({
          eventId: event.eventId,
          status: "accepted",
          effectiveGeneration: index,
        })),
      },
    });
    await flush(home, transport);
    const state = await readSessionState("codex", "client-a", "session-1", { home });
    expect(Object.values(state.acknowledgedMessages)).toMatchObject([
      { hostMessageId: "earlier", sourceGeneration: 0 },
      { hostMessageId: "successor", sourceGeneration: 1 },
    ]);
  });

  it("acknowledges a successor retraction of a predecessor message", async () => {
    const home = temporaryHome();
    const [event] = await seed(home, ["earlier"]);
    const first = scripted({
      status: 200,
      body: accepted([event!.eventId], { effectiveGeneration: 0 }),
    });
    await flush(home, first.transport);
    const retraction = await enqueueTurnRetraction(
      { ...message("earlier"), reason: "branch_removed" },
      { home }
    );
    const next = scripted({
      status: 200,
      body: accepted([retraction.event!.eventId], { effectiveGeneration: 1 }),
    });
    await flush(home, next.transport);
    const state = await readSessionState("codex", "client-a", "session-1", { home });
    expect(Object.values(state.acknowledgedMessages)).toMatchObject([
      { hostMessageId: "earlier", sourceGeneration: 0, retracted: true },
    ]);
    expect(await readPendingEvents({ home })).toHaveLength(0);
  });

  it("retracts a removed offline append on replay, even when its accepted ACK was lost", async () => {
    for (const alreadyAccepted of [false, true]) {
      const home = temporaryHome();
      const [event] = await seed(home, ["removed"]);
      const plan = planReconciliation({
        sourceGeneration: 0,
        transcript: [],
        acknowledgedMessages: {},
        pending: [event!],
      });
      expect(plan.cancellations).toEqual([]);
      expect(plan.retractions).toEqual([{ hostMessageId: "removed", reason: "branch_removed" }]);
      for (const retraction of plan.retractions)
        await enqueueTurnRetraction({ ...message("removed"), ...retraction }, { home });
      const seen: string[] = [];
      let live = alreadyAccepted;
      const transport: DeliveryTransport = {
        async post(input) {
          const { events } = JSON.parse(input.body);
          return {
            status: 200,
            headers: {},
            text: JSON.stringify({
              protocolVersion: 1,
              workspaceId: BINDING.workspaceId,
              acknowledgements: events.map((e: any) => {
                seen.push(e.type);
                if (e.type === "turn.append") {
                  live = true;
                  return { eventId: e.eventId, status: "accepted", effectiveGeneration: 0 };
                }
                if (e.type === "turn.retract") live = false;
                return { eventId: e.eventId, status: "accepted", effectiveGeneration: 0 };
              }),
            }),
          };
        },
      };
      await flush(home, transport);
      expect(live).toBe(false);
      expect(seen).toEqual(["turn.append", "turn.retract"]);
      const state = await readSessionState("codex", "client-a", "session-1", { home });
      expect(Object.values(state.acknowledgedMessages)).toMatchObject([{ retracted: true }]);
      expect(await readPendingEvents({ home })).toHaveLength(0);
    }
  });
});

describe("classifying what the server says", () => {
  it("keeps retrying a transient failure forever instead of giving up on the data", async () => {
    for (const status of [429, 500, 503]) {
      const home = temporaryHome();
      await seed(home, ["m1"]);
      const { transport } = scripted({ status });

      const result = await flush(home, transport);

      expect(result.status).toBe("retry");
      // Transient means transient: the event is never dropped, however long it lasts.
      expect(await readPendingEvents({ home })).toHaveLength(1);
      expect((await readDeliveryState({ home }))!.blocked).toBeUndefined();
    }
  });

  it("honours Retry-After instead of its own backoff", async () => {
    const home = temporaryHome();
    await seed(home, ["m1"]);
    const { transport } = scripted({ status: 429, headers: { "retry-after": "120" } });

    const result = await flush(home, transport);

    expect(result.retryAfterMs).toBe(120_000);
    const state = await readDeliveryState({ home });
    expect(Date.parse(state!.nextAttemptAt!) - Date.now()).toBeGreaterThan(100_000); // determinism-ok: retry deadline is relative to now by design; the assertion is on the interval, not the instant
  });

  it("backs off exponentially, with jitter drawn from the injected source", async () => {
    const home = temporaryHome();
    await seed(home, ["m1"]);
    const delays: number[] = [];

    for (let i = 0; i < 3; i += 1) {
      const { transport } = scripted({ status: 503 });
      // now() advances past each persisted deadline, so every pass actually sends
      // and the growth being measured is the backoff curve, not the clock.
      const result = await flush(home, transport, {
        random: () => 1,
        now: () => new Date(Date.now() + i * MAX_BACKOFF_MS), // determinism-ok: wall-clock value the assertion does not depend on
      });
      delays.push(result.retryAfterMs!);
    }

    expect(delays[1]).toBeGreaterThan(delays[0]!);
    expect(delays[2]).toBeGreaterThan(delays[1]!);
  });

  it("treats a rejected credential as an operator problem and stops trying", async () => {
    for (const status of [401, 403]) {
      const home = temporaryHome();
      await seed(home, ["m1"]);
      const { transport } = scripted({ status });

      expect(await flush(home, transport)).toMatchObject({ status: "blocked" });
      // Hammering a rejected key locks the account out; a human has to fix this.
      expect((await readDeliveryState({ home }))!.blocked).toMatchObject({ status });
      expect(await readPendingEvents({ home })).toHaveLength(1);
    }
  });

  it("refuses to keep sending once blocked, until the block is cleared", async () => {
    const home = temporaryHome();
    await seed(home, ["m1"]);
    await flush(home, scripted({ status: 401 }).transport);

    const { transport, sent } = scripted({ status: 200, body: accepted([]) });
    expect(await flush(home, transport)).toMatchObject({ status: "blocked" });
    expect(sent).toHaveLength(0);
  });

  it("quarantines the queue when the server says it belongs to another binding", async () => {
    const home = temporaryHome();
    await seed(home, ["m1"]);
    const { transport } = scripted({ status: 409 });

    expect(await flush(home, transport)).toMatchObject({ status: "quarantined", quarantined: 1 });
    // Delivering another workspace's conversation is worse than losing it.
    expect(await readPendingEvents({ home })).toHaveLength(0);
  });

  it("splits an oversized batch rather than quarantining events that would fit", async () => {
    const home = temporaryHome();
    const events = await seed(home, ["m1", "m2"]);
    const { transport, sent } = scripted(
      { status: 413 },
      { status: 200, body: accepted([events[0]!.eventId]) },
      { status: 200, body: accepted([events[1]!.eventId]) }
    );

    const result = await flush(home, transport);

    expect(result.delivered).toBe(2);
    expect(sent[0]!.body.events).toHaveLength(2);
    expect(sent[1]!.body.events).toHaveLength(1);
  });

  it("quarantines a single event the server will never accept", async () => {
    const home = temporaryHome();
    await seed(home, ["m1"]);
    const { transport } = scripted({ status: 413 });

    // Nothing left to split: this one event cannot be delivered, ever.
    expect(await flush(home, transport)).toMatchObject({ status: "quarantined", quarantined: 1 });
    expect(await readPendingEvents({ home })).toHaveLength(0);
  });

  it("keeps the queue on a 404 once the server has been proven to exist", async () => {
    const home = temporaryHome();
    const [event] = await seed(home, ["m1"]);
    await flush(home, scripted({ status: 200, body: accepted([event!.eventId]) }).transport);
    await enqueueVisibleMessage(message("m2"), { home });

    const { transport } = scripted({ status: 404 });
    expect(await flush(home, transport)).toMatchObject({ status: "retry" });
    // A server that answered before is deploying or misrouted, not gone.
    expect(await readPendingEvents({ home })).toHaveLength(1);
  });

  it("drops an event the server permanently rejects, and keeps the rest", async () => {
    const home = temporaryHome();
    const events = await seed(home, ["m1", "m2"]);
    const { transport } = scripted({
      status: 200,
      body: {
        protocolVersion: 1,
        workspaceId: BINDING.workspaceId,
        acknowledgements: [
          { eventId: events[0]!.eventId, status: "rejected", retryable: false, code: "invalid" },
          { eventId: events[1]!.eventId, status: "accepted", retryable: false },
        ],
      },
    });

    const result = await flush(home, transport);

    expect(result).toMatchObject({ delivered: 1, rejected: 1 });
    expect(await readPendingEvents({ home })).toHaveLength(0);
  });

  it("retries an event the server rejected retryably", async () => {
    const home = temporaryHome();
    const events = await seed(home, ["m1"]);
    const { transport } = scripted({
      status: 200,
      body: {
        protocolVersion: 1,
        workspaceId: BINDING.workspaceId,
        acknowledgements: [
          {
            eventId: events[0]!.eventId,
            status: "rejected",
            retryable: true,
            code: "ingestion_failed",
          },
        ],
      },
    });

    await flush(home, transport);
    expect(await readPendingEvents({ home })).toHaveLength(1);
  });
});

describe("refusing a response it cannot trust", () => {
  const cases: Array<[string, unknown]> = [
    ["invalid JSON", "{not json"],
    [
      "a different protocol",
      { protocolVersion: 2, workspaceId: BINDING.workspaceId, acknowledgements: [] },
    ],
    [
      "a different workspace",
      { protocolVersion: 1, workspaceId: "workspace-z", acknowledgements: [] },
    ],
    ["no acknowledgements array", { protocolVersion: 1, workspaceId: BINDING.workspaceId }],
  ];

  for (const [label, body] of cases) {
    it(`rejects ${label} without touching the queue`, async () => {
      const home = temporaryHome();
      await seed(home, ["m1"]);
      const { transport } = scripted({ status: 200, body });

      const result = await flush(home, transport);

      expect(result.status).toBe("retry");
      // A response we cannot understand proves nothing about what the server stored.
      expect(await readPendingEvents({ home })).toHaveLength(1);
    });
  }

  it("rejects an acknowledgement for an event it never sent", async () => {
    const home = temporaryHome();
    await seed(home, ["m1"]);
    const { transport } = scripted({ status: 200, body: accepted(["some-other-event"]) });

    expect((await flush(home, transport)).status).toBe("retry");
    expect(await readPendingEvents({ home })).toHaveLength(1);
  });

  it("rejects duplicate acknowledgements for one event", async () => {
    const home = temporaryHome();
    const [event] = await seed(home, ["m1"]);
    const { transport } = scripted({
      status: 200,
      body: accepted([event!.eventId, event!.eventId]),
    });

    expect((await flush(home, transport)).status).toBe("retry");
    expect(await readPendingEvents({ home })).toHaveLength(1);
  });
});

describe("bounding one flush", () => {
  it("stops after its attempt budget rather than looping on a broken server", async () => {
    const home = temporaryHome();
    await seed(home, ["m1", "m2", "m3"]);
    const { transport, sent } = scripted({ status: 500 });

    await flush(home, transport, { maxAttempts: 2 });

    expect(sent.length).toBeLessThanOrEqual(2);
  });

  it("waits out a persisted retry deadline instead of sending early", async () => {
    const home = temporaryHome();
    await seed(home, ["m1"]);
    await flush(home, scripted({ status: 503, headers: { "retry-after": "300" } }).transport);

    const { transport, sent } = scripted({ status: 200, body: accepted([]) });
    expect(await flush(home, transport)).toMatchObject({ status: "deferred" });
    expect(sent).toHaveLength(0);
  });

  it("never lets a transport failure escape into the host", async () => {
    const home = temporaryHome();
    await seed(home, ["m1"]);
    const transport: DeliveryTransport = {
      async post() {
        throw new Error("ECONNREFUSED");
      },
    };

    // Capture is fail-open: a delivery problem is never the host's problem.
    expect(await flush(home, transport)).toMatchObject({ status: "retry" });
    expect(await readPendingEvents({ home })).toHaveLength(1);
  });
});
