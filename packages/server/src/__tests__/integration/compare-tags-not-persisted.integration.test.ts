/**
 * Real-Postgres verification for the DB-level premise behind `memory_compare`'s
 * B6 fix (docs/archive/openspec/complete-mcp-tools, spec.md Requirement 5): tags are not,
 * and cannot be, persisted through the real fact wire path.
 *
 * Originally (docs/archive/openspec/tool-promise-remediation) this premise justified
 * treating `packages/mcp/src/tools/compare.ts`'s tags-added/removed diff and
 * the tag-overlap shortcut in `detectSameSubject` as unreachable-but-present
 * dead code. `docs/archive/openspec/complete-mcp-tools` (B6) went further and DELETED both
 * branches outright rather than leaving them formalized-but-inert — so this
 * test no longer characterizes dead code in `compare.ts`; it stands alone as
 * a DB-contract regression guard: if a `tags` column or `CreateFactInput.tags`
 * field is ever added back to the fact write path, `memory_compare`'s diff
 * output would silently need updating too, and this test is the tripwire.
 *
 * Two things together mean the fact-fetch API can never return a persisted
 * tag:
 *
 *   1. `mnemosyne.mnemo_fact` (packages/adapter-postgres/migrations/baseline/
 *      0001_v3_complete_baseline.sql) has NO `tags` column at all.
 *   2. `toApiFact` (packages/server/src/mappers.ts) — the mapper
 *      `GET /facts/:id` uses to build the wire `Fact` — hardcodes
 *      `tags: []` regardless of the row (design.md D6.1: `Fact.tags` is a
 *      phantom field with no v3 storage backing at all — there is no
 *      `CreateFactInput.tags` to even attempt setting it).
 *
 * This test proves both empirically against a REAL migrated Postgres
 * instance, connected as the NOSUPERUSER/NOBYPASSRLS `mnemo_app` role
 * production actually uses (mirrors `boot-nonsuperuser.integration.test.ts`'s
 * provisioning), rather than trusting the static read alone for the
 * DB-level half of the claim:
 *
 *   (a) `information_schema.columns` has zero rows for
 *       (table_schema='mnemosyne', table_name='mnemo_fact', column_name='tags')
 *   (b) a real `storage.createFact` followed by `toApiFact(storage.getFact(...))`
 *       — the exact function chain `GET /facts/:id` and thus
 *       `memory_compare`'s `client.getFact()` call uses — returns `tags: []`.
 *
 * `packages/mcp/src/__tests__/contracts/compare.test.ts` covers the unit-level
 * half of the B6 contract (no tag diff is ever produced, `suggestedVerb` is
 * one of exactly 4 values).
 *
 * flatten-legacy-dual-core Phase 7: originally proved (b) through the legacy
 * `CoreLike.createFact`/`getFact` (`createCore()`, deleted this Phase) —
 * `facts.ts`'s `GET /:id` has called `deps.storage.getFact` + `toApiFact()`
 * since PR9a (D6.1), so this test now drives that exact same real chain.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toApiFact } from "../../mappers.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const APP_USER = "mnemo_app";
const APP_PASS = "mnemo_app_test";
const WS = "cccc0003-0003-0003-0003-000000000003";

let container: StartedTestContainer;
let superUrl: string;
let appUrl: string;
let storage: import("@mnemo-ai/adapter-postgres").DrizzleStorageAdapter;
let storageClose: (() => Promise<void>) | undefined;

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  superUrl = `postgres://${PG.user}:${PG.password}@${host}:${port}/${PG.db}`;

  const bootstrap = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  const { stdout: coreOut } = await execFileAsync(
    process.execPath,
    [CORE_MIGRATE_CLI, "--migrations-dir", CORE_MIGRATIONS_DIR, "--database-url", superUrl],
    { timeout: 120_000 }
  );
  expect(coreOut).toContain("done");

  const { stdout: v3Out } = await execFileAsync(process.execPath, [V3_MIGRATE_CLI], {
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: superUrl },
  });
  expect(v3Out).toContain("Done. Applied:");

  // Real NOSUPERUSER NOBYPASSRLS role — same provisioning shape as
  // boot-nonsuperuser.integration.test.ts, trimmed to what this test needs
  // (no API keys / HTTP app layer — this test calls storage.createFact/getFact
  // directly, the exact StorageAdapter facts.ts's route uses).
  const admin = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await admin.unsafe(`
      DO $provision$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_USER}') THEN
          CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
            NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
        END IF;
      END $provision$;
      GRANT mnemo_app_role TO ${APP_USER};
      GRANT app_user       TO ${APP_USER};
      GRANT app_org_user   TO ${APP_USER};
      GRANT CONNECT ON DATABASE ${PG.db} TO ${APP_USER};
      GRANT USAGE ON SCHEMA mnemosyne TO ${APP_USER};
      GRANT USAGE ON SCHEMA public    TO ${APP_USER};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mnemosyne TO mnemo_app_role;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public    TO app_user;
    `);
  } finally {
    await admin.end();
  }

  appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`;

  const adapterPgMod = await import("@mnemo-ai/adapter-postgres");
  const { db, pgClient } = adapterPgMod.createDrizzleClient(appUrl);
  storage = new adapterPgMod.DrizzleStorageAdapter(db, pgClient);
  storageClose = () => pgClient.end({ timeout: 5 });
}, 180_000);

afterAll(async () => {
  await storageClose?.().catch(() => void 0);
  await container?.stop();
});

describe("memory_compare DB contract: tags are never persisted through the real fact wire path", () => {
  it("(a) mnemosyne.mnemo_fact has no tags column in the real schema", async () => {
    const sql = postgres(superUrl, { max: 1, onnotice: () => void 0 });
    try {
      const rows = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'mnemosyne' AND table_name = 'mnemo_fact' AND column_name = 'tags'
      `;
      expect(rows).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  it("(b) storage.createFact followed by toApiFact(storage.getFact()) always reports tags: [] — real round trip", async () => {
    const created = await storage.createFact({
      workspaceId: WS,
      scope: "global",
      statement: "Integration test fact for tags round-trip",
      subject: "compare-tags-test",
      kind: "other",
      metadata: { source: "integration-test" },
    });

    // The exact chain GET /facts/:id and thus `client.getFact()` (what
    // memory_compare calls) uses — deps.storage.getFact + toApiFact().
    // toApiFact() hardcodes `tags: []` unconditionally (D6.1) — there is no
    // `CreateFactInput.tags` field to even attempt setting it in the first
    // place, so this reports [] regardless of what a caller "intends".
    const fetched = await storage.getFact(created.id, WS);
    expect(fetched).not.toBeNull();
    const wire = toApiFact(fetched!);
    expect(wire.tags).toEqual([]);
  });
});
