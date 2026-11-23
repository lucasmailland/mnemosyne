/**
 * PG-TIMEOUTS / CHAOS-1: liveness must notice a wedged database pool.
 *
 * On the chaos stack the pool deadlocked for good and `/health/live` kept
 * answering 200, so nothing restarted the instance. The watchdog tells a
 * LOCAL pool stall (the pool cannot run `SELECT 1`, a fresh connection can)
 * apart from a database outage (neither can), and only the former, sustained,
 * fails liveness: restarting because the database is down would only add a
 * restart storm to the outage.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import net from "node:net";

import {
  createDirectPgProbe,
  createPoolStallWatchdog,
} from "../../resilience/poolStallWatchdog.js";
import { mountProbes } from "../../routes/health.js";
import type { ServerDeps } from "../../deps.js";

const never = () => new Promise<never>(() => undefined);
const ok = async () => undefined;
const fail = async () => {
  throw new Error("connection refused");
};

function watchdog(
  probePool: () => Promise<unknown>,
  probeDirect: () => Promise<unknown>,
  clock: { t: number }
) {
  return createPoolStallWatchdog({
    probePool,
    probeDirect,
    probeTimeoutMs: 20,
    stallAfterMs: 60_000,
    now: () => clock.t,
  });
}

describe("createPoolStallWatchdog", () => {
  it("is healthy while the pool answers", async () => {
    const clock = { t: 0 };
    const w = watchdog(ok, ok, clock);
    await w.tick();
    expect(w.state()).toMatchObject({ stalled: false, failingSinceMs: null });
  });

  it("flags a sustained local stall: pool hangs, a direct connection works", async () => {
    const clock = { t: 0 };
    const w = watchdog(never, ok, clock);
    await w.tick();
    expect(w.state()).toMatchObject({ stalled: false, failingSinceMs: 0, reason: "pool_stalled" });
    clock.t = 59_999;
    await w.tick();
    expect(w.state().stalled).toBe(false);
    clock.t = 60_000;
    await w.tick();
    expect(w.state()).toMatchObject({ stalled: true, reason: "pool_stalled" });
  });

  it("never flags a database outage (direct connection fails too)", async () => {
    const clock = { t: 0 };
    const w = watchdog(fail, fail, clock);
    for (const t of [0, 30_000, 120_000]) {
      clock.t = t;
      await w.tick();
    }
    expect(w.state()).toMatchObject({
      stalled: false,
      failingSinceMs: null,
      reason: "db_unreachable",
    });
  });

  it("an outage in the middle resets the stall clock", async () => {
    const clock = { t: 0 };
    let direct: () => Promise<unknown> = ok;
    const w = watchdog(never, () => direct(), clock);
    await w.tick(); // stall starts at 0
    direct = fail;
    clock.t = 30_000;
    await w.tick(); // DB unreachable: not a local stall
    direct = ok;
    clock.t = 70_000;
    await w.tick(); // stall starts again at 70 s
    expect(w.state()).toMatchObject({ stalled: false, failingSinceMs: 70_000 });
  });

  it("recovers as soon as the pool answers again", async () => {
    const clock = { t: 0 };
    // A wedged pool: the probe stays queued until the pool frees up.
    let unwedge!: () => void;
    const queued = new Promise<void>((r) => (unwedge = r));
    let pool: () => Promise<unknown> = () => queued;
    const w = watchdog(() => pool(), ok, clock);
    await w.tick();
    clock.t = 61_000;
    await w.tick();
    expect(w.state().stalled).toBe(true);
    unwedge(); // the queued probe finally runs...
    pool = ok;
    await new Promise((r) => setTimeout(r, 0));
    await w.tick(); // ...so the next tick probes afresh
    expect(w.state()).toMatchObject({ stalled: false, failingSinceMs: null });
  });

  it("does not stack probes: a tick in flight is reused", async () => {
    const clock = { t: 0 };
    const probePool = vi.fn(() => new Promise<void>((r) => setTimeout(r, 10)));
    const w = watchdog(probePool, ok, clock);
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    expect(probePool).toHaveBeenCalledTimes(1);
  });

  it("is disabled with stallAfterMs 0", async () => {
    const clock = { t: 0 };
    const w = createPoolStallWatchdog({
      probePool: never,
      probeDirect: ok,
      probeTimeoutMs: 20,
      stallAfterMs: 0,
      now: () => clock.t,
    });
    clock.t = 1e9;
    await w.tick();
    expect(w.state().stalled).toBe(false);
  });
});

describe("/health/live and the watchdog", () => {
  function liveApp(state: { stalled: boolean; failingSinceMs: number | null }) {
    const app = new Hono();
    mountProbes(app, {
      storage: { healthCheck: async () => ({ status: "ok" }) },
      bus: undefined,
      healthAdapters: {
        poolStall: { state: () => ({ ...state, reason: "pool_stalled" }) },
      },
    } as unknown as ServerDeps);
    return app;
  }

  it("answers 200 alive while the pool is not stalled", async () => {
    const res = await liveApp({ stalled: false, failingSinceMs: null }).request("/health/live");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "alive" });
  });

  it("answers 503 once the pool has been stalled past the threshold", async () => {
    const res = await liveApp({ stalled: true, failingSinceMs: 0 }).request("/health/live");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "stalled", reason: "db_pool_stalled" });
  });

  it("answers without touching the database (no probe on the request path)", async () => {
    const healthCheck = vi.fn(never);
    const app = new Hono();
    mountProbes(app, { storage: { healthCheck }, bus: undefined } as unknown as ServerDeps);
    const res = await app.request("/health/live");
    expect(res.status).toBe(200);
    expect(healthCheck).not.toHaveBeenCalled();
  });
});

describe("readiness probes are bounded", () => {
  function appWith(adapters: Record<string, unknown>, storage = { healthCheck: never }) {
    const app = new Hono();
    mountProbes(
      app,
      { storage, bus: undefined, healthAdapters: adapters } as unknown as ServerDeps,
      {
        probeTimeoutMs: 50,
      }
    );
    return app;
  }
  const okA = { healthCheck: async () => ({ status: "ok", latencyMs: 1 }) };

  it("/health/ready answers 503 promptly when the storage probe never settles (wedged pool)", async () => {
    const started = Date.now(); // determinism-ok: measures elapsed wall time for a latency bound
    const res = await appWith({
      storage: { healthCheck: never },
      vector: okA,
      cache: okA,
      embed: okA,
    }).request("/health/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "not_ready", reason: "postgres_unavailable" });
    expect(Date.now() - started).toBeLessThan(1_000); // determinism-ok: measures elapsed wall time for a latency bound
  });

  it("/health/ready marks a hanging cache down instead of waiting for it (CHAOS-4: 10.7 s)", async () => {
    const started = Date.now(); // determinism-ok: measures elapsed wall time for a latency bound
    const res = await appWith({
      storage: okA,
      vector: okA,
      cache: { healthCheck: never },
      embed: okA,
    }).request("/health/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ degraded: true, checks: { cache: "down" } });
    expect(Date.now() - started).toBeLessThan(1_000); // determinism-ok: measures elapsed wall time for a latency bound
  });

  it("/readyz answers 503 promptly when the storage probe never settles", async () => {
    const res = await appWith({}).request("/readyz");
    expect(res.status).toBe(503);
  });
});

// ─── Review round: the watchdog must not leak its own probes ──────────────────

/**
 * Speaks just enough of the Postgres protocol to finish the startup handshake
 * (AuthenticationOk, BackendKeyData, ReadyForQuery), then never answers a
 * query: a database reachable but hung. Counts the sockets still open.
 */
