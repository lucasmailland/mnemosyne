/**
 * Instance plane (accounts stage A, task 5): superadmin user management on the
 * dashboard bridge, against real Postgres as a NOSUPERUSER app login.
 *
 * Coordinator runs with Node >=22 + Docker.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import bcrypt from "bcrypt";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDrizzleClient, DrizzleStorageAdapter } from "@mnemo-ai/adapter-postgres";
import { DashboardPasswordAuth, PostgresCredentialStore } from "../../dashboard-password.js";
import { mountDashboardAuth } from "../../routes/dashboard-auth.js";
import { mountDashboardApi } from "../../routes/dashboard-api.js";
import { mintDashboardToken, DASHBOARD_COOKIE } from "../../dashboard-session.js";
import { PostgresUserStatusSource, UserStatusService } from "../../user-status.js";
import { PgWorkspaceConfigStore } from "../../config/WorkspaceConfigStore.js";
import { emailIdentifier } from "../../dashboard-password.js";
import { toErrorBody } from "../../errors.js";
import type { ServerDeps } from "../../deps.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const secret = "integration-dashboard-secret-more-than-32-bytes";
const password = "instance plane password";
const GLOBAL = "00000000-0000-0000-0000-000000000000";
const migrationsDir = resolve(root, "packages/adapter-postgres/migrations/baseline");
const emails = {
  superadmin: "instance-super@example.test",
  regular: "instance-regular@example.test",
  target: "instance-target@example.test",
};

let container: StartedTestContainer;
let admin: postgres.Sql;
let client: postgres.Sql;
let auditClient: ReturnType<typeof createDrizzleClient>;
let app: Hono;
let superId: string, regularId: string, targetId: string;
let superWorkspace: string, regularWorkspace: string, targetWorkspace: string;
let userStatus: UserStatusService;
let passwordHash: string;
let storage: DrizzleStorageAdapter;

const cookieOf = (res: Response, name = DASHBOARD_COOKIE) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))
    ?.split(";")[0];
/**
 * Sign in; a user with several workspaces picks `pick`, by default their own
 * personal one.
 */
