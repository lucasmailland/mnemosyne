/**
 * SAFE-1 — pins the real GRANT gaps found by migration-safety.ts's new
 * grant_completeness check when run against the real baseline migrations.
 * 11 tables in 0001/0008 had RLS enabled (or were plainly app-facing) with no
 * matching GRANT to mnemo_app_role — under any properly-hardened deployment
 * (app_user role, not the superuser connection), every query against them
 * 500s with "permission denied". Fixed by migration 0014.
 *
 * The three scoped-key tables (mnemo_scoped_api_keys, mnemo_scoped_key_usage,
 * mnemo_scoped_key_escrow) were left ungranted here on the belief that
 * mnemo_api_keys was too; it is granted (0001), and the server reads both over
 * the application role. Migration 0069 grants them the least each needs. This
 * test pins that exact set, so neither a missing grant (MNEMO_SCOPED_AUTH=1
 * refuses every key) nor a blanket one (DELETE, TRUNCATE) slips in.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { migrate } from "../migrate.js";

const PG_IMAGE = "pgvector/pgvector:pg17";
const PG_USER = "mnemo_test";
const PG_PASSWORD = "mnemo_test";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let raw: ReturnType<typeof postgres>;

const GRANTED_TABLES = [
  "mnemo_consolidation_lock",
  "mnemo_embedding_cache",
  "mnemo_hot_tier_snapshot",
  "mnemo_key_escrow",
  "mnemo_review_item",
  "mnemo_workspace_kek",
  "mnemo_workspace_mode",
  "mnemo_vector_space",
  "mnemo_fact_embeddings_1024",
  "mnemo_fact_embeddings_1536",
  "mnemo_fact_embeddings_2048",
  "mnemo_fact_embeddings_4096",
];

// table → [SELECT, INSERT, UPDATE, DELETE] for mnemo_app_role (0069).
const SCOPED_KEY_GRANTS: Record<string, [boolean, boolean, boolean, boolean]> = {
  mnemo_scoped_api_keys: [true, true, true, false],
  mnemo_scoped_key_usage: [true, true, false, false],
  mnemo_scoped_key_escrow: [false, true, false, false],
};

beforeAll(async () => {
  container = await new GenericContainer(PG_IMAGE)
    .withEnvironment({ POSTGRES_USER: PG_USER, POSTGRES_PASSWORD: PG_PASSWORD, POSTGRES_DB: PG_DB })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;
  await migrate({ databaseUrl, log: () => void 0 });
  raw = postgres(databaseUrl, { onnotice: () => void 0, max: 3 });
}, 120_000);

afterAll(async () => {
  await raw?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("mnemo_app_role grants (SAFE-1, migration 0014)", () => {
  it.each(GRANTED_TABLES)("%s: mnemo_app_role has SELECT/INSERT/UPDATE/DELETE", async (table) => {
    const rows = await raw<Array<{ s: boolean; i: boolean; u: boolean; d: boolean }>>`
      SELECT
        has_table_privilege('mnemo_app_role', ${"mnemosyne." + table}, 'SELECT') AS s,
        has_table_privilege('mnemo_app_role', ${"mnemosyne." + table}, 'INSERT') AS i,
        has_table_privilege('mnemo_app_role', ${"mnemosyne." + table}, 'UPDATE') AS u,
        has_table_privilege('mnemo_app_role', ${"mnemosyne." + table}, 'DELETE') AS d
    `;
    expect(rows[0]).toEqual({ s: true, i: true, u: true, d: true });
  });

  it.each(Object.entries(SCOPED_KEY_GRANTS))(
    "%s: mnemo_app_role holds exactly the scoped-key grants of 0069",
    async (table, [s, i, u, d]) => {
      const rows = await raw<Array<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }>>`
        SELECT
          has_table_privilege('mnemo_app_role', ${"mnemosyne." + table}, 'SELECT') AS s,
          has_table_privilege('mnemo_app_role', ${"mnemosyne." + table}, 'INSERT') AS i,
          has_table_privilege('mnemo_app_role', ${"mnemosyne." + table}, 'UPDATE') AS u,
          has_table_privilege('mnemo_app_role', ${"mnemosyne." + table}, 'DELETE') AS d,
          has_table_privilege('mnemo_app_role', ${"mnemosyne." + table}, 'TRUNCATE') AS t
      `;
      expect(rows[0]).toEqual({ s, i, u, d, t: false });
    }
  );
});
