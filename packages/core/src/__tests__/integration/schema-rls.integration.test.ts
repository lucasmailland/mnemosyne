/**
 * REAL integration test for the @mnemo-ai/core schema + RLS layer.
 *
 * Spins up a throwaway pgvector/pgvector:pg17 container (testcontainers),
 * enables the `vector` extension, applies ALL bundled migrations through the
 * built migrate CLI (packages/core/dist/migrate.js) exactly as production
 * does — lexical order, 0015 before 0016 — then asserts:
 *
 *   1. the resulting schema (table/policy/role/function counts), and
 *   2. that row-level security actually isolates tenants once we SET ROLE
 *      app_user (a non-superuser with no BYPASSRLS).
 *
 * Hermetic and CI-safe: random host port, fresh DB per run, container torn
 * down in afterAll. Slow to boot, hence the 120s timeouts.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/__tests__/integration -> packages/core
const PACKAGE_ROOT = resolve(__dirname, "..", "..", "..");
const MIGRATE_CLI = resolve(PACKAGE_ROOT, "dist", "migrate.js");
const MIGRATIONS_DIR = resolve(PACKAGE_ROOT, "migrations");

const PG_USER = "mnemo";
const PG_PASSWORD = "mnemo";
const PG_DB = "mnemo_test";

let container: StartedTestContainer;
let databaseUrl: string;
/** Superuser client — used for schema introspection and RLS test sessions. */
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  // 1. Boot a real pgvector Postgres on a RANDOM host port (no conflict with
  //    any manually-started mnemo-test-pg on 55999).
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  databaseUrl = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`;

  // 2. Enable the vector extension BEFORE migrations (HNSW index columns in
  //    0017 require it). The migrate CLI pre-flight expects it present.
  const bootstrap = postgres(databaseUrl, { onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
  } finally {
    await bootstrap.end().catch(() => void 0);
  }

  // 3. Apply migrations via the BUILT CLI through child_process for fidelity
  //    with production. Asserts the process exits 0 (execFileSync throws on
  //    non-zero, surfacing the captured stderr).
  try {
    execFileSync(
      "node",
      [MIGRATE_CLI, "--migrations-dir", MIGRATIONS_DIR, "--database-url", databaseUrl],
      { stdio: "pipe", encoding: "utf8" }
    );
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `migrate CLI exited non-zero:\n--- stdout ---\n${e.stdout ?? ""}\n--- stderr ---\n${e.stderr ?? ""}\n${e.message}`
    );
  }

  // 4. Long-lived superuser client for the assertions below.
  sql = postgres(databaseUrl, { onnotice: () => void 0, max: 4 });
}, 120_000);

afterAll(async () => {
  await sql?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
}, 60_000);

describe("schema", () => {
  it("created ~20 mnemo/brain tables", async () => {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pg_tables
      WHERE schemaname = 'public'
        AND (tablename LIKE 'mnemo%' OR tablename LIKE 'brain%')
    `;
    expect(n).toBeGreaterThanOrEqual(18);
  });

  it("enabled row-level security on the tenant tables", async () => {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pg_tables
      WHERE schemaname = 'public' AND rowsecurity = true
    `;
    expect(n).toBeGreaterThanOrEqual(15);
  });

  it("installed the tenant-isolation policies", async () => {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'
    `;
    expect(n).toBeGreaterThanOrEqual(50);
  });

  it("created the app_user and app_org_user roles", async () => {
    const rows = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles
      WHERE rolname IN ('app_user', 'app_org_user')
    `;
    const names = rows.map((r) => r.rolname).sort();
    expect(names).toEqual(["app_org_user", "app_user"]);
  });

  it("defined the RLS helper functions", async () => {
    const rows = await sql<{ proname: string }[]>`
      SELECT proname FROM pg_proc
      WHERE proname IN ('apply_pattern_a', 'current_workspace_id', 'is_cross_tenant_admin')
    `;
    const names = new Set(rows.map((r) => r.proname));
    expect(names.has("apply_pattern_a")).toBe(true);
    expect(names.has("current_workspace_id")).toBe(true);
    expect(names.has("is_cross_tenant_admin")).toBe(true);
  });

  it("mnemo_api_keys has a key_hash column", async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'mnemo_api_keys'
        AND column_name = 'key_hash'
    `;
    expect(rows).toHaveLength(1);
  });
});

