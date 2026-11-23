/**
 * Pool-stall watchdog — lets liveness notice a wedged database pool
 * (PG-TIMEOUTS, CHAOS-1).
 *
 * On the chaos stack the application pool deadlocked for good while
 * `/health/live` kept answering 200, so no orchestrator restarted the
 * instance. Liveness must still never fail because the DATABASE is down: that
 * turns an outage into a restart storm. So the watchdog separates the two:
 *
 *   - pool answers `SELECT 1`                      → healthy
 *   - pool does not, a fresh connection does       → local stall (counts)
 *   - neither answers                              → database unreachable
 *                                                    (resets; never fails liveness)
 *
 * Liveness fails only when a local stall has lasted `stallAfterMs`. Probes run
 * on a background timer and liveness reads the last verdict, so the probe
 * endpoint stays instant (orchestrators time liveness out after ~1-3 s).
 */

import { Socket } from "node:net";

export interface PoolStallWatchdogOptions {
  /**
   * `SELECT 1` through the application pool. Never more than one in flight:
   * while the previous one is still pending, the pool counts as not answering.
   */
  probePool: () => Promise<unknown>;
  /**
   * `SELECT 1` on a fresh connection outside the pool. `signal` aborts at the
   * deadline, and the probe must then release its connection
   * ({@link createDirectPgProbe} does).
   */
  probeDirect: (signal: AbortSignal) => Promise<unknown>;
  /** A probe that has not settled after this long counts as failed. */
  probeTimeoutMs: number;
  /** How long a local stall must last before liveness fails. 0 disables. */
  stallAfterMs: number;
  /** Background probe period for {@link PoolStallWatchdog.start}. Default 10 s. */
  intervalMs?: number;
  now?: () => number;
}

export interface PoolStallState {
  stalled: boolean;
  /** When the current local stall began; null when the pool answers (or the DB is down). */
  failingSinceMs: number | null;
  reason: "ok" | "pool_stalled" | "db_unreachable";
}

export interface PoolStallWatchdog {
  /** Run one probe cycle. Concurrent calls share the cycle in flight. */
  tick(): Promise<void>;
  state(): PoolStallState;
  start(): void;
  stop(): void;
}

/** Whether `work` settled successfully within `ms`. */
async function settledOkWithin(work: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function succeeds(work: () => Promise<unknown>): Promise<boolean> {
  return Promise.resolve()
    .then(work)
    .then(
      () => true,
      () => false
    );
}

export function createPoolStallWatchdog(opts: PoolStallWatchdogOptions): PoolStallWatchdog {
  const now = opts.now ?? Date.now;
  let current: PoolStallState = { stalled: false, failingSinceMs: null, reason: "ok" };
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  // A pool probe that outlives its deadline stays queued in the pool; starting
  // another on every tick would pile them up behind a wedged pool.
  let pendingPoolProbe: Promise<boolean> | null = null;

  async function cycle(): Promise<void> {
    let poolOk = false;
    if (!pendingPoolProbe) {
      const probe = succeeds(opts.probePool).finally(() => {
        pendingPoolProbe = null;
      });
      pendingPoolProbe = probe;
      poolOk = await settledOkWithin(probe, opts.probeTimeoutMs);
    }
    if (poolOk) {
      current = { stalled: false, failingSinceMs: null, reason: "ok" };
      return;
    }
    const abort = new AbortController();
    const directOk = await settledOkWithin(
      succeeds(() => opts.probeDirect(abort.signal)),
      opts.probeTimeoutMs
    );
    abort.abort(); // releases the direct connection if it is still open
    if (!directOk) {
      current = { stalled: false, failingSinceMs: null, reason: "db_unreachable" };
      return;
    }
    const since = current.failingSinceMs ?? now();
    current = {
      stalled: opts.stallAfterMs > 0 && now() - since >= opts.stallAfterMs,
      failingSinceMs: since,
      reason: "pool_stalled",
    };
  }

  function tick(): Promise<void> {
    inFlight ??= cycle().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    tick,
    state: () => current,
    start() {
      if (timer || opts.stallAfterMs <= 0) return;
      timer = setInterval(() => void tick(), opts.intervalMs ?? 10_000);
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/**
 * `SELECT 1` on a fresh, single-connection client outside every pool. The
 * connection is always closed: after the answer, or at once when `signal`
 * aborts (the watchdog's deadline). A connect timeout does not bound a query
 * on an established connection, so without the abort a database that accepts
 * connections and then goes silent leaked one connection per tick.
 */
export function createDirectPgProbe(
  databaseUrl: string,
  connectTimeoutSeconds = 5
): (signal: AbortSignal) => Promise<void> {
  return async (signal) => {
    if (signal.aborted) throw new Error("direct probe aborted");
    const { default: postgres } = await import("postgres");
    if (signal.aborted) throw new Error("direct probe aborted");
    const sockets = new Set<Socket>();
    let hostIndex = 0;
    const options = {
      max: 1,
      connect_timeout: connectTimeoutSeconds,
      // SELECT 1 needs no array types. Left on, postgres.js runs its own
      // type query on connect, and destroying the connection at the deadline
      // rejected that internal promise with nobody listening: an unhandled
      // rejection, which crashes a Node process by default.
      fetch_types: false,
      onnotice: () => undefined,
      // postgres.js' graceful end can leave a socket that is still connecting
      // alive until connect_timeout. Own the transport so the probe deadline
      // destroys it even during startup, TLS negotiation or a silent query.
      socket: async ({ host, port, path }: { host: string[]; port: number[]; path?: string }) => {
        // The driver cannot fail over when its async socket factory rejects:
        // its close/reconnect listeners are attached only after this resolves.
        // Try the remaining endpoints here, within the same abort deadline.
        const attempts = path ? 1 : host.length;
        for (let attempt = 0; attempt < attempts; attempt++) {
          if (signal.aborted) throw new Error("direct probe aborted");
          try {
            return await new Promise<Socket>((resolve, reject) => {
              const socket = new Socket();
              sockets.add(socket);
              const timer =
                connectTimeoutSeconds > 0
                  ? setTimeout(
                      () => socket.destroy(new Error("direct probe connect timeout")),
                      connectTimeoutSeconds * 1000
                    )
                  : undefined;
              socket.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
                socket.destroy();
              });
              socket.once("close", () => {
                clearTimeout(timer);
                sockets.delete(socket);
                reject(new Error("direct probe connection closed"));
              });
              socket.once("connect", () => {
                clearTimeout(timer);
                resolve(socket);
              });
              if (path) socket.connect(path);
              else {
                const destination = { host: host[hostIndex]!, port: (port[hostIndex] ?? port[0])! };
                Object.assign(socket, destination); // postgres.js uses host for TLS SNI
                hostIndex = (hostIndex + 1) % host.length;
                socket.connect(destination);
              }
            });
          } catch (error) {
            if (signal.aborted || attempt === attempts - 1) throw error;
          }
        }
        throw new Error("direct probe has no database endpoints");
      },
    };
    const direct = postgres(databaseUrl, options);
    const destroy = () => {
      for (const socket of sockets) socket.destroy();
      void direct.end({ timeout: 0 }).catch(() => undefined);
    };
    signal.addEventListener("abort", destroy, { once: true });
    try {
      if (signal.aborted) throw new Error("direct probe aborted");
      await direct`SELECT 1`;
    } finally {
      signal.removeEventListener("abort", destroy);
      destroy();
    }
  };
}
