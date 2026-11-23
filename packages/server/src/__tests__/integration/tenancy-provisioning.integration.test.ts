/**
 * WP-12 — tenant and workspace provisioning under RLS, on real Postgres.
 *
 * Findings: SEC-5, PRIM-17, RECALL-14, CLIENTS-11, AGENTSIM-12. With a
 * tenant-bound owner key, `POST /tenants`, `POST /users`, an invitation with
 * `createIfMissing` and a workspace created with `ownerUserId` all answered
 * 500 (`new row violates row-level security policy`), and a workspace created
 * without one belonged to nobody, so its creator could not use it.
 *
 * The routes run on the NOSUPERUSER/NOBYPASSRLS `mnemo_app` role production
 * connects as, with the grants of `docker/scripts/provision-app-role.mjs`,
 * as in `tenant-null-bypass.integration.test.ts`. The keyless-tenant path is
 * the key the real `POST /bootstrap` mints, plus a key of the same shape that
 * holds `admin:tenant`.
 *
 * Seed:
 *  - HOME: the bootstrap's tenant and workspace; HOME_USER is a member.
 *  - A: OWNER_A (tenant owner) and MEMBER_A (tenant member). WS_A1 belongs to
 *    OWNER_A, MEMBER_A writes in it. Both hold `uk_live_*` tokens bound to A
 *    with the full scope set, `admin:tenant` included.
 *  - B: OWNER_B and WS_B1, the foreign tenant.
 *  - EXISTING: a registered user in no tenant of the callers.
 *
 * The RLS policy that lets an owner seed the first membership of a new
 * workspace is also attacked directly, as `mnemo_app`, without the routes.
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
const APP_PASS = "mnemo_app_test_tenancy_provisioning";

const WS_HOME = "7e0a12c0-0001-4000-8000-000000000001"; // the bootstrap's workspace
const HOME_USER = "7e0a12c0-user-home-0000-000000000001";

const TENANT_A = "7e0a12c0-tenant-a-0000-000000000001";
const WS_A1 = "7e0a12c0-00a1-4000-8000-000000000001";
const OWNER_A = "7e0a12c0-user-a-owner-0000-0000000001";
const MEMBER_A = "7e0a12c0-user-a-member-000-0000000001";

const TENANT_B = "7e0a12c0-tenant-b-0000-000000000001";
const WS_B1 = "7e0a12c0-00b1-4000-8000-000000000001";
const OWNER_B = "7e0a12c0-user-b-owner-0000-0000000001";

const EXISTING_USER = "7e0a12c0-user-existing-0000-00000001";
const EXISTING_TENANT = "7e0a12c0-tenant-existing-0000-000001";
const EXISTING_EMAIL = "tenancy-existing@example.com";

// Workspaces seeded only for the direct attacks on the first-owner policy.
const WS_A_EMPTY = "7e0a12c0-00a2-4000-8000-000000000001"; // A, declared owner OWNER_A, no members
const WS_A_EMPTY_MEMBER = "7e0a12c0-00a3-4000-8000-000000000001"; // A, declared owner MEMBER_A, no members
const WS_A_TAKEN = "7e0a12c0-00a4-4000-8000-000000000001"; // A, declared owner OWNER_A, MEMBER_A is a member
const WS_B_EMPTY = "7e0a12c0-00b2-4000-8000-000000000001"; // B, declared owner OWNER_A, no members

const BOOTSTRAP_KEY = "mns_live_tenancyprovisioningbootstrap01";
/** Same shape as the bootstrap key (no tenant, no user), given admin:tenant. */
const NULL_TENANT_ADMIN_KEY = "mns_live_tenancyprovisioningnulladmin01";
const KEY_OWNER_A = "uk_live_tenancyprovisioningownera0011223";
const KEY_MEMBER_A = "uk_live_tenancyprovisioningmembera001122";

const FULL_SCOPES = [
  "admin:tenant",
  "memory:read",
  "memory:write",
  "memory:delete",
  "memory:admin",
  "memory:session",
];

let container: StartedTestContainer;
let admin: ReturnType<typeof postgres>;
let appSql: ReturnType<typeof postgres>;
let metricsPgClient: ReturnType<typeof postgres>;
let apiKeys: Awaited<ReturnType<typeof import("@mnemo-ai/core").createApiKeyLookup>>;
let app: ReturnType<typeof createApp>;
let homeTenant: string;

function authed(key: string, workspaceId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  if (workspaceId) headers["X-Workspace-Id"] = workspaceId;
  return headers;
}

function post(path: string, key: string, body: unknown, workspaceId?: string) {
  return app.request(path, {
    method: "POST",
    headers: authed(key, workspaceId),
    body: JSON.stringify(body),
  });
}

async function members(workspaceId: string): Promise<Array<{ user_id: string; role: string }>> {
  return admin<Array<{ user_id: string; role: string }>>`
    SELECT user_id, role FROM mnemosyne.mnemo_workspace_member
    WHERE workspace_id = ${workspaceId} ORDER BY user_id`;
}

async function workspacesNamed(name: string): Promise<number> {
  const rows = await admin<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM mnemosyne.mnemo_workspace WHERE name = ${name}`;
  return rows[0]!.n;
}

async function tenantRole(tenantId: string, userId: string): Promise<string | undefined> {
  const rows = await admin<Array<{ role: string }>>`
    SELECT role FROM mnemosyne.mnemo_tenant_member
    WHERE tenant_id = ${tenantId} AND user_id = ${userId}`;
  return rows[0]?.role;
}

async function usersWithEmail(email: string): Promise<number> {
  const rows = await admin<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM mnemosyne.mnemo_user WHERE email = ${email}`;
  return rows[0]!.n;
}

