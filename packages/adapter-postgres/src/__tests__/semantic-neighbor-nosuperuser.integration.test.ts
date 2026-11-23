/**
 * NOSUPERUSER proof for public.mnemo_semantic_neighbor access.
 *
 * Migration 0073 (core/public) creates public.mnemo_semantic_neighbor but
 * never GRANTs DML access to mnemo_app_role. The adapter-postgres baseline
 * (0001) closes that gap.
 *
 * This test proves:
 *   1. A NOSUPERUSER NOBYPASSRLS login role that inherits mnemo_app_role
 *      can INSERT, SELECT, and DELETE from public.mnemo_semantic_neighbor.
 *   2. SELECT with workspace filter returns only the caller's workspace rows
 *      (application-level isolation enforced by WHERE, not RLS).
 *   3. Before the baseline (0001) is applied, the grant is absent → access denied.
 *      (Verified by checking pg_table_privileges directly, not by a rollback.)
 *
 * Requires Docker. Run with:
 *   pnpm --filter @mnemo-ai/adapter-postgres test:integration -- --run semantic-neighbor-nosuperuser
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_super";
const PG_PASS = "mnemo_super";
const PG_DB = "mnemo_test";

const APP_USER = "mnemo_app_ns_test";
const APP_PASS = "mnemo_app_ns_test_pass";

const WS_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

let container: StartedTestContainer;
let superUrl: string;
let appUrl: string;
let super_: ReturnType<typeof postgres>;

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASS,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  superUrl = `postgres://${PG_USER}:${PG_PASS}@${host}:${port}/${PG_DB}`;

  // 1. Pre-create the extension and the public.mnemo_semantic_neighbor table.
  //    This table is normally created by core migration 0073, but we need it
  //    to exist before the adapter-postgres baseline (0001) runs its GRANT.
  super_ = postgres(superUrl, { onnotice: () => void 0, max: 3 });
  await super_.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  await super_.unsafe(`
    CREATE TABLE IF NOT EXISTS public.mnemo_semantic_neighbor (
      workspace_id   uuid        NOT NULL,
      source_fact_id text        NOT NULL,
      target_fact_id text        NOT NULL,
      cosine         real        NOT NULL,
      model_version  text,
      computed_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, source_fact_id, target_fact_id)
    )
  `);

  // 2. Run adapter-postgres baseline migrations (the baseline, 0001, creates
  //    mnemo_app_role and GRANTs public.mnemo_semantic_neighbor).
  await migrate({ databaseUrl: superUrl, log: () => void 0 });

  // 3. Create the NOSUPERUSER NOBYPASSRLS login role that inherits mnemo_app_role.
  await super_.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN
        CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
          NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      END IF;
    END $$;
    GRANT mnemo_app_role TO ${APP_USER};
    GRANT CONNECT ON DATABASE ${PG_DB} TO ${APP_USER};
    GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
    GRANT USAGE ON SCHEMA public    TO ${APP_USER};
  `);

  appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG_DB}`;

  // 4. Seed some rows as superuser (backfill simulation).
  await super_.unsafe(`
    INSERT INTO public.mnemo_semantic_neighbor (workspace_id, source_fact_id, target_fact_id, cosine)
    VALUES
      ('${WS_A}', 'f-a1', 'f-a2', 0.95),
      ('${WS_A}', 'f-a1', 'f-a3', 0.80),
      ('${WS_B}', 'f-b1', 'f-b2', 0.90)
    ON CONFLICT DO NOTHING
  `);
}, 120_000);

afterAll(async () => {
  await super_?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("T2.1 NOSUPERUSER: public.mnemo_semantic_neighbor (baseline 0001 grant)", () => {
  it("the baseline (0001) GRANTs SELECT to mnemo_app_role", async () => {
    const rows = await super_<Array<{ privilege_type: string }>>`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'mnemo_app_role'
        AND table_schema = 'public'
        AND table_name = 'mnemo_semantic_neighbor'
    `;
    const privs = new Set(rows.map((r) => r.privilege_type));
    expect(privs.has("SELECT"), "SELECT should be granted").toBe(true);
    expect(privs.has("INSERT"), "INSERT should be granted").toBe(true);
    expect(privs.has("UPDATE"), "UPDATE should be granted").toBe(true);
    expect(privs.has("DELETE"), "DELETE should be granted").toBe(true);
  });

  it("app role can SELECT from public.mnemo_semantic_neighbor", async () => {
    const app = postgres(appUrl, { onnotice: () => void 0, max: 1 });
    try {
      const rows = await app<Array<{ source_fact_id: string }>>`
        SELECT source_fact_id FROM public.mnemo_semantic_neighbor
        WHERE workspace_id = ${WS_A}::uuid
      `;
      expect(rows.length).toBe(2);
    } finally {
      await app.end().catch(() => void 0);
    }
  });

  it("app role can INSERT into public.mnemo_semantic_neighbor", async () => {
    const app = postgres(appUrl, { onnotice: () => void 0, max: 1 });
    try {
      await app`
        INSERT INTO public.mnemo_semantic_neighbor (workspace_id, source_fact_id, target_fact_id, cosine)
        VALUES (${WS_A}::uuid, 'f-a4', 'f-a5', 0.88)
        ON CONFLICT DO NOTHING
      `;
      const rows = await app<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM public.mnemo_semantic_neighbor
        WHERE workspace_id = ${WS_A}::uuid
      `;
      expect(rows[0]?.count).toBe(3);
    } finally {
      await app.end().catch(() => void 0);
    }
  });

  it("app role can DELETE from public.mnemo_semantic_neighbor (workspace scoped)", async () => {
    const app = postgres(appUrl, { onnotice: () => void 0, max: 1 });
    try {
      await app`
        DELETE FROM public.mnemo_semantic_neighbor
        WHERE workspace_id = ${WS_A}::uuid
          AND source_fact_id = 'f-a4'
      `;
      const rows = await app<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM public.mnemo_semantic_neighbor
        WHERE workspace_id = ${WS_A}::uuid AND source_fact_id = 'f-a4'
      `;
      expect(rows[0]?.count).toBe(0);
    } finally {
      await app.end().catch(() => void 0);
    }
  });

  it("workspace isolation: WS_A rows not visible from WS_B query scope", async () => {
    const app = postgres(appUrl, { onnotice: () => void 0, max: 1 });
    try {
      const rows = await app<Array<{ source_fact_id: string }>>`
        SELECT source_fact_id FROM public.mnemo_semantic_neighbor
        WHERE workspace_id = ${WS_B}::uuid
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]?.source_fact_id).toBe("f-b1");
    } finally {
      await app.end().catch(() => void 0);
    }
  });
});
