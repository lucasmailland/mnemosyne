/**
 * §35 GET /memory/events REST catch-up endpoint unit tests.
 */
import { describe, it, expect } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountMemoryEvents } from "../../routes/memoryEvents.js";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { ReplayBuffer, StampedEvent } from "../../resilience/replayBuffer.js";

function makeApp(deps: Partial<ServerDeps>) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  // Inject a synthetic workspaceId so auth middleware is bypassed.
  app.use("*", async (c, next) => {
    c.set("workspaceId", "ws-test-1");
    await next();
  });
  mountMemoryEvents(app, deps as ServerDeps);
  return app;
}

const evt1: StampedEvent = {
  id: "evt_wstest1_1000_0000",
  channel: "facts.*",
  type: "fact.created",
  payload: { workspaceId: "ws-test-1", id: "f1" },
  timestamp: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
  traceId: "t1",
};
const evt2: StampedEvent = {
  id: "evt_wstest1_1001_0000",
  channel: "facts.*",
  type: "fact.created",
  payload: { workspaceId: "ws-test-1", id: "f2" },
  timestamp: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
  traceId: "t2",
};

describe("GET /memory/events (§35 REST catch-up)", () => {
  it("returns 204 when no replay buffer is configured", async () => {
    const app = makeApp({});
    const res = await app.request("/memory/events?since=evt_wstest1_999_0000&channel=facts.*");
    expect(res.status).toBe(204);
  });

  it("returns replay result when cursor is found", async () => {
    const replay: ReplayBuffer = {
      async record() {},
      async catchUp(_wsId, _channel, _lastId) {
        return { type: "replay", events: [evt2], gapDetected: false };
      },
    };
    const app = makeApp({ replay });
    const res = await app.request("/memory/events?since=evt_wstest1_1000_0000&channel=facts.*");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; events: StampedEvent[] };
    expect(body.type).toBe("replay");
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.id).toBe(evt2.id);
  });

  it("returns gap result when cursor is not found", async () => {
    const replay: ReplayBuffer = {
      async record() {},
      async catchUp() {
        return { type: "gap", oldestAvailable: evt1.id, message: "gap" };
      },
    };
    const app = makeApp({ replay });
    const res = await app.request("/memory/events?since=evt_unknown_0_0000&channel=facts.*");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; oldestAvailable: string };
    expect(body.type).toBe("gap");
    expect(body.oldestAvailable).toBe(evt1.id);
  });

  it("passes workspaceId and channel from request to catchUp", async () => {
    let capturedArgs: { workspaceId: string; channel: string; lastEventId: string } | undefined;
    const replay: ReplayBuffer = {
      async record() {},
      async catchUp(workspaceId, channel, lastEventId) {
        capturedArgs = { workspaceId, channel, lastEventId };
        return { type: "replay", events: [], gapDetected: false };
      },
    };
    const app = makeApp({ replay });
    await app.request("/memory/events?since=evt_wstest1_500_0000&channel=session.*");
    expect(capturedArgs?.workspaceId).toBe("ws-test-1");
    expect(capturedArgs?.channel).toBe("session.*");
    expect(capturedArgs?.lastEventId).toBe("evt_wstest1_500_0000");
  });
});
