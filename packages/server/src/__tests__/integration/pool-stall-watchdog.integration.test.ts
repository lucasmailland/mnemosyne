/**
 * The pool-stall watchdog against real Postgres (PG-TIMEOUTS, CHAOS-1).
 *
 * A pool whose only connection is held cannot run `SELECT 1`, while a fresh
 * connection can: that is a local stall and must flag. The direct probe must
 * leave no connection behind, whether it answered or not.
 *
 * Requires Docker (testcontainers).
 */
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDirectPgProbe, createPoolStallWatchdog } from "../../resilience/poolStallWatchdog.js";

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };

let container: StartedTestContainer;
let url: string;
let admin: ReturnType<typeof postgres>;

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  url = `postgres://${PG.user}:${PG.password}@${container.getHost()}:${container.getMappedPort(5432)}/${PG.db}`;
  admin = postgres(url, { max: 1, onnotice: () => undefined });
}, 120_000);

afterAll(async () => {
  await admin?.end({ timeout: 1 }).catch(() => undefined);
  await container?.stop().catch(() => undefined);
});

async function backends(): Promise<number> {
  const [row] = await admin<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = ${PG.db} AND pid <> pg_backend_pid() AND backend_type = 'client backend'
  `;
  return row!.n;
}

describe("pool-stall watchdog on real Postgres", () => {
  it("the direct probe answers and closes its connection", async () => {
    const before = await backends();
    await createDirectPgProbe(url)(new AbortController().signal);
    await new Promise((r) => setTimeout(r, 200));
    expect(await backends()).toBe(before);
  });

  it("flags a pool whose only connection is held, without leaking probes", async () => {
    const pool = postgres(url, { max: 1, onnotice: () => undefined });
    const held = await pool.reserve();
    try {
      const before = await backends();
      let t = 0;
      const w = createPoolStallWatchdog({
        probePool: () => pool`SELECT 1`,
        probeDirect: createDirectPgProbe(url),
        probeTimeoutMs: 500,
        stallAfterMs: 1_000,
        now: () => t,
      });
      for (const at of [0, 500, 1_000]) {
        t = at;
        await w.tick();
      }
      expect(w.state()).toMatchObject({ stalled: true, reason: "pool_stalled" });
      await new Promise((r) => setTimeout(r, 300));
      // Only the held pool connection, as before: no direct probe left open.
      expect(await backends()).toBe(before);
    } finally {
      held.release();
      await pool.end({ timeout: 1 }).catch(() => undefined);
    }
  });
});
