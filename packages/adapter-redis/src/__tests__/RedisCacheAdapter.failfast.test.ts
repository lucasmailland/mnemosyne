/**
 * CHAOS-4: with Redis down, `/recall` and `/session/start` hung ~97 s before
 * failing. The client queued every command offline and retried each up to 20
 * times. Commands must fail fast instead — both when nothing listens and when
 * a server accepts the connection but stops answering — so callers can fall
 * back (hot tier → cold recall) or answer 503 at once. (Against a real Redis,
 * the hash and list suites cover commands issued while still connecting.)
 *
 * Real ioredis against real sockets (no module mock, no Docker).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { RedisCacheAdapter } from "../RedisCacheAdapter.js";

const DEADLINE_MS = 5_000;

async function settled<T>(work: Promise<T>): Promise<{ ok: boolean; ms: number; err?: unknown }> {
  const started = Date.now(); // determinism-ok: measures elapsed wall time for a latency bound
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"hung">((r) => {
    timer = setTimeout(() => r("hung"), DEADLINE_MS);
  });
  try {
    const out = await Promise.race([
      work.then(
        () => ({ ok: true }),
        (err: unknown) => ({ ok: false, err })
      ),
      deadline,
    ]);
    if (out === "hung") throw new Error(`still pending after ${DEADLINE_MS} ms`);
    return { ...out, ms: Date.now() - started }; // determinism-ok: measures elapsed wall time for a latency bound
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A server that completes ioredis' handshake (HELLO refused so it falls back
 * to RESP2, CLIENT SETINFO, the INFO ready check) and then never answers a
 * command again: Redis "up" but hung.
 */
let openSockets = 0;

function handshakeThenSilence(socket: net.Socket): void {
  openSockets++;
  socket.on("close", () => openSockets--);
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split("\r\n");
    buffered = lines.pop() ?? "";
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (!line.startsWith("*")) {
        i++;
        continue;
      }
      const name = (lines[i + 2] ?? "").toUpperCase();
      i += 1 + 2 * Number(line.slice(1));
      if (name === "HELLO") socket.write("-ERR unknown command 'HELLO'\r\n");
      else if (name === "CLIENT" || name === "SELECT" || name === "AUTH") socket.write("+OK\r\n");
      else if (name === "INFO") {
        const body = "# Server\r\nloading:0\r\n";
        socket.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`);
      }
      // Any other command: silence.
    }
  });
  socket.on("error", () => undefined);
}

/** Completes the handshake, then never answers again. */
let silent: net.Server;
let silentPort: number;
/** A port with nothing listening. */
let closedPort: number;

beforeAll(async () => {
  silent = net.createServer(handshakeThenSilence);
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  silentPort = (silent.address() as net.AddressInfo).port;

  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  closedPort = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
});

afterAll(async () => {
  await new Promise<void>((r) => silent.close(() => r()));
});

describe("RedisCacheAdapter fails fast (CHAOS-4)", () => {
  it("rejects promptly when nothing listens (bounded offline queue, no 20 retries)", async () => {
    const cache = new RedisCacheAdapter({ host: "127.0.0.1", port: closedPort });
    try {
      await new Promise((r) => setTimeout(r, 200)); // let the first connect attempt fail
      const res = await settled(cache.get("k"));
      expect(res.ok).toBe(false);
      expect(res.ms).toBeLessThan(2_500);
      expect((await settled(cache.zrangeByScore("z", -Infinity, Infinity))).ok).toBe(false);
      const health = await settled(cache.healthCheck());
      expect(health.ok).toBe(true);
      expect((await cache.healthCheck()).status).toBe("down");
    } finally {
      await cache.close();
    }
  }, 20_000);

  it("times a command out when the server is connected but unresponsive", async () => {
    const cache = new RedisCacheAdapter({ host: "127.0.0.1", port: silentPort });
    try {
      await new Promise((r) => setTimeout(r, 200)); // connected + ready check answered
      expect((cache as unknown as { redis: { status: string } }).redis.status).toBe("ready");
      const res = await settled(cache.get("k"));
      expect(res.ok).toBe(false);
      expect(res.ms).toBeLessThan(2_500);
      const started = Date.now(); // determinism-ok: measures elapsed wall time for a latency bound
      expect((await cache.healthCheck()).status).toBe("down");
      expect(Date.now() - started).toBeLessThan(2_500); // determinism-ok: measures elapsed wall time for a latency bound
    } finally {
      await cache.close();
    }
  }, 20_000);

  // Review round: a command deadline rejects the caller, but ioredis keeps the
  // command in its queue until a reply arrives, and a silent connection never
  // replies, so sustained traffic grew the queue without bound (3,900 commands
  // after 8 s at 500/s, never drained). The connection itself must be dropped.
  it("does not accumulate commands under sustained traffic to a silent server", async () => {
    const cache = new RedisCacheAdapter({ host: "127.0.0.1", port: silentPort });
    const client = (cache as unknown as { redis: Record<string, unknown> }).redis;
    // While reconnecting, prevCommandQueue IS the old commandQueue: count it once.
    const queued = () => {
      const cmd = client["commandQueue"] as { length: number };
      const prev = client["prevCommandQueue"] as { length: number } | null;
      return (
        cmd.length +
        (client["offlineQueue"] as { length: number }).length +
        (prev && prev !== cmd ? prev.length : 0)
      );
    };
    try {
      await new Promise((r) => setTimeout(r, 200));
      let peak = 0;
      const until = Date.now() + 4_000; // determinism-ok: polling deadline on the wall clock, not an assertion value
      while (Date.now() /* determinism-ok: polling deadline on the wall clock */ < until) {
        for (let i = 0; i < 50; i++) void cache.get(`k${i}`).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 100));
        peak = Math.max(peak, queued());
      }
      // Bounded by what arrives within one stall window, not by elapsed time.
      expect(peak).toBeLessThan(1_500);
      // Once traffic stops, nothing stays queued, and no socket was leaked.
      await new Promise((r) => setTimeout(r, 4_000));
      expect(queued()).toBe(0);
      expect(openSockets).toBeLessThanOrEqual(1);
    } finally {
      await cache.close();
    }
  }, 30_000);
});
