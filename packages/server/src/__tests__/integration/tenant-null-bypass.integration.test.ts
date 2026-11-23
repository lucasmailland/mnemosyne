/**
 * AUTH-TENANT-NULL — real-Postgres proof that a key without a tenant binding
 * acts in its home workspace's tenant, and only there.
 *
 * The unit suite (`unit/tenant-null-bypass.test.ts`) fakes the SQL. What it
 * cannot show is the part that depends on RLS: a caller whose key row has no
 * tenant runs `withTenantRls` with no tenant GUC, so under the permissive
 * fallback of `mnemo_workspace_read` it sees every tenant's workspaces. That
 * is the window the hole went through, and the same window the derived-tenant
 * lookup reads its own home workspace through. This suite runs the routes on
 * the NOSUPERUSER/NOBYPASSRLS `mnemo_app` role production connects as, with
 * the grants of `docker/scripts/provision-app-role.mjs`.
 *
 * The bootstrap key is minted by the real `POST /bootstrap`, so the proof
 * covers the key shape that endpoint actually writes (no tenant, no user).
 *
 * Seed: tenant HOME (created by the bootstrap) and tenant FOREIGN, one
 * workspace each. The home workspace has one member, the foreign one two.
 *
 * Proves:
 *  1. The bootstrap key manages its own workspace's members as before (D-D):
 *     the tenant lookup works under RLS.
 *  2. It cannot list, re-role or remove a member of FOREIGN's workspace, and
 *     the answer is the same 404 and body as a workspace that does not exist.
 *  3. A key of the same shape holding `admin:tenant` cannot read FOREIGN's
 *     members or mint a token for FOREIGN's user, and no key row is written.
 *     In its own tenant it reads members and mints tokens as before.
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import bcrypt from "bcrypt";
import { Hono } from "hono";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountBootstrap } from "../../routes/bootstrap.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(HERE, "../../../../core");
const CORE_MIGRATE_CLI = resolve(CORE_DIR, "dist/migrate.js");
const CORE_MIGRATIONS_DIR = resolve(CORE_DIR, "migrations");
const V3_MIGRATE_CLI = resolve(HERE, "../../../../adapter-postgres/dist/migrate.js");

const PG = { user: "mnemo", password: "mnemo", db: "mnemo" };
const APP_USER = "mnemo_app";
const APP_PASS = "mnemo_app_test_tenant_null";

const WS_HOME = "7e0a11c0-0001-4000-8000-000000000001"; // the bootstrap's workspace
const FOREIGN_TENANT = "7e0a11c0-tenant-foreign-0000-000000000002";
const WS_FOREIGN = "7e0a11c0-0002-4000-8000-000000000001";
const WS_MISSING = "7e0a11c0-0003-4000-8000-000000000001"; // never inserted
const HOME_USER = "7e0a11c0-user-home-0000-000000000001";
const VICTIM = "7e0a11c0-user-foreign-0000-00000000001";
const BYSTANDER = "7e0a11c0-user-foreign-0000-00000000002";

const BOOTSTRAP_KEY = "mns_live_tenantnullproofbootstrapkey01";
/** Same shape as the bootstrap key (no tenant, no user), given admin:tenant. */
const NULL_TENANT_ADMIN_KEY = "mns_live_tenantnullproofadmintenantkey1";

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let metricsPgClient: ReturnType<typeof postgres>;
let apiKeys: Awaited<ReturnType<typeof import("@mnemo-ai/core").createApiKeyLookup>>;
let app: ReturnType<typeof createApp>;
let homeTenant: string;

function authed(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

async function workspaceRole(workspaceId: string, userId: string): Promise<string | undefined> {
  const rows = await admin<Array<{ role: string }>>`
    SELECT role FROM mnemosyne.mnemo_workspace_member
    WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
  return rows[0]?.role;
}

async function keyCount(userId: string): Promise<number> {
  const rows = await admin<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM mnemosyne.mnemo_api_keys WHERE user_id = ${userId}`;
  return rows[0]!.n;
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

  // The grants of docker/scripts/provision-app-role.mjs.
  await admin.unsafe(`
    CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASS}'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
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

  // ── The real POST /bootstrap mints the first key. It reads DATABASE_URL when
  // mounted and refuses once any key exists, so it runs first, on its own app.
  const previousDatabaseUrl = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = superUrl;
  try {
    const bootApp = new Hono();
    mountBootstrap(bootApp);
    const res = await bootApp.request("/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", "x-setup-token": (process.env["MNEMO_SETUP_TOKEN"] ??= "integration-setup-token-0001") },
      body: JSON.stringify({ apiKey: BOOTSTRAP_KEY, workspaceId: WS_HOME }),
    });
    expect(res.status).toBe(201);
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previousDatabaseUrl;
  }

  const [home] = await admin<Array<{ tenant_id: string }>>`
    SELECT tenant_id FROM mnemosyne.mnemo_workspace WHERE id = ${WS_HOME}`;
  homeTenant = home!.tenant_id;

  // ── Seed: one member in the bootstrap's tenant, a foreign tenant with one ──
  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${HOME_USER}, ${"tenant-null-home@example.com"}, ${homeTenant})`;
  await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${homeTenant}, ${HOME_USER}, ${"member"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_HOME}, ${HOME_USER}, ${"read"})`;

  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${FOREIGN_TENANT}, ${"tenant-null foreign tenant"}, ${"organization"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, slug, tenant_id) VALUES (${WS_FOREIGN}, ${"foreign workspace"}, ${"tenant-null-foreign"}, ${FOREIGN_TENANT})`;
  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${VICTIM}, ${"tenant-null-victim@example.com"}, ${FOREIGN_TENANT})`;
  await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${FOREIGN_TENANT}, ${VICTIM}, ${"member"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_FOREIGN}, ${VICTIM}, ${"write"})`;
  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${BYSTANDER}, ${"tenant-null-bystander@example.com"}, ${FOREIGN_TENANT})`;
  await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${FOREIGN_TENANT}, ${BYSTANDER}, ${"member"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_FOREIGN}, ${BYSTANDER}, ${"read"})`;

  const adminHash = await bcrypt.hash(NULL_TENANT_ADMIN_KEY, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
    VALUES (${"key_tenant_null_admin"}, ${WS_HOME}, ${adminHash}, ${"tenant-null-admin"}, ${"tenant-null-admin"},
       ARRAY['admin:tenant','memory:read','memory:write','memory:admin']::text[])
  `;

  const appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`;
  metricsPgClient = postgres(appUrl, { max: 5, onnotice: () => void 0 });
  const coreMod = await import("@mnemo-ai/core");
  apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });

  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const deps = {
    apiKeys,
    llm: undefined,
    embedModel: "fake-model",
    telemetry: {
      startSpan: () => noopSpan,
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
    metricsPgClient,
  } as unknown as ServerDeps;
  app = createApp({ deps, version: "tenant-null-proof" });
}, 180_000);