/** Everything one account is made of, read past RLS. */
async function accountGraph(email: string) {
  const [user] = await admin<Array<{ id: string; personal_tenant_id: string }>>`
    SELECT id, personal_tenant_id FROM mnemosyne.mnemo_user WHERE email = ${email}`;
  if (!user) return null;
  const [tenant] = await admin<Array<{ kind: string }>>`
    SELECT kind FROM mnemosyne.mnemo_tenant WHERE id = ${user.personal_tenant_id}`;
  const workspaces = await admin<Array<{ id: string; owner_user_id: string | null }>>`
    SELECT id, owner_user_id FROM mnemosyne.mnemo_workspace WHERE tenant_id = ${user.personal_tenant_id}`;
  return {
    userId: user.id,
    tenantId: user.personal_tenant_id,
    tenantKind: tenant?.kind,
    tenantRole: await tenantRole(user.personal_tenant_id, user.id),
    workspaces,
    workspaceMembers: workspaces[0] ? await members(workspaces[0].id) : [],
  };
}

/** A transaction as `mnemo_app`, with the GUCs the tenant routes set. */
function asApp<T>(
  gucs: { userId?: string; tenantId?: string },
  fn: (tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
  return appSql.begin(async (tx) => {
    if (gucs.userId) await tx`SELECT set_config('mnemosyne.actor_user_id', ${gucs.userId}, true)`;
    if (gucs.tenantId)
      await tx`SELECT set_config('mnemosyne.actor_tenant_id', ${gucs.tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

const ROLLBACK = "rollback-sentinel";

async function insertKey(
  id: string,
  key: string,
  row: { workspaceId: string; tenantId: string | null; userId: string | null; kind: string }
): Promise<void> {
  const hash = await bcrypt.hash(key, BCRYPT_COST);
  await admin`
    INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, tenant_id, user_id, key_kind, key_hash, name, label, scopes)
    VALUES (${id}, ${row.workspaceId}, ${row.tenantId}, ${row.userId}, ${row.kind}, ${hash}, ${id}, ${id},
       ${admin.array(FULL_SCOPES)})
  `;
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

  // ── The real POST /bootstrap mints the first key (no tenant, no user). ──
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

  // ── HOME ──
  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${HOME_USER}, ${"tenancy-home@example.com"}, ${homeTenant})`;
  await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${homeTenant}, ${HOME_USER}, ${"member"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_HOME}, ${HOME_USER}, ${"read"})`;

  // ── A ──
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${TENANT_A}, ${"tenancy tenant A"}, ${"organization"})`;
  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${OWNER_A}, ${"tenancy-owner-a@example.com"}, ${TENANT_A})`;
  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${MEMBER_A}, ${"tenancy-member-a@example.com"}, ${TENANT_A})`;
  await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${TENANT_A}, ${OWNER_A}, ${"owner"})`;
  await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${TENANT_A}, ${MEMBER_A}, ${"member"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id, owner_user_id) VALUES (${WS_A1}, ${"tenancy A1"}, ${TENANT_A}, ${OWNER_A})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_A1}, ${OWNER_A}, ${"owner"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_A1}, ${MEMBER_A}, ${"write"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id, owner_user_id) VALUES (${WS_A_EMPTY}, ${"tenancy A empty"}, ${TENANT_A}, ${OWNER_A})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id, owner_user_id) VALUES (${WS_A_EMPTY_MEMBER}, ${"tenancy A empty, member's"}, ${TENANT_A}, ${MEMBER_A})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id, owner_user_id) VALUES (${WS_A_TAKEN}, ${"tenancy A taken"}, ${TENANT_A}, ${OWNER_A})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_A_TAKEN}, ${MEMBER_A}, ${"write"})`;

  // ── B ──
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${TENANT_B}, ${"tenancy tenant B"}, ${"organization"})`;
  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${OWNER_B}, ${"tenancy-owner-b@example.com"}, ${TENANT_B})`;
  await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${TENANT_B}, ${OWNER_B}, ${"owner"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id, owner_user_id) VALUES (${WS_B1}, ${"tenancy B1"}, ${TENANT_B}, ${OWNER_B})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_B1}, ${OWNER_B}, ${"owner"})`;
  await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id, owner_user_id) VALUES (${WS_B_EMPTY}, ${"tenancy B empty"}, ${TENANT_B}, ${OWNER_A})`;

  // ── A registered user no caller can see under RLS ──
  await admin`INSERT INTO mnemosyne.mnemo_tenant (id, name, kind) VALUES (${EXISTING_TENANT}, ${EXISTING_EMAIL}, ${"personal"})`;
  await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${EXISTING_USER}, ${EXISTING_EMAIL}, ${EXISTING_TENANT})`;
  await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${EXISTING_TENANT}, ${EXISTING_USER}, ${"owner"})`;

  await insertKey("key_tenancy_null_admin", NULL_TENANT_ADMIN_KEY, {
    workspaceId: WS_HOME,
    tenantId: null,
    userId: null,
    kind: "workspace",
  });
  await insertKey("key_tenancy_owner_a", KEY_OWNER_A, {
    workspaceId: WS_A1,
    tenantId: TENANT_A,
    userId: OWNER_A,
    kind: "user",
  });
  await insertKey("key_tenancy_member_a", KEY_MEMBER_A, {
    workspaceId: WS_A1,
    tenantId: TENANT_A,
    userId: MEMBER_A,
    kind: "user",
  });

  const appUrl = `postgres://${APP_USER}:${APP_PASS}@${host}:${port}/${PG.db}`;
  appSql = postgres(appUrl, { max: 2, onnotice: () => void 0 });
  metricsPgClient = postgres(appUrl, { max: 5, onnotice: () => void 0 });
  const coreMod = await import("@mnemo-ai/core");
  apiKeys = coreMod.createApiKeyLookup({ databaseUrl: superUrl });

  // The v3 cognitive core, so a new workspace's owner can write and recall in
  // it (fake embeddings, no LLM), as in workspace-role-scopes.integration.test.ts.
  const [adapterPgMod, adapterVectorMod, v3CoreMod] = await Promise.all([
    import("@mnemo-ai/adapter-postgres"),
    import("@mnemo-ai/adapter-vector"),
    import("@mnemo-ai/core/cognitive"),
  ]);
  const DIMS = 1536;
  const fakeEmbed: import("@mnemo-ai/types").EmbedAdapter = {
    id: "fake-embed",
    model: "fake-model",
    dimensions: DIMS,
    async embed(texts) {
      return texts.map(() => new Float32Array(DIMS));
    },
    async embedSingle() {
      return new Float32Array(DIMS);
    },
    async healthCheck() {
      return { status: "ok" as const, latencyMs: 0 };
    },
  };
  const { db: v3Db, pgClient: v3Pg } = adapterPgMod.createDrizzleClient(appUrl);
  const v3Storage = new adapterPgMod.DrizzleStorageAdapter(v3Db, v3Pg, undefined);
  const v3Vector = new adapterVectorMod.PgVectorAdapter({ connectionString: appUrl });
  const noopLogger: import("@mnemo-ai/types").Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: function () {
      return this;
    },
  };
  const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
  const telemetry = {
    startSpan: () => noopSpan,
    counter: () => {},
    histogram: () => {},
    gauge: () => {},
    shutdown: async () => {},
  };
  const outboxAdapter: import("@mnemo-ai/types").OutboxAdapter = {
    async append(e) {
      return v3Storage.appendOutbox(e);
    },
    async claimBatch(n) {
      return v3Storage.claimOutbox(n);
    },
    async markProcessed(ids) {
      return v3Storage.markOutboxProcessed(ids);
    },
    async markFailed(id, err) {
      return v3Storage.markOutboxFailed(id, err);
    },
    async getStats() {
      return { pending: 0, failed: 0, oldestPendingMs: 0 };
    },
  };
  const cognitive = v3CoreMod.createCore({
    storage: v3Storage,
    vector: v3Vector,
    embed: fakeEmbed,
    outbox: outboxAdapter,
    logger: noopLogger,
    telemetry,
  });

  const deps = {
    storage: v3Storage,
    apiKeys,
    cognitive,
    llm: undefined,
    embedModel: "fake-model",
    telemetry,
    metricsPgClient,
  } as unknown as ServerDeps;
  app = createApp({ deps, version: "tenancy-provisioning-proof" });
}, 180_000);

