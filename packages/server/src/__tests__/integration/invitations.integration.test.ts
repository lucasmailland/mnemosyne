/**
 * Workspace members with email, invitations and single-use links (accounts
 * stage A, task 7), on the dashboard bridge and the public link endpoints,
 * against real Postgres as a NOSUPERUSER app login.
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
import { DASHBOARD_COOKIE } from "../../dashboard-session.js";
import { PostgresUserStatusSource, UserStatusService } from "../../user-status.js";
import { hashLinkToken, newLinkToken } from "../../single-use-link.js";
import { createAuthMiddleware, type AuthVariables } from "../../auth.js";
import { computeLookupHash } from "../../routes/_key-secret.js";
import { logger } from "../../logging.js";
import { toErrorBody } from "../../errors.js";
import type { ServerDeps } from "../../deps.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const secret = "integration-dashboard-secret-more-than-32-bytes";
const password = "invitations test password";
const newPassword = "a brand new password 42";
const GLOBAL = "00000000-0000-0000-0000-000000000000";
const BASE = "https://mnemo.example.test";
const migrationsDir = resolve(root, "packages/adapter-postgres/migrations/baseline");
const emails = {
  owner: "inv-owner@example.test",
  admin: "inv-admin@example.test",
  writer: "inv-writer@example.test",
  superadmin: "inv-super@example.test",
  outsider: "inv-outsider@example.test",
  target: "inv-target@example.test",
  inviter: "inv-inviter@example.test",
};

let container: StartedTestContainer;
let admin: postgres.Sql;
let client: postgres.Sql;
let auditClient: ReturnType<typeof createDrizzleClient>;
let app: Hono;
let userStatus: UserStatusService;
let passwordHash: string;
type Provisioned = { id: string; workspace: string; tenant: string };
const users = {} as Record<keyof typeof emails, Provisioned>;
let teamTenant: string, team: string;
let dbUrl: string;

const cookieOf = (res: Response, name = DASHBOARD_COOKIE) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))
    ?.split(";")[0];

/** A distinct client address per public request: the per-IP bucket (30) spans the file. */
let ipCount = 0;
const nextIp = () => {
  ipCount++;
  return `198.18.${ipCount >> 8}.${ipCount & 255}`;
};

