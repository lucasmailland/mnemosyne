import { describe, it, expect, vi } from "vitest";
import { WsSubscriber } from "../../resilience/wsRingBuffer.js";
import type { MnemoEvent } from "@mnemo-ai/types";

function evt(n: number): MnemoEvent {
  return { channel: "facts.*", type: "fact.created", payload: { n },
    timestamp: new Date().toISOString(), // determinism-ok: throwaway fixture date, not asserted
    traceId: "t" };
}

describe("§34.10 WS ring buffer", () => {
  it("drops oldest when buffer exceeds maxBufferSize", () => {
    const sent: string[] = [];
    const ws = { send: (s: string) => sent.push(s), readyState: 1 } as never;
    const sub = new WsSubscriber("c1", ws, { maxBufferSize: 3, slowFlushMs: 0 });
    sub.markNotReady();
    sub.push(evt(1)); sub.push(evt(2)); sub.push(evt(3)); sub.push(evt(4));
    expect(sub.depth).toBe(3);
    expect(sub.dropped).toBe(1);
    expect(sub.oldestN()).toBe(2);
  });

  it("marks slow at 50% full", () => {
    const ws = { send: () => {}, readyState: 1 } as never;
    const sub = new WsSubscriber("c1", ws, { maxBufferSize: 10, slowFlushMs: 500 });
    sub.markNotReady();
    for (let i = 0; i < 5; i++) sub.push(evt(i));
    expect(sub.isSlow).toBe(true);
  });

  it("flushes immediately when ready and not slow", () => {
    const sent: string[] = [];
    const ws = { send: (s: string) => sent.push(s), readyState: 1 } as never;
    const sub = new WsSubscriber("c1", ws, { maxBufferSize: 100, slowFlushMs: 500 });
    sub.push(evt(1));
    expect(sent.length).toBe(1);
    expect(sub.depth).toBe(0);
  });

  it("signals disconnect after sustained buffer-full", () => {
    vi.useFakeTimers();
    const ws = { send: () => {}, readyState: 1, close: vi.fn() } as never;
    const sub = new WsSubscriber("c1", ws, { maxBufferSize: 1, slowFlushMs: 0, disconnectAfterMs: 300_000 });
    sub.markNotReady();
    sub.push(evt(1)); sub.push(evt(2));
    expect(sub.shouldDisconnect(Date.now())).toBe(false); // determinism-ok: result is false regardless of exact time
    vi.advanceTimersByTime(300_001);
    sub.push(evt(3));
    expect(sub.shouldDisconnect(Date.now())).toBe(true); // determinism-ok: uses vi fake timers, Date.now() is synthetic
    vi.useRealTimers();
  });
});
