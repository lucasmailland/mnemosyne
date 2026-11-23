/**
 * §35 WS gap-frame ordering — the synthetic `ws.gap` control frame must flow
 * through the same ordered subscriber buffer as live events, not be sent
 * directly via a raw `ws.send`. This prevents the gap frame from jumping
 * ahead of already-buffered live events when a slow-flush is pending.
 *
 * Two complementary test suites:
 *
 * Suite A — WsSubscriber unit tests (test the ring-buffer fix in isolation):
 *   Verify WsSubscriber.push() accepts WsControlFrame and serialises it in
 *   the correct insertion order relative to MnemoBusEvents.
 *
 * Suite B — ws.ts handler integration test (test the ws.ts fix):
 *   Spy on WsSubscriber.prototype.push and verify it IS called for gap frames,
 *   and that the raw ws.send is NOT used for the gap frame.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WsSubscriber } from "../../resilience/wsRingBuffer.js";
import type { WsControlFrame } from "../../resilience/wsRingBuffer.js";
import type { MnemoBusEvent } from "@mnemo-ai/types";

// ── Vitest hoists vi.mock() calls to the top of the module, before imports.
// This lets us mock @hono/node-ws so createWsHandler() can be imported
// without a real HTTP server, and we can capture the WSEvents handlers.

// Captured WSEvents from the last upgradeWebSocket call
type WsEventHandlers = {
  onOpen?: (evt: unknown, ws: unknown) => void;
  onMessage?: (evt: MessageEvent, ws: unknown) => void;
  onClose?: (evt: unknown, ws: unknown) => void;
};
let capturedHandlers: WsEventHandlers = {};

vi.mock("@hono/node-ws", () => ({
  createNodeWebSocket: () => ({
    upgradeWebSocket: (factory: (ctx: unknown) => Promise<WsEventHandlers>) => {
      // Return a "middleware" that immediately invokes factory with a fake context.
      // This lets createWsHandler() complete its setup synchronously-ish.
      return async (ctx: unknown) => {
        const handlers = await factory(ctx);
        capturedHandlers = handlers;
      };
    },
    injectWebSocket: vi.fn(),
  }),
}));

// Mock auth so the token check always resolves (avoids bcrypt)
vi.mock("../../auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth.js")>();
  return {
    ...actual,
    verifyApiKeyToken: vi.fn().mockResolvedValue({ workspaceId: "ws_test", scopes: [] }),
  };
});

import { createWsHandler } from "../../ws.js";
import { createReplayBuffer, type ReplayBuffer } from "../../resilience/replayBuffer.js";
import { verifyApiKeyToken } from "../../auth.js";
import type { Hono } from "hono";

// ── Helpers ───────────────────────────────────────────────────────────────────

function liveEvent(n: number): MnemoBusEvent {
  return {
    channel: "facts.*",
    type: "fact.created",
    payload: { workspaceId: "ws_test", n },
    timestamp: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
    traceId: "t",
  };
}

function gapFrame(channel = "facts.*"): WsControlFrame {
  return {
    type: "ws.gap",
    channel,
    oldestAvailable: "evt_w_100_0000",
    message: "Events lost. Use REST API to sync.",
  };
}

function makeFakeWs() {
  const rawSends: string[] = [];
  return {
    ws: {
      send: vi.fn((data: string) => rawSends.push(data)),
      readyState: 1,
      close: vi.fn(),
    },
    rawSends,
  };
}

// ── Suite A: WsSubscriber ring-buffer unit tests ───────────────────────────────

describe("§35 WS gap-frame ordering via subscriber buffer", () => {
  it("WsControlFrame type is importable and structurally correct", () => {
    // Compile-time check: if WsControlFrame is not exported from wsRingBuffer.ts,
    // the import at the top of this file produces a TS error (caught by typecheck).
    const frame: WsControlFrame = {
      type: "ws.gap",
      channel: "facts.*",
      oldestAvailable: "evt_w_42_0000",
    };
    expect(frame.type).toBe("ws.gap");
  });

  it("gap frame flushed alone produces a valid ws.gap JSON frame", () => {
    const sent: string[] = [];
    const ws = { send: (s: string) => sent.push(s), readyState: 1 } as never;
    const sub = new WsSubscriber("conn-gap-solo", ws, { maxBufferSize: 100, slowFlushMs: 0 });

    // With slowFlushMs: 0 and ready (default) → immediate flush on push
    sub.push(gapFrame("tasks.*"));

    expect(sent.length).toBe(1);
    const frame = JSON.parse(sent[0]!) as {
      type: string;
      channel: string;
      oldestAvailable: string;
    };
    expect(frame.type).toBe("ws.gap");
    expect(frame.channel).toBe("tasks.*");
    expect(frame.oldestAvailable).toBe("evt_w_100_0000");
  });

  it("slow-consumer deferred flush preserves live→gap ordering", () => {
    const sent: string[] = [];
    const ws = { send: (s: string) => sent.push(s), readyState: 1 } as never;
    // maxBufferSize=2 → isSlow at count≥1 (1 >= 2*0.5 = 1)
    const sub = new WsSubscriber("conn-gap-order", ws, { maxBufferSize: 2, slowFlushMs: 500 });

    sub.push(liveEvent(42)); // slow triggered, scheduleFlush (timer, not immediate send)
    expect(sub.isSlow).toBe(true);
    expect(sent.length).toBe(0); // timer is pending

    sub.push(gapFrame("facts.*")); // second push while slow
    expect(sub.depth).toBe(2);

    sub.dispose(); // cancel timer to avoid test leaks

    // Manually trigger flush (same codepath as timer callback)
    sub.flush();
    expect(sent.length).toBe(1); // both items sent as array in one ws.send

    const parsed = JSON.parse(sent[0]!) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed[0] as { type: string }).type).toBe("fact.created");
    expect((parsed[1] as { type: string }).type).toBe("ws.gap");
  });

  it("multiple items flushed individually preserve insertion order", () => {
    const sent: string[] = [];
    const ws = { send: (s: string) => sent.push(s), readyState: 1 } as never;
    const sub = new WsSubscriber("conn-gap-seq", ws, { maxBufferSize: 100, slowFlushMs: 0 });

    sub.push(liveEvent(1));
    sub.push(liveEvent(2));
    sub.push(gapFrame());

    expect(sent.length).toBe(3);
    const frames = sent.map((s) => JSON.parse(s) as { type: string; payload?: { n?: number } });
    expect(frames[0]!.type).toBe("fact.created");
    expect((frames[0]!.payload as { n: number }).n).toBe(1);
    expect(frames[1]!.type).toBe("fact.created");
    expect((frames[1]!.payload as { n: number }).n).toBe(2);
    expect(frames[2]!.type).toBe("ws.gap");
  });
});

// ── Suite B: ws.ts handler — gap frame routing ────────────────────────────────

describe("§35 ws.ts resubscribe: gap frame routed through subscriber, not raw ws.send", () => {
  // Fake event bus — needed so subscriber is created in onOpen
  const fakeBus = {
    subscribe: vi.fn(() => () => {}),
    publish: vi.fn(),
  };

  // Fake replay buffer that always returns gap
  const gapReplay = {
    async record() {},
    async catchUp() {
      return {
        type: "gap" as const,
        oldestAvailable: "evt_w_100_0000",
        message: "Events lost. Use REST API to sync.",
      };
    },
  };

  // Fake API key lookup (not used — verifyApiKeyToken is mocked above)
  const fakeApiKeys = {
    listActive: vi.fn().mockResolvedValue([]),
    touch: vi.fn(),
  };

  beforeEach(() => {
    capturedHandlers = {};
    vi.clearAllMocks();
    // Re-setup the auth mock implementation after clearAllMocks() wiped it
    vi.mocked(verifyApiKeyToken).mockResolvedValue({ workspaceId: "ws_test", scopes: [] } as never);
    fakeBus.subscribe.mockReturnValue(() => {});
  });

  async function setupHandler(replay: ReplayBuffer = gapReplay): Promise<void> {
    const fakeHono = {
      get(_path: string, middleware: (ctx: unknown) => Promise<void>) {
        const fakeCtx = {
          req: { query: (_key: string) => "mns_test_validtoken" },
        };
        void middleware(fakeCtx);
      },
    } as unknown as Hono;

    const wsHandler = createWsHandler(fakeHono, {
      bus: fakeBus as never,
      apiKeys: fakeApiKeys as never,
      replay,
    });
    wsHandler.mount(fakeHono);

    // Wait for the async verifyApiKeyToken factory to complete
    await new Promise((r) => setTimeout(r, 10));
  }

  it("gap frame is sent via subscriber.push, not raw ws.send", async () => {
    await setupHandler();

    // Verify handlers were actually captured (mock is working)
    expect(
      capturedHandlers.onOpen,
      "onOpen handler must be captured by the @hono/node-ws mock"
    ).toBeDefined();
    expect(
      capturedHandlers.onMessage,
      "onMessage handler must be captured by the @hono/node-ws mock"
    ).toBeDefined();

    const pushSpy = vi.spyOn(WsSubscriber.prototype, "push");
    const { ws, rawSends } = makeFakeWs();

    // Fire onOpen (creates the WsSubscriber)
    await capturedHandlers.onOpen?.(new Event("open"), ws);

    // Fire onMessage with a resubscribe request
    const msg = JSON.stringify({
      resubscribe: { channels: ["facts.*"], lastEventId: "evt_old_0001" },
    });
    await capturedHandlers.onMessage?.({ data: msg } as MessageEvent, ws);

    // Wait for catchUp promise to resolve
    await new Promise((r) => setTimeout(r, 20));

    // ASSERTION 1: subscriber.push must have been called with the gap frame.
    // This is the primary ordering guarantee: the gap frame entered the ring buffer
    // and will be serialised in insertion order with respect to live events.
    const gapPushCall = pushSpy.mock.calls.find((args) => {
      const frame = args[0] as { type?: string };
      return frame.type === "ws.gap";
    });
    expect(
      gapPushCall,
      "subscriber.push must be called with the ws.gap frame (not bypassed via a direct ws.send call)"
    ).toBeDefined();

    // ASSERTION 2: the gap frame was flushed through the subscriber (ws.send was
    // eventually called — that is correct, it means the buffer flushed the frame).
    // We verify the gap frame IS present in rawSends (flushed), meaning the path
    // was: ws.ts → subscriber.push → subscriber.flush → ws.send (correct order).
    const gapFlushed = rawSends.some((s) => {
      try {
        return (JSON.parse(s) as { type?: string }).type === "ws.gap";
      } catch {
        return false;
      }
    });
    expect(gapFlushed, "gap frame must be flushed to the client via the subscriber buffer").toBe(
      true
    );
  });

  // ── Wildcard / alias catch-up through the real buffer ───────────────────────

  function memoryCache() {
    const lists = new Map<string, string[]>();
    return {
      async lpushCapped(k: string, v: string, max: number) {
        lists.set(k, [v, ...(lists.get(k) ?? [])].slice(0, max));
      },
      async lrange(k: string) {
        return lists.get(k) ?? [];
      },
    };
  }

  function stamped(id: string, channel: string, workspaceId = "ws_test") {
    return { ...liveEvent(0), id, channel, type: channel, payload: { workspaceId, id } };
  }

  async function resubscribe(replay: ReplayBuffer, channels: string[], lastEventId: string) {
    await setupHandler(replay);
    const { ws, rawSends } = makeFakeWs();
    await capturedHandlers.onOpen?.(new Event("open"), ws);
    await capturedHandlers.onMessage?.(
      { data: JSON.stringify({ resubscribe: { channels, lastEventId } }) } as MessageEvent,
      ws
    );
    await new Promise((r) => setTimeout(r, 20));
    return rawSends.flatMap((s) => {
      const parsed = JSON.parse(s) as unknown;
      return (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ id?: string; type: string }>;
    });
  }

  it("overlapping wildcard and alias patterns replay each missed event once, in order", async () => {
    const replay = createReplayBuffer(memoryCache() as never, { maxEvents: 100, ttlSeconds: 60 });
    for (const e of [
      stamped("e0", "fact.created"),
      stamped("e1", "task.created"),
      stamped("e2", "fact.updated"),
      stamped("e3", "task.updated"),
      // Recorded under ws_test but stamped for another workspace: the live
      // isolation gate must drop it on replay too.
      stamped("e4", "task.updated", "ws_other"),
    ])
      await replay.record("ws_test", e as never);

    const frames = await resubscribe(replay, ["tasks.*", "task.updated", "*"], "e0");
    expect(frames.map((f) => f.id)).toEqual(["e1", "e2", "e3"]);
    expect(frames.some((f) => f.type === "ws.gap")).toBe(false);
  });

  it("a wildcard resubscribe whose lastEventId was evicted gets a gap frame per channel", async () => {
    const replay = createReplayBuffer(memoryCache() as never, { maxEvents: 1, ttlSeconds: 60 });
    await replay.record("ws_test", stamped("e0", "task.created") as never);
    await replay.record("ws_test", stamped("e1", "task.updated") as never);

    const frames = await resubscribe(replay, ["tasks.*", "*"], "e0");
    expect(frames).toEqual([
      expect.objectContaining({ type: "ws.gap", channel: "tasks.*", oldestAvailable: "e1" }),
      expect.objectContaining({ type: "ws.gap", channel: "*", oldestAvailable: "e1" }),
    ]);
  });
});