/** Sign in, picking `pick` when the user has several workspaces. */
const signIn = async (email: string, pick?: string, pw = password) => {
  const ip = nextIp();
  const res = await app.request("/dashboard/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password: pw }),
  });
  if (res.status !== 200) return { status: res.status, cookie: undefined };
  if (!(await res.clone().json()).requiresWorkspace) return { status: 200, cookie: cookieOf(res) };
  const picked = await app.request("/dashboard/auth/workspace", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      cookie: cookieOf(res, "mnemo_dash_choice")!,
    },
    body: JSON.stringify({ workspaceId: pick }),
  });
  return { status: picked.status, cookie: cookieOf(picked) };
};
const mustSignIn = async (email: string, pick?: string) => {
  const { status, cookie } = await signIn(email, pick);
  expect(status).toBe(200);
  return cookie!;
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
const tokenOf = (link: string) => {
  expect(link.startsWith(`${BASE}/dashboard/link/`)).toBe(true);
  return link.slice(`${BASE}/dashboard/link/`.length);
};
const describeLink = (token: string) =>
  app.request(`/dashboard/auth/link/${token}`, { headers: { "x-forwarded-for": nextIp() } });
const acceptLink = (token: string, body: unknown = {}, cookie?: string) =>
  app.request(`/dashboard/auth/link/${token}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": nextIp(),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
const sessionOf = async (cookie: string) =>
  (await app.request("/dashboard/auth/session", { headers: { cookie } })).json() as Promise<{
    workspaceId: string;
    userId: string;
    role: string;
  }>;
const invite = async (cookie: string, email: string, role: string) => {
  const res = await call("POST", "/workspace/invitations", cookie, { email, role });
  return { res, body: (await res.json()) as { id: string; link: string; expiresAt: string } };
};
const usersWithEmail = async (email: string) =>
  admin`SELECT id FROM mnemosyne.mnemo_user WHERE lower(btrim(email)) = ${email}`;
const membership = async (workspaceId: string, userId: string) =>
  (
    await admin`SELECT role FROM mnemosyne.mnemo_workspace_member WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`
  )[0]?.role as string | undefined;

/** A user with a personal tenant and workspace, as registration makes one. */
const provisionUser = async (email: string, name: string): Promise<Provisioned> => {
  const [row] =
    await admin`SELECT * FROM mnemosyne.mnemo_provision_user(${email}, ${name}, ${`${name} workspace`})`;
  await admin`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${row!.user_id as string}, ${passwordHash})`;
  return {
    id: row!.user_id as string,
    workspace: row!.workspace_id as string,
    tenant: row!.tenant_id as string,
  };
};
const createTeam = async (name: string, members: Array<[string, string]>) => {
  const [{ id: tenant }] =
    (await admin`INSERT INTO mnemosyne.mnemo_tenant (name, kind) VALUES (${name}, 'organization') RETURNING id`) as unknown as [
      { id: string },
    ];
  const [{ id: workspace }] =
    (await admin`INSERT INTO mnemosyne.mnemo_workspace (name, tenant_id, owner_user_id) VALUES (${name}, ${tenant}, ${members[0]![0]}) RETURNING id`) as unknown as [
      { id: string },
    ];
  for (const [userId, role] of members) {
    await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${workspace}, ${userId}, ${role})`;
    await admin`INSERT INTO mnemosyne.mnemo_tenant_member (tenant_id, user_id, role) VALUES (${tenant}, ${userId}, ${role === "owner" ? "owner" : "member"})`;
  }
  return { tenant, workspace };
};

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: "mnemo", POSTGRES_PASSWORD: "mnemo", POSTGRES_DB: "mnemo" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const address = `${container.getHost()}:${container.getMappedPort(5432)}/mnemo`;
  const url = (dbUrl = `postgres://mnemo:mnemo@${address}`);
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
    "CREATE ROLE invitations_test LOGIN PASSWORD 'invitations-test-only' NOSUPERUSER NOBYPASSRLS; GRANT app_user, mnemo_app_role TO invitations_test; GRANT USAGE ON SCHEMA mnemosyne TO invitations_test;"
  );
  client = postgres(`postgres://invitations_test:invitations-test-only@${address}`, {
    max: 10,
    onnotice: () => {},
  });
  drizzle(client); // Match createDrizzlePool: Drizzle installs string timestamp codecs.

  passwordHash = await bcrypt.hash(password, 12);
  for (const key of Object.keys(emails) as Array<keyof typeof emails>)
    users[key] = await provisionUser(emails[key], key[0]!.toUpperCase() + key.slice(1));
  await admin`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${users.superadmin.id}, 'system:test')`;
  ({ tenant: teamTenant, workspace: team } = await createTeam("Acme team", [
    [users.owner.id, "owner"],
    [users.admin.id, "admin"],
    [users.writer.id, "write"],
  ]));

  vi.stubEnv("MNEMO_DASHBOARD_SECRET", secret);
  vi.stubEnv("MNEMO_PUBLIC_BASE_URL", `${BASE}/`);
  auditClient = createDrizzleClient(url);
  const deps = {
    dashboardPasswordAuth: new DashboardPasswordAuth(new PostgresCredentialStore(client)),
    metricsPgClient: client,
    userStatus: (userStatus = new UserStatusService(new PostgresUserStatusSource(client))),
    storage: new DrizzleStorageAdapter(auditClient.db, auditClient.pgClient),
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

describe("workspace members", () => {
  let ownerCookie: string, writerCookie: string;
  beforeAll(async () => {
    ownerCookie = await mustSignIn(emails.owner, team);
    writerCookie = await mustSignIn(emails.writer, team);
  });

  it("lists the members with email, name, role and joined date for an owner", async () => {
    const res = await call("GET", "/workspace/members", ownerCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<Record<string, unknown>>;
      invitations: unknown[];
    };
    expect(body.members.map((m) => [m.email, m.role])).toEqual([
      [emails.admin, "admin"],
      [emails.owner, "owner"],
      [emails.writer, "write"],
    ]);
    expect(body.members[1]).toMatchObject({ userId: users.owner.id, displayName: "Owner" });
    expect(new Date(body.members[1]!.joinedAt as string).getTime()).not.toBeNaN();
    expect(Array.isArray(body.invitations)).toBe(true);
  });

  it("carries each member's latest audit entry in this workspace, not elsewhere", async () => {
    const entry = (ws: string, ago: string) => admin<Array<{ created_at: Date }>>`
      INSERT INTO mnemosyne.mnemo_audit_log
        (workspace_id, actor_type, actor_id, action, resource, metadata, merkle_hash, created_at)
      VALUES (${ws}, 'user', ${`user:${users.admin.id}`}, 'recall', 'recall', '{}'::jsonb,
              '\\x00'::bytea, now() - ${ago}::interval)
      RETURNING created_at
    `;
    const [latest] = await entry(team, "2 days");
    await entry(team, "5 days");
    const [other] =
      await admin`SELECT id FROM mnemosyne.mnemo_workspace WHERE id <> ${team} LIMIT 1`;
    await entry(other!.id, "1 hour");
    const body = (await (await call("GET", "/workspace/members", ownerCookie)).json()) as {
      members: Array<{ userId: string; lastActiveAt: string | null }>;
    };
    expect(body.members.find((m) => m.userId === users.admin.id)?.lastActiveAt).toBe(
      latest!.created_at.toISOString()
    );
  });

  it("is empty for a non-member, at the database", async () => {
    const asApp = await client.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      return [
        await tx`SELECT * FROM mnemosyne.mnemo_workspace_member_profiles(${users.outsider.id}, ${team})`,
        await tx`SELECT * FROM mnemosyne.mnemo_workspace_member_profiles(${users.superadmin.id}, ${team})`,
      ];
    });
    expect(asApp[0]).toHaveLength(0);
    expect(asApp[1]).toHaveLength(3);
  });

  it("a writer sees members but no invitations, and changes nothing", async () => {
    await invite(ownerCookie, "pending-for-writer@example.test", "read");
    const res = await call("GET", "/workspace/members", writerCookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { invitations: unknown[] }).invitations).toEqual([]);
    expect(
      (await call("PATCH", `/workspace/members/${users.admin.id}`, writerCookie, { role: "read" }))
        .status
    ).toBe(403);
    expect(
      (await call("DELETE", `/workspace/members/${users.admin.id}`, writerCookie)).status
    ).toBe(403);
    expect((await invite(writerCookie, "nobody@example.test", "read")).res.status).toBe(403);
    expect(await membership(team, users.admin.id)).toBe("admin");
  });

  it("refuses to remove or demote the last owner (409 last_owner)", async () => {
    const removed = await call("DELETE", `/workspace/members/${users.owner.id}`, ownerCookie);
    expect(removed.status).toBe(409);
    expect(await removed.json()).toEqual({ error: "last_owner" });
    const demoted = await call("PATCH", `/workspace/members/${users.owner.id}`, ownerCookie, {
      role: "admin",
    });
    expect(demoted.status).toBe(409);
    expect(await membership(team, users.owner.id)).toBe("owner");
  });

  it("an admin cannot touch an owner nor make one; an owner can, audited", async () => {
    const adminCookie = await mustSignIn(emails.admin, team);
    expect(
      (await call("PATCH", `/workspace/members/${users.writer.id}`, adminCookie, { role: "owner" }))
        .status
    ).toBe(403);
    const touch = await call("DELETE", `/workspace/members/${users.owner.id}`, adminCookie);
    expect(touch.status).toBe(403);
    expect(await touch.json()).toEqual({ error: "role_not_allowed" });
    expect(
      (await call("PATCH", `/workspace/members/no-such-user`, ownerCookie, { role: "read" })).status
    ).toBe(404);
    expect(
      (await call("PATCH", `/workspace/members/${users.writer.id}`, ownerCookie, { role: "boss" }))
        .status
    ).toBe(400);

    const ok = await call("PATCH", `/workspace/members/${users.writer.id}`, ownerCookie, {
      role: "read",
    });
    expect(ok.status).toBe(200);
    expect(await membership(team, users.writer.id)).toBe("read");
    // The writer's open session narrows on its next request (live role).
    expect((await sessionOf(writerCookie)).role).toBe("viewer");
    const rows = await admin`
      SELECT actor_id, resource_id, workspace_id::text AS workspace_id, metadata::text AS detail
      FROM mnemosyne.mnemo_audit_log WHERE action = 'member_role_changed'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: `user:${users.owner.id}`,
      resource_id: users.writer.id,
      workspace_id: team,
    });
    expect(rows[0]!.detail).toContain('"role": "read"');
    await call("PATCH", `/workspace/members/${users.writer.id}`, ownerCookie, { role: "write" });
  });

  it("a superadmin who opened the workspace read-only cannot change members or invite", async () => {
    const superCookie = await mustSignIn(emails.superadmin);
    const opened = await call("POST", `/instance/workspaces/${team}/open`, superCookie);
    expect(opened.status).toBe(200);
    const readOnly = cookieOf(opened)!;
    // Reads work (superadmin), nothing else does.
    expect((await call("GET", "/workspace/members", readOnly)).status).toBe(200);
    expect(
      (await call("PATCH", `/workspace/members/${users.writer.id}`, readOnly, { role: "read" }))
        .status
    ).toBe(403);
    expect((await call("DELETE", `/workspace/members/${users.writer.id}`, readOnly)).status).toBe(
      403
    );
    expect((await invite(readOnly, "sneaky@example.test", "owner")).res.status).toBe(403);
    // And the database refuses a non-member actor whatever the route said.
    await expect(
      client.begin(async (tx) => {
        await tx`SET LOCAL ROLE app_user`;
        await tx`SELECT mnemosyne.mnemo_workspace_set_member_role(${users.superadmin.id}, ${team}, ${users.writer.id}, 'read')`;
      })
    ).rejects.toMatchObject({ code: "42501", message: "not_workspace_admin" });
    expect(await membership(team, users.writer.id)).toBe("write");
  });
});

describe("invitations", () => {
  let ownerCookie: string, adminCookie: string, ownerPersonal: string;
  beforeAll(async () => {
    ownerCookie = await mustSignIn(emails.owner, team);
    adminCookie = await mustSignIn(emails.admin, team);
    ownerPersonal = await mustSignIn(emails.owner, users.owner.workspace);
  });

  it("an admin cannot invite an owner; an admin invitation works", async () => {
    const refused = await invite(adminCookie, "would-be-owner@example.test", "owner");
    expect(refused.res.status).toBe(403);
    expect(refused.body).toMatchObject({ error: "role_not_allowed" });
    const ok = await invite(adminCookie, "new-admin@example.test", "admin");
    expect(ok.res.status).toBe(201);
    expect(ok.body.link).toMatch(/^https:\/\/mnemo\.example\.test\/dashboard\/link\/[\w-]{43}$/);
    expect(new Date(ok.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000); // determinism-ok: the database clock sets the expiry
  });

  it("refuses an invitation into a personal workspace (403)", async () => {
    const res = await invite(ownerPersonal, "friend@example.test", "read");
    expect(res.res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "personal_workspace" });
  });

  it("' Luca@E2E.test ' and 'luca@e2e.test' are the same invitee", async () => {
    const first = await invite(ownerCookie, " Luca@E2E.test ", "write");
    expect(first.res.status).toBe(201);
    const second = await invite(ownerCookie, "luca@e2e.test", "write");
    expect(second.res.status).toBe(201);
    // The second replaced the first: one pending invitation, the old link dead.
    const list = (await (await call("GET", "/workspace/members", ownerCookie)).json()) as {
      invitations: Array<{ id: string; email: string; role: string }>;
    };
    expect(list.invitations.filter((i) => i.email === "luca@e2e.test")).toEqual([
      { id: second.body.id, email: "luca@e2e.test", role: "write", expiresAt: expect.any(String) },
    ]);
    expect((await describeLink(tokenOf(first.body.link))).status).toBe(404);

    const described = await describeLink(tokenOf(second.body.link));
    expect(described.status).toBe(200);
    expect(await described.json()).toEqual({
      purpose: "invite",
      workspaceName: "Acme team",
      accountExists: false,
      expiresAt: expect.any(String),
    });
    const accepted = await acceptLink(tokenOf(second.body.link), {
      password: newPassword,
      displayName: "Luca",
    });
    expect(accepted.status).toBe(200);
    const luca = await usersWithEmail("luca@e2e.test");
    expect(luca).toHaveLength(1);
    const lucaId = luca[0]!.id as string;
    expect(await membership(team, lucaId)).toBe("write");
    // Signed in to the invited workspace.
    expect(await sessionOf(cookieOf(accepted)!)).toMatchObject({
      workspaceId: team,
      userId: lucaId,
    });
    // A personal workspace too, and the tenant membership.
    const [personal] = await admin`
      SELECT w.id FROM mnemosyne.mnemo_user u JOIN mnemosyne.mnemo_workspace w ON w.tenant_id = u.personal_tenant_id
      WHERE u.id = ${lucaId}`;
    expect(await membership(personal!.id as string, lucaId)).toBe("owner");
    expect(
      await admin`SELECT role FROM mnemosyne.mnemo_tenant_member WHERE tenant_id = ${teamTenant} AND user_id = ${lucaId}`
    ).toEqual([{ role: "member" }]);
    // Inviting the same person again: already a member, whatever the spelling.
    const again = await invite(ownerCookie, "LUCA@e2e.test", "read");
    expect(again.res.status).toBe(409);
    expect(again.body).toMatchObject({ error: "already_member" });
    // The accepted link is used up.
    expect((await acceptLink(tokenOf(second.body.link), { password: newPassword })).status).toBe(
      404
    );
    const audit = await admin`
      SELECT action, actor_id, workspace_id::text AS workspace_id FROM mnemosyne.mnemo_audit_log
      WHERE actor_id = ${`user:${lucaId}`} ORDER BY id`;
    expect(audit).toEqual([
      { action: "user_created", actor_id: `user:${lucaId}`, workspace_id: GLOBAL },
      { action: "invitation_accepted", actor_id: `user:${lucaId}`, workspace_id: team },
    ]);
  });

  it("the same link accepted twice at once makes one account and one membership", async () => {
    const email = "race@example.test";
    const { body } = await invite(ownerCookie, email, "read");
    const token = tokenOf(body.link);
    const results = await Promise.all([
      acceptLink(token, { password: newPassword }),
      acceptLink(token, { password: newPassword }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    const accounts = await usersWithEmail(email);
    expect(accounts).toHaveLength(1);
    expect(
      await admin`SELECT role FROM mnemosyne.mnemo_workspace_member WHERE workspace_id = ${team} AND user_id = ${accounts[0]!.id as string}`
    ).toEqual([{ role: "read" }]);
  });

  it("two consumes of one link racing at the database: one wins, the other link_invalid", async () => {
    const email = "db-race@example.test";
    const { body } = await invite(ownerCookie, email, "read");
    const hash = hashLinkToken(tokenOf(body.link));
    const consume = () =>
      client.begin(async (tx) => {
        await tx`SET LOCAL ROLE app_user`;
        return tx`SELECT * FROM mnemosyne.mnemo_link_consume(${hash}, ${passwordHash}, NULL)`;
      });
    const settled = await Promise.allSettled([consume(), consume(), consume()]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    for (const s of settled.filter((s) => s.status === "rejected"))
      expect((s as PromiseRejectedResult).reason).toMatchObject({
        code: "P0002",
        message: "link_invalid",
      });
    expect(await usersWithEmail(email)).toHaveLength(1);
  });

  it("revoked, expired and regenerated-old links are 404", async () => {
    const revoked = await invite(ownerCookie, "revoked@example.test", "read");
    expect(
      (await call("DELETE", `/workspace/invitations/${revoked.body.id}`, ownerCookie)).status
    ).toBe(200);
    expect((await describeLink(tokenOf(revoked.body.link))).status).toBe(404);
    expect((await acceptLink(tokenOf(revoked.body.link), { password: newPassword })).status).toBe(
      404
    );
    expect(
      (await call("DELETE", `/workspace/invitations/${revoked.body.id}`, ownerCookie)).status
    ).toBe(404);

    const expired = await invite(ownerCookie, "expired@example.test", "read");
    await admin`UPDATE mnemosyne.mnemo_link_token SET expires_at = now() - interval '1 second' WHERE id = ${expired.body.id}`;
    expect((await describeLink(tokenOf(expired.body.link))).status).toBe(404);
    expect((await acceptLink(tokenOf(expired.body.link), { password: newPassword })).status).toBe(
      404
    );

    // Regenerating an expired invitation gives a fresh link; the old one stays dead.
    const regen = await call(
      "POST",
      `/workspace/invitations/${expired.body.id}/regenerate`,
      ownerCookie
    );
    expect(regen.status).toBe(200);
    const fresh = (await regen.json()) as { link: string; expiresAt: string };
    expect(fresh.link).not.toBe(expired.body.link);
    expect((await acceptLink(tokenOf(expired.body.link), { password: newPassword })).status).toBe(
      404
    );
    expect((await describeLink(tokenOf(fresh.link))).status).toBe(200);
    expect((await acceptLink(tokenOf(fresh.link), { password: newPassword })).status).toBe(200);
    expect(await usersWithEmail("expired@example.test")).toHaveLength(1);
    expect(await usersWithEmail("revoked@example.test")).toHaveLength(0);
    expect(
      (await call("POST", "/workspace/invitations/no-such-id/regenerate", ownerCookie)).status
    ).toBe(404);
  });

  it("an invitation is refused at use once its issuer was demoted, or its workspace is gone", async () => {
    const { workspace: side } = await createTeam("Side team", [
      [users.owner.id, "owner"],
      [users.inviter.id, "admin"],
    ]);
    const inviterCookie = await mustSignIn(emails.inviter, side);
    const pending = await invite(inviterCookie, "after-demotion@example.test", "write");
    expect(pending.res.status).toBe(201);
    const sideOwner = await mustSignIn(emails.owner, side);
    expect(
      (await call("PATCH", `/workspace/members/${users.inviter.id}`, sideOwner, { role: "write" }))
        .status
    ).toBe(200);
    expect((await describeLink(tokenOf(pending.body.link))).status).toBe(404);
    expect((await acceptLink(tokenOf(pending.body.link), { password: newPassword })).status).toBe(
      404
    );
    expect(await usersWithEmail("after-demotion@example.test")).toHaveLength(0);

    // An invitation whose workspace is deleted goes with it.
    const gone = await invite(sideOwner, "workspace-gone@example.test", "read");
    expect(gone.res.status).toBe(201);
    await admin`DELETE FROM mnemosyne.mnemo_workspace_member WHERE workspace_id = ${side}`;
    await admin`DELETE FROM mnemosyne.mnemo_workspace WHERE id = ${side}`;
    expect((await describeLink(tokenOf(gone.body.link))).status).toBe(404);
    expect((await acceptLink(tokenOf(gone.body.link), { password: newPassword })).status).toBe(404);
    expect(await usersWithEmail("workspace-gone@example.test")).toHaveLength(0);
  });

  it("an existing account accepts only through its own session", async () => {
    const { body } = await invite(ownerCookie, emails.outsider.toUpperCase(), "read");
    const token = tokenOf(body.link);
    const described = await describeLink(token);
    expect(await described.json()).toMatchObject({ accountExists: true, purpose: "invite" });

    const anonymous = await acceptLink(token, { password: newPassword });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: "session_required" });
    // Someone else's session does not do either.
    const other = await acceptLink(token, {}, ownerCookie);
    expect(other.status).toBe(401);
    expect(await membership(team, users.outsider.id)).toBeUndefined();

    const own = await mustSignIn(emails.outsider);
    const accepted = await acceptLink(token, {}, own);
    expect(accepted.status).toBe(200);
    expect(await membership(team, users.outsider.id)).toBe("read");
    expect(await sessionOf(cookieOf(accepted)!)).toMatchObject({
      workspaceId: team,
      userId: users.outsider.id,
    });
    // The password did not change.
    expect((await signIn(emails.outsider, users.outsider.workspace)).status).toBe(200);
  });

  it("an existing account accepting while signed in continues its session", async () => {
    const email = "inv-chain@example.test";
    const chain = await provisionUser(email, "Chain");
    const { body } = await invite(ownerCookie, email, "read");
    const own = await mustSignIn(email);
    const accepted = await acceptLink(tokenOf(body.link), {}, own);
    expect(accepted.status).toBe(200);
    const after = cookieOf(accepted)!;
    expect(await membership(team, chain.id)).toBe("read");

    await app.request("/dashboard/auth/logout", { method: "POST", headers: { cookie: after } });

    for (const cookie of [own, after]) {
      const session = await app.request("/dashboard/auth/session", { headers: { cookie } });
      expect(session.status).toBe(401);
    }
  });

  it("a new account made in a browser signed in as someone else starts its own session", async () => {
    const email = "inv-fresh@example.test";
    const { body } = await invite(ownerCookie, email, "write");
    // Another person's live session in the same browser (its own sign-in: adminCookie
    // serves other tests).
    const someoneElse = await mustSignIn(emails.admin, team);
    const accepted = await acceptLink(
      tokenOf(body.link),
      { password: newPassword, displayName: "Fresh" },
      someoneElse
    );
    expect(accepted.status).toBe(200);
    const fresh = cookieOf(accepted)!;
    expect(await sessionOf(fresh)).toMatchObject({ workspaceId: team });

    // Not one session: signing the other person out leaves the new account signed in.
    await app.request("/dashboard/auth/logout", {
      method: "POST",
      headers: { cookie: someoneElse },
    });
    const gone = await app.request("/dashboard/auth/session", { headers: { cookie: someoneElse } });
    expect(gone.status).toBe(401);
    const kept = await app.request("/dashboard/auth/session", { headers: { cookie: fresh } });
    expect(kept.status).toBe(200);
  });

  it("a password that breaks the policy is refused before anything changes", async () => {
    const { body } = await invite(ownerCookie, "policy@example.test", "read");
    const res = await acceptLink(tokenOf(body.link), { password: "short" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "password_policy" });
    const sameAsEmail = await acceptLink(tokenOf(body.link), { password: " POLICY@example.test" });
    expect(sameAsEmail.status).toBe(400);
    expect((await acceptLink(tokenOf(body.link), {})).status).toBe(400);
    expect(await usersWithEmail("policy@example.test")).toHaveLength(0);
    expect((await describeLink(tokenOf(body.link))).status).toBe(200);
  });
});

describe("superadmin links: account setup and password reset", () => {
  let superCookie: string;
  beforeAll(async () => {
    superCookie = await mustSignIn(emails.superadmin);
  });

  it("creates an account through a setup link; a taken email is 409", async () => {
    const res = await call("POST", "/instance/users", superCookie, {
      email: " New.Person@Example.test ",
      displayName: "New Person",
    });
    expect(res.status).toBe(201);
    const { link } = (await res.json()) as { link: string };
    const token = tokenOf(link);
    expect(await (await describeLink(token)).json()).toMatchObject({
      purpose: "account_setup",
      workspaceName: null,
      accountExists: false,
    });
    const accepted = await acceptLink(token, { password: newPassword });
    expect(accepted.status).toBe(200);
    const [created] = await admin`
      SELECT id, email, display_name FROM mnemosyne.mnemo_user WHERE email = 'new.person@example.test'`;
    expect(created).toMatchObject({ display_name: "New Person" });
    const session = await sessionOf(cookieOf(accepted)!);
    expect(session.userId).toBe(created!.id);
    const [personal] = await admin`
      SELECT w.id FROM mnemosyne.mnemo_user u JOIN mnemosyne.mnemo_workspace w ON w.tenant_id = u.personal_tenant_id
      WHERE u.id = ${created!.id as string}`;
    expect(session.workspaceId).toBe(personal!.id);

    const taken = await call("POST", "/instance/users", superCookie, {
      email: "NEW.PERSON@example.test",
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "email_taken" });
    const audit = await admin`
      SELECT action, workspace_id::text AS workspace_id FROM mnemosyne.mnemo_audit_log
      WHERE action IN ('link_created', 'user_created') AND (actor_id = ${`user:${users.superadmin.id}`} OR actor_id = ${`user:${created!.id as string}`})
      ORDER BY id`;
    expect(audit).toEqual([
      { action: "link_created", workspace_id: GLOBAL },
      { action: "user_created", workspace_id: GLOBAL },
    ]);
  });

  it("a non-superadmin gets the unknown-route 404", async () => {
    const ownerCookie = await mustSignIn(emails.owner, team);
    expect(
      (await call("POST", "/instance/users", ownerCookie, { email: "x@example.test" })).status
    ).toBe(404);
    expect(
      (await call("POST", `/instance/users/${users.target.id}/reset-link`, ownerCookie)).status
    ).toBe(404);
  });

  it("a reset link unlocks the account, ends old sessions and signs in with the new password", async () => {
    const targetSession = await mustSignIn(emails.target);
    expect((await call("GET", "/workspace/members", targetSession)).status).toBe(200);
    const first = await call("POST", `/instance/users/${users.target.id}/reset-link`, superCookie);
    expect(first.status).toBe(201);
    const second = await call("POST", `/instance/users/${users.target.id}/reset-link`, superCookie);
    const { link, expiresAt } = (await second.json()) as { link: string; expiresAt: string };
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000); // determinism-ok: the database clock sets the expiry
    // A new reset revokes the older unused one.
    expect(
      (await describeLink(tokenOf(((await first.json()) as { link: string }).link))).status
    ).toBe(404);

    await admin`UPDATE mnemosyne.mnemo_user_credential SET failed_attempts = 5, locked_until = now() + interval '1 hour' WHERE user_id = ${users.target.id}`;
    const token = tokenOf(link);
    expect(await (await describeLink(token)).json()).toMatchObject({
      purpose: "password_reset",
      accountExists: true,
    });
    const reset = await acceptLink(token, { password: newPassword });
    expect(reset.status).toBe(200);
    expect(await sessionOf(cookieOf(reset)!)).toMatchObject({ userId: users.target.id });
    // The session open before the reset is over.
    expect((await call("GET", "/workspace/members", targetSession)).status).toBe(401);
    const [credential] = await admin`
      SELECT failed_attempts, locked_until FROM mnemosyne.mnemo_user_credential WHERE user_id = ${users.target.id}`;
    expect(credential).toEqual({ failed_attempts: 0, locked_until: null });
    expect((await signIn(emails.target, undefined, password)).status).toBe(401);
    expect((await signIn(emails.target, undefined, newPassword)).status).toBe(200);
    expect((await acceptLink(token, { password: newPassword })).status).toBe(404);
    const audit = await admin`
      SELECT actor_id, workspace_id::text AS workspace_id FROM mnemosyne.mnemo_audit_log
      WHERE action = 'password_reset'`;
    expect(audit).toEqual([{ actor_id: `user:${users.target.id}`, workspace_id: GLOBAL }]);
  });

  it("refuses a reset link for an unknown user (404)", async () => {
    expect(
      (await call("POST", "/instance/users/no-such-user/reset-link", superCookie)).status
    ).toBe(404);
  });
});

describe("no link or token in logs and audit rows", () => {
  it("issues, regenerates, reads and accepts links without logging or auditing them", async () => {
    const spies = (["info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(logger, level)
    );
    const secrets: string[] = [];
    try {
      const ownerCookie = await mustSignIn(emails.owner, team);
      const superCookie = await mustSignIn(emails.superadmin);
      const issued = await invite(ownerCookie, "quiet@example.test", "read");
      const regen = (await (
        await call("POST", `/workspace/invitations/${issued.body.id}/regenerate`, ownerCookie)
      ).json()) as { link: string };
      const setup = (await (
        await call("POST", "/instance/users", superCookie, { email: "quiet-setup@example.test" })
      ).json()) as { link: string };
      const reset = (await (
        await call("POST", `/instance/users/${users.writer.id}/reset-link`, superCookie)
      ).json()) as { link: string };
      for (const link of [issued.body.link, regen.link, setup.link, reset.link]) {
        const token = tokenOf(link);
        secrets.push(link, token, hashLinkToken(token));
        await describeLink(token);
      }
      await acceptLink(tokenOf(issued.body.link), { password: newPassword });
      await acceptLink(tokenOf(regen.link), { password: newPassword });
      await acceptLink(tokenOf(setup.link), { password: newPassword });
      const logged = spies.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)));
      expect(logged.length).toBeGreaterThan(0);
      for (const line of logged) for (const s of secrets) expect(line).not.toContain(s);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const rows = await admin`SELECT row_to_json(a)::text AS row FROM mnemosyne.mnemo_audit_log a`;
    expect(rows.length).toBeGreaterThan(0);
    for (const { row } of rows) {
      for (const s of secrets) expect(row as string).not.toContain(s);
      // Nor the invitees' addresses: the link row holds them.
      expect(row as string).not.toContain("quiet");
    }
  });
});

describe("member removal revokes that workspace's user-bound keys (I5)", () => {
  let v1: Hono;
  let closeLookup: () => Promise<void>;
  beforeAll(async () => {
    const { createApiKeyLookup } = await import("@mnemo-ai/core");
    const lookup = createApiKeyLookup({ databaseUrl: dbUrl });
    closeLookup = () => lookup.close();
    v1 = new Hono<{ Variables: AuthVariables }>();
    v1.onError((err, c) => {
      const { status, body } = toErrorBody(err);
      return c.json(body, status as 400);
    });
    v1.use("*", createAuthMiddleware(lookup, { userStatus }));
    v1.get("/whoami", (c) => c.json({ workspaceId: c.get("workspaceId") }));
  });
  afterAll(async () => {
    await closeLookup?.();
  });

  /** A user-bound key for `userId` homed in `workspaceId`; returns its token. */
  let keyCount = 0;
  const mintKey = async (userId: string, workspaceId: string) => {
    keyCount++;
    const token = `uk_live_${"i5".repeat(10)}${String(keyCount).padStart(12, "0")}`;
    await admin`
      INSERT INTO mnemosyne.mnemo_api_keys
        (id, workspace_id, user_id, key_kind, key_hash, lookup_hash, name, label, scopes)
      VALUES (${`uk_i5${keyCount}`}, ${workspaceId}, ${userId}, 'user', ${await bcrypt.hash(token, 4)},
              ${computeLookupHash(token)}, 'i5', 'i5', ARRAY['memory:read', 'memory:write'])`;
    return token;
  };
  const whoami = (token: string) =>
    v1.request("/whoami", { headers: { authorization: `Bearer ${token}` } });

  for (const via of ["workspace", "instance"] as const) {
    it(`removal through the ${via} route revokes the member's keys there at once`, async () => {
      const member = await provisionUser(`i5-${via}@example.test`, `I5 ${via}`);
      const { workspace } = await createTeam(`I5 ${via} team`, [
        [users.owner.id, "owner"],
        [member.id, "write"],
      ]);
      const teamKey = await mintKey(member.id, workspace);
      const personalKey = await mintKey(member.id, member.workspace);
      // Both work, and the team key is now in the auth caches.
      expect((await whoami(teamKey)).status).toBe(200);
      expect((await whoami(personalKey)).status).toBe(200);

      const res =
        via === "workspace"
          ? await call(
              "DELETE",
              `/workspace/members/${member.id}`,
              await mustSignIn(emails.owner, workspace)
            )
          : await call(
              "DELETE",
              `/instance/workspaces/${workspace}/members/${member.id}`,
              await mustSignIn(emails.superadmin)
            );
      expect(res.status).toBe(200);

      expect((await whoami(teamKey)).status).toBe(401);
      expect((await whoami(personalKey)).status).toBe(200);
      const keys = await admin`
        SELECT workspace_id, revoked_at IS NOT NULL AS revoked FROM mnemosyne.mnemo_api_keys
        WHERE user_id = ${member.id} ORDER BY workspace_id = ${workspace} DESC`;
      expect(keys).toEqual([
        { workspace_id: workspace, revoked: true },
        { workspace_id: member.workspace, revoked: false },
      ]);
    });
  }

  it("a refused removal (last owner) revokes nothing", async () => {
    const soleOwner = await provisionUser("i5-sole@example.test", "I5 sole");
    const { workspace } = await createTeam("I5 sole team", [[soleOwner.id, "owner"]]);
    const key = await mintKey(soleOwner.id, workspace);
    const res = await call(
      "DELETE",
      `/instance/workspaces/${workspace}/members/${soleOwner.id}`,
      await mustSignIn(emails.superadmin)
    );
    expect(res.status).toBe(409);
    expect((await whoami(key)).status).toBe(200);
  });
});

