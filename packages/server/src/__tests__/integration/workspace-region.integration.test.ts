/**
 * §35 data residency against a real Postgres, as the NOSUPERUSER/NOBYPASSRLS
 * role production connects as (setup mirrors workspace-tenant-fallback):
 *
 *  - migration 0062: mnemo_workspace.region, NULL for workspaces that were
 *    already there; a new workspace gets MNEMO_REGION through the
 *    mnemosyne.region setting its creation transaction sets (the tenant routes
 *    through withTenantRls, the dashboard's own workspaces through asAppUser
 *    and the SQL function behind them);
 *  - the region lock mounted after auth (app.ts): 403 wrong_region for a
 *    workspace of another region, through for a workspace without one.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { asAppUser } from "../../dashboard-live-session.js";
import type { ServerDeps } from "../../deps.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const APP_USER = "mnemo_app";
const APP_PASS = "mnemo_app_test_region";

const TENANT = "ee620001-tenant-0000-0000-000000000001";
const WS_OLD = "ee620001-0001-0001-0001-000000000001"; // there before 0062's code ran
const USER_ID = "ee620001-user-0000-0000-000000000002";
const KEY_OLD = "mns_live_regionlockintegrationkeyold01";
const KEY_NEW = "mns_live_regionlockintegrationkeynew01";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let metricsPgClient: ReturnType<typeof postgres>;
let apiKeys: Awaited<ReturnType<typeof import("@mnemo-ai/core").createApiKeyLookup>>;
let app: ReturnType<typeof createApp>;

const origRegion = process.env.MNEMO_REGION;
afterEach(() => {
  if (origRegion === undefined) delete process.env.MNEMO_REGION;
  else process.env.MNEMO_REGION = origRegion;
});

const authed = (key: string) => ({ authorization: `Bearer ${key}` });

async function regionOf(workspaceId: string): Promise<string | null> {
  const [row] = await admin<{ region: string | null }[]>`
    SELECT region FROM mnemosyne.mnemo_workspace WHERE id = ${workspaceId}`;
  if (!row) throw new Error(`workspace ${workspaceId} not found`);
  return row.region;
}

async function createViaApi(name: string): Promise<string> {
  const res = await app.request(`/tenants/${TENANT}/workspaces`, {
    method: "POST",
    headers: { ...authed(KEY_OLD), "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mnemosyne TO mnemo_app_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public    TO app_user;
  `);

  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${TENANT}, ${"Acme"}, ${"organization"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id) VALUES (${WS_OLD}, ${"Acme legacy"}, ${TENANT})`;
  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${USER_ID}, ${"ana@acme.example"}, ${TENANT})`;
  // A key with no user acts as tenant admin of its own tenant (requireTenantAdmin).
  const hash = await bcrypt.hash(KEY_OLD, 4);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, tenant_id, key_hash, name, label, scopes)
    VALUES (${"key_region_old"}, ${WS_OLD}, ${TENANT}, ${hash}, ${"region-old"}, ${"region-old"},
       ARRAY['memory:read','memory:write','memory:admin','admin:tenant']::text[])
  `;

  const appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`;
  metricsPgClient = postgres(appUrl, { max: 5, onnotice: () => void 0 });
  const coreMod = await import("@mnemo-ai/core");
  apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps = {
    apiKeys,
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

  app = createApp({ deps, version: "workspace-region-test" });
}, 180_000);

afterAll(async () => {
  await apiKeys?.close?.().catch(() => void 0);
  await metricsPgClient?.end().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("mnemo_workspace.region (migration 0062)", () => {
  it("a workspace created without the setting has no region", async () => {
    expect(await regionOf(WS_OLD)).toBeNull();
  });

  it("POST /tenants/:id/workspaces stores MNEMO_REGION", async () => {
    process.env.MNEMO_REGION = "eu-west-1";
    expect(await regionOf(await createViaApi("Acme Research"))).toBe("eu-west-1");
  });

  it("POST /tenants/:id/workspaces without MNEMO_REGION leaves it NULL", async () => {
    delete process.env.MNEMO_REGION;
    expect(await regionOf(await createViaApi("Acme Ops"))).toBeNull();
  });

  it("the dashboard's own workspaces (asAppUser + mnemo_user_create_workspace) store MNEMO_REGION", async () => {
    process.env.MNEMO_REGION = "eu-west-1";
    const [row] = await asAppUser(
      metricsPgClient,
      USER_ID,
      (tx) =>
        tx<{ workspace_id: string }[]>`
          SELECT workspace_id FROM mnemosyne.mnemo_user_create_workspace(${USER_ID}, ${"Larkspur Robotics"}, 5)`
    );
    expect(await regionOf(row!.workspace_id)).toBe("eu-west-1");
  });
});

describe("region lock after auth (app.ts)", () => {
  let wsNew: string;

  beforeAll(async () => {
    process.env.MNEMO_REGION = "eu-west-1";
    wsNew = await createViaApi("Acme EU");
    const hash = await bcrypt.hash(KEY_NEW, 4);
    await admin`
      INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, tenant_id, key_hash, name, label, scopes)
      VALUES (${"key_region_new"}, ${wsNew}, ${TENANT}, ${hash}, ${"region-new"}, ${"region-new"},
         ARRAY['memory:read']::text[])
    `;
  });

  it("answers 403 wrong_region on an instance of another region", async () => {
    process.env.MNEMO_REGION = "us-east-1";
    const res = await app.request("/me", { headers: authed(KEY_NEW) });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe("wrong_region");
    expect(body.error.details).toMatchObject({
      homeRegion: "eu-west-1",
      instanceRegion: "us-east-1",
    });
  });

  it("lets the workspace in on its own region", async () => {
    process.env.MNEMO_REGION = "eu-west-1";
    expect((await app.request("/me", { headers: authed(KEY_NEW) })).status).toBe(200);
  });

  it("lets a workspace without a region in anywhere", async () => {
    process.env.MNEMO_REGION = "us-east-1";
    expect((await app.request("/me", { headers: authed(KEY_OLD) })).status).toBe(200);
  });

  it("leaves the probes alone", async () => {
    process.env.MNEMO_REGION = "us-east-1";
    expect((await app.request("/healthz")).status).toBe(200);
  });
});
