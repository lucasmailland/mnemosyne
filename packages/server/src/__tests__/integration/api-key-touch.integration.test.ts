/**
 * CHAOS-2: the per-request `touch` against real Postgres.
 *
 * It used to run `UPDATE mnemo_api_keys SET last_used_at = now() WHERE
 * workspace_id = $1` on every authenticated request: every key of the
 * workspace got the same timestamp (including never-used keys), concurrent
 * multi-row updates deadlocked 45-73 times a minute under load, and the
 * touches queued on the same 4-connection pool as the auth lookups, which
 * stalled cold authentications for 15 s.
 *
 * Now `touch` names one key, writes at most once a minute per key (checked
 * in-process and again in SQL, so replicas don't each write), and runs on its
 * own one-connection pool so a blocked touch cannot hold up authentication.
 *
 * Runs as a NOSUPERUSER role that inherits mnemo_app_role, like production.
 * Requires Docker (testcontainers).
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiKeyLookup, type CoreApiKeyLookup } from "@mnemo-ai/core";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const APP_USER = "mnemo_app_touch";
const APP_PASS = "mnemo_app_touch_pass";

const WS_1 = "11111111-1111-4111-8111-111111111111";
const WS_2 = "22222222-2222-4222-8222-222222222222";

let container: StartedTestContainer;
let appUrl: string;
let admin: ReturnType<typeof postgres>;
const lookups: CoreApiKeyLookup[] = [];

function newLookup(): CoreApiKeyLookup {
  const l = createApiKeyLookup({ databaseUrl: appUrl });
  lookups.push(l);
  return l;
}

async function seedKey(id: string, workspaceId: string, lookupHash: string): Promise<void> {
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, lookup_hash)
    VALUES (${id}, ${workspaceId}, ${`bcrypt-not-used-${id}`}, ${id}, ${lookupHash})
  `;
}

async function lastUsed(id: string): Promise<Date | null> {
  const rows = await admin<Array<{ last_used_at: Date | null }>>`
    SELECT last_used_at FROM mnemosyne.mnemo_api_keys WHERE id = ${id}
  `;
  return rows[0]?.last_used_at ?? null;
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superUrl = `postgres://${PG.user}:${PG.password}@${host}:${port}/${PG.db}`;

  admin = postgres(superUrl, { max: 3, onnotice: () => void 0 });
  await admin.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  const { stdout } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });
  expect(stdout).toContain("Done. Applied:");

  await admin.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG.db} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
    GRANT USAGE ON SCHEMA public TO ${APP_USER};
  `);
  appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`;

  await seedKey("key-a", WS_1, "lh-a");
  await seedKey("key-b", WS_1, "lh-b");
  await seedKey("key-c", WS_2, "lh-c");
  for (let i = 0; i < 8; i++) await seedKey(`key-busy-${i}`, WS_2, `lh-busy-${i}`);
}, 180_000);

afterAll(async () => {
  for (const l of lookups) await l.close().catch(() => undefined);
  await admin?.end({ timeout: 2 }).catch(() => undefined);
  await container?.stop().catch(() => undefined);
});

describe("CHAOS-2: touch updates one key, rarely, off the auth pool", () => {
  it("touch(keyId) stamps that key only — not its workspace siblings, not other workspaces", async () => {
    const lookup = newLookup();
    await lookup.touch("key-a");

    expect(await lastUsed("key-a")).toBeInstanceOf(Date);
    expect(await lastUsed("key-b")).toBeNull();
    expect(await lastUsed("key-c")).toBeNull();
  });

  it("a second replica touching the same key within the minute does not rewrite it", async () => {
    const first = await lastUsed("key-a");
    expect(first).toBeInstanceOf(Date);

    const otherReplica = newLookup();
    await otherReplica.touch("key-a");

    expect((await lastUsed("key-a"))?.getTime()).toBe(first!.getTime());
  });

  it("auth lookups stay responsive while touches are blocked on locked rows", async () => {
    const lookup = newLookup();
    // Warm the auth pool so the timing below measures queueing, not connects.
    expect((await lookup.findByLookupHash("lh-c"))?.id).toBe("key-c");

    const busy = Array.from({ length: 8 }, (_, i) => `key-busy-${i}`);
    const holder = await admin.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM mnemosyne.mnemo_api_keys WHERE id = ANY(${busy}) FOR UPDATE`;

      // Eight touches that cannot complete while the rows are locked — more
      // than the auth pool's four connections.
      const touches = busy.map((id) => lookup.touch(id).catch(() => undefined));

      const started = Date.now(); // determinism-ok: measures elapsed wall time for a latency bound
      const found = await Promise.all(
        ["lh-a", "lh-b", "lh-c", "lh-a", "lh-b", "lh-c"].map((h) => lookup.findByLookupHash(h))
      );
      const elapsed = Date.now() - started; // determinism-ok: measures elapsed wall time for a latency bound

      expect(found.map((r) => r?.id)).toEqual([
        "key-a",
        "key-b",
        "key-c",
        "key-a",
        "key-b",
        "key-c",
      ]);
      expect(elapsed).toBeLessThan(2_000);

      await holder`ROLLBACK`;
      await Promise.all(touches);
    } finally {
      holder.release();
    }
  });

  // PG-TIMEOUTS: the auth/touch pools carry the same limits as the storage
  // pools, so a touch stuck on a locked row gives up instead of holding its
  // connection forever.
  it("a touch blocked on a locked row gives up after lock_timeout", async () => {
    await seedKey("key-locked", WS_1, "lh-locked");
    const saved = { ...process.env };
    process.env["MNEMO_PG_STATEMENT_TIMEOUT_MS"] = "2000";
    process.env["MNEMO_PG_LOCK_TIMEOUT_MS"] = "300";
    let lookup: CoreApiKeyLookup;
    try {
      lookup = newLookup();
      // Pools open lazily; open them while the short limits are in the env.
      await lookup.findByLookupHash("lh-locked");
      await lookup.touch("key-a-warm-touch-pool");
    } finally {
      process.env = saved;
    }

    const holder = await admin.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM mnemosyne.mnemo_api_keys WHERE id = 'key-locked' FOR UPDATE`;
      const started = Date.now(); // determinism-ok: measures elapsed wall time for a latency bound
      await expect(lookup.touch("key-locked")).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "55P03" }),
      });
      expect(Date.now() - started).toBeLessThan(1_500); // determinism-ok: measures elapsed wall time for a latency bound
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
  }, 30_000);
});
