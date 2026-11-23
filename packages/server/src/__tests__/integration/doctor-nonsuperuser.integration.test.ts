/**
 * Integration tests for GET /doctor — the 6 server-side checks behind
 * the `memory_doctor` MCP tool — against a REAL Postgres instance, running
 * the app connection as the NOSUPERUSER/NOBYPASSRLS `mnemo_app` role
 * production actually connects as. Mirrors the container/migration/role
 * provisioning pattern in `boot-nonsuperuser.integration.test.ts`.
 *
 * Each `it` below independently breaks exactly ONE of the 6 conditions
 * doctor.ts's server-side checks are documented to detect (see
 * packages/server/src/routes/doctor.ts) and asserts:
 *   (a) that specific check reports its expected non-"ok" status, and
 *   (b) the other checks still report their baseline status —
 *       proving the 6 checks are independent, not just "doctor returns
 *       6 items".
 *
 * Two findings surfaced while building this suite (see docs/STATUS.md /
 * the audit report for the full writeup):
 *
 *  1. schema_shadows is NOT "ok" in a normally, correctly deployed
 *     Mnemosyne instance. docker/Dockerfile.migrate runs BOTH migration
 *     streams in every real deploy (legacy/public `@mnemo-ai/core`
 *     migrations AND v3/mnemosyne `@mnemo-ai/adapter-postgres`
 *     migrations — the "dual-core hybrid", see that Dockerfile's header
 *     comment). Both streams create same-named tables (mnemo_fact,
 *     mnemo_entity, mnemo_relation, mnemo_decision, mnemo_episode,
 *     mnemo_api_keys, mnemo_citation, mnemo_fact_archive, ...) in
 *     `public` and `mnemosyne` respectively. So schema_shadows reports
 *     "warn" on every healthy production boot, not just on genuine
 *     accidental collisions — it can never distinguish the two. The
 *     baseline test below asserts this "warn-by-design" state explicitly
 *     instead of asserting "ok", and a second test proves the check is
 *     still live/reactive (not a hardcoded count) by adding and removing
 *     one more synthetic shadow table on top of the natural baseline.
 *
 *  2. workspace_id_valid's error branch is unreachable through any real
 *     HTTP request — and the gate is even earlier than auth.ts. A stored
 *     API key row with a malformed workspace_id is filtered out by
 *     `packages/core/src/api-key-lookup.ts`'s own `isWorkspaceId()` guard
 *     inside `listActive()`/`findByLookupHash()`, so the key resolves as
 *     simply "not found" — a plain 401 "Invalid API key", not a 400
 *     "invalid_workspace". Even if a malformed workspace_id somehow made
 *     it past that layer, both of auth.ts's own auth paths
 *     (`packages/server/src/auth.ts:235` for scoped `mk_*` keys, `:366`
 *     for standard `mns_*` keys) call the exact same `isWorkspaceId()`
 *     regex doctor.ts's `checkWorkspaceIdValid` uses, and would reject
 *     with 400 before any route handler — including /doctor's — ever
 *     runs. Two independent gates, neither of which /doctor's own check
 *     can ever observe firing. The malformed-UUID test below proves the
 *     first (outermost) gate empirically, and a companion unit test in
 *     doctor.test.ts proves the check's error-branch logic itself is
 *     correct via direct invocation.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { createDrizzleClient, DrizzleStorageAdapter } from "@mnemo-ai/adapter-postgres";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const APP_USER = "mnemo_app";
const APP_PASS = "mnemo_app_test";

const WS_MAIN = "cccc0003-0003-0003-0003-000000000003";
const WS_EMBED = "dddd0004-0004-0004-0004-000000000004";
const KEY_MAIN = "mns_live_doctorintegrationkeymain1";
const KEY_EMBED = "mns_live_doctorintegrationkeyembed";
const KEY_BADWS = "mns_live_doctorintegrationkeybadws";

type Check = { name: string; status: string; message: string; detail?: Record<string, unknown> };
type DoctorBody = { status: string; checks: Check[]; timestamp: string };

function indexChecks(checks: Check[]): Record<string, Check> {
  return Object.fromEntries(checks.map((c) => [c.name, c]));
}

let container: StartedTestContainer;
let host: string;
let port: number;
let superUrl: string;
let appUrl: string;
let admin: ReturnType<typeof postgres>;
let metricsPgClient: ReturnType<typeof postgres>;
let apiKeys: Awaited<ReturnType<typeof import("@mnemo-ai/core").createApiKeyLookup>>;
let storage: DrizzleStorageAdapter;
let deps: ServerDeps;
let app: ReturnType<typeof createApp>;

function authed(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: PG.user, POSTGRES_PASSWORD: PG.password, POSTGRES_DB: PG.db })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  host = container.getHost();
  port = container.getMappedPort(5432);
  superUrl = `postgres://${PG.user}:${PG.password}@${host}:${port}/${PG.db}`;

  const bootstrap = postgres(superUrl, { max: 1, onnotice: () => void 0 });
  try {
    await bootstrap.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");
  } finally {
    await bootstrap.end();
  }

  // Apply BOTH migration streams — mirrors docker/Dockerfile.migrate exactly
  // (the real deploy always runs both; see the file-level comment above).
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

  admin = postgres(superUrl, { max: 5, onnotice: () => void 0 });

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
    -- Mirrors docker/scripts/provision-app-role.mjs exactly: without this,
    -- mnemo_app_role has no DML rights at all on tables the migrate step
    -- creates ad hoc outside the versioned SQL files (e.g.
    -- mnemosyne.schema_migrations, created inline by migrate.ts), and
    -- migration_version's query fails with "permission denied" even on an
    -- otherwise healthy deploy.
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mnemosyne TO mnemo_app_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public    TO app_user;
  `);

  const hashMain = await bcrypt.hash(KEY_MAIN, BCRYPT_COST);
  const hashEmbed = await bcrypt.hash(KEY_EMBED, BCRYPT_COST);
  const hashBadWs = await bcrypt.hash(KEY_BADWS, BCRYPT_COST);
  // GET /doctor is an operator view: the keys carry memory:admin (app-scope.ts).
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES
      (${"key_doctor_main"}, ${WS_MAIN}, ${hashMain}, ${"doctor-main"}, ${"doctor-main"}, ARRAY['memory:read','memory:write','memory:admin']::text[]),
      (${"key_doctor_embed"}, ${WS_EMBED}, ${hashEmbed}, ${"doctor-embed"}, ${"doctor-embed"}, ARRAY['memory:read','memory:write','memory:admin']::text[]),
      (${"key_doctor_badws"}, ${"not-a-valid-uuid"}, ${hashBadWs}, ${"doctor-badws"}, ${"doctor-badws"}, ARRAY['memory:read','memory:write','memory:admin']::text[])
  `;

  appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`;
  metricsPgClient = postgres(appUrl, { max: 5, onnotice: () => void 0 });

  const coreMod = await import("@mnemo-ai/core");
  apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });
  // Same nonsuperuser appUrl as `core` above — doctor.ts's connectivity check
  // now goes through this v3 StorageAdapter instead of `core.ping()`
  // (flatten-legacy-dual-core PR6).
  const storageClient = createDrizzleClient(appUrl);
  storage = new DrizzleStorageAdapter(storageClient.db, storageClient.pgClient);

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  deps = {
    apiKeys,
    storage,
    llm: undefined,
    embedModel: "text-embedding-3-small",
    cognitive: undefined,
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
    metricsPgClient,
  } as unknown as ServerDeps;

  app = createApp({ deps, version: "doctor-nonsuperuser-test" });
}, 180_000);

afterAll(async () => {
  await storage?.close().catch(() => void 0);
  await apiKeys?.close?.().catch(() => void 0);
  await metricsPgClient?.end().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("GET /doctor — real Postgres, NOSUPERUSER app role", () => {
  it("baseline: connectivity, app_user_grants, migration_version, embedding_backlog, workspace_id_valid are ok; schema_shadows is warn-by-design (dual-core deploy)", async () => {
    const res = await app.request("/doctor", { headers: authed(KEY_MAIN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DoctorBody;
    expect(body.checks).toHaveLength(6);
    const byName = indexChecks(body.checks);

    expect(byName.connectivity?.status).toBe("ok");
    expect(byName.app_user_grants?.status).toBe("ok");
    expect(byName.migration_version?.status).toBe("ok");
    expect(byName.embedding_backlog?.status).toBe("ok");
    expect(byName.workspace_id_valid?.status).toBe("ok");

    // APP-049 (audit 2026-11-22): both migration streams run on every deploy,
    // so the legacy public tables always shadow their v3 namesakes. That is
    // the expected state and no longer a warning; it is still listed.
    expect(byName.schema_shadows?.status).toBe("ok");
    const tables = (byName.schema_shadows?.detail?.tables as string[] | undefined) ?? [];
    expect(tables).toContain("mnemo_fact");
    expect(byName.schema_shadows?.detail?.unexpected).toEqual([]);
  });

  it("connectivity reports error when Postgres is unreachable, while every other check stays at its baseline status", async () => {
    // A minimal healthCheck()-only stub pointed at a closed port —
    // deliberately NOT going through @mnemo-ai/core's createCore(), which
    // registers a process-wide DB singleton (setDb()) that throws on a
    // second registration. checkConnectivity only ever calls
    // deps.storage.healthCheck() (flatten-legacy-dual-core PR6 — was
    // deps.core.ping()), so this is a faithful, isolated failure simulation
    // without disturbing the shared `core`/`storage`/`deps` used by every
    // other test in this file.
    const badClient = postgres(`postgres://${APP_USER}:${APP_PASS}@127.0.0.1:1/${PG.db}`, {
      max: 1,
      connect_timeout: 2,
      onnotice: () => void 0,
    });
    const badDeps = {
      ...deps,
      storage: {
        healthCheck: async () => {
          await badClient`SELECT 1`;
          return { status: "ok" as const, latencyMs: 0 };
        },
      },
    } as unknown as ServerDeps;
    const badApp = createApp({ deps: badDeps, version: "doctor-badcore-test" });
    try {
      const res = await badApp.request("/doctor", { headers: authed(KEY_MAIN) });
      const body = (await res.json()) as DoctorBody;
      const byName = indexChecks(body.checks);

      expect(byName.connectivity?.status).toBe("error");
      expect(byName.connectivity?.message.toLowerCase()).toMatch(/unreachable|refused|connect/);

      expect(byName.app_user_grants?.status).toBe("ok");
      expect(byName.schema_shadows?.status).toBe("ok"); // baseline, unaffected
      expect(byName.migration_version?.status).toBe("ok");
      expect(byName.embedding_backlog?.status).toBe("ok");
      expect(byName.workspace_id_valid?.status).toBe("ok");
    } finally {
      await badClient.end({ timeout: 1 }).catch(() => void 0);
    }
  });

  it("app_user_grants reports error when the app_user role loses USAGE on schema mnemosyne, while every other check stays at its baseline status", async () => {
    try {
      // has_schema_privilege('app_user', ...) considers INHERITED privileges
      // too: app_user gets USAGE both directly (baseline migration) and via
      // its membership in mnemo_app_role (which also has USAGE granted).
      // Revoking only the direct grant leaves the inherited path intact and
      // the check keeps reporting ok — both paths must be cut.
      await admin`REVOKE USAGE ON SCHEMA mnemosyne FROM app_user`;
      await admin`REVOKE mnemo_app_role FROM app_user`;

      const res = await app.request("/doctor", { headers: authed(KEY_MAIN) });
      const body = (await res.json()) as DoctorBody;
      const byName = indexChecks(body.checks);

      expect(byName.app_user_grants?.status).toBe("error");

      // mnemo_app (the LOGIN role the connection actually authenticates as)
      // keeps its OWN direct USAGE grant AND its OWN direct mnemo_app_role
      // membership (both provisioned independently of app_user's — see
      // beforeAll), so the connection running these other checks is
      // unaffected by revoking app_user's grants specifically.
      expect(byName.connectivity?.status).toBe("ok");
      expect(byName.schema_shadows?.status).toBe("ok");
      expect(byName.migration_version?.status).toBe("ok");
      expect(byName.embedding_backlog?.status).toBe("ok");
      expect(byName.workspace_id_valid?.status).toBe("ok");
    } finally {
      await admin`GRANT mnemo_app_role TO app_user`;
      await admin`GRANT USAGE ON SCHEMA mnemosyne TO app_user`;
    }
  });

  it("schema_shadows is live: adding one more duplicate table increases the shadow count and names it; removing it restores the baseline count", async () => {
    const baseline = (await app
      .request("/doctor", { headers: authed(KEY_MAIN) })
      .then((r) => r.json())) as DoctorBody;
    const baselineCount =
      (indexChecks(baseline.checks).schema_shadows?.detail?.shadowCount as number) ?? 0;

    try {
      // mnemo_hyperedge exists only in `mnemosyne` (v3-only primitive, not part
      // of core's legacy public-schema table set) — safe to duplicate in
      // isolation without disturbing the natural dual-core baseline set.
      await admin.unsafe("CREATE TABLE public.mnemo_hyperedge (id int)");

      const res = await app.request("/doctor", { headers: authed(KEY_MAIN) });
      const body = (await res.json()) as DoctorBody;
      const byName = indexChecks(body.checks);

      expect(byName.schema_shadows?.status).toBe("warn");
      expect(byName.schema_shadows?.detail?.shadowCount).toBe(baselineCount + 1);
      const tables = (byName.schema_shadows?.detail?.tables as string[] | undefined) ?? [];
      expect(tables).toContain("mnemo_hyperedge");

      // Unaffected.
      expect(byName.connectivity?.status).toBe("ok");
      expect(byName.app_user_grants?.status).toBe("ok");
      expect(byName.migration_version?.status).toBe("ok");
      expect(byName.embedding_backlog?.status).toBe("ok");
      expect(byName.workspace_id_valid?.status).toBe("ok");
    } finally {
      await admin.unsafe("DROP TABLE IF EXISTS public.mnemo_hyperedge");
    }

    const restored = (await app
      .request("/doctor", { headers: authed(KEY_MAIN) })
      .then((r) => r.json())) as DoctorBody;
    expect(indexChecks(restored.checks).schema_shadows?.detail?.shadowCount).toBe(baselineCount);
  });

  it("migration_version reports error naming the missing migration when the latest applied row is rolled back, while every other check stays at its baseline status", async () => {
    const [latestRow] = await admin<{ filename: string; applied_at: Date; checksum: string }[]>`
      SELECT filename, applied_at, checksum FROM mnemosyne.schema_migrations ORDER BY applied_at DESC LIMIT 1
    `;
    expect(latestRow).toBeDefined();

    try {
      await admin`DELETE FROM mnemosyne.schema_migrations WHERE filename = ${latestRow!.filename}`;

      const res = await app.request("/doctor", { headers: authed(KEY_MAIN) });
      const body = (await res.json()) as DoctorBody;
      const byName = indexChecks(body.checks);

      expect(byName.migration_version?.status).toBe("error");
      expect(byName.migration_version?.message).toContain(latestRow!.filename);
      expect(byName.migration_version?.detail?.expectedLatest).toBe(latestRow!.filename);
      expect(byName.migration_version?.detail?.missing as string[] | undefined).toContain(
        latestRow!.filename
      );

      expect(byName.connectivity?.status).toBe("ok");
      expect(byName.app_user_grants?.status).toBe("ok");
      expect(byName.schema_shadows?.status).toBe("ok");
      expect(byName.embedding_backlog?.status).toBe("ok");
      expect(byName.workspace_id_valid?.status).toBe("ok");
    } finally {
      await admin`
        INSERT INTO mnemosyne.schema_migrations (filename, applied_at, checksum)
        VALUES (${latestRow!.filename}, ${latestRow!.applied_at}, ${latestRow!.checksum})
        ON CONFLICT (filename) DO NOTHING
      `;
    }
  });

  it("embedding_backlog reports warn scoped to the caller's own workspace when a live fact has embedding IS NULL, while every other check stays at its baseline status", async () => {
    await admin`
      INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, kind, subject, statement)
      VALUES (${"doctor_backlog_fact_1"}, ${WS_EMBED}, ${"global"}, ${"other"}, ${"doctor-test"}, ${"a fact with no embedding"})
    `;

    try {
      const res = await app.request("/doctor", { headers: authed(KEY_EMBED) });
      const body = (await res.json()) as DoctorBody;
      const byName = indexChecks(body.checks);

      expect(byName.embedding_backlog?.status).toBe("warn");
      expect(byName.embedding_backlog?.detail?.backlog).toBe(1);
      expect(byName.embedding_backlog?.message).toContain("1");

      // WS_MAIN has no facts at all — proves the check is scoped per-caller,
      // not a global count leaking across workspaces.
      const mainRes = await app.request("/doctor", { headers: authed(KEY_MAIN) });
      const mainBody = (await mainRes.json()) as DoctorBody;
      expect(indexChecks(mainBody.checks).embedding_backlog?.status).toBe("ok");

      expect(byName.connectivity?.status).toBe("ok");
      expect(byName.app_user_grants?.status).toBe("ok");
      expect(byName.schema_shadows?.status).toBe("ok");
      expect(byName.migration_version?.status).toBe("ok");
      expect(byName.workspace_id_valid?.status).toBe("ok");
    } finally {
      await admin`DELETE FROM mnemosyne.mnemo_fact WHERE id = ${"doctor_backlog_fact_1"}`;
    }
  });

  it("workspace_id_valid's error branch is unreachable via the real HTTP path: a malformed workspace_id on a stored key never reaches /doctor's handler at all", async () => {
    const res = await app.request("/doctor", { headers: authed(KEY_BADWS) });
    // Rejected even before auth.ts's own isWorkspaceId() gate runs: the
    // api-key-lookup layer (packages/core/src/api-key-lookup.ts) filters
    // rows with a malformed workspace_id out of listActive() entirely
    // (isWorkspaceId(r.workspace_id) guard — see the "[mnemo] API key has
    // non-UUID workspace_id ... key rejected" warning this test emits), so
    // the key resolves as simply invalid (401), not as an authenticated
    // request with a bad workspace_id (which would be the 400
    // "invalid_workspace" auth.ts:235/:366 produces). Either way, /doctor's
    // handler — and checkWorkspaceIdValid's "error" branch — is never
    // reached.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toContain("Invalid API key");
  });
});
