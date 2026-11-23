/**
 * CHAOS-4: every Redis client on the request path fails fast when Redis is
 * connected but stops answering. The rate limiter (every request), the
 * idempotency store (writes with an Idempotency-Key) and the JTI store
 * (session tokens) already refused to queue commands while disconnected, but
 * had no per-command deadline: a hung Redis hung the request.
 *
 * Real ioredis against a socket that answers the ready check and then goes
 * silent (no module mock, no Docker).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";

import { RedisRateLimitBackend } from "../../ratelimitRedis.js";
import { RedisIdempotencyStore } from "../../RedisIdempotencyStore.js";
import { RedisJtiStore } from "../../RedisJtiStore.js";

/**
 * A server that completes ioredis' handshake (HELLO refused so it falls back
 * to RESP2, CLIENT SETINFO, the INFO ready check) and then never answers a
 * command again: Redis "up" but hung.
 */
function handshakeThenSilence(socket: net.Socket): void {
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

let silent: net.Server;
let url: string;

beforeAll(async () => {
  silent = net.createServer(handshakeThenSilence);
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  url = `redis://127.0.0.1:${(silent.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => silent.close(() => r()));
});

async function settlesWithin(work: () => Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([
      work().then(
        () => true,
        () => true
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Wait for the handshake, and check the client really is connected and ready. */
async function ready(client: unknown): Promise<void> {
  await new Promise((r) => setTimeout(r, 200));
  expect((client as { redis: { status: string } }).redis.status).toBe("ready");
}

describe("server Redis clients time out on a silent Redis (CHAOS-4)", () => {
  it("rate limiter: consumeToken and acquireSlot settle within the command deadline", async () => {
    const rl = new RedisRateLimitBackend(url);
    try {
      await ready(rl);
      expect(await settlesWithin(() => rl.consumeToken("k", 2, 20), 2_500)).toBe(true);
      expect(await settlesWithin(() => rl.acquireSlot("k", 10), 2_500)).toBe(true);
    } finally {
      await rl.close();
    }
  }, 20_000);

  it("idempotency store: begin settles within the command deadline", async () => {
    const store = new RedisIdempotencyStore(url);
    try {
      await ready(store);
      expect(await settlesWithin(() => store.begin("ws", "key", "hash"), 2_500)).toBe(true);
    } finally {
      await (store as unknown as { close?: () => Promise<void> }).close?.();
      (store as unknown as { redis: { disconnect(): void } }).redis.disconnect();
    }
  }, 20_000);

  it("JTI store: checkAndRecord settles within the command deadline", async () => {
    const store = new RedisJtiStore(url);
    try {
      await ready(store);
      const expiry = Math.floor(Date.now() / 1000) + 60; // determinism-ok: expiry relative to now, not asserted
      expect(await settlesWithin(() => store.checkAndRecord("jti", expiry), 2_500)).toBe(true);
    } finally {
      await store.close();
    }
  }, 20_000);

  // Review round: the command deadline rejects the caller but ioredis keeps the
  // command queued until a reply arrives; on a silent connection the queue grew
  // without bound. The stalled connection must be dropped instead.
  it.each([
    [
      "rate limiter",
      (url: string) => {
        const c = new RedisRateLimitBackend(url);
        return { client: c, fire: () => c.consumeToken("k", 2, 20), close: () => c.close() };
      },
    ],
    [
      "idempotency store",
      (url: string) => {
        const c = new RedisIdempotencyStore(url);
        return {
          client: c,
          fire: () => c.begin("ws", "key", "hash"),
          close: async () => (c as unknown as { redis: { disconnect(): void } }).redis.disconnect(),
        };
      },
    ],
    [
      "JTI store",
      (url: string) => {
        const c = new RedisJtiStore(url);
        return {
          client: c,
          fire: () => c.checkAndRecord("jti", Math.floor(Date.now() / 1000) + 60), // determinism-ok: token expiry relative to now; the test asserts fail-fast timing, not the value
          close: () => c.close(),
        };
      },
    ],
  ] as const)(
    "%s: no command build-up under sustained traffic to a silent Redis",
    async (_n, make) => {
      const { client, fire, close } = make(url);
      const redis = (client as unknown as { redis: Record<string, unknown> }).redis;
      // While reconnecting, prevCommandQueue IS the old commandQueue: count it once.
      const queued = () => {
        const cmd = redis["commandQueue"] as { length: number };
        const prev = redis["prevCommandQueue"] as { length: number } | null;
        return (
          cmd.length +
          (redis["offlineQueue"] as { length: number }).length +
          (prev && prev !== cmd ? prev.length : 0)
        );
      };
      try {
        await ready(client);
        const until = Date.now() + 2_000; // determinism-ok: polling deadline on the wall clock, not an assertion value
        while (Date.now() /* determinism-ok: polling deadline on the wall clock */ < until) {
          for (let i = 0; i < 50; i++) void fire().catch(() => undefined);
          await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 3_500));
        expect(queued()).toBe(0);
      } finally {
        await close();
      }
    },
    30_000
  );
});
