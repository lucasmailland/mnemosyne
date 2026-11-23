/**
 * Integration test: DrizzleIdempotencyStore.reap() (spec §35, migrations 0035 + 0072).
 *
 * Boots a real pgvector container, applies all migrations, and verifies that
 * reap() deletes stale non-completed rows (older than 72h) while leaving
 * completed rows untouched.
 *
 * RLS-safety proof: mnemo_idempotency_keys has FORCE ROW LEVEL SECURITY.
 * Migration 0072 adds a DELETE-only permissive policy (mnemo_idempotency_reap)
 * so mnemo_app_role can delete stale in-flight rows cross-workspace without
 * superuser/BYPASSRLS. This test creates a NOSUPERUSER NOBYPASSRLS role
 * (appconn) and calls reap() through it to prove the fix works in production
 * conditions — not just as the superuser test account.
 *
 * Requires Docker (testcontainers).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createDrizzleClient } from "../DrizzleStorageAdapter.js";
import { DrizzleIdempotencyStore } from "../DrizzleIdempotencyStore.js";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const WS_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let container: StartedTestContainer;
// Superuser db client for seeding and verification (bypasses RLS).
let superDb: ReturnType<typeof createDrizzleClient>["db"];
let superPg: { end: () => Promise<void> };
// Non-superuser store: the actual subject under test.
let appStore: DrizzleIdempotencyStore;
let appPg: { end: () => Promise<void> };

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: "mnemo_test",
      POSTGRES_PASSWORD: "mnemo_test",
      POSTGRES_DB: "mnemo_test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const superUrl = `postgres://mnemo_test:mnemo_test@${container.getHost()}:${container.getMappedPort(5432)}/mnemo_test`;
  await migrate({ databaseUrl: superUrl, log: () => {} });

  const superClient = createDrizzleClient(superUrl);
  superDb = superClient.db;
  superPg = superClient.pgClient as unknown as { end: () => Promise<void> };

  // Create a NOSUPERUSER NOBYPASSRLS role with mnemo_app_role — mirrors prod.
  const admin = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'appconn') THEN
          CREATE ROLE appconn LOGIN PASSWORD 'appconn' NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
      GRANT mnemo_app_role TO appconn;
      GRANT CONNECT ON DATABASE mnemo_test TO appconn;
    `);
  } finally {
    await admin.end();
  }

  const u = new URL(superUrl);
  u.username = "appconn";
  u.password = "appconn";
  const appUrl = u.toString();

  const appClient = createDrizzleClient(appUrl);
  appStore = new DrizzleIdempotencyStore(appClient.db);
  appPg = appClient.pgClient as unknown as { end: () => Promise<void> };
}, 120_000);

afterAll(async () => {
  await superPg?.end?.();
  await appPg?.end?.();
  await container?.stop();
});

describe("DrizzleIdempotencyStore.reap() — RLS-safe under non-superuser (spec §35 + migration 0072)", () => {
  it("deletes stale in-flight rows and leaves completed rows, running as NOSUPERUSER NOBYPASSRLS appconn", async () => {
    // Seed test rows as superuser (RLS-bypassing) — set workspace GUC for INSERT.
    await superDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL row_security = off`);
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_idempotency_keys
          (workspace_id, key, request_hash, recovery_point, locked_at, created_at)
        VALUES
          (${WS_A}, 'reap-stale-001', 'hash-stale', 'started',
           now() - interval '80 hours', now() - interval '80 hours'),
          (${WS_B}, 'reap-fresh-001', 'hash-fresh', 'completed',
           now(), now())
      `);
    });

    // Confirm both rows exist before reap (as superuser, RLS off).
    const before = await superDb.execute<{ key: string }>(sql`
      SELECT key FROM mnemosyne.mnemo_idempotency_keys
      WHERE key IN ('reap-stale-001', 'reap-fresh-001')
      ORDER BY key
    `);
    expect(before.map((r) => r.key)).toContain("reap-stale-001");
    expect(before.map((r) => r.key)).toContain("reap-fresh-001");

    // Call reap() AS THE NON-SUPERUSER appconn — this is the proof of RLS-safety.
    // Prior to migration 0072, this would throw:
    //   ERROR: query would be affected by row-level security policy
    // because reap() used SET LOCAL row_security = off (superuser-only).
    const result = await appStore.reap();
    expect(result).toEqual({ reaped: 1 });

    // Verify as superuser: stale row gone, fresh completed row survives.
    const after = await superDb.execute<{ key: string }>(sql`
      SELECT key FROM mnemosyne.mnemo_idempotency_keys
      WHERE key IN ('reap-stale-001', 'reap-fresh-001')
      ORDER BY key
    `);
    const afterKeys = after.map((r) => r.key);
    expect(afterKeys).not.toContain("reap-stale-001");
    expect(afterKeys).toContain("reap-fresh-001");
  });
});