describe("RLS isolation", () => {
  // Each step runs as role app_user (non-superuser, no BYPASSRLS) so that
  // ENABLE/FORCE ROW LEVEL SECURITY actually bites. We thread a single
  // postgres-js connection via sql.reserve() so SET ROLE / SET app.workspace_id
  // and the inserts all share one session.
  const EP_A = "ep_a";
  const FACT_A = "fact_a";

  it("isolates tenants and rejects cross-tenant writes via WITH CHECK", async () => {
    const conn = await sql.reserve();
    try {
      await conn.unsafe("SET ROLE app_user");

      // --- workspace ws_a: insert episode + fact, both visible. ---
      await conn.unsafe("SET app.workspace_id = 'ws_a'");

      await conn.unsafe(
        `INSERT INTO mnemo_episode (id, workspace_id, title, narrative, occurred_at)
         VALUES ($1, 'ws_a', 'Episode A', 'narrative for ws_a', now())`,
        [EP_A]
      );
      await conn.unsafe(
        `INSERT INTO mnemo_fact
           (id, workspace_id, scope, kind, subject, statement, episode_id)
         VALUES ($1, 'ws_a', 'conversation', 'event', 'subject a', 'statement a', $2)`,
        [FACT_A, EP_A]
      );

      const visibleInA = await conn.unsafe("SELECT count(*)::int AS n FROM mnemo_fact");
      expect(visibleInA[0].n).toBe(1);

      // --- switch to ws_b: the ws_a fact must be invisible. ---
      await conn.unsafe("SET app.workspace_id = 'ws_b'");
      const visibleInB = await conn.unsafe("SELECT count(*)::int AS n FROM mnemo_fact");
      expect(visibleInB[0].n).toBe(0);

      // --- rogue write: tag a row workspace_id='ws_a' while context is ws_b.
      //     RLS WITH CHECK must REJECT it. ---
      let threw = false;
      let message = "";
      try {
        await conn.unsafe(
          `INSERT INTO mnemo_fact
             (id, workspace_id, scope, kind, subject, statement, episode_id)
           VALUES ('fact_rogue', 'ws_a', 'conversation', 'event', 'rogue', 'rogue', $1)`,
          [EP_A]
        );
      } catch (err) {
        threw = true;
        message = err instanceof Error ? err.message : String(err);
      }
      expect(threw).toBe(true);
      expect(message.toLowerCase()).toContain("row-level security");

      // --- back to ws_a: still exactly 1 fact (rogue insert never landed). ---
      await conn.unsafe("SET app.workspace_id = 'ws_a'");
      const stillInA = await conn.unsafe("SELECT count(*)::int AS n FROM mnemo_fact");
      expect(stillInA[0].n).toBe(1);
    } finally {
      // Drop role + reset settings before returning the conn to the pool.
      await conn.unsafe("RESET app.workspace_id").catch(() => void 0);
      await conn.unsafe("RESET ROLE").catch(() => void 0);
      conn.release();
    }
  });
});

describe("mnemo_semantic_neighbor RLS (DB-6)", () => {
  it("has RLS enabled AND forced", async () => {
    const rows = await sql<Array<{ rls_enabled: boolean; rls_forced: boolean }>>`
      SELECT relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
      FROM pg_class WHERE oid = 'public.mnemo_semantic_neighbor'::regclass
    `;
    expect(rows[0]).toEqual({ rls_enabled: true, rls_forced: true });
  });

  it("isolates workspaces and rejects cross-workspace writes via WITH CHECK", async () => {
    const conn = await sql.reserve();
    try {
      await conn.unsafe("SET ROLE app_user");
      const WS_SEM_A = "11111111-1111-4111-8111-111111111111";
      const WS_SEM_B = "22222222-2222-4222-8222-222222222222";
      await conn.unsafe(`SET mnemosyne.workspace_id = '${WS_SEM_A}'`);

      await conn.unsafe(
        `INSERT INTO mnemo_semantic_neighbor (workspace_id, source_fact_id, target_fact_id, cosine)
         VALUES ('${WS_SEM_A}'::uuid, 'f1', 'f2', 0.9)`
      );

      const visibleInA = await conn.unsafe(
        "SELECT count(*)::int AS n FROM mnemo_semantic_neighbor"
      );
      expect(visibleInA[0].n).toBe(1);

      await conn.unsafe(`SET mnemosyne.workspace_id = '${WS_SEM_B}'`);
      const visibleInB = await conn.unsafe(
        "SELECT count(*)::int AS n FROM mnemo_semantic_neighbor"
      );
      expect(visibleInB[0].n).toBe(0);

      let threw = false;
      let message = "";
      try {
        await conn.unsafe(
          `INSERT INTO mnemo_semantic_neighbor (workspace_id, source_fact_id, target_fact_id, cosine)
           VALUES ('${WS_SEM_A}'::uuid, 'f3', 'f4', 0.9)`
        );
      } catch (err) {
        threw = true;
        message = err instanceof Error ? err.message : String(err);
      }
      expect(threw).toBe(true);
      expect(message.toLowerCase()).toContain("row-level security");
    } finally {
      await conn.unsafe("RESET mnemosyne.workspace_id").catch(() => void 0);
      await conn.unsafe("RESET ROLE").catch(() => void 0);
      conn.release();
    }
  });
});