let loginCount = 0;
const login = async (email: string, pw = password, pick?: string) => {
  // A client address per sign-in: the limiter's per-IP bucket (30) spans the file.
  const ip = `198.51.100.${++loginCount}`;
  const res = await app.request("/dashboard/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password: pw }),
  });
  if (res.status !== 200 || !(await res.clone().json()).requiresWorkspace)
    return { res, cookie: cookieOf(res) };
  const workspaceId = pick ?? (email === emails.target ? targetWorkspace : regularWorkspace);
  const picked = await app.request("/dashboard/auth/workspace", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      cookie: cookieOf(res, "mnemo_dash_choice")!,
    },
    body: JSON.stringify({ workspaceId }),
  });
  return { res: picked, cookie: cookieOf(picked) };
};
const call = (method: string, path: string, cookie: string | undefined, body?: unknown) =>
  app.request(`/dashboard/api${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const signIn = async (email: string, pick?: string) => {
  const { res, cookie } = await login(email, password, pick);
  expect(res.status).toBe(200);
  return cookie!;
};
const adminRow = async (userId: string) =>
  admin`SELECT user_id FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${userId}`;
/** A user with a personal tenant and workspace, as registration makes one. */
const provisionUser = async (email: string, name: string) => {
  const [row] =
    await admin`SELECT * FROM mnemosyne.mnemo_provision_user(${email}, ${name}, ${`${name} workspace`})`;
  return {
    id: row!.user_id as string,
    workspace: row!.workspace_id as string,
    tenant: row!.tenant_id as string,
  };
};

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: "mnemo", POSTGRES_PASSWORD: "mnemo", POSTGRES_DB: "mnemo" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const address = `${container.getHost()}:${container.getMappedPort(5432)}/mnemo`;
  const url = `postgres://mnemo:mnemo@${address}`;
  admin = postgres(url, { onnotice: () => {} });
  await admin`CREATE EXTENSION IF NOT EXISTS vector`;
  await run(
    process.execPath,
    [
      resolve(root, "packages/core/dist/migrate.js"),
      "--migrations-dir",
      resolve(root, "packages/core/migrations"),
      "--database-url",
      url,
    ],
    { timeout: 120_000 }
  );
  await run(process.execPath, [resolve(root, "packages/adapter-postgres/dist/migrate.js")], {
    env: { ...process.env, DATABASE_URL: url },
    timeout: 120_000,
  });
  await admin.unsafe(
    "CREATE ROLE instance_test LOGIN PASSWORD 'instance-test-only' NOSUPERUSER NOBYPASSRLS; GRANT app_user, mnemo_app_role TO instance_test; GRANT USAGE ON SCHEMA mnemosyne TO instance_test;"
  );
  client = postgres(`postgres://instance_test:instance-test-only@${address}`, {
    max: 10,
    onnotice: () => {},
  });
  drizzle(client); // Match createDrizzlePool: Drizzle installs string timestamp codecs.

  const provision = async (email: string, name: string) => {
    const user = await provisionUser(email, name);
    return { id: user.id, workspace: user.workspace };
  };
  const s = await provision(emails.superadmin, "Super");
  const r = await provision(emails.regular, "Regular");
  const t = await provision(emails.target, "Target");
  [superId, regularId, targetId] = [s.id, r.id, t.id];
  [superWorkspace, regularWorkspace, targetWorkspace] = [s.workspace, r.workspace, t.workspace];
  const hash = (passwordHash = await bcrypt.hash(password, 12));
  await admin`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${superId}, ${hash}), (${regularId}, ${hash}), (${targetId}, ${hash})`;
  await admin`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${superId}, 'system:test')`;
  // The target also reads the regular user's workspace, in another tenant.
  await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${regularWorkspace}, ${targetId}, 'read')`;

  vi.stubEnv("MNEMO_DASHBOARD_SECRET", secret);
  // Installation settings are stored encrypted (instance-settings.ts).
  vi.stubEnv("MNEMO_MASTER_KEY", "c".repeat(64));
  auditClient = createDrizzleClient(url);
  storage = new DrizzleStorageAdapter(auditClient.db, auditClient.pgClient);
  const deps = {
    dashboardPasswordAuth: new DashboardPasswordAuth(new PostgresCredentialStore(client)),
    metricsPgClient: client,
    userStatus: (userStatus = new UserStatusService(new PostgresUserStatusSource(client))),
    storage,
    workspaceConfigStore: new PgWorkspaceConfigStore(client),
  } as unknown as ServerDeps;
  app = new Hono();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as 400);
  });
  mountDashboardAuth(app, deps);
  mountDashboardApi(app, deps);
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await auditClient?.pgClient.end();
  await client?.end();
  await admin?.end();
  await container?.stop();
});

describe("instance plane: superadmin user management", () => {
  it("answers 404 to every /instance/* route for a non-superadmin, as for an unknown route", async () => {
    const regular = await signIn(emails.regular);
    const unknown = await call("GET", "/no-such-route", regular);
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", "/instance/users"],
      ["POST", `/instance/users/${targetId}/disable`],
      ["POST", `/instance/users/${targetId}/enable`],
      ["POST", `/instance/users/${regularId}/superadmin`, { password }],
      ["DELETE", `/instance/users/${superId}/superadmin`, { password }],
      ["GET", "/instance/anything-else"],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(method, path, regular, body);
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
      expect(await res.text()).toBe(unknownBody);
    }
    expect(await adminRow(regularId)).toHaveLength(0);
    const [target] =
      await admin`SELECT disabled_at FROM mnemosyne.mnemo_user WHERE id = ${targetId}`;
    expect(target!.disabled_at).toBeNull();
  });

  it("answers 404 to a superadmin whose session is not a password session", async () => {
    const { token } = await mintDashboardToken(secret, {
      workspaceId: superWorkspace,
      keyPrefix: "mns_live_",
      scopes: ["memory:read", "memory:admin", "admin:workspace"],
      plan: "free",
      actorId: "some-key-id",
      userId: superId,
    });
    const res = await call("GET", "/instance/users", `${DASHBOARD_COOKIE}=${token}`);
    expect(res.status).toBe(404);
  });

  it("lists every user with email, superadmin flag and workspace roles across tenants", async () => {
    const res = await call("GET", "/instance/users", await signIn(emails.superadmin));
    expect(res.status).toBe(200);
    const { users } = (await res.json()) as {
      users: Array<{
        id: string;
        email: string;
        displayName: string | null;
        createdAt: string;
        lastLoginAt: string | null;
        disabledAt: string | null;
        isSuperadmin: boolean;
        workspaces: Array<{ id: string; name: string; role: string }>;
      }>;
    };
    const byId = new Map(users.map((u) => [u.id, u]));
    expect(byId.get(superId)).toMatchObject({ email: emails.superadmin, isSuperadmin: true });
    expect(byId.get(regularId)).toMatchObject({
      email: emails.regular,
      displayName: "Regular",
      isSuperadmin: false,
      disabledAt: null,
      workspaces: [{ id: regularWorkspace, name: "Regular workspace", role: "owner" }],
    });
    const target = byId.get(targetId)!;
    expect(target.email).toBe(emails.target);
    expect(new Date(target.createdAt).toString()).not.toBe("Invalid Date");
    expect(target.workspaces).toEqual(
      expect.arrayContaining([
        { id: regularWorkspace, name: "Regular workspace", role: "read" },
        { id: targetWorkspace, name: "Target workspace", role: "owner" },
      ])
    );
    expect(target.workspaces).toHaveLength(2);
  });

  it("disable ends the target's open session at once; enable lets them sign in again", async () => {
    const superCookie = await signIn(emails.superadmin);
    const target = await signIn(emails.target);
    // Alive (and its status cached) before the disable: a live non-superadmin gets 404.
    expect((await call("GET", "/instance/users", target)).status).toBe(404);
    const disabled = await call("POST", `/instance/users/${targetId}/disable`, superCookie);
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ ok: true });
    expect((await call("GET", "/instance/users", target)).status).toBe(401);
    expect((await login(emails.target)).res.status).toBe(401);
    const [row] =
      await admin`SELECT disabled_at, sessions_valid_after > 'epoch' AS bumped FROM mnemosyne.mnemo_user WHERE id = ${targetId}`;
    expect(row!.disabled_at).not.toBeNull();
    expect(row!.bumped).toBe(true);

    const enabled = await call("POST", `/instance/users/${targetId}/enable`, superCookie);
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({ ok: true });
    // The old session stays dead; a new sign-in works.
    expect((await call("GET", "/instance/users", target)).status).toBe(401);
    expect((await login(emails.target)).res.status).toBe(200);
  });

  it("refuses to disable yourself (409 self)", async () => {
    const res = await call(
      "POST",
      `/instance/users/${superId}/disable`,
      await signIn(emails.superadmin)
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("self");
    const [row] = await admin`SELECT disabled_at FROM mnemosyne.mnemo_user WHERE id = ${superId}`;
    expect(row!.disabled_at).toBeNull();
  });

  it("answers 404 for an unknown user", async () => {
    const res = await call(
      "POST",
      "/instance/users/no-such-user/disable",
      await signIn(emails.superadmin)
    );
    expect(res.status).toBe(404);
  });

  it("grant with a wrong password is 401, writes no row and counts a failure", async () => {
    const superCookie = await signIn(emails.superadmin);
    const res = await call("POST", `/instance/users/${regularId}/superadmin`, superCookie, {
      password: "not the right password",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_credentials");
    expect(await adminRow(regularId)).toHaveLength(0);
    const [cred] =
      await admin`SELECT failed_attempts FROM mnemosyne.mnemo_user_credential WHERE user_id = ${superId}`;
    expect(cred!.failed_attempts).toBe(1);
    const missing = await call("POST", `/instance/users/${regularId}/superadmin`, superCookie, {});
    expect(missing.status).toBe(400);
  });

  it("grant and revoke with the password apply on the target's next request", async () => {
    const superCookie = await signIn(emails.superadmin);
    const regular = await signIn(emails.regular);
    expect((await call("GET", "/instance/users", regular)).status).toBe(404);

    const granted = await call("POST", `/instance/users/${regularId}/superadmin`, superCookie, {
      password,
    });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({ ok: true });
    expect(await adminRow(regularId)).toHaveLength(1);
    const [cred] =
      await admin`SELECT failed_attempts FROM mnemosyne.mnemo_user_credential WHERE user_id = ${superId}`;
    expect(cred!.failed_attempts).toBe(0);
    expect((await call("GET", "/instance/users", regular)).status).toBe(200);

    const revoked = await call("DELETE", `/instance/users/${regularId}/superadmin`, superCookie, {
      password,
    });
    expect(revoked.status).toBe(200);
    expect(await adminRow(regularId)).toHaveLength(0);
    // Revocation ends the revoked user's sessions.
    expect((await call("GET", "/instance/users", regular)).status).toBe(401);
    expect((await call("GET", "/instance/users", await signIn(emails.regular))).status).toBe(404);
  });

  it("refuses to grant superadmin to a disabled user (409 user_disabled)", async () => {
    const superCookie = await signIn(emails.superadmin);
    expect((await call("POST", `/instance/users/${targetId}/disable`, superCookie)).status).toBe(
      200
    );
    const res = await call("POST", `/instance/users/${targetId}/superadmin`, superCookie, {
      password,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("user_disabled");
    expect(await adminRow(targetId)).toHaveLength(0);
    expect((await call("POST", `/instance/users/${targetId}/enable`, superCookie)).status).toBe(
      200
    );
  });

  it("refuses to revoke the last active superadmin (409 last_superadmin)", async () => {
    const res = await call(
      "DELETE",
      `/instance/users/${superId}/superadmin`,
      await signIn(emails.superadmin),
      { password }
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("last_superadmin");
    expect(await adminRow(superId)).toHaveLength(1);
  });

  it("writes one audit row per mutation, under the global workspace, as the acting user", async () => {
    const rows = await admin`
      SELECT action, actor_id, actor_type, resource, resource_id,
             workspace_id::text AS workspace_id, metadata::text AS metadata
      FROM mnemosyne.mnemo_audit_log
      WHERE action IN ('user_disabled', 'user_enabled', 'superadmin_granted', 'superadmin_revoked')
      ORDER BY created_at, action`;
    expect(rows.map((r) => [r.action, r.resource_id])).toEqual([
      ["user_disabled", targetId],
      ["user_enabled", targetId],
      ["superadmin_granted", regularId],
      ["superadmin_revoked", regularId],
      ["user_disabled", targetId],
      ["user_enabled", targetId],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        actor_id: `user:${superId}`,
        actor_type: "user",
        resource: "user",
        workspace_id: GLOBAL,
      });
      expect(JSON.stringify(row)).not.toContain(password);
      expect(JSON.stringify(row)).not.toContain("@example.test");
    }
  });
});

describe("instance plane: workspaces, opening any workspace, offboarding", () => {
  const more = {
    super2: "instance-super2@example.test",
    leaver: "instance-leaver@example.test",
    heir: "instance-heir@example.test",
  };
  let super2: Awaited<ReturnType<typeof provisionUser>>;
  let leaver: Awaited<ReturnType<typeof provisionUser>>;
  let heir: Awaited<ReturnType<typeof provisionUser>>;
  /** An organization tenant's team workspace, owned by the leaver alone. */
  let teamTenant: string, teamWorkspace: string;
  /** A team workspace in a tenant of kind `personal` that is nobody's personal tenant. */
  let legacyTenant: string, legacyWorkspace: string;
  /** One sign-in for the whole block: the login limiter allows 10 per email. */
  let superCookie: string;
  const factId = "6a0c1e9e-3a51-4c43-9b8e-0d6f2f1f0a01";
  const readFact = (cookie: string) => call("GET", `/facts/${factId}`, cookie);
  // PATCH /facts/{id} is a real bridge route that needs memory:write.
  const writeFact = (cookie: string) => call("PATCH", `/facts/${factId}`, cookie, {});
  const open = async (cookie: string, workspaceId: string) => {
    const res = await call("POST", `/instance/workspaces/${workspaceId}/open`, cookie);
    return { res, cookie: cookieOf(res) };
  };
  const sessionOf = async (cookie: string) =>
    (await app.request("/dashboard/auth/session", { headers: { cookie } })).json() as Promise<{
      workspaceId: string;
      role: string;
      scopes: string[];
    }>;
  const memberships = async (userId: string) =>
    (
      await admin`SELECT workspace_id, role FROM mnemosyne.mnemo_workspace_member WHERE user_id = ${userId} ORDER BY workspace_id`
    ).map((r) => ({ workspaceId: r.workspace_id as string, role: r.role as string }));

  beforeAll(async () => {
    super2 = await provisionUser(more.super2, "Super Two");
    leaver = await provisionUser(more.leaver, "Leaver");
    heir = await provisionUser(more.heir, "Heir");
    await admin`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${super2.id}, ${passwordHash}), (${leaver.id}, ${passwordHash}), (${heir.id}, ${passwordHash})`;
    await admin`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${super2.id}, 'system:test')`;
    [{ id: teamTenant }] =
      (await admin`INSERT INTO mnemosyne.mnemo_tenant (name, kind) VALUES ('Acme', 'organization') RETURNING id`) as unknown as [
        { id: string },
      ];
    [{ id: teamWorkspace }] =
      (await admin`INSERT INTO mnemosyne.mnemo_workspace (name, tenant_id, owner_user_id) VALUES ('Acme team', ${teamTenant}, ${leaver.id}) RETURNING id`) as unknown as [
        { id: string },
      ];
    [{ id: legacyTenant }] =
      (await admin`INSERT INTO mnemosyne.mnemo_tenant (name, kind) VALUES ('Legacy', 'personal') RETURNING id`) as unknown as [
        { id: string },
      ];
    [{ id: legacyWorkspace }] =
      (await admin`INSERT INTO mnemosyne.mnemo_workspace (name, tenant_id, owner_user_id) VALUES ('first-test', ${legacyTenant}, ${heir.id}) RETURNING id`) as unknown as [
        { id: string },
      ];
    await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES
      (${teamWorkspace}, ${leaver.id}, 'owner'), (${teamWorkspace}, ${heir.id}, 'write'),
      (${legacyWorkspace}, ${heir.id}, 'owner'), (${legacyWorkspace}, ${leaver.id}, 'read')`;
    await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES
      (${teamTenant}, ${leaver.id}, 'owner'), (${teamTenant}, ${heir.id}, 'member'),
      (${legacyTenant}, ${heir.id}, 'owner'), (${legacyTenant}, ${leaver.id}, 'member')`;
    const validFrom = new Date(Date.now() - 60_000); // determinism-ok: seed timestamp, not an assertion value
    await admin`
      INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, kind, subject, statement, status, valid_from)
      VALUES (${factId}, ${teamWorkspace}, 'global', 'other', 'acme', 'Acme ships on Fridays', 'active', ${validFrom})`;
    superCookie = await signIn(emails.superadmin);
  });

  // Later tests count the active superadmins: leave only the first one.
  afterAll(async () => {
    await admin`DELETE FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${super2.id}`;
    userStatus.invalidate(super2.id);
  });

  it("answers 404 to every new /instance/* route for a non-superadmin", async () => {
    const regular = await signIn(emails.regular);
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", "/instance/workspaces"],
      ["GET", `/instance/workspaces/${teamWorkspace}/members`],
      [
        "POST",
        `/instance/workspaces/${teamWorkspace}/members`,
        { email: more.heir, role: "owner" },
      ],
      ["PATCH", `/instance/workspaces/${teamWorkspace}/members/${heir.id}`, { role: "read" }],
      ["DELETE", `/instance/workspaces/${teamWorkspace}/members/${heir.id}`],
      ["POST", `/instance/workspaces/${teamWorkspace}/open`],
      ["POST", `/instance/users/${leaver.id}/offboard`, {}],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(method, path, regular, body);
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
    }
    expect(await memberships(heir.id)).toContainEqual({
      workspaceId: teamWorkspace,
      role: "write",
    });
    const [row] = await admin`SELECT disabled_at FROM mnemosyne.mnemo_user WHERE id = ${leaver.id}`;
    expect(row!.disabled_at).toBeNull();
  });

  it("gives each workspace its live memories under the caller's ceiling and its last write", async () => {
    // legacyWorkspace: one readable live fact, then a later restricted one and a later closed
    // one. superWorkspace: only a restricted fact and a closed one.
    const [readable] = await admin<Array<{ created_at: Date }>>`
      INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, kind, subject, statement, status, sensitivity, valid_to, created_at)
      VALUES ('ip_f1', ${legacyWorkspace}, 'global', 'other', 's', 'one', 'active', 'internal', NULL, now() - interval '2 days')
      RETURNING created_at
    `;
    await admin`
      INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, kind, subject, statement, status, sensitivity, valid_to)
      VALUES ('ip_f2', ${legacyWorkspace}, 'global', 'other', 's', 'two', 'active', 'restricted', NULL),
             ('ip_f3', ${legacyWorkspace}, 'global', 'other', 's', 'three', 'active', 'internal', now()),
             ('ip_f4', ${superWorkspace}, 'global', 'other', 's', 'four', 'active', 'restricted', NULL),
             ('ip_f5', ${superWorkspace}, 'global', 'other', 's', 'five', 'active', 'internal', now())
    `;
    const { workspaces } = (await (
      await call("GET", "/instance/workspaces", superCookie)
    ).json()) as {
      workspaces: Array<{ id: string; factsLive: number | null; lastWriteAt: string | null }>;
    };
    // The last write is the readable live fact's: a later restricted or closed one never
    // shows through its timestamp.
    expect(workspaces.find((w) => w.id === legacyWorkspace)).toMatchObject({
      factsLive: 1,
      lastWriteAt: readable!.created_at.toISOString(),
    });
    expect(workspaces.find((w) => w.id === superWorkspace)).toMatchObject({
      factsLive: 0,
      lastWriteAt: null,
    });
    await admin`DELETE FROM mnemosyne.mnemo_fact WHERE id IN ('ip_f1', 'ip_f2', 'ip_f3', 'ip_f4', 'ip_f5')`;
  });

  it("lists every workspace, personal ones flagged by personal_tenant_id, never by tenant kind", async () => {
    const res = await call("GET", "/instance/workspaces", superCookie);
    expect(res.status).toBe(200);
    const { workspaces } = (await res.json()) as {
      workspaces: Array<{
        id: string;
        name: string;
        tenantId: string;
        tenantName: string;
        isPersonal: boolean;
        visibility: string;
        memberCount: number;
        owners: Array<{ id: string; email: string; displayName: string | null }>;
      }>;
    };
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    expect(byId.get(superWorkspace)).toMatchObject({
      name: "Super workspace",
      isPersonal: true,
      memberCount: 1,
      owners: [{ id: superId, email: emails.superadmin, displayName: "Super" }],
    });
    expect(byId.get(regularWorkspace)).toMatchObject({ isPersonal: true, memberCount: 2 });
    expect(byId.get(teamWorkspace)).toEqual({
      id: teamWorkspace,
      name: "Acme team",
      tenantId: teamTenant,
      tenantName: "Acme",
      isPersonal: false,
      visibility: "private",
      memberCount: 2,
      owners: [{ id: leaver.id, email: more.leaver, displayName: "Leaver" }],
      // The fixture's one live fact in the team workspace.
      factsLive: 1,
      lastWriteAt: expect.any(String),
    });
    // Tenant kind `personal`, but nobody's personal tenant: a team workspace.
    expect(byId.get(legacyWorkspace)).toMatchObject({
      name: "first-test",
      tenantName: "Legacy",
      isPersonal: false,
      memberCount: 2,
      owners: [{ id: heir.id, email: more.heir, displayName: "Heir" }],
    });
  });

  it("lists the members of any workspace with email, name, role and joined date", async () => {
    const res = await call("GET", `/instance/workspaces/${teamWorkspace}/members`, superCookie);
    expect(res.status).toBe(200);
    const { members } = (await res.json()) as {
      members: Array<{
        userId: string;
        email: string;
        displayName: string | null;
        role: string;
        joinedAt: string;
      }>;
    };
    expect(members.map(({ joinedAt: _j, ...m }) => m)).toEqual([
      { userId: heir.id, email: more.heir, displayName: "Heir", role: "write" },
      { userId: leaver.id, email: more.leaver, displayName: "Leaver", role: "owner" },
    ]);
    expect(new Date(members[0]!.joinedAt).toString()).not.toBe("Invalid Date");
    const unknown = await call(
      "GET",
      "/instance/workspaces/no-such-workspace/members",
      superCookie
    );
    expect(unknown.status).toBe(404);
  });

  it("opening a workspace continues the session: sign-out ends the tokens before and after", async () => {
    // Its own superadmin sign-in: superCookie serves the rest of this block.
    const before = await signIn(more.super2);
    const { res, cookie: after } = await open(before, teamWorkspace);
    expect(res.status).toBe(200);
    expect(after).not.toBe(before);

    await app.request("/dashboard/auth/logout", { method: "POST", headers: { cookie: after! } });

    for (const cookie of [before, after!]) {
      const session = await app.request("/dashboard/auth/session", { headers: { cookie } });
      expect(session.status).toBe(401);
    }
  });

  it("opens a foreign workspace read-only: facts read (200), a write is 403, audited", async () => {
    // Not a member: the plain session cannot reach the team's facts.
    expect((await readFact(superCookie)).status).toBe(404);
    const { res, cookie } = await open(superCookie, teamWorkspace);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cookie).toBeDefined();
    const session = await sessionOf(cookie!);
    expect(session).toMatchObject({ workspaceId: teamWorkspace, role: "viewer" });
    expect(session.scopes).not.toContain("memory:write");
    const read = await readFact(cookie!);
    expect(read.status).toBe(200);
    expect((await read.json()).content).toBe("Acme ships on Fridays");
    expect((await writeFact(cookie!)).status).toBe(403);

    const rows = await admin`
      SELECT actor_id, resource, resource_id, workspace_id::text AS workspace_id
      FROM mnemosyne.mnemo_audit_log WHERE action = 'workspace_opened'`;
    expect(rows).toContainEqual({
      actor_id: `user:${superId}`,
      resource: "workspace",
      resource_id: teamWorkspace,
      workspace_id: teamWorkspace,
    });
  });

  it("opens a workspace the superadmin belongs to with their real role", async () => {
    const { res, cookie } = await open(superCookie, superWorkspace);
    expect(res.status).toBe(200);
    expect(await sessionOf(cookie!)).toMatchObject({ workspaceId: superWorkspace, role: "admin" });
    // A write passes the scope guard.
    expect([401, 403]).not.toContain((await writeFact(cookie!)).status);
  });

  it("answers 404 when opening an unknown workspace", async () => {
    const { res, cookie } = await open(superCookie, "no-such-workspace");
    expect(res.status).toBe(404);
    expect(cookie).toBeUndefined();
  });

  it("a superadmin who loses the role loses the opened workspace on the next request", async () => {
    // Without a session bump: only the live superadmin check stands in the way.
    let opened = (await open(await signIn(more.super2), teamWorkspace)).cookie!;
    expect((await readFact(opened)).status).toBe(200);
    await admin`DELETE FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${super2.id}`;
    userStatus.invalidate(super2.id);
    expect((await readFact(opened)).status).toBe(401);
    await admin`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${super2.id}, 'system:test')`;
    userStatus.invalidate(super2.id);

    // Through the route (Review Focus 5).
    opened = (await open(await signIn(more.super2), teamWorkspace)).cookie!;
    expect((await readFact(opened)).status).toBe(200);
    const revoked = await call("DELETE", `/instance/users/${super2.id}/superadmin`, superCookie, {
      password,
    });
    expect(revoked.status).toBe(200);
    expect((await readFact(opened)).status).toBe(401);
    // Signed in again, no longer a superadmin: the team workspace cannot be opened.
    const again = await signIn(more.super2);
    expect((await open(again, teamWorkspace)).res.status).toBe(404);
    await admin`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${super2.id}, 'system:test')`;
    userStatus.invalidate(super2.id);
  });

  it("changes a member's role in any workspace, refusing to demote the last owner", async () => {
    const heirInTeam = await signIn(more.heir, teamWorkspace);
    expect([401, 403]).not.toContain((await writeFact(heirInTeam)).status);
    const path = `/instance/workspaces/${teamWorkspace}/members`;
    const demoted = await call("PATCH", `${path}/${heir.id}`, superCookie, { role: "read" });
    expect(demoted.status).toBe(200);
    expect(await demoted.json()).toEqual({ ok: true });
    expect(await memberships(heir.id)).toContainEqual({ workspaceId: teamWorkspace, role: "read" });
    // Applies to the member's open session on the next request.
    expect((await writeFact(heirInTeam)).status).toBe(403);

    const lastOwner = await call("PATCH", `${path}/${leaver.id}`, superCookie, { role: "admin" });
    expect(lastOwner.status).toBe(409);
    expect(await lastOwner.json()).toEqual({ error: "last_owner" });
    expect(await memberships(leaver.id)).toContainEqual({
      workspaceId: teamWorkspace,
      role: "owner",
    });

    expect((await call("PATCH", `${path}/${heir.id}`, superCookie, { role: "boss" })).status).toBe(
      400
    );
    expect((await call("PATCH", `${path}/${heir.id}`, superCookie, {})).status).toBe(400);
    expect((await call("PATCH", `${path}/${superId}`, superCookie, { role: "read" })).status).toBe(
      404
    );
    expect(
      (
        await call("PATCH", `/instance/workspaces/no-such/members/${heir.id}`, superCookie, {
          role: "read",
        })
      ).status
    ).toBe(404);
    expect((await call("PATCH", `${path}/${heir.id}`, superCookie, { role: "write" })).status).toBe(
      200
    );
  });

  it("removes a member from any workspace, refusing to remove the last owner", async () => {
    await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${legacyWorkspace}, ${regularId}, 'read')`;
    const path = `/instance/workspaces/${legacyWorkspace}/members`;
    const removed = await call("DELETE", `${path}/${regularId}`, superCookie);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await memberships(regularId)).map((m) => m.workspaceId)).not.toContain(legacyWorkspace);
    const lastOwner = await call("DELETE", `${path}/${heir.id}`, superCookie);
    expect(lastOwner.status).toBe(409);
    expect(await lastOwner.json()).toEqual({ error: "last_owner" });
    expect((await call("DELETE", `${path}/${regularId}`, superCookie)).status).toBe(404);
  });

  it("refuses to offboard the last owner of a shared workspace and lists it (409 owner_required)", async () => {
    const before = await memberships(leaver.id);
    const res = await call("POST", `/instance/users/${leaver.id}/offboard`, superCookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "owner_required",
      workspaces: [{ id: teamWorkspace, name: "Acme team" }],
    });
    // Nothing happened.
    expect(await memberships(leaver.id)).toEqual(before);
    const [row] = await admin`SELECT disabled_at FROM mnemosyne.mnemo_user WHERE id = ${leaver.id}`;
    expect(row!.disabled_at).toBeNull();
    // A new owner that cannot own: unknown, or the leaver themselves.
    for (const owner of ["no-such-user", leaver.id]) {
      const bad = await call("POST", `/instance/users/${leaver.id}/offboard`, superCookie, {
        newOwners: { [teamWorkspace]: owner },
      });
      expect(bad.status).toBe(409);
      expect(await bad.json()).toEqual({ error: "invalid_new_owner" });
    }
    const malformed = await call("POST", `/instance/users/${leaver.id}/offboard`, superCookie, {
      newOwners: [heir.id],
    });
    expect(malformed.status).toBe(400);
    expect(await memberships(leaver.id)).toEqual(before);
  });

  it("offboards: memberships outside the personal tenant gone, tokens revoked, disabled, personal workspace kept", async () => {
    await admin`INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, user_id, key_kind) VALUES
      ('leaver-key-personal', ${leaver.workspace}, 'h1', 'personal', ${leaver.id}, 'user'),
      ('leaver-key-team', ${teamWorkspace}, 'h2', 'team', ${leaver.id}, 'workspace'),
      ('heir-key-team', ${teamWorkspace}, 'h3', 'heir', ${heir.id}, 'workspace')`;
    const leaverSession = await signIn(more.leaver, teamWorkspace);
    expect((await readFact(leaverSession)).status).toBe(200);

    const res = await call("POST", `/instance/users/${leaver.id}/offboard`, superCookie, {
      newOwners: { [teamWorkspace]: heir.id },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await memberships(leaver.id)).toEqual([
      { workspaceId: leaver.workspace, role: "owner" },
    ]);
    expect(
      (
        await admin`SELECT tenant_id FROM mnemosyne.mnemo_tenant_member WHERE user_id = ${leaver.id}`
      ).map((r) => r.tenant_id)
    ).toEqual([leaver.tenant]);
    expect(await memberships(heir.id)).toContainEqual({
      workspaceId: teamWorkspace,
      role: "owner",
    });
    const keys = await admin`
      SELECT id, revoked_at IS NOT NULL AS revoked FROM mnemosyne.mnemo_api_keys
      WHERE id IN ('leaver-key-personal', 'leaver-key-team', 'heir-key-team') ORDER BY id`;
    expect(keys.map((k) => [k.id, k.revoked])).toEqual([
      ["heir-key-team", false],
      ["leaver-key-personal", true],
      ["leaver-key-team", true],
    ]);
    const [user] = await admin`
      SELECT disabled_at, sessions_valid_after > 'epoch' AS bumped
      FROM mnemosyne.mnemo_user WHERE id = ${leaver.id}`;
    expect(user!.disabled_at).not.toBeNull();
    expect(user!.bumped).toBe(true);
    const [personal] =
      await admin`SELECT id FROM mnemosyne.mnemo_workspace WHERE id = ${leaver.workspace}`;
    expect(personal).toBeDefined();
    // The open session ends on the next request; sign-in is refused.
    expect((await readFact(leaverSession)).status).toBe(401);
    expect((await login(more.leaver)).res.status).toBe(401);

    const [audit] = await admin`
      SELECT actor_id, resource, resource_id, workspace_id::text AS workspace_id
      FROM mnemosyne.mnemo_audit_log WHERE action = 'user_offboarded'`;
    expect(audit).toEqual({
      actor_id: `user:${superId}`,
      resource: "user",
      resource_id: leaver.id,
      workspace_id: GLOBAL,
    });
  });

  it("refuses to offboard yourself (409 self) and answers 404 for an unknown user", async () => {
    const self = await call("POST", `/instance/users/${superId}/offboard`, superCookie, {});
    expect(self.status).toBe(409);
    expect((await self.json()).error).toBe("self");
    const unknown = await call("POST", "/instance/users/no-such-user/offboard", superCookie, {});
    expect(unknown.status).toBe(404);
  });

  /** An organization tenant with one workspace; no members yet. */
  const teamOf = async (name: string) => {
    const [tenant] =
      await admin`INSERT INTO mnemosyne.mnemo_tenant (name, kind) VALUES (${name}, 'organization') RETURNING id`;
    const [workspace] =
      await admin`INSERT INTO mnemosyne.mnemo_workspace (name, tenant_id) VALUES (${`${name} team`}, ${tenant!.id}) RETURNING id`;
    return { tenant: tenant!.id as string, workspace: workspace!.id as string };
  };

  it("offboarding a superadmin removes the grant for good, audited as superadmin_revoked", async () => {
    const ex = await provisionUser("instance-exsuper@example.test", "Ex Super");
    await admin`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${ex.id}, 'system:test')`;
    const res = await call("POST", `/instance/users/${ex.id}/offboard`, superCookie);
    expect(res.status).toBe(200);
    expect(await adminRow(ex.id)).toHaveLength(0);
    // Re-enabled later, they are an ordinary user.
    expect((await call("POST", `/instance/users/${ex.id}/enable`, superCookie)).status).toBe(200);
    const [status] = await admin`SELECT * FROM mnemosyne.mnemo_user_status(${ex.id})`;
    expect(status).toMatchObject({ disabled_at: null, is_superadmin: false });
    const rows = await admin`
      SELECT resource_id, actor_id, workspace_id::text AS workspace_id
      FROM mnemosyne.mnemo_audit_log
      WHERE action = 'superadmin_revoked' AND resource_id IN (${ex.id}, ${leaver.id})`;
    // The leaver held no grant: only the ex-superadmin's revocation is recorded.
    expect(rows).toEqual([
      { resource_id: ex.id, actor_id: `user:${superId}`, workspace_id: GLOBAL },
    ]);
  });

  it("last-owner rules count only enabled owners", async () => {
    const active = await provisionUser("instance-active-owner@example.test", "Active Owner");
    const dormant = await provisionUser("instance-dormant-owner@example.test", "Dormant Owner");
    const dormantTeam = await teamOf("Dormant");
    await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES
      (${dormantTeam.workspace}, ${active.id}, 'owner'), (${dormantTeam.workspace}, ${dormant.id}, 'owner')`;
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${dormant.id}`;
    const before = await memberships(active.id);
    const path = `/instance/workspaces/${dormantTeam.workspace}/members/${active.id}`;

    const demote = await call("PATCH", path, superCookie, { role: "admin" });
    expect(demote.status).toBe(409);
    expect(await demote.json()).toEqual({ error: "last_owner" });
    const remove = await call("DELETE", path, superCookie);
    expect(remove.status).toBe(409);
    expect(await remove.json()).toEqual({ error: "last_owner" });
    const offboard = await call("POST", `/instance/users/${active.id}/offboard`, superCookie);
    expect(offboard.status).toBe(409);
    expect(await offboard.json()).toEqual({
      error: "owner_required",
      workspaces: [{ id: dormantTeam.workspace, name: "Dormant team" }],
    });
    expect(await memberships(active.id)).toEqual(before);
    const [row] = await admin`SELECT disabled_at FROM mnemosyne.mnemo_user WHERE id = ${active.id}`;
    expect(row!.disabled_at).toBeNull();
  });

  it("a new owner from outside the workspace's tenant joins the tenant as member", async () => {
    const leaver2 = await provisionUser("instance-leaver2@example.test", "Leaver Two");
    const beta = await teamOf("Beta");
    await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${beta.workspace}, ${leaver2.id}, 'owner')`;
    await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${beta.tenant}, ${leaver2.id}, 'owner')`;
    const res = await call("POST", `/instance/users/${leaver2.id}/offboard`, superCookie, {
      newOwners: { [beta.workspace]: heir.id },
    });
    expect(res.status).toBe(200);
    expect(await memberships(heir.id)).toContainEqual({
      workspaceId: beta.workspace,
      role: "owner",
    });
    const tenantRows = await admin`
      SELECT user_id, role FROM mnemosyne.mnemo_tenant_member WHERE tenant_id = ${beta.tenant}`;
    expect(tenantRows).toEqual([{ user_id: heir.id, role: "member" }]);
    // A new owner already in the tenant keeps their tenant role.
    const [heirInTeam] = await admin`
      SELECT role FROM mnemosyne.mnemo_tenant_member WHERE tenant_id = ${teamTenant} AND user_id = ${heir.id}`;
    expect(heirInTeam!.role).toBe("member");
  });

  it("adds an existing user to an ownerless workspace as owner, audited as member_added", async () => {
    const orphan = await teamOf("Orphan");
    const path = `/instance/workspaces/${orphan.workspace}/members`;
    // The email is matched the way sign-in matches it: trimmed, any case.
    const added = await call("POST", path, superCookie, {
      email: `  ${more.heir.toUpperCase()} `,
      role: "owner",
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toEqual({ ok: true, userId: heir.id });
    expect(await memberships(heir.id)).toContainEqual({
      workspaceId: orphan.workspace,
      role: "owner",
    });
    // Joins the workspace's tenant as member, as accepting an invitation does.
    expect(
      await admin`SELECT user_id, role FROM mnemosyne.mnemo_tenant_member WHERE tenant_id = ${orphan.tenant}`
    ).toEqual([{ user_id: heir.id, role: "member" }]);
    // The new owner manages it: their session there carries memory:admin.
    const heirThere = await signIn(more.heir, orphan.workspace);
    expect((await sessionOf(heirThere)).scopes).toContain("memory:admin");

    const [audit] = await admin`
      SELECT actor_id, resource_id, workspace_id::text AS workspace_id, metadata::text AS detail
      FROM mnemosyne.mnemo_audit_log WHERE action = 'member_added' AND resource_id = ${heir.id}`;
    expect(audit).toMatchObject({
      actor_id: `user:${superId}`,
      resource_id: heir.id,
      workspace_id: GLOBAL,
    });
    expect(audit!.detail).toContain(orphan.workspace);
    expect(audit!.detail).toContain("owner");
    expect(audit!.detail).not.toContain("@example.test");
  });

  it("refuses to add to a personal workspace, an unknown or disabled email, or a member twice", async () => {
    const orphan = await teamOf("Refusals");
    const add = (workspaceId: string, body: unknown) =>
      call("POST", `/instance/workspaces/${workspaceId}/members`, superCookie, body);
    const refusal = async (res: Response) => ({ status: res.status, body: await res.json() });

    expect(await refusal(await add(heir.workspace, { email: more.super2, role: "read" }))).toEqual({
      status: 409,
      body: { error: "personal_workspace" },
    });
    expect(
      await refusal(await add(orphan.workspace, { email: "nobody@example.test", role: "read" }))
    ).toEqual({ status: 409, body: { error: "unknown_email" } });

    const gone = await provisionUser("instance-gone@example.test", "Gone");
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${gone.id}`;
    expect(
      await refusal(
        await add(orphan.workspace, { email: "instance-gone@example.test", role: "read" })
      )
    ).toEqual({ status: 409, body: { error: "user_disabled" } });

    expect((await add(orphan.workspace, { email: more.super2, role: "write" })).status).toBe(201);
    expect(
      await refusal(await add(orphan.workspace, { email: more.super2, role: "owner" }))
    ).toEqual({ status: 409, body: { error: "already_member" } });
    // The second request changed nothing.
    expect(await memberships(super2.id)).toContainEqual({
      workspaceId: orphan.workspace,
      role: "write",
    });

    for (const body of [
      { email: more.heir },
      { email: more.heir, role: "boss" },
      { role: "read" },
      {},
    ])
      expect((await add(orphan.workspace, body)).status).toBe(400);
    expect((await add("no-such", { email: more.heir, role: "read" })).status).toBe(404);
    expect(
      (await add("00000000-0000-4000-8000-000000000000", { email: more.heir, role: "read" })).status
    ).toBe(404);
  });

  it("audits member changes under the global workspace, naming the workspace", async () => {
    const rows = await admin`
      SELECT action, actor_id, resource, resource_id, workspace_id::text AS workspace_id,
             metadata::text AS detail
      FROM mnemosyne.mnemo_audit_log
      WHERE action IN ('member_role_changed', 'member_removed')
      ORDER BY created_at, action`;
    expect(rows.map((r) => [r.action, r.resource_id])).toEqual([
      ["member_role_changed", heir.id],
      ["member_role_changed", heir.id],
      ["member_removed", regularId],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        actor_id: `user:${superId}`,
        resource: "user",
        workspace_id: GLOBAL,
      });
      expect(row.detail).toContain(
        row.action === "member_removed" ? legacyWorkspace : teamWorkspace
      );
      expect(JSON.stringify(row)).not.toContain("@example.test");
    }
  });
});

describe("instance plane: installation settings and security audit", () => {
  const ownerEmail = "settings-owner@example.test";
  let owner: { id: string; workspace: string };
  let ownerCookie: string;
  let superCookie: string;

  type SettingsView = {
    invitationsEnabled: boolean;
    publicBaseUrl: string | null;
    registrationMode: string;
    source: Record<string, string>;
  };
  type AuditEntry = {
    id: string;
    workspaceId: string;
    actorType: string;
    actorId: string;
    actorEmail: string | null;
    action: string;
    resourceKind: string;
    resourceId: string | null;
    detail: Record<string, unknown> | null;
    createdAt: string;
  };
  type AuditPage = { entries: AuditEntry[]; nextCursor: string | null };
  const audit = async (query = "") => {
    const res = await call("GET", `/instance/audit${query}`, superCookie);
    expect(res.status).toBe(200);
    return (await res.json()) as AuditPage;
  };
  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    const apply = (values: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    apply(vars);
    try {
      await fn();
    } finally {
      apply(saved);
    }
  };

  beforeAll(async () => {
    const user = await provisionUser(ownerEmail, "SettingsOwner");
    owner = { id: user.id, workspace: user.workspace };
    await admin`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${owner.id}, ${passwordHash})`;
    ownerCookie = await signIn(ownerEmail);
    superCookie = await signIn(emails.superadmin);
    // Sign-in audits are written after the response: let these land first.
    await vi.waitFor(async () => {
      const rows = await admin`
        SELECT 1 FROM mnemosyne.mnemo_audit_log
        WHERE action = 'login_success' AND actor_id = ${`user:${owner.id}`}`;
      expect(rows).toHaveLength(1);
    });
  });

  it("counts the security actions per UTC day and action, and failed sign-ins of 7 days", async () => {
    await admin`
      INSERT INTO mnemosyne.mnemo_audit_log
        (workspace_id, actor_type, actor_id, action, resource, metadata, merkle_hash, created_at)
      VALUES (${GLOBAL}, 'system', 'system:dashboard-login', 'login_failure', 'user', '{}'::jsonb,
              '\\x00'::bytea, now() - interval '1 day')
    `;
    const res = await call("GET", "/instance/audit/stats?days=7", superCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: Array<{ day: string; count: number }>;
      byAction: Array<{ action: string; count: number }>;
      failedSignIns7d: number;
    };
    expect(body.days).toHaveLength(7);
    const [{ n }] = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_audit_log
      WHERE action = 'login_failure' AND created_at >= (now() AT TIME ZONE 'UTC')::date - 6`;
    expect(body.failedSignIns7d).toBe(n);
    expect(body.failedSignIns7d).toBeGreaterThan(0);
    // Operational rows (recall, create...) never count.
    expect(body.byAction.some((a) => a.action === "recall" || a.action === "create")).toBe(false);
    expect(body.days.reduce((sum, d) => sum + d.count, 0)).toBe(
      body.byAction.reduce((sum, a) => sum + a.count, 0)
    );
    expect((await call("GET", "/instance/audit/stats?days=6", superCookie)).status).toBe(400);
  });

  it("answers 404 to the settings and audit routes for a non-superadmin", async () => {
    const unknownBody = await (await call("GET", "/no-such-route", ownerCookie)).text();
    for (const [method, path, body] of [
      ["GET", "/instance/settings"],
      ["PUT", "/instance/settings", { invitationsEnabled: false }],
      ["GET", "/instance/audit"],
      ["GET", "/instance/audit/stats"],
    ] as Array<[string, string, unknown?]>) {
      const res = await call(method, path, ownerCookie, body);
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
      expect(await res.text()).toBe(unknownBody);
    }
  });

  it("reports env values as source env; a saved value wins as source global and builds links", async () => {
    await withEnv(
      {
        MNEMO_PUBLIC_BASE_URL: "https://env.example.test/",
        MNEMO_INVITATIONS_ENABLED: undefined,
        MNEMO_WORKSPACE_LLM_OVERRIDE: undefined,
        MNEMO_WORKSPACE_LIMIT_PER_USER: undefined,
      },
      async () => {
        let res = await call("GET", "/instance/settings", superCookie);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          invitationsEnabled: true,
          publicBaseUrl: "https://env.example.test",
          registrationMode: "closed",
          workspaceLlmOverride: false,
          workspaceLimitPerUser: 5,
          source: {
            invitationsEnabled: "default",
            publicBaseUrl: "env",
            registrationMode: "default",
            workspaceLlmOverride: "default",
            workspaceLimitPerUser: "default",
          },
        });

        res = await call("PUT", "/instance/settings", superCookie, {
          publicBaseUrl: "https://saved.example.test/",
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          publicBaseUrl: "https://saved.example.test",
          source: { publicBaseUrl: "global", invitationsEnabled: "default" },
        });
        const view = (await (
          await call("GET", "/instance/settings", superCookie)
        ).json()) as SettingsView;
        expect(view).toMatchObject({
          publicBaseUrl: "https://saved.example.test",
          source: { publicBaseUrl: "global" },
        });

        // Stored encrypted under the global sentinel.
        const [row] = await admin`
          SELECT convert_from(value_enc, 'UTF8') AS value, updated_by
          FROM mnemosyne.mnemo_workspace_config
          WHERE workspace_id = ${GLOBAL}::uuid AND key = 'instance_public_base_url'`;
        expect(row!.value).not.toContain("saved.example.test");
        expect(row!.updated_by).toBe(`user:${superId}`);

        // Links are built on the saved URL, not env or the request origin.
        const created = await call("POST", "/instance/users", superCookie, {
          email: "settings-link@example.test",
        });
        expect(created.status).toBe(201);
        expect(((await created.json()) as { link: string }).link).toMatch(
          /^https:\/\/saved\.example\.test\/dashboard\/link\/[A-Za-z0-9_-]{43}$/
        );

        // Clearing it brings env back.
        res = await call("PUT", "/instance/settings", superCookie, { publicBaseUrl: null });
        expect(await res.json()).toMatchObject({
          publicBaseUrl: "https://env.example.test",
          source: { publicBaseUrl: "env" },
        });
      }
    );
    const rows = await admin`
      SELECT actor_id, actor_type, resource, workspace_id::text AS workspace_id, metadata::text AS detail
      FROM mnemosyne.mnemo_audit_log WHERE action = 'settings_changed' ORDER BY created_at, id`;
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row).toMatchObject({
        actor_id: `user:${superId}`,
        actor_type: "user",
        resource: "settings",
        workspace_id: GLOBAL,
      });
    expect(rows[0]!.detail).toContain("saved.example.test");
  });

  it("refuses an invalid URL or a read-only field with 400 and changes nothing", async () => {
    const before =
      await admin`SELECT count(*)::int AS n FROM mnemosyne.mnemo_audit_log WHERE action = 'settings_changed'`;
    for (const [body, error] of [
      [{ publicBaseUrl: "http://plain.example.test" }, "invalid_public_base_url"],
      [{ publicBaseUrl: "javascript:alert(1)" }, "invalid_public_base_url"],
      [{ registrationMode: "open" }, "invalid_request"],
      [{ invitationsEnabled: "no" }, "invalid_request"],
      [{}, "invalid_request"],
    ] as const) {
      const res = await call("PUT", "/instance/settings", superCookie, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
    const after =
      await admin`SELECT count(*)::int AS n FROM mnemosyne.mnemo_audit_log WHERE action = 'settings_changed'`;
    expect(after[0]!.n).toBe(before[0]!.n);
    const [row] = await admin`
      SELECT count(*)::int AS n FROM mnemosyne.mnemo_workspace_config
      WHERE workspace_id = ${GLOBAL}::uuid AND key = 'instance_public_base_url'`;
    expect(row!.n).toBe(0);
  });

  it("with invitations off, creating or regenerating an invitation is 403 invitations_disabled", async () => {
    let res = await call("PUT", "/instance/settings", superCookie, { invitationsEnabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      invitationsEnabled: false,
      source: { invitationsEnabled: "global" },
    });
    try {
      res = await call("POST", "/workspace/invitations", ownerCookie, {
        email: "invitee@example.test",
        role: "write",
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("invitations_disabled");
      res = await call("POST", "/workspace/invitations/any-id/regenerate", ownerCookie);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("invitations_disabled");
    } finally {
      res = await call("PUT", "/instance/settings", superCookie, { invitationsEnabled: true });
      expect(res.status).toBe(200);
    }
    // Back on: the owner's personal workspace refuses for its own reason.
    res = await call("POST", "/workspace/invitations", ownerCookie, {
      email: "invitee@example.test",
      role: "write",
    });
    expect(((await res.json()) as { error: string }).error).toBe("personal_workspace");
  });

  it("audits sign-ins: success as the user, failure with the email hash only, same 401", async () => {
    const before = await admin`SELECT max(id) AS id FROM mnemosyne.mnemo_audit_log`;
    const since = (before[0]!.id as string | null) ?? "0";
    const unknown = await login("nobody-here@example.test", "wrong password!!");
    const wrong = await login(ownerEmail, "wrong password!!");
    expect(unknown.res.status).toBe(401);
    expect(wrong.res.status).toBe(401);
    expect(await wrong.res.text()).toBe(await unknown.res.text());
    await signIn(ownerEmail);

    // Written after the response, so poll.
    let rows: postgres.RowList<postgres.Row[]> | undefined;
    await vi.waitFor(async () => {
      rows = await admin`
        SELECT action, actor_id, actor_type, resource, resource_id,
               workspace_id::text AS workspace_id, metadata::text AS detail
        FROM mnemosyne.mnemo_audit_log
        WHERE id > ${since}
          AND (action = 'login_failure'
               OR (action = 'login_success' AND actor_id = ${`user:${owner.id}`}))
        ORDER BY id`;
      expect(rows).toHaveLength(3);
    });
    const [failA, failB, ok] = [...rows!].sort((a, b) =>
      String(a.action).localeCompare(String(b.action))
    );
    for (const fail of [failA!, failB!]) {
      expect(fail).toMatchObject({
        action: "login_failure",
        actor_type: "system",
        workspace_id: GLOBAL,
      });
      expect(fail.detail).toContain("invalid_credentials");
    }
    expect([failA!.detail, failB!.detail].join()).toContain(emailIdentifier(ownerEmail));
    expect(ok).toMatchObject({
      action: "login_success",
      actor_id: `user:${owner.id}`,
      actor_type: "user",
      resource_id: owner.id,
      workspace_id: GLOBAL,
    });
    const text = JSON.stringify(rows);
    expect(text).not.toContain("@example.test");
    expect(text).not.toContain("wrong password");
  });

  it("lists security actions from every workspace, never fact rows", async () => {
    await login(ownerEmail, "another wrong pw");
    const kinds = {
      recall: "fact",
      create: "fact",
      invitation_created: "invitation",
      key_revoke: "key",
    };
    for (const action of ["recall", "create", "invitation_created", "key_revoke"] as const) {
      await storage.appendAuditEntry({
        workspaceId: owner.workspace,
        actorType: "user",
        actorId: `user:${owner.id}`,
        action,
        resourceKind: kinds[action],
        resourceId: `audit-test-${action}`,
        isTerminal: false,
      });
    }
    await vi.waitFor(async () => {
      const { entries } = await audit("?action=login_failure");
      expect(entries.length).toBeGreaterThanOrEqual(3);
    });
    const { entries } = await audit();
    const actions = new Set(entries.map((e) => e.action));
    expect(actions.has("recall")).toBe(false);
    expect(actions.has("create")).toBe(false);
    expect(entries.find((e) => e.resourceId === "audit-test-invitation_created")).toMatchObject({
      workspaceId: owner.workspace,
      actorId: `user:${owner.id}`,
      actorEmail: ownerEmail,
    });
    expect(entries.some((e) => e.action === "login_failure" && e.workspaceId === GLOBAL)).toBe(
      true
    );
    // API key events are security actions too (spec §6).
    expect(entries.find((e) => e.resourceId === "audit-test-key_revoke")).toMatchObject({
      action: "key_revoke",
      workspaceId: owner.workspace,
      resourceKind: "key",
    });
    const revocations = await audit("?action=key_revoke");
    expect(revocations.entries.map((e) => e.resourceId)).toContain("audit-test-key_revoke");
    expect(revocations.entries.every((e) => e.action === "key_revoke")).toBe(true);
    for (const action of ["key_create", "key_rotate"])
      expect((await call("GET", `/instance/audit?action=${action}`, superCookie)).status).toBe(200);
    // Newest first.
    const times = entries.map((e) => Date.parse(e.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const grants = await audit("?action=superadmin_granted");
    expect(grants.entries.length).toBeGreaterThan(0);
    expect(grants.entries.every((e) => e.action === "superadmin_granted")).toBe(true);

    const mine = await audit(`?actor=${encodeURIComponent(`user:${owner.id}`)}`);
    expect(mine.entries.length).toBeGreaterThan(0);
    expect(mine.entries.every((e) => e.actorId === `user:${owner.id}`)).toBe(true);
    // A bare user id means that user.
    expect((await audit(`?actor=${owner.id}`)).entries.map((e) => e.id)).toEqual(
      mine.entries.map((e) => e.id)
    );

    expect((await audit("?from=2999-01-01T00:00:00Z")).entries).toEqual([]);
    for (const query of [
      "?action=recall",
      "?action=create",
      "?from=yesterday",
      "?cursor=nope",
      `?cursor=${Buffer.from(JSON.stringify(["2026-02-30T00:00:00.000000Z", "1"])).toString("base64url")}`,
    ]) {
      const res = await call("GET", `/instance/audit${query}`, superCookie);
      expect({ query, status: res.status }).toEqual({ query, status: 400 });
    }
  });

  it("pages 50 at a time, newest first, on a stable cursor", async () => {
    for (let i = 0; i < 60; i++)
      await storage.appendAuditEntry({
        workspaceId: owner.workspace,
        actorType: "user",
        actorId: `user:${owner.id}`,
        action: "member_added",
        resourceKind: "user",
        resourceId: `page-${i}`,
        isTerminal: false,
      });
    const first = await audit("?action=member_added");
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await audit(
      `?action=member_added&cursor=${encodeURIComponent(first.nextCursor!)}`
    );
    expect(second.entries.length).toBeGreaterThanOrEqual(10);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.entries, ...second.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const pages = [...first.entries, ...second.entries].filter((e) =>
      e.resourceId?.startsWith("page-")
    );
    expect(pages.map((e) => e.resourceId)).toEqual(
      Array.from({ length: 60 }, (_, i) => `page-${59 - i}`)
    );
  });
});

describe("final review fixes: keys, CSRF, password audit, settings re-check", () => {
  /**
   * The superadmin's password session on their personal workspace, minted
   * directly: the file has spent the per-email sign-in budget (10) by now.
   */
  const superSession = async () => {
    const { token } = await mintDashboardToken(secret, {
      workspaceId: superWorkspace,
      keyPrefix: "password",
      scopes: [],
      plan: "free",
      actorId: superId,
      userId: superId,
      authMethod: "password",
    });
    return `${DASHBOARD_COOKIE}=${token}`;
  };
  /** A fresh user with the shared password, signed in to their personal workspace. */
  const freshUser = async (email: string, name: string) => {
    const user = await provisionUser(email, name);
    await admin`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${user.id}, ${passwordHash})`;
    return user;
  };

  it("a superadmin session cannot mint or rotate a key carrying admin:workspace (C1)", async () => {
    const cookie = await superSession();
    // The session itself holds admin:workspace while its user is a superadmin.
    const session = await app.request("/dashboard/auth/session", { headers: { cookie } });
    expect((await session.json()).scopes).toContain("admin:workspace");

    const before =
      await admin`SELECT count(*)::int AS n FROM mnemosyne.mnemo_api_keys WHERE workspace_id = ${superWorkspace}`;
    const refused = await call("POST", "/admin/keys", cookie, {
      label: "outlives superadmin",
      scopes: ["memory:read", "admin:workspace"],
    });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).toContain("admin:workspace");
    for (const keyKind of ["workspace", "user"])
      expect(
        (
          await call("POST", "/admin/keys", cookie, {
            label: `only admin ${keyKind}`,
            scopes: ["admin:workspace"],
            keyKind,
          })
        ).status
      ).toBe(403);
    const [after] =
      await admin`SELECT count(*)::int AS n FROM mnemosyne.mnemo_api_keys WHERE workspace_id = ${superWorkspace}`;
    expect(after!.n).toBe(before[0]!.n);
    // The owner's own scopes still mint.
    const allowed = await call("POST", "/admin/keys", cookie, {
      label: "owner scopes",
      scopes: ["memory:read", "admin:keys"],
    });
    expect(allowed.status).toBe(201);

    // Rotating is minting: a key that already holds admin:workspace is refused.
    const keyId = "mk_c1rotate0000000001";
    await admin`
      INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name, label, scopes)
      VALUES (${keyId}, ${superWorkspace}, 'not-a-real-hash', 'legacy', 'legacy',
              ARRAY['memory:read', 'admin:workspace'])`;
    const rotated = await call("POST", `/admin/keys/${keyId}/rotate`, cookie);
    expect(rotated.status).toBe(403);
    const [row] =
      await admin`SELECT deprecated_at FROM mnemosyne.mnemo_api_keys WHERE id = ${keyId}`;
    expect(row!.deprecated_at).toBeNull();
    expect(
      await admin`SELECT 1 FROM mnemosyne.mnemo_api_keys WHERE rotated_from_id = ${keyId}`
    ).toHaveLength(0);
  });

  it("refuses a cross-site or same-site write on the bridge with 403 invalid_origin (M3)", async () => {
    const cookie = await superSession();
    const send = (method: string, site: string | null) =>
      app.request("/dashboard/api/admin/keys", {
        method,
        headers: {
          cookie,
          "content-type": "application/json",
          ...(site ? { "sec-fetch-site": site } : {}),
        },
        ...(method === "GET" ? {} : { body: JSON.stringify({ label: "csrf", scopes: [] }) }),
      });
    for (const site of ["cross-site", "same-site"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await send(method, site);
        expect({ method, site, status: res.status }).toEqual({ method, site, status: 403 });
        expect(await res.json()).toEqual({ error: "invalid_origin" });
      }
    }
    // Without a session the origin check still answers first.
    const anonymous = await app.request("/dashboard/api/admin/keys", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(anonymous.status).toBe(403);
    // Same-origin, a typed URL (none), a client without the header, and reads pass the check.
    for (const site of ["same-origin", "none", null]) {
      const res = await send("POST", site);
      expect(res.status).toBe(400); // reaches the route: scopes must not be empty
    }
    expect((await send("GET", "cross-site")).status).toBe(200);
  });

  it("audits a self-service password change as the user, under the global workspace (I3)", async () => {
    const user = await freshUser("password-audit@example.test", "PasswordAudit");
    const cookie = await signIn("password-audit@example.test");
    const res = await app.request("/dashboard/auth/password", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: password, newPassword: "a changed password 42" }),
    });
    expect(res.status).toBe(200);
    const rows = await admin`
      SELECT actor_id, actor_type, resource, resource_id, workspace_id::text AS workspace_id,
             metadata::text AS detail
      FROM mnemosyne.mnemo_audit_log WHERE action = 'password_changed'`;
    expect(rows).toEqual([
      expect.objectContaining({
        actor_id: `user:${user.id}`,
        actor_type: "user",
        resource: "user",
        resource_id: user.id,
        workspace_id: GLOBAL,
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("changed password");
    // A wrong current password changes nothing and audits nothing.
    const wrong = await app.request("/dashboard/auth/password", {
      method: "POST",
      headers: { cookie: cookieOf(res)!, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "not the password!", newPassword: "x".repeat(20) }),
    });
    expect(wrong.status).toBe(401);
    expect(
      await admin`SELECT 1 FROM mnemosyne.mnemo_audit_log WHERE action = 'password_changed'`
    ).toHaveLength(1);
  });

  it("PUT /instance/settings re-checks superadmin in the database, past a fresh cache (M9)", async () => {
    const sa = await freshUser("settings-revoked@example.test", "SettingsRevoked");
    await admin`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${sa.id}, 'system:test')`;
    const cookie = await signIn("settings-revoked@example.test");
    const read = await call("GET", "/instance/settings", cookie);
    expect(read.status).toBe(200);
    const view = (await read.json()) as { invitationsEnabled: boolean };
    const audits = async () =>
      (
        await admin`SELECT count(*)::int AS n FROM mnemosyne.mnemo_audit_log WHERE action = 'settings_changed'`
      )[0]!.n as number;
    const auditsBefore = await audits();

    // Revoked in the database; the status cache still says superadmin.
    await admin`DELETE FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${sa.id}`;
    expect((await userStatus.get(sa.id))?.isSuperadmin).toBe(true);
    const res = await call("PUT", "/instance/settings", cookie, {
      invitationsEnabled: !view.invitationsEnabled,
    });
    expect(res.status).toBe(404);
    expect(await audits()).toBe(auditsBefore);
    const superCookie = await superSession();
    const now = (await (await call("GET", "/instance/settings", superCookie)).json()) as {
      invitationsEnabled: boolean;
    };
    expect(now.invitationsEnabled).toBe(view.invitationsEnabled);
  });
});

describe("instance plane: 0055 database rules", () => {
  const asApp = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    client.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      return fn(tx);
    }) as Promise<T>;

  it("mnemo_instance_audit refuses a non-superadmin or NULL actor (42501)", async () => {
    for (const actor of [regularId, null, "no-such-user"]) {
      await expect(
        asApp((tx) => tx`SELECT * FROM mnemosyne.mnemo_instance_audit(${actor})`)
      ).rejects.toMatchObject({ code: "42501" });
    }
    const rows = await asApp(
      (tx) =>
        tx`SELECT * FROM mnemosyne.mnemo_instance_audit(${superId}, NULL, NULL, NULL, NULL, NULL, NULL, 5)`
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it("refuses a half cursor and an action outside the security list returns nothing", async () => {
    await expect(
      asApp(
        (tx) =>
          tx`SELECT * FROM mnemosyne.mnemo_instance_audit(${superId}, NULL, NULL, NULL, NULL, now(), NULL)`
      )
    ).rejects.toMatchObject({ code: "22023" });
    const rows = await asApp(
      (tx) => tx`SELECT * FROM mnemosyne.mnemo_instance_audit(${superId}, 'recall')`
    );
    expect(rows).toHaveLength(0);
  });

  it("is restricted to the app roles with a pinned search_path", async () => {
    const [fn] = await admin`
      SELECT p.prosecdef, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
             has_function_privilege('mnemo_app_role', p.oid, 'EXECUTE') AS app_role_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'mnemosyne' AND p.proname = 'mnemo_instance_audit'`;
    expect(fn).toMatchObject({
      prosecdef: true,
      public_exec: false,
      app_user_exec: true,
      app_role_exec: true,
      proconfig: ["search_path=mnemosyne, pg_temp"],
    });
  });

  it("reverts with the down migration and re-applies", async () => {
    const file = (suffix: string) =>
      readFile(resolve(migrationsDir, `0055_instance_audit${suffix}`), "utf8");
    const present = async () =>
      (
        await admin`
          SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'mnemosyne' AND p.proname = 'mnemo_instance_audit'`
      ).length;
    const conn = await admin.reserve();
    try {
      await conn.unsafe(await file(".down.sql"));
    } finally {
      conn.release();
    }
    expect(await present()).toBe(0);
    const up = await file(".sql");
    await admin.begin((tx) => tx.unsafe(up));
    expect(await present()).toBe(1);
  });
});

describe("instance plane: database rules", () => {
  const asApp = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    client.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      return fn(tx);
    }) as Promise<T>;

  it("app roles cannot write disabled_at directly, but still bump sessions_valid_after", async () => {
    for (const role of ["app_user", "mnemo_app_role"]) {
      await expect(
        client.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${role}`);
          await tx`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${regularId}`;
        })
      ).rejects.toMatchObject({ code: "42501" });
    }
    await asApp(async (tx) => {
      await tx`SELECT set_config('mnemosyne.actor_user_id', ${regularId}, true)`;
      const bumped =
        await tx`UPDATE mnemosyne.mnemo_user SET sessions_valid_after = clock_timestamp(), last_login_at = clock_timestamp() WHERE id = ${regularId} RETURNING id`;
      expect(bumped).toHaveLength(1);
    });
  });

  it("every instance function refuses a non-superadmin actor (42501)", async () => {
    const statements = [
      (tx: postgres.TransactionSql) =>
        tx`SELECT * FROM mnemosyne.mnemo_instance_list_users(${regularId})`,
      (tx: postgres.TransactionSql) =>
        tx`SELECT mnemosyne.mnemo_instance_set_disabled(${regularId}, ${targetId}, true)`,
    ];
    for (const statement of statements) {
      await expect(asApp(statement)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("a disabled superadmin no longer counts: the last active one cannot be disabled", async () => {
    // Two superadmins; disabling one leaves the other as the last active one.
    await admin`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${regularId}, 'system:test')`;
    try {
      await asApp(
        (tx) => tx`SELECT mnemosyne.mnemo_instance_set_disabled(${superId}, ${regularId}, true)`
      );
      // regular is disabled: no longer an actor, and super is the last active one.
      await expect(
        asApp(
          (tx) => tx`SELECT mnemosyne.mnemo_instance_set_disabled(${regularId}, ${superId}, true)`
        )
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        asApp((tx) => tx`SELECT mnemosyne.mnemo_instance_revoke_admin(${superId}, ${superId})`)
      ).rejects.toMatchObject({ code: "23514", message: "last_superadmin" });
    } finally {
      await asApp(
        (tx) => tx`SELECT mnemosyne.mnemo_instance_set_disabled(${superId}, ${regularId}, false)`
      );
      await admin`DELETE FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${regularId}`;
    }
  });

  it("restricts the 0052 functions to the app roles and pins their search_path", async () => {
    const functions = await admin`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
             has_function_privilege('mnemo_app_role', p.oid, 'EXECUTE') AS app_role_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'mnemosyne'
        AND p.proname IN ('mnemo_instance_list_users', 'mnemo_instance_set_disabled',
                          'mnemo_instance_grant_admin')`;
    expect(functions).toHaveLength(3);
    for (const fn of functions) {
      expect(fn, fn.proname as string).toMatchObject({
        prosecdef: true,
        public_exec: false,
        app_user_exec: true,
        app_role_exec: true,
        proconfig: ["search_path=mnemosyne, pg_temp"],
      });
    }
  });

  it("reverts with the down migration and re-applies", async () => {
    const up = await readFile(resolve(migrationsDir, "0052_instance_plane.sql"), "utf8");
    const down = await readFile(resolve(migrationsDir, "0052_instance_plane.down.sql"), "utf8");
    const state = async () => {
      const [row] = await admin`
        SELECT to_regprocedure('mnemosyne.mnemo_instance_list_users(text)') AS list_fn,
               to_regprocedure('mnemosyne.mnemo_instance_set_disabled(text,text,boolean)') AS set_fn,
               has_column_privilege('app_user', 'mnemosyne.mnemo_user', 'disabled_at', 'UPDATE') AS app_user_disabled,
               has_column_privilege('mnemo_app_role', 'mnemosyne.mnemo_user', 'disabled_at', 'UPDATE') AS app_role_disabled,
               has_column_privilege('app_user', 'mnemosyne.mnemo_user', 'sessions_valid_after', 'UPDATE') AS app_user_epoch`;
      return row!;
    };
    // The down file carries its own BEGIN/COMMIT, so it needs a dedicated connection.
    const conn = await admin.reserve();
    try {
      await conn.unsafe(down);
    } finally {
      conn.release();
    }
    expect(await state()).toMatchObject({
      list_fn: null,
      set_fn: null,
      app_user_disabled: true,
      app_role_disabled: true,
      app_user_epoch: true,
    });
    // 0050's grant again: a disabled user is no longer refused by the function.
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${targetId}`;
    await asApp((tx) => tx`SELECT mnemosyne.mnemo_instance_grant_admin(${superId}, ${targetId})`);
    await admin`DELETE FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${targetId}`;
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = NULL WHERE id = ${targetId}`;

    await admin.begin((tx) => tx.unsafe(up));
    expect(await state()).toMatchObject({
      app_user_disabled: false,
      app_role_disabled: false,
      app_user_epoch: true,
    });
    const rows = await asApp(
      (tx) => tx`SELECT id FROM mnemosyne.mnemo_instance_list_users(${superId})`
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});

describe("instance plane: 0053 database rules", () => {
  const asApp = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    client.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      return fn(tx);
    }) as Promise<T>;
  const names = [
    "mnemo_instance_list_workspaces",
    "mnemo_instance_workspace_members",
    "mnemo_instance_set_member_role",
    "mnemo_instance_remove_member",
    "mnemo_instance_offboard",
  ];

  it("every 0053 function refuses a non-superadmin actor (42501) and changes nothing", async () => {
    const statements = [
      (tx: postgres.TransactionSql) =>
        tx`SELECT * FROM mnemosyne.mnemo_instance_list_workspaces(${regularId})`,
      (tx: postgres.TransactionSql) =>
        tx`SELECT * FROM mnemosyne.mnemo_instance_workspace_members(${regularId}, ${regularWorkspace})`,
      (tx: postgres.TransactionSql) =>
        tx`SELECT mnemosyne.mnemo_instance_set_member_role(${regularId}, ${regularWorkspace}, ${targetId}, 'owner')`,
      (tx: postgres.TransactionSql) =>
        tx`SELECT mnemosyne.mnemo_instance_remove_member(${regularId}, ${regularWorkspace}, ${targetId})`,
      (tx: postgres.TransactionSql) =>
        tx`SELECT mnemosyne.mnemo_instance_offboard(${regularId}, ${targetId}, '{}'::jsonb)`,
    ];
    for (const statement of statements) {
      await expect(asApp(statement)).rejects.toMatchObject({ code: "42501" });
    }
    const [member] = await admin`
      SELECT role FROM mnemosyne.mnemo_workspace_member
      WHERE workspace_id = ${regularWorkspace} AND user_id = ${targetId}`;
    expect(member!.role).toBe("read");
  });

  it("restricts the 0053 functions to the app roles and pins their search_path", async () => {
    const functions = await admin`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
             has_function_privilege('mnemo_app_role', p.oid, 'EXECUTE') AS app_role_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'mnemosyne' AND p.proname = ANY(${names})`;
    expect(functions.map((f) => f.proname).sort()).toEqual([...names].sort());
    for (const fn of functions) {
      expect(fn, fn.proname as string).toMatchObject({
        prosecdef: true,
        public_exec: false,
        app_user_exec: true,
        app_role_exec: true,
        proconfig: ["search_path=mnemosyne, pg_temp"],
      });
    }
  });

  it("reverts with the down migration and re-applies", async () => {
    const file = (suffix: string) =>
      readFile(resolve(migrationsDir, `0053_instance_workspaces_offboard${suffix}`), "utf8");
    const present = async () =>
      (
        await admin`
          SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'mnemosyne' AND p.proname = ANY(${names})`
      ).length;
    const conn = await admin.reserve();
    try {
      await conn.unsafe(await file(".down.sql"));
    } finally {
      conn.release();
    }
    expect(await present()).toBe(0);
    const up = await file(".sql");
    await admin.begin((tx) => tx.unsafe(up));
    expect(await present()).toBe(names.length);
    const rows = await asApp(
      (tx) => tx`SELECT id FROM mnemosyne.mnemo_instance_list_workspaces(${superId})`
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});