afterAll(async () => {
  await apiKeys?.close?.().catch(() => void 0);
  await metricsPgClient?.end().catch(() => void 0);
  await appSql?.end().catch(() => void 0);
  await admin?.end().catch(() => void 0);
  await container?.stop().catch(() => void 0);
});

// ─── Workspaces (RECALL-14, CLIENTS-11, AGENTSIM-12, PRIM-17) ─────────────────

describe("POST /tenants/:tenantId/workspaces — tenant-bound owner key", () => {
  it("creates a workspace with an explicit self owner and seeds exactly one owner membership", async () => {
    const res = await post(`/tenants/${TENANT_A}/workspaces`, KEY_OWNER_A, {
      name: "tenancy explicit self owner",
      ownerUserId: OWNER_A,
    });
    expect(res.status).toBe(201);
    const ws = (await res.json()) as { id: string; tenantId: string };
    expect(ws.tenantId).toBe(TENANT_A);
    expect(await members(ws.id)).toEqual([{ user_id: OWNER_A, role: "owner" }]);
  });

  it("makes the caller the owner when ownerUserId is omitted, and the owner can use it", async () => {
    const res = await post(`/tenants/${TENANT_A}/workspaces`, KEY_OWNER_A, {
      name: "tenancy default owner",
    });
    expect(res.status).toBe(201);
    const ws = (await res.json()) as { id: string };
    expect(await members(ws.id)).toEqual([{ user_id: OWNER_A, role: "owner" }]);

    // The creator's own token switches into it as its owner…
    const me = await app.request("/me", { headers: authed(KEY_OWNER_A, ws.id) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ workspaceId: ws.id, workspaceRole: "owner" });

    // …writes memory into it…
    const remember = await post(
      "/remember",
      KEY_OWNER_A,
      { statement: "tenancy: the default-owner workspace takes writes from its creator" },
      ws.id
    );
    expect(remember.status).toBe(201);
    const facts = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_fact WHERE workspace_id::text = ${ws.id}`;
    expect(facts[0]!.n).toBe(1);
    const recall = await post("/recall", KEY_OWNER_A, { query: "default-owner workspace" }, ws.id);
    expect(recall.status).toBe(200);

    // …and lets a teammate in, which an ownerless workspace refused (403).
    const invite = await post(`/workspaces/${ws.id}/members`, KEY_OWNER_A, {
      userId: MEMBER_A,
      role: "write",
    });
    expect(invite.status).toBe(200);
    expect(await members(ws.id)).toEqual(
      [
        { user_id: OWNER_A, role: "owner" },
        { user_id: MEMBER_A, role: "write" },
      ].sort((x, y) => x.user_id.localeCompare(y.user_id))
    );
  });

  it("seeds an explicit owner from the same tenant, and the creator gets no membership", async () => {
    const res = await post(`/tenants/${TENANT_A}/workspaces`, KEY_OWNER_A, {
      name: "tenancy owned by a teammate",
      ownerUserId: MEMBER_A,
    });
    expect(res.status).toBe(201);
    const ws = (await res.json()) as { id: string };
    expect(await members(ws.id)).toEqual([{ user_id: MEMBER_A, role: "owner" }]);
  });

  it("refuses an owner outside the tenant and creates nothing", async () => {
    const res = await post(`/tenants/${TENANT_A}/workspaces`, KEY_OWNER_A, {
      name: "tenancy foreign owner",
      ownerUserId: OWNER_B,
    });
    expect(res.status).toBe(403);
    expect(await workspacesNamed("tenancy foreign owner")).toBe(0);
  });

  it("refuses an owner that does not exist and creates nothing", async () => {
    const res = await post(`/tenants/${TENANT_A}/workspaces`, KEY_OWNER_A, {
      name: "tenancy ghost owner",
      ownerUserId: "7e0a12c0-user-nobody-0000-0000000001",
    });
    expect(res.status).toBe(403);
    expect(await workspacesNamed("tenancy ghost owner")).toBe(0);
  });

  it("cannot create a workspace in another tenant", async () => {
    const res = await post(`/tenants/${TENANT_B}/workspaces`, KEY_OWNER_A, {
      name: "tenancy cross-tenant workspace",
      ownerUserId: OWNER_A,
    });
    expect(res.status).toBe(403);
    expect(await workspacesNamed("tenancy cross-tenant workspace")).toBe(0);
  });

  it("a tenant member without the owner or admin role cannot create one", async () => {
    const res = await post(`/tenants/${TENANT_A}/workspaces`, KEY_MEMBER_A, {
      name: "tenancy member's workspace",
    });
    expect(res.status).toBe(403);
    expect(await workspacesNamed("tenancy member's workspace")).toBe(0);
  });
});

describe("first-owner seeding policy — direct SQL as mnemo_app", () => {
  const ownerA = { userId: OWNER_A, tenantId: TENANT_A };

  it("control: a tenant owner seeds the declared owner of an empty workspace of its tenant", async () => {
    await expect(
      asApp(ownerA, async (tx) => {
        await tx`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
                 VALUES (${WS_A_EMPTY}, ${OWNER_A}, 'owner')`;
        throw new Error(ROLLBACK);
      })
    ).rejects.toThrow(ROLLBACK);
  });

  it("cannot seed into another tenant's workspace, even as its declared owner", async () => {
    await expect(
      asApp(
        ownerA,
        (tx) => tx`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
                               VALUES (${WS_B_EMPTY}, ${OWNER_A}, 'owner')`
      )
    ).rejects.toThrow(/row-level security/);
    expect(await members(WS_B_EMPTY)).toEqual([]);
  });

  it("cannot seed into a workspace that already has members", async () => {
    await expect(
      asApp(
        ownerA,
        (tx) => tx`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
                               VALUES (${WS_A_TAKEN}, ${OWNER_A}, 'owner')`
      )
    ).rejects.toThrow(/row-level security/);
    expect(await members(WS_A_TAKEN)).toEqual([{ user_id: MEMBER_A, role: "write" }]);
  });

  it("cannot seed any role but owner", async () => {
    await expect(
      asApp(
        ownerA,
        (tx) => tx`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
                               VALUES (${WS_A_EMPTY}, ${OWNER_A}, 'admin')`
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot seed anyone but the workspace's declared owner", async () => {
    await expect(
      asApp(
        ownerA,
        (tx) => tx`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
                               VALUES (${WS_A_EMPTY}, ${MEMBER_A}, 'owner')`
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("a tenant member without the owner or admin role cannot seed, even itself as declared owner", async () => {
    await expect(
      asApp(
        { userId: MEMBER_A, tenantId: TENANT_A },
        (tx) => tx`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
                   VALUES (${WS_A_EMPTY_MEMBER}, ${MEMBER_A}, 'owner')`
      )
    ).rejects.toThrow(/row-level security/);
    expect(await members(WS_A_EMPTY_MEMBER)).toEqual([]);
  });

  it("without a tenant GUC nothing is seeded through it", async () => {
    await expect(
      asApp(
        { userId: OWNER_A },
        (tx) => tx`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
                                          VALUES (${WS_A_EMPTY}, ${OWNER_A}, 'owner')`
      )
    ).rejects.toThrow(/row-level security/);
  });

  it("does not widen UPDATE: a write member cannot promote itself to owner", async () => {
    const rows = await asApp(
      { userId: MEMBER_A, tenantId: TENANT_A },
      (tx) => tx`UPDATE mnemosyne.mnemo_workspace_member SET role = 'owner'
                 WHERE workspace_id = ${WS_A_TAKEN} AND user_id = ${MEMBER_A} RETURNING user_id`
    );
    expect(rows).toHaveLength(0);
    expect(await members(WS_A_TAKEN)).toEqual([{ user_id: MEMBER_A, role: "write" }]);
  });
});

// ─── Tenants and accounts (SEC-5, PRIM-17) ────────────────────────────────────

describe("POST /tenants — tenant-bound owner key", () => {
  it("creates the tenant and makes the caller its owner", async () => {
    const res = await post("/tenants", KEY_OWNER_A, {
      name: "tenancy new org",
      kind: "organization",
    });
    expect(res.status).toBe(201);
    const tenant = (await res.json()) as { id: string; name: string; kind: string; plan: string };
    expect(tenant).toMatchObject({ name: "tenancy new org", kind: "organization", plan: "free" });
    expect(await tenantRole(tenant.id, OWNER_A)).toBe("owner");
  });

  it("a tenant member without the owner or admin role is refused and nothing is created", async () => {
    const res = await post("/tenants", KEY_MEMBER_A, { name: "tenancy member's org" });
    expect(res.status).toBe(403);
    const rows = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_tenant WHERE name = ${"tenancy member's org"}`;
    expect(rows[0]!.n).toBe(0);
  });
});

