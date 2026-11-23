/**
 * PG-TIMEOUTS against real Postgres: every runtime pool carries a
 * statement_timeout, a shorter lock_timeout and an
 * idle_in_transaction_session_timeout, so a stuck connection is released
 * instead of wedging the pool for good (CHAOS-1: all three were `0`).
 * Migrations and long maintenance statements are not cut by them.
 *
 * Requires Docker. Run with:
 *   pnpm --filter @mnemo-ai/adapter-postgres exec vitest run \
 *     --config vitest.integration.config.ts pool-timeouts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createDrizzlePool, makePoolConfigFromEnv } from "../pool-config.js";
import { createDrizzleClient, DrizzleStorageAdapter } from "../DrizzleStorageAdapter.js";
import { withMaintenanceBudget } from "../pg-timeouts.js";
import { isTransientDbError } from "@mnemo-ai/types";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASS = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let databaseUrl: string;
let admin: ReturnType<typeof postgres>;
const toClose: Array<{ end: (o?: { timeout?: number }) => Promise<void> }> = [];

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASS, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  databaseUrl = `postgres://${PG_USER}:${PG_PASS}@${container.getHost()}:${container.getMappedPort(5432)}/${PG_DB}`;
  await migrate({ databaseUrl, log: () => void 0 });
  admin = postgres(databaseUrl, { max: 2, onnotice: () => void 0 });
}, 120_000);

afterAll(async () => {
  for (const c of toClose) await c.end({ timeout: 1 }).catch(() => void 0);
  await admin?.end({ timeout: 1 }).catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

/** A runtime pool built exactly as the server builds it, from an env object. */
function runtimePool(env: Record<string, string> = {}) {
  const pool = createDrizzlePool(makePoolConfigFromEnv({ DATABASE_URL: databaseUrl, ...env }));
  toClose.push(pool.pgClient);
  return pool;
}

async function settings(run: (q: string) => Promise<Array<Record<string, string>>>) {
  const [row] = await run(
    `SELECT current_setting('statement_timeout') AS statement,
            current_setting('lock_timeout') AS lock,
            current_setting('idle_in_transaction_session_timeout') AS idle`
  );
  return row;
}

describe("PG-TIMEOUTS: runtime pools are bounded by default", () => {
  it("createDrizzlePool (the server's main pool) sets all three limits", async () => {
    const { pgClient } = runtimePool();
    expect(await settings((q) => pgClient.unsafe(q))).toEqual({
      statement: "1min",
      lock: "15s",
      idle: "1min",
    });
  });

  it("createDrizzleClient (idempotency, RBAC, outbox worker pools) sets them too", async () => {
    const { pgClient } = createDrizzleClient(databaseUrl);
    toClose.push(pgClient);
    expect(await settings((q) => pgClient.unsafe(q))).toEqual({
      statement: "1min",
      lock: "15s",
      idle: "1min",
    });
  });

  it("env overrides reach the connection", async () => {
    const { pgClient } = runtimePool({
      MNEMO_PG_STATEMENT_TIMEOUT_MS: "20000",
      MNEMO_PG_LOCK_TIMEOUT_MS: "2000",
      MNEMO_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: "30000",
    });
    expect(await settings((q) => pgClient.unsafe(q))).toEqual({
      statement: "20s",
      lock: "2s",
      idle: "30s",
    });
  });
});