afterAll(async () => {
  await apiKeys?.close?.().catch(() => void 0);
  await metricsPgClient?.end().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

describe("the key POST /bootstrap mints", () => {
  it("has no tenant and no user, the shape this proof is about", async () => {
    const rows = await admin<Array<{ tenant_id: string | null; user_id: string | null }>>`
      SELECT tenant_id, user_id FROM mnemosyne.mnemo_api_keys WHERE workspace_id = ${WS_HOME} AND name = ${"bootstrap"}`;
    expect(rows).toEqual([{ tenant_id: null, user_id: null }]);
  });
});

describe("AUTH-TENANT-NULL — bootstrap key, workspace plane", () => {
  it("lists its own workspace's members", async () => {
    const res = await app.request(`/workspaces/${WS_HOME}/members`, {
      headers: authed(BOOTSTRAP_KEY),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ userId: string }> };
    expect(body.members.map((m) => m.userId)).toEqual([HOME_USER]);
  });

  it("re-roles a member of its own workspace", async () => {
    const res = await app.request(`/workspaces/${WS_HOME}/members/${HOME_USER}`, {
      method: "PATCH",
      headers: authed(BOOTSTRAP_KEY),
      body: JSON.stringify({ role: "write" }),
    });
    expect(res.status).toBe(200);
    expect(await workspaceRole(WS_HOME, HOME_USER)).toBe("write");
  });

  it("gets the same 404 and body for a foreign workspace's members as for a missing workspace", async () => {
    const foreign = await app.request(`/workspaces/${WS_FOREIGN}/members`, {
      headers: authed(BOOTSTRAP_KEY),
    });
    const missing = await app.request(`/workspaces/${WS_MISSING}/members`, {
      headers: authed(BOOTSTRAP_KEY),
    });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  it("cannot re-role a member of a foreign workspace", async () => {
    const res = await app.request(`/workspaces/${WS_FOREIGN}/members/${VICTIM}`, {
      method: "PATCH",
      headers: authed(BOOTSTRAP_KEY),
      body: JSON.stringify({ role: "read" }),
    });
    expect(res.status).toBe(404);
    expect(await workspaceRole(WS_FOREIGN, VICTIM)).toBe("write");
  });

  it("cannot remove a member of a foreign workspace", async () => {
    const res = await app.request(`/workspaces/${WS_FOREIGN}/members/${BYSTANDER}`, {
      method: "DELETE",
      headers: authed(BOOTSTRAP_KEY),
    });
    expect(res.status).toBe(404);
    expect(await workspaceRole(WS_FOREIGN, BYSTANDER)).toBe("read");
  });
});

describe("AUTH-TENANT-NULL — null-tenant key with admin:tenant, tenant plane", () => {
  it("reads its own tenant's members", async () => {
    const res = await app.request(`/tenants/${homeTenant}/members`, {
      headers: authed(NULL_TENANT_ADMIN_KEY),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ userId: string }> };
    expect(body.members.map((m) => m.userId)).toContain(HOME_USER);
  });

  it("cannot read a foreign tenant's members", async () => {
    const res = await app.request(`/tenants/${FOREIGN_TENANT}/members`, {
      headers: authed(NULL_TENANT_ADMIN_KEY),
    });
    expect(res.status).toBe(403);
  });

  it("cannot mint a token for a foreign tenant's user, and writes no key row", async () => {
    const res = await app.request(`/tenants/${FOREIGN_TENANT}/users/${VICTIM}/tokens`, {
      method: "POST",
      headers: authed(NULL_TENANT_ADMIN_KEY),
      body: JSON.stringify({ label: "should be rejected", homeWorkspaceId: WS_FOREIGN }),
    });
    expect(res.status).toBe(403);
    expect(await keyCount(VICTIM)).toBe(0);
  });

  it("mints a token for its own tenant's user", async () => {
    const res = await app.request(`/tenants/${homeTenant}/users/${HOME_USER}/tokens`, {
      method: "POST",
      headers: authed(NULL_TENANT_ADMIN_KEY),
      body: JSON.stringify({ label: "home user token", homeWorkspaceId: WS_HOME }),
    });
    expect(res.status).toBe(201);
    expect(await keyCount(HOME_USER)).toBe(1);
  });
});