describe("POST /users — tenant-bound owner key", () => {
  it("creates the user with a personal tenant and workspace it owns", async () => {
    const email = "tenancy-new-user@example.com";
    const res = await post("/users", KEY_OWNER_A, { email, displayName: "New User" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string; email: string; displayName: string | null; personalTenantId: string };
      personalTenant: { id: string; kind: string };
      personalWorkspace: { id: string; tenantId: string };
    };
    expect(body.user).toMatchObject({ email, displayName: "New User" });
    expect(body.personalTenant).toMatchObject({ id: body.user.personalTenantId, kind: "personal" });
    expect(body.personalWorkspace.tenantId).toBe(body.user.personalTenantId);

    const graph = await accountGraph(email);
    expect(graph).toMatchObject({
      userId: body.user.id,
      tenantId: body.personalTenant.id,
      tenantKind: "personal",
      tenantRole: "owner",
      workspaces: [{ id: body.personalWorkspace.id, owner_user_id: body.user.id }],
      workspaceMembers: [{ user_id: body.user.id, role: "owner" }],
    });
  });

  it("answers 400 for a registered email the caller cannot see, and creates nothing", async () => {
    const tenantsBefore = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_tenant`;
    const res = await post("/users", KEY_OWNER_A, { email: EXISTING_EMAIL });
    expect(res.status).toBe(400);
    expect(await usersWithEmail(EXISTING_EMAIL)).toBe(1);
    const tenantsAfter = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_tenant`;
    expect(tenantsAfter[0]!.n).toBe(tenantsBefore[0]!.n);
  });

  it("a tenant member without the owner or admin role is refused and nothing is created", async () => {
    const email = "tenancy-member-made@example.com";
    const res = await post("/users", KEY_MEMBER_A, { email });
    expect(res.status).toBe(403);
    expect(await usersWithEmail(email)).toBe(0);
  });
});