describe("PG-TIMEOUTS: a stuck connection is released", () => {
  const SHORT = {
    MNEMO_PG_STATEMENT_TIMEOUT_MS: "1000",
    MNEMO_PG_LOCK_TIMEOUT_MS: "300",
    MNEMO_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS: "1000",
  };

  it("cancels a statement that runs past statement_timeout", async () => {
    const { db } = runtimePool(SHORT);
    const started = Date.now(); // determinism-ok: measures elapsed wall time for a latency bound
    const err = await db.execute(sql`SELECT pg_sleep(5)`).catch((e: unknown) => e);
    expect(err).toMatchObject({ cause: expect.objectContaining({ code: "57014" }) });
    expect(Date.now() - started).toBeLessThan(4_000); // determinism-ok: measures elapsed wall time for a latency bound
    // CHAOS-10: a fired limit is a dependency failure (503), not a bug (500).
    expect(isTransientDbError(err)).toBe(true);
  });

  it("gives up on a held advisory lock after lock_timeout, not statement_timeout", async () => {
    const { db } = runtimePool(SHORT);
    const holder = await admin.reserve();
    try {
      await holder`SELECT pg_advisory_lock(424242)`;
      const started = Date.now(); // determinism-ok: measures elapsed wall time for a latency bound
      const err = await db
        .transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(424242)`);
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ cause: expect.objectContaining({ code: "55P03" }) });
      expect(Date.now() - started).toBeLessThan(1_000); // determinism-ok: measures elapsed wall time for a latency bound
      expect(isTransientDbError(err)).toBe(true);
    } finally {
      await holder`SELECT pg_advisory_unlock(424242)`;
      holder.release();
    }
  });

  it("ends a session left idle in a transaction, and the pool keeps serving", async () => {
    const { db, pgClient } = runtimePool({ ...SHORT, MNEMO_PG_POOL_MAX: "1" });
    // The transaction sits idle while the application waits on something else
    // (what the CHAOS-1 holder did while it waited for a second connection).
    const stuck = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1`);
      await new Promise((r) => setTimeout(r, 2_500));
      await tx.execute(sql`SELECT 1`);
    });
    await expect(stuck).rejects.toBeTruthy();

    // The one pool connection is usable again.
    const [row] = await pgClient`SELECT 1 AS ok`;
    expect(row?.ok).toBe(1);
  }, 15_000);
});

describe("CHAOS-10: an unreachable database fails fast and is classified transient", () => {
  it("a pool pointed at a closed port rejects within the connect timeout", async () => {
    const closed = databaseUrl.replace(/:(\d+)\//, ":1/");
    const { db, pgClient } = createDrizzlePool(
      makePoolConfigFromEnv({ DATABASE_URL: closed, MNEMO_PG_CONNECT_TIMEOUT: "2" })
    );
    toClose.push(pgClient);
    const started = Date.now(); // determinism-ok: measures elapsed wall time for a latency bound
    const err = await db.execute(sql`SELECT 1`).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5_000); // determinism-ok: measures elapsed wall time for a latency bound
    expect(isTransientDbError(err)).toBe(true);
  });

  it("a constraint violation is not transient", async () => {
    const { db } = runtimePool();
    const err = await db
      .transaction(async (tx) => {
        await tx.execute(sql`CREATE TEMP TABLE t_dup (k int PRIMARY KEY) ON COMMIT DROP`);
        await tx.execute(sql`INSERT INTO t_dup VALUES (1)`);
        await tx.execute(sql`INSERT INTO t_dup VALUES (1)`);
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });
    expect(isTransientDbError(err)).toBe(false);
  });
});

describe("PG-TIMEOUTS: what the limits must not cut", () => {
  it("migrations run without them, even with tiny runtime limits configured", async () => {
    await admin.unsafe(`CREATE DATABASE mnemo_migrate_probe`);
    const probeUrl = databaseUrl.replace(/\/[^/]+$/, "/mnemo_migrate_probe");
    const saved = { ...process.env };
    try {
      process.env["MNEMO_PG_STATEMENT_TIMEOUT_MS"] = "50";
      process.env["MNEMO_PG_LOCK_TIMEOUT_MS"] = "10";
      process.env["MNEMO_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS"] = "50";
      await expect(migrate({ databaseUrl: probeUrl, log: () => void 0 })).resolves.toBeDefined();
    } finally {
      process.env = saved;
    }
  });

  it("withMaintenanceBudget lifts the statement limit for one transaction", async () => {
    const { db } = runtimePool({
      MNEMO_PG_STATEMENT_TIMEOUT_MS: "500",
      MNEMO_PG_LOCK_TIMEOUT_MS: "200",
    });
    await expect(db.execute(sql`SELECT pg_sleep(1)`)).rejects.toBeTruthy();
    await expect(
      withMaintenanceBudget(db, (tx) => tx.execute(sql`SELECT pg_sleep(1)`), 0)
    ).resolves.toBeDefined();
    // ...and only for that transaction: the session limit is back afterwards.
    await expect(db.execute(sql`SELECT pg_sleep(1)`)).rejects.toBeTruthy();
  });

  it("the matview refreshes run under the maintenance budget", async () => {
    const { db, pgClient } = runtimePool({
      MNEMO_PG_STATEMENT_TIMEOUT_MS: "500",
      MNEMO_PG_LOCK_TIMEOUT_MS: "200",
    });
    const adapter = new DrizzleStorageAdapter(db, pgClient);
    await expect(adapter.refreshMetacognitionViews()).resolves.toBeUndefined();
    await expect(adapter.refreshAnticipationViews()).resolves.toBeUndefined();
  });
});
