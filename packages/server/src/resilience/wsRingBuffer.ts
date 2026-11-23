/**
 * §34.10 per-connection bounded ring buffer (MEMORY_IMPROVEMENT.md:3748-3793).
 */
import type { MnemoBusEvent } from "@mnemo-ai/types";
import { wsBufferDepth, wsDropsTotal, wsSlowConsumers } from "../metrics/backpressure.js";

/**
 * Synthetic control frame emitted by the server when the replay buffer reports
 * a gap (cursor too old). Routing it through the same push/flush path as live
 * events ensures it is never delivered out-of-order relative to already-buffered
 * live events.
 */
export interface WsControlFrame {
  type: "ws.gap";
  channel: string;
  oldestAvailable: string | null;
  message?: string;
}

/** Union of all frame types that may pass through the per-connection ring buffer. */
export type SubscriberFrame = MnemoBusEvent | WsControlFrame;

interface WsLike {
  send(data: string): void;
  readyState: number;
  close?(code?: number, reason?: string): void;
}

export interface WsSubscriberOpts {
  maxBufferSize?: number;
  slowFlushMs?: number;
  disconnectAfterMs?: number;
}

const OPEN = 1;

export class WsSubscriber {
  private buf: (SubscriberFrame | undefined)[];
  private head = 0;
  private count = 0;
  private cap: number;
  private slowFlushMs: number;
  private disconnectAfterMs: number;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private fullSince: number | null = null;
  private ready = true;
  dropped = 0;
  isSlow = false;

  constructor(readonly connectionId: string, private readonly ws: WsLike, opts: WsSubscriberOpts = {}) {
    this.cap = opts.maxBufferSize ?? 100;
    this.slowFlushMs = opts.slowFlushMs ?? 500;
    this.disconnectAfterMs = opts.disconnectAfterMs ?? 300_000;
    this.buf = new Array(this.cap);
  }

  markNotReady(): void { this.ready = false; }
  get depth(): number { return this.count; }

  oldestN(): number | undefined {
    if (this.count === 0) return undefined;
    const frame = this.buf[this.head];
    if (!frame || frame.type === "ws.gap") return undefined;
    return (frame.payload as { n?: number } | undefined)?.n;
  }

  push(event: SubscriberFrame): void {
    if (this.count === this.cap) {
      this.head = (this.head + 1) % this.cap;
      this.count--;
      this.dropped++;
      wsDropsTotal.inc({ connection_id: this.connectionId, reason: "buffer_full" });
      if (this.fullSince === null) this.fullSince = Date.now();
    }
    const tail = (this.head + this.count) % this.cap;
    this.buf[tail] = event;
    this.count++;
    wsBufferDepth.set({ connection_id: this.connectionId, channel: event.channel }, this.count);

    const slowNow = this.count >= this.cap * 0.5;
    if (slowNow && !this.isSlow) { this.isSlow = true; wsSlowConsumers.set({}, 1); }

    if (this.isSlow && this.slowFlushMs > 0) this.scheduleFlush();
    else this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, this.slowFlushMs);
  }

  flush(): void {
    if (!this.ready || this.ws.readyState !== OPEN) return;
    if (this.count === 0) return;
    const out: SubscriberFrame[] = [];
    while (this.count > 0) {
      out.push(this.buf[this.head]!);
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.cap;
      this.count--;
    }
    this.ws.send(JSON.stringify(out.length === 1 ? out[0] : out));
    this.fullSince = null;
    wsBufferDepth.set({ connection_id: this.connectionId, channel: "*" }, 0);
    if (this.isSlow) { this.isSlow = false; wsSlowConsumers.set({}, 0); }
  }

  shouldDisconnect(nowMs: number): boolean {
    return this.fullSince !== null && nowMs - this.fullSince >= this.disconnectAfterMs;
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}