describe("POST /tenants/:tenantId/members — invitations by a tenant-bound owner key", () => {
  it("createIfMissing provisions the whole account and adds it to the tenant", async () => {
    const email = "tenancy-invited-new@example.com";
    const res = await post(`/tenants/${TENANT_A}/members`, KEY_OWNER_A, {
      email,
      role: "member",
      createIfMissing: true,
    });
    expect(res.status).toBe(200);
    const graph = await accountGraph(email);
    expect(graph).toMatchObject({
      tenantKind: "personal",
      tenantRole: "owner",
      workspaceMembers: [{ role: "owner" }],
    });
    expect(graph!.workspaces).toHaveLength(1);
    expect(graph!.workspaces[0]!.owner_user_id).toBe(graph!.userId);
    expect(await tenantRole(TENANT_A, graph!.userId)).toBe("member");
  });

  it("re-invites a member of its own tenant by email, without a duplicate", async () => {
    const email = "tenancy-invited-new@example.com"; // joined A in the test above
    const res = await post(`/tenants/${TENANT_A}/members`, KEY_OWNER_A, {
      email,
      role: "admin",
      createIfMissing: true,
    });
    expect(res.status).toBe(200);
    const graph = await accountGraph(email);
    expect(await tenantRole(TENANT_A, graph!.userId)).toBe("admin");
    expect(await usersWithEmail(email)).toBe(1);
  });

  // An account from outside would be one this admin could mint a token for,
  // and a user token switches into every workspace of its user, in any tenant.
  it("does not pull in a registered user from outside the tenant, so it cannot mint it a token", async () => {
    const res = await post(`/tenants/${TENANT_A}/members`, KEY_OWNER_A, {
      email: EXISTING_EMAIL,
      role: "member",
    });
    expect(res.status).toBe(404);
    expect(await tenantRole(TENANT_A, EXISTING_USER)).toBeUndefined();

    const mint = await post(`/tenants/${TENANT_A}/users/${EXISTING_USER}/tokens`, KEY_OWNER_A, {
      label: "should be refused",
      homeWorkspaceId: WS_A1,
    });
    expect(mint.status).toBe(404);
    const keys = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_api_keys WHERE user_id = ${EXISTING_USER}`;
    expect(keys[0]!.n).toBe(0);
  });

  it("with createIfMissing, a registered user from outside is a 409, and no second account", async () => {
    const res = await post(`/tenants/${TENANT_A}/members`, KEY_OWNER_A, {
      email: EXISTING_EMAIL,
      role: "member",
      createIfMissing: true,
    });
    expect(res.status).toBe(409);
    expect(await tenantRole(TENANT_A, EXISTING_USER)).toBeUndefined();
    expect(await usersWithEmail(EXISTING_EMAIL)).toBe(1);
  });

  it("cannot invite into another tenant, and creates no account", async () => {
    const email = "tenancy-invited-foreign@example.com";
    const res = await post(`/tenants/${TENANT_B}/members`, KEY_OWNER_A, {
      email,
      role: "member",
      createIfMissing: true,
    });
    expect(res.status).toBe(403);
    expect(await usersWithEmail(email)).toBe(0);
  });
});

describe("provisioning functions — direct SQL as mnemo_app", () => {
  it("a tenant member without the owner or admin role cannot provision an account", async () => {
    await expect(
      asApp(
        { userId: MEMBER_A, tenantId: TENANT_A },
        (tx) => tx`SELECT * FROM mnemosyne.mnemo_provision_user(
                     ${"tenancy-sql-member@example.com"}, ${null}, ${"x"})`
      )
    ).rejects.toThrow(/owner or admin/);
    expect(await usersWithEmail("tenancy-sql-member@example.com")).toBe(0);
  });

  it("a tenant member without the owner or admin role cannot provision a tenant", async () => {
    await expect(
      asApp(
        { userId: MEMBER_A, tenantId: TENANT_A },
        (tx) =>
          tx`SELECT * FROM mnemosyne.mnemo_provision_tenant(${"tenancy sql org"}, ${"organization"}, ${null}, ${null})`
      )
    ).rejects.toThrow(/owner or admin/);
  });

  it("a tenant member without the owner or admin role cannot look users up by email", async () => {
    await expect(
      asApp(
        { userId: MEMBER_A, tenantId: TENANT_A },
        (tx) => tx`SELECT mnemosyne.mnemo_find_user_id_by_email(${EXISTING_EMAIL})`
      )
    ).rejects.toThrow(/owner or admin/);
  });

  it("the email lookup shows a user-bound caller the members of its tenant, and nobody else", async () => {
    const lookup = (email: string) =>
      asApp(
        { userId: OWNER_A, tenantId: TENANT_A },
        (tx) => tx<Array<{ id: string | null }>>`
          SELECT mnemosyne.mnemo_find_user_id_by_email(${email}) AS id`
      );
    expect(await lookup("tenancy-member-a@example.com")).toEqual([{ id: MEMBER_A }]);
    expect(await lookup(EXISTING_EMAIL)).toEqual([{ id: null }]);
    expect(await lookup("tenancy-owner-b@example.com")).toEqual([{ id: null }]);
  });

  it("an account provisioned in a transaction that fails later leaves no row behind", async () => {
    const email = "tenancy-rolled-back@example.com";
    await expect(
      asApp({ userId: OWNER_A, tenantId: TENANT_A }, async (tx) => {
        await tx`SELECT * FROM mnemosyne.mnemo_provision_user(${email}, ${null}, ${"x"})`;
        throw new Error(ROLLBACK);
      })
    ).rejects.toThrow(ROLLBACK);
    expect(await accountGraph(email)).toBeNull();
    const tenants = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_tenant WHERE name = ${email}`;
    expect(tenants[0]!.n).toBe(0);
  });
});

