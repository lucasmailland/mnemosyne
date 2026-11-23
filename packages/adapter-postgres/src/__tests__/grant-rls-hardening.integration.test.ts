/**
 * DB-4/DB-5 — grant + RLS hardening (2026-07-23 audit, Phase 4 Task 17).
 *
 * DB-4: mnemo_key_escrow, mnemo_workspace_kek, mnemo_workspace_mode have RLS
 * ENABLED but not FORCED — CLAUDE.md's S2 invariant ("All mnemo_* tables MUST
 * have both ENABLE ROW LEVEL SECURITY AND FORCE ROW LEVEL SECURITY") is
 * violated for these 3. mnemo_recall_log is DELIBERATELY excluded — it has
 * its own pinned exception in migrations.test.ts ("does NOT have FORCE ROW
 * LEVEL SECURITY", FORCE removed pre-squash) and this test respects that.
 *
 * DB-5: no ALTER DEFAULT PRIVILEGES exists for the mnemosyne schema, so every
 * new table a future migration creates starts ungranted by default — exactly
 * the bug class SAFE-1's grant_completeness linter check exists to catch
 * (and did catch, 11 times, fixed by migration 0014). This closes the gap at
 * the schema level so it can't recur silently.
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

describe("DB-4: FORCE ROW LEVEL SECURITY", () => {
  it.each(["mnemo_key_escrow", "mnemo_workspace_kek", "mnemo_workspace_mode"])(
    "%s has both RLS enabled AND forced",
    async (table) => {
      const rows = await raw<Array<{ rls_enabled: boolean; rls_forced: boolean }>>`
        SELECT relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
        FROM pg_class WHERE oid = ${"mnemosyne." + table}::regclass
      `;
      expect(rows[0]).toEqual({ rls_enabled: true, rls_forced: true });
    }
  );

  it("mnemo_recall_log is the deliberate exception — enabled but NOT forced (unchanged)", async () => {
    const rows = await raw<Array<{ rls_enabled: boolean; rls_forced: boolean }>>`
      SELECT relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
      FROM pg_class WHERE oid = 'mnemosyne.mnemo_recall_log'::regclass
    `;
    expect(rows[0]).toEqual({ rls_enabled: true, rls_forced: false });
  });
});

describe("DB-5: ALTER DEFAULT PRIVILEGES on the mnemosyne schema", () => {
  it("a table created after the default-privileges migration is automatically granted to mnemo_app_role", async () => {
    await raw.unsafe(`CREATE TABLE mnemosyne.mnemo_db5_probe (id text)`);
    try {
      const rows = await raw<Array<{ can_select: boolean; can_insert: boolean }>>`
        SELECT
          has_table_privilege('mnemo_app_role', 'mnemosyne.mnemo_db5_probe', 'SELECT') AS can_select,
          has_table_privilege('mnemo_app_role', 'mnemosyne.mnemo_db5_probe', 'INSERT') AS can_insert
      `;
      expect(rows[0]).toEqual({ can_select: true, can_insert: true });
    } finally {
      await raw.unsafe(`DROP TABLE mnemosyne.mnemo_db5_probe`);
    }
  });
});