describe("0054 database rules", () => {
  const asApp = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    client.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      return fn(tx);
    }) as Promise<T>;
  const granted = [
    "mnemo_workspace_member_profiles",
    "mnemo_workspace_invitations",
    "mnemo_workspace_set_member_role",
    "mnemo_workspace_remove_member",
    "mnemo_link_issue",
    "mnemo_invitation_regenerate",
    "mnemo_invitation_revoke",
    "mnemo_link_describe",
    "mnemo_link_consume",
  ];
  const internal = [
    "mnemo_workspace_is_personal",
    "mnemo_workspace_active_role",
    "mnemo_workspace_lock",
    "mnemo_workspace_lock_as_admin",
    "mnemo_workspace_member_apply",
    "mnemo_link_email_lock",
    "mnemo_link_usable",
  ];

  it("restricts the granted functions to the app roles, pins search_path, keeps helpers internal", async () => {
    const functions = await admin`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec,
             has_function_privilege('mnemo_app_role', p.oid, 'EXECUTE') AS app_role_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'mnemosyne' AND p.proname = ANY(${[...granted, ...internal]})`;
    expect(functions.map((f) => f.proname).sort()).toEqual([...granted, ...internal].sort());
    for (const fn of functions) {
      const isGranted = granted.includes(fn.proname as string);
      expect(fn, fn.proname as string).toMatchObject({
        prosecdef: isGranted,
        public_exec: false,
        app_user_exec: isGranted,
        app_role_exec: isGranted,
        proconfig: ["search_path=mnemosyne, pg_temp"],
      });
    }
  });

  it("no app role reads or writes mnemo_link_token directly; RLS is forced", async () => {
    await expect(asApp((tx) => tx`SELECT * FROM mnemosyne.mnemo_link_token`)).rejects.toMatchObject(
      {
        code: "42501",
      }
    );
    const [table] = await admin`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'mnemosyne.mnemo_link_token'::regclass`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("account setup and reset links need a superadmin; invitations an owner or admin", async () => {
    const hash = "0".repeat(64);
    await expect(
      asApp(
        (tx) =>
          tx`SELECT mnemosyne.mnemo_link_issue(${users.owner.id}, 'password_reset', ${emails.writer}, NULL, NULL, ${hash}, '30 minutes')`
      )
    ).rejects.toMatchObject({ code: "42501", message: "not_superadmin" });
    await expect(
      asApp(
        (tx) =>
          tx`SELECT mnemosyne.mnemo_link_issue(${users.writer.id}, 'invite', 'x@example.test', ${team}, 'read', ${hash}, '7 days')`
      )
    ).rejects.toMatchObject({ code: "42501", message: "not_workspace_admin" });
    await expect(
      asApp(
        (tx) =>
          tx`SELECT mnemosyne.mnemo_link_issue(${users.superadmin.id}, 'invite', 'x@example.test', ${team}, 'read', ${hash}, '7 days')`
      )
    ).rejects.toMatchObject({ code: "42501", message: "not_workspace_admin" });
  });

  it("an invitation whose issuer was removed or disabled is link_invalid at consume", async () => {
    const removed = await provisionUser("issuer-removed@example.test", "Removed");
    const disabled = await provisionUser("issuer-disabled@example.test", "Disabled");
    const { workspace } = await createTeam("Issuer team", [
      [users.owner.id, "owner"],
      [removed.id, "admin"],
      [disabled.id, "admin"],
    ]);
    const issue = async (actor: string, email: string) => {
      const { hash } = newLinkToken();
      await asApp(
        (tx) =>
          tx`SELECT mnemosyne.mnemo_link_issue(${actor}, 'invite', ${email}, ${workspace}, 'read', ${hash}, '7 days')`
      );
      return hash;
    };
    const cases = [
      {
        hash: await issue(removed.id, "via-removed@example.test"),
        email: "via-removed@example.test",
      },
      {
        hash: await issue(disabled.id, "via-disabled@example.test"),
        email: "via-disabled@example.test",
      },
    ];
    // (a) the issuer leaves the workspace, (b) the issuer is disabled.
    await admin`DELETE FROM mnemosyne.mnemo_workspace_member WHERE workspace_id = ${workspace} AND user_id = ${removed.id}`;
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${disabled.id}`;
    for (const { hash, email } of cases) {
      const [row] = await admin`
        SELECT mnemosyne.mnemo_link_usable(t) AS usable FROM mnemosyne.mnemo_link_token t
        WHERE t.token_hash = ${hash}`;
      // false, never NULL: NOT NULL would let a consume through.
      expect(row!.usable).toBe(false);
      expect(
        await asApp((tx) => tx`SELECT * FROM mnemosyne.mnemo_link_describe(${hash})`)
      ).toHaveLength(0);
      await expect(
        asApp(
          (tx) => tx`SELECT * FROM mnemosyne.mnemo_link_consume(${hash}, ${passwordHash}, NULL)`
        )
      ).rejects.toMatchObject({ code: "P0002", message: "link_invalid" });
      expect(await usersWithEmail(email)).toHaveLength(0);
    }
    expect(
      await admin`SELECT 1 FROM mnemosyne.mnemo_link_token WHERE token_hash = ANY(${cases.map((c) => c.hash)}) AND consumed_at IS NOT NULL`
    ).toHaveLength(0);
  });

  it("a setup or reset link whose issuer lost superadmin is link_invalid at consume (I1)", async () => {
    const revoked = await provisionUser("link-issuer-revoked@example.test", "Revoked");
    const disabled = await provisionUser("link-issuer-disabled@example.test", "Disabled");
    const victims = [
      await provisionUser("link-victim-a@example.test", "VictimA"),
      await provisionUser("link-victim-b@example.test", "VictimB"),
    ];
    await admin`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${revoked.id}, 'system:test'), (${disabled.id}, 'system:test')`;
    const issue = async (actor: string, purpose: string, email: string) => {
      const { hash } = newLinkToken();
      await asApp(
        (tx) =>
          tx`SELECT mnemosyne.mnemo_link_issue(${actor}, ${purpose}, ${email}, NULL, NULL, ${hash}, '30 minutes')`
      );
      return hash;
    };
    const hashes = [
      await issue(revoked.id, "account_setup", "setup-via-revoked@example.test"),
      await issue(disabled.id, "account_setup", "setup-via-disabled@example.test"),
      await issue(revoked.id, "password_reset", "link-victim-a@example.test"),
      await issue(disabled.id, "password_reset", "link-victim-b@example.test"),
    ];
    const credentials = () =>
      admin`SELECT user_id, password_hash FROM mnemosyne.mnemo_user_credential
            WHERE user_id = ANY(${victims.map((v) => v.id)}) ORDER BY user_id`;
    const credentialsBefore = await credentials();
    // (a) superadmin revoked, (b) the issuer disabled (still holding the grant).
    await admin`DELETE FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${revoked.id}`;
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${disabled.id}`;
    for (const hash of hashes) {
      const [row] = await admin`
        SELECT t.revoked_at, mnemosyne.mnemo_link_usable(t) AS usable
        FROM mnemosyne.mnemo_link_token t WHERE t.token_hash = ${hash}`;
      expect(row!.revoked_at).toBeNull();
      // false, never NULL.
      expect(row!.usable).toBe(false);
      expect(
        await asApp((tx) => tx`SELECT * FROM mnemosyne.mnemo_link_describe(${hash})`)
      ).toHaveLength(0);
      await expect(
        asApp(
          (tx) => tx`SELECT * FROM mnemosyne.mnemo_link_consume(${hash}, ${passwordHash}, NULL)`
        )
      ).rejects.toMatchObject({ code: "P0002", message: "link_invalid" });
    }
    expect(await usersWithEmail("setup-via-revoked@example.test")).toHaveLength(0);
    expect(await usersWithEmail("setup-via-disabled@example.test")).toHaveLength(0);
    expect(await credentials()).toEqual(credentialsBefore);
  });

  it("the member helper refuses a NULL remove flag instead of reading it as a role change", async () => {
    await expect(
      admin`SELECT mnemosyne.mnemo_workspace_member_apply(${team}, ${users.writer.id}, 'read', NULL, NULL)`
    ).rejects.toMatchObject({ code: "22023" });
    expect(await membership(team, users.writer.id)).toBe("write");
  });

  it("reverts with the down migration and re-applies", async () => {
    const file = (suffix: string) =>
      readFile(resolve(migrationsDir, `0054_single_use_links${suffix}`), "utf8");
    const present = async () =>
      (
        await admin`
          SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'mnemosyne' AND p.proname = ANY(${[...granted, ...internal]})`
      ).length;
    const conn = await admin.reserve();
    try {
      await conn.unsafe(await file(".down.sql"));
    } finally {
      conn.release();
    }
    expect(await present()).toBe(0);
    expect((await admin`SELECT to_regclass('mnemosyne.mnemo_link_token') AS t`)[0]!.t).toBeNull();
    // 0053's instance member functions still work without the helpers.
    const members = await asApp(
      (tx) =>
        tx`SELECT * FROM mnemosyne.mnemo_instance_workspace_members(${users.superadmin.id}, ${team})`
    );
    expect(members.length).toBeGreaterThan(0);
    const up = await file(".sql");
    await admin.begin((tx) => tx.unsafe(up));
    expect(await present()).toBe(granted.length + internal.length);
  });
});