// ─── Keys with no tenant keep working (AUTH-TENANT-NULL) ──────────────────────

describe("a key with no tenant and no user, holding admin:tenant", () => {
  it("creates a workspace in its home tenant with a member of that tenant as owner", async () => {
    const res = await post(`/tenants/${homeTenant}/workspaces`, NULL_TENANT_ADMIN_KEY, {
      name: "tenancy home, owned",
      ownerUserId: HOME_USER,
    });
    expect(res.status).toBe(201);
    const ws = (await res.json()) as { id: string };
    expect(await members(ws.id)).toEqual([{ user_id: HOME_USER, role: "owner" }]);
  });

  it("still creates a workspace with no owner, which it keeps managing", async () => {
    const res = await post(`/tenants/${homeTenant}/workspaces`, NULL_TENANT_ADMIN_KEY, {
      name: "tenancy home, unowned",
    });
    expect(res.status).toBe(201);
    const ws = (await res.json()) as { id: string };
    expect(await members(ws.id)).toEqual([]);
    const invite = await post(`/workspaces/${ws.id}/members`, NULL_TENANT_ADMIN_KEY, {
      userId: HOME_USER,
      role: "read",
    });
    expect(invite.status).toBe(200);
  });

  it("cannot make a user of another tenant the owner of a workspace in its own", async () => {
    const res = await post(`/tenants/${homeTenant}/workspaces`, NULL_TENANT_ADMIN_KEY, {
      name: "tenancy home, foreign owner",
      ownerUserId: OWNER_B,
    });
    expect(res.status).toBe(403);
    expect(await workspacesNamed("tenancy home, foreign owner")).toBe(0);
  });

  it("cannot create a workspace in another tenant", async () => {
    const res = await post(`/tenants/${TENANT_B}/workspaces`, NULL_TENANT_ADMIN_KEY, {
      name: "tenancy null-tenant cross-tenant",
    });
    expect(res.status).toBe(403);
    expect(await workspacesNamed("tenancy null-tenant cross-tenant")).toBe(0);
  });

  it("still creates users", async () => {
    const email = "tenancy-null-admin-made@example.com";
    const res = await post("/users", NULL_TENANT_ADMIN_KEY, { email });
    expect(res.status).toBe(201);
    expect(await accountGraph(email)).toMatchObject({
      tenantRole: "owner",
      workspaceMembers: [{ role: "owner" }],
    });
  });

  it("still invites a registered user from outside its tenant, as the RLS fallbacks let it", async () => {
    const res = await post(`/tenants/${homeTenant}/members`, NULL_TENANT_ADMIN_KEY, {
      email: EXISTING_EMAIL,
      role: "member",
    });
    expect(res.status).toBe(200);
    expect(await tenantRole(homeTenant, EXISTING_USER)).toBe("member");
  });

  it("cannot invite into another tenant", async () => {
    const res = await post(`/tenants/${TENANT_B}/members`, NULL_TENANT_ADMIN_KEY, {
      email: EXISTING_EMAIL,
      role: "member",
    });
    expect(res.status).toBe(403);
    expect(await tenantRole(TENANT_B, EXISTING_USER)).toBeUndefined();
  });
});

describe("the bootstrap key", () => {
  it("still lists its own workspace's members", async () => {
    const res = await app.request(`/workspaces/${WS_HOME}/members`, {
      headers: authed(BOOTSTRAP_KEY),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ userId: string }> };
    expect(body.members.map((m) => m.userId)).toEqual([HOME_USER]);
  });
});

// ─── Review round: onboarding ends that led nowhere ──────────────────────────

describe("an account the tenant provisioned can be brought into it", () => {
  it("POST /users → invitation → workspace membership → token, as one flow", async () => {
    const email = "tenancy-review-flow@example.com";
    const created = await post("/users", KEY_OWNER_A, { email });
    expect(created.status).toBe(201);
    const { user } = (await created.json()) as { user: { id: string } };

    const invite = await post(`/tenants/${TENANT_A}/members`, KEY_OWNER_A, {
      email,
      role: "member",
    });
    expect(invite.status).toBe(200);
    expect(await tenantRole(TENANT_A, user.id)).toBe("member");

    const join = await post(`/workspaces/${WS_A1}/members`, KEY_OWNER_A, {
      userId: user.id,
      role: "write",
    });
    expect(join.status).toBe(200);

    const mint = await post(`/tenants/${TENANT_A}/users/${user.id}/tokens`, KEY_OWNER_A, {
      label: "review flow",
      homeWorkspaceId: WS_A1,
      scopes: ["memory:read", "memory:write"],
    });
    expect(mint.status).toBe(201);
    const { key } = (await mint.json()) as { key: string };
    const me = await app.request("/me", { headers: authed(key) });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ userId: user.id, workspaceId: WS_A1 });
  });

  it("an account another tenant provisioned stays out of reach", async () => {
    const email = "tenancy-review-b-made@example.com";
    await asApp(
      { userId: OWNER_B, tenantId: TENANT_B },
      (tx) => tx`SELECT * FROM mnemosyne.mnemo_provision_user(${email}, ${null}, ${"x"})`
    );
    const invite = await post(`/tenants/${TENANT_A}/members`, KEY_OWNER_A, {
      email,
      role: "member",
    });
    expect(invite.status).toBe(404);
    const graph = await accountGraph(email);
    expect(await tenantRole(TENANT_A, graph!.userId)).toBeUndefined();
  });
});