let fakePg: net.Server;
let fakePgUrl: string;
let openSockets = 0;

beforeAll(async () => {
  fakePg = net.createServer((socket) => {
    openSockets++;
    socket.on("close", () => openSockets--);
    socket.on("error", () => undefined);
    let started = false;
    socket.on("data", () => {
      if (started) return; // queries: silence
      started = true;
      const auth = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]); // R: AuthenticationOk
      const key = Buffer.from([0x4b, 0, 0, 0, 12, 0, 0, 0, 1, 0, 0, 0, 2]); // K: BackendKeyData
      const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]); // Z: ReadyForQuery (idle)
      socket.write(Buffer.concat([auth, key, ready]));
    });
  });
  await new Promise<void>((r) => fakePg.listen(0, "127.0.0.1", r));
  fakePgUrl = `postgres://u:p@127.0.0.1:${(fakePg.address() as net.AddressInfo).port}/db`;
});

afterAll(async () => {
  await new Promise<void>((r) => fakePg.close(() => r()));
});

describe("watchdog probes are bounded underneath their deadlines (review)", () => {
  it("never starts a second pool probe while the previous one is outstanding", async () => {
    const probePool = vi.fn(never);
    const w = createPoolStallWatchdog({
      probePool,
      probeDirect: ok,
      probeTimeoutMs: 10,
      stallAfterMs: 60_000,
      now: () => 0,
    });
    for (let i = 0; i < 5; i++) await w.tick();
    expect(probePool).toHaveBeenCalledTimes(1);
    expect(w.state().reason).toBe("pool_stalled");
  });

  it("closes each direct probe connection when its deadline passes (silent database)", async () => {
    const w = createPoolStallWatchdog({
      probePool: never,
      probeDirect: createDirectPgProbe(fakePgUrl),
      probeTimeoutMs: 200,
      stallAfterMs: 60_000,
      now: () => 0,
    });
    for (let i = 0; i < 5; i++) await w.tick();
    // The database is reachable but silent: not a local stall, and no
    // connection may be left behind.
    expect(w.state().reason).toBe("db_unreachable");
    await new Promise((r) => setTimeout(r, 300));
    expect(openSockets).toBe(0);
  }, 20_000);

  it("an already-aborted direct probe opens nothing that stays open", async () => {
    const controller = new AbortController();
    controller.abort();
    await createDirectPgProbe(fakePgUrl)(controller.signal).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    expect(openSockets).toBe(0);
  });
});