describe("POST /tenants with issueOwnerToken — a new tenant its creator can operate", () => {
  it("returns a first workspace and an owner token that works in the new tenant, and only there", async () => {
    const res = await post("/tenants", KEY_OWNER_A, {
      name: "tenancy review org",
      kind: "organization",
      issueOwnerToken: true,
      workspaceName: "tenancy review org — main",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      workspace: { id: string; tenantId: string; name: string };
      ownerToken: {
        id: string;
        key: string;
        tenantId: string;
        workspaceId: string;
        userId: string;
        scopes: string[];
      };
    };
    expect(body.workspace).toMatchObject({ tenantId: body.id, name: "tenancy review org — main" });
    expect(body.ownerToken).toMatchObject({
      tenantId: body.id,
      workspaceId: body.workspace.id,
      userId: OWNER_A,
    });
    expect(body.ownerToken.key).toMatch(/^uk_live_/);
    expect(new Set(body.ownerToken.scopes)).toEqual(new Set(FULL_SCOPES));
    expect(await members(body.workspace.id)).toEqual([{ user_id: OWNER_A, role: "owner" }]);
    const keyRows = await admin<
      Array<{ tenant_id: string; user_id: string; workspace_id: string }>
    >`
      SELECT tenant_id, user_id, workspace_id FROM mnemosyne.mnemo_api_keys WHERE id = ${body.ownerToken.id}`;
    expect(keyRows).toEqual([
      { tenant_id: body.id, user_id: OWNER_A, workspace_id: body.workspace.id },
    ]);

    const token = body.ownerToken.key;
    // The tenant plane of the new tenant…
    const tenantMembers = await app.request(`/tenants/${body.id}/members`, {
      headers: authed(token),
    });
    expect(tenantMembers.status).toBe(200);
    const second = await post(`/tenants/${body.id}/workspaces`, token, {
      name: "tenancy review org — second",
    });
    expect(second.status).toBe(201);
    // …its memory…
    const remember = await post("/remember", token, {
      statement: "tenancy: the new org takes writes",
    });
    expect(remember.status).toBe(201);
    // …and nothing of the old one.
    const oldTenant = await app.request(`/tenants/${TENANT_A}/members`, { headers: authed(token) });
    expect(oldTenant.status).toBe(403);
  });

  it("without the flag, nothing but the tenant and its owner membership is created", async () => {
    const res = await post("/tenants", KEY_OWNER_A, { name: "tenancy review plain org" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("ownerToken");
    expect(body).not.toHaveProperty("workspace");
    const ws = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_workspace WHERE tenant_id = ${body.id as string}`;
    expect(ws[0]!.n).toBe(0);
  });

  it("a key with no user cannot ask for an owner token, and nothing is created", async () => {
    const res = await post("/tenants", NULL_TENANT_ADMIN_KEY, {
      name: "tenancy review userless org",
      issueOwnerToken: true,
    });
    expect(res.status).toBe(400);
    const rows = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_tenant WHERE name = ${"tenancy review userless org"}`;
    expect(rows[0]!.n).toBe(0);
  });

  it("a tenant member without the owner or admin role gets no tenant and no token", async () => {
    const res = await post("/tenants", KEY_MEMBER_A, {
      name: "tenancy review member org",
      issueOwnerToken: true,
    });
    expect(res.status).toBe(403);
    const keys = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_api_keys WHERE user_id = ${MEMBER_A}`;
    expect(keys[0]!.n).toBe(1); // its own key only
  });
});

// ─── AUTH-TENANT-RLS-FALLBACK ────────────────────────────────────────────────
//
// A key with no tenant and no user ran the tenant routes with no GUC at all,
// so RLS let it see and write every tenant's workspaces and memberships, and
// the AUTH-TENANT-NULL guards were the only barrier. The routes now give it its
// home tenant as actor tenant, and mnemo_workspace_member admits a caller with
// no user only in the workspaces of that tenant.

describe("AUTH-TENANT-RLS-FALLBACK — memberships for a caller with no user", () => {
  const home = () => ({ tenantId: homeTenant });

  it("the home-tenant lookup does not read through the RLS fallback", async () => {
    // As a caller of tenant B, RLS hides the bootstrap's workspace.
    const rows = await asApp(
      { userId: OWNER_B, tenantId: TENANT_B },
      (tx) => tx<Array<{ visible: number; tenant: string | null }>>`
        SELECT (SELECT count(*)::int FROM mnemosyne.mnemo_workspace WHERE id = ${WS_HOME}) AS visible,
               mnemosyne.mnemo_workspace_tenant_id(${WS_HOME}) AS tenant`
    );
    expect(rows).toEqual([{ visible: 0, tenant: homeTenant }]);
  });

  it("control: it manages the memberships of a workspace of its home tenant", async () => {
    await expect(
      asApp(home(), async (tx) => {
        const updated = await tx`UPDATE mnemosyne.mnemo_workspace_member SET role = 'write'
                                 WHERE workspace_id = ${WS_HOME} AND user_id = ${HOME_USER}
                                 RETURNING user_id`;
        expect(updated).toHaveLength(1);
        throw new Error(ROLLBACK);
      })
    ).rejects.toThrow(ROLLBACK);
  });

  it("cannot read the memberships of another tenant's workspace", async () => {
    const rows = await asApp(
      home(),
      (tx) => tx`SELECT user_id FROM mnemosyne.mnemo_workspace_member WHERE workspace_id = ${WS_B1}`
    );
    expect(rows).toHaveLength(0);
  });

  it("cannot change or add memberships in another tenant's workspace", async () => {
    const updated = await asApp(
      home(),
      (tx) => tx`UPDATE mnemosyne.mnemo_workspace_member SET role = 'read'
                 WHERE workspace_id = ${WS_B1} AND user_id = ${OWNER_B} RETURNING user_id`
    );
    expect(updated).toHaveLength(0);
    await expect(
      asApp(
        home(),
        (tx) => tx`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
                                VALUES (${WS_B1}, ${HOME_USER}, 'owner')`
      )
    ).rejects.toThrow(/row-level security/);
    expect(await members(WS_B1)).toEqual([{ user_id: OWNER_B, role: "owner" }]);
  });

  it("with no GUC at all, memberships are neither visible nor writable", async () => {
    const rows = await asApp({}, (tx) => tx`SELECT user_id FROM mnemosyne.mnemo_workspace_member`);
    expect(rows).toHaveLength(0);
    await expect(
      asApp(
        {},
        (tx) => tx`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role)
                           VALUES (${WS_HOME}, ${OWNER_B}, 'owner')`
      )
    ).rejects.toThrow(/row-level security/);
  });
});

// Last: it takes the migration away and puts it back.
describe("migration 0047 on a live database", () => {
  const MIGRATION = resolve(
    HERE,
    "../../../../adapter-postgres/migrations/baseline/0047_tenant_provisioning"
  );

  async function provisioningObjects(): Promise<number> {
    const rows = await admin<Array<{ n: number }>>`
      SELECT ((SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'mnemosyne'
                 AND p.proname IN ('mnemo_actor_may_provision', 'mnemo_provision_tenant',
                                   'mnemo_provision_user', 'mnemo_find_user_id_by_email',
                                   'mnemo_can_seed_workspace_owner', 'mnemo_workspace_tenant_id'))
            + (SELECT count(*) FROM pg_policies
               WHERE policyname = 'mnemo_workspace_member_seed_owner')
            -- the two membership policies of 0047 name the tenant lookup
            + (SELECT count(*) FROM pg_policies
               WHERE tablename = 'mnemo_workspace_member'
                 AND qual LIKE '%mnemo_workspace_tenant_id%'))::int AS n`;
    return rows[0]!.n;
  }

  it("the down file removes it, and the up file applies again over it", async () => {
    const { readFile } = await import("node:fs/promises");
    expect(await provisioningObjects()).toBe(9);

    await admin.unsafe(await readFile(`${MIGRATION}.down.sql`, "utf8"));
    expect(await provisioningObjects()).toBe(0);
    const without = await post(`/tenants/${TENANT_A}/workspaces`, KEY_OWNER_A, {
      name: "tenancy after the down migration",
    });
    expect(without.status).toBe(500);
    expect(await workspacesNamed("tenancy after the down migration")).toBe(0);

    const up = await readFile(`${MIGRATION}.sql`, "utf8");
    await admin.unsafe(up);
    await admin.unsafe(up); // by hand, twice: still fine
    expect(await provisioningObjects()).toBe(9);
    const again = await post(`/tenants/${TENANT_A}/workspaces`, KEY_OWNER_A, {
      name: "tenancy after the up migration",
    });
    expect(again.status).toBe(201);
  });
});

describe("DELETE /workspaces/:workspaceId/members/:userId — the removed member's keys", () => {
  const WS_A5 = "7e0a12c0-00a5-4000-8000-000000000001";
  const LEAVER = "7e0a12c0-user-a-leaver-000-0000000001";
  const KEY_LEAVER_A5 = "uk_live_tenancyprovisioningleavera5aa01";
  const KEY_LEAVER_A1 = "uk_live_tenancyprovisioningleavera1aa01";

  beforeAll(async () => {
    await admin`INSERT INTO mnemosyne.mnemo_user (id, email, personal_tenant_id) VALUES (${LEAVER}, ${"tenancy-leaver-a@example.com"}, ${TENANT_A})`;
    await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${TENANT_A}, ${LEAVER}, ${"member"})`;
    await admin`INSERT INTO mnemosyne.mnemo_workspace (id, name, tenant_id, owner_user_id) VALUES (${WS_A5}, ${"tenancy A5"}, ${TENANT_A}, ${OWNER_A})`;
    await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_A5}, ${OWNER_A}, ${"owner"})`;
    await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_A5}, ${LEAVER}, ${"write"})`;
    await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${WS_A1}, ${LEAVER}, ${"write"})`;
    await insertKey("key_tenancy_leaver_a5", KEY_LEAVER_A5, {
      workspaceId: WS_A5,
      tenantId: TENANT_A,
      userId: LEAVER,
      kind: "user",
    });
    await insertKey("key_tenancy_leaver_a1", KEY_LEAVER_A1, {
      workspaceId: WS_A1,
      tenantId: TENANT_A,
      userId: LEAVER,
      kind: "user",
    });
  });

  it("revokes the member's keys homed in that workspace at once, and only those", async () => {
    // Both keys work, and the A5 key is now in this process's auth cache.
    expect((await app.request("/me", { headers: authed(KEY_LEAVER_A5) })).status).toBe(200);
    expect((await app.request("/me", { headers: authed(KEY_LEAVER_A1) })).status).toBe(200);

    const res = await app.request(`/workspaces/${WS_A5}/members/${LEAVER}`, {
      method: "DELETE",
      headers: authed(KEY_OWNER_A, WS_A5),
    });
    expect(res.status).toBe(200);

    expect((await app.request("/me", { headers: authed(KEY_LEAVER_A5) })).status).toBe(401);
    expect((await app.request("/me", { headers: authed(KEY_LEAVER_A1) })).status).toBe(200);
    const keys = await admin<Array<{ id: string; revoked: boolean }>>`
      SELECT id, revoked_at IS NOT NULL AS revoked FROM mnemosyne.mnemo_api_keys
      WHERE user_id = ${LEAVER} ORDER BY id`;
    expect(keys).toEqual([
      { id: "key_tenancy_leaver_a1", revoked: false },
      { id: "key_tenancy_leaver_a5", revoked: true },
    ]);
  });
});
