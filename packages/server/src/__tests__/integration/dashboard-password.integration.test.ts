/** Real Postgres / NOSUPERUSER contract. Coordinator runs with Node >=22 + Docker. */
import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import bcrypt from "bcrypt";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DashboardPasswordAuth, PostgresCredentialStore } from "../../dashboard-password.js";
import { mountDashboardAuth } from "../../routes/dashboard-auth.js";
import { createDrizzleClient, DrizzleStorageAdapter } from "@mnemo-ai/adapter-postgres";
import { mountBootstrap } from "../../routes/bootstrap.js";
import { mountDashboardApi } from "../../routes/dashboard-api.js";
import { verifyDashboardToken } from "../../dashboard-session.js";
import { PostgresUserStatusSource, UserStatusService } from "../../user-status.js";
import { toErrorBody } from "../../errors.js";
import { logger } from "../../logging.js";
import type { ServerDeps } from "../../deps.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const password = "integration password twelve";
const email = "dashboard-person@example.test";
let container: StartedTestContainer;
let admin: postgres.Sql;
let client: postgres.Sql;
let auth: DashboardPasswordAuth;
let userStatus: UserStatusService;
let app: Hono;
let userId: string, otherId: string, workspaceId: string, otherWorkspace: string;
let appUrl: string;
let adminUrl: string;

const post = (path: string, body: unknown, cookie?: string) =>
  app.request(`/dashboard/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`) && !cookie.startsWith(`${name}=;`))
    ?.split(";")[0];

beforeAll(async () => {
  container = await new GenericContainer("pgvector/pgvector:pg17")
    .withEnvironment({ POSTGRES_USER: "mnemo", POSTGRES_PASSWORD: "mnemo", POSTGRES_DB: "mnemo" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const address = `${container.getHost()}:${container.getMappedPort(5432)}/mnemo`;
  const url = `postgres://mnemo:mnemo@${address}`;
  adminUrl = url;
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
    "CREATE ROLE dashboard_test LOGIN PASSWORD 'dashboard-test-only' NOSUPERUSER NOBYPASSRLS; GRANT app_user, mnemo_app_role TO dashboard_test; GRANT USAGE ON SCHEMA mnemosyne TO dashboard_test;"
  );
  appUrl = `postgres://dashboard_test:dashboard-test-only@${address}`;
  client = postgres(appUrl, { max: 10, onnotice: () => {} });
  // Match createDrizzlePool: Drizzle mutates this same raw client's timestamps.
  drizzle(client);
  // Fixtures use migration owner's provisioning helper, isolated per account.
  const [user] =
    await admin`SELECT * FROM mnemosyne.mnemo_provision_user(${email}, 'Person', 'Personal')`;
  const [other] =
    await admin`SELECT * FROM mnemosyne.mnemo_provision_user('dashboard-other@example.test', 'Other', 'Other workspace')`;
  userId = user!.user_id;
  workspaceId = user!.workspace_id;
  otherId = other!.user_id;
  otherWorkspace = other!.workspace_id;
  await admin`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${userId}, ${await bcrypt.hash(password, 12)}), (${otherId}, ${await bcrypt.hash(password, 12)})`;
  auth = new DashboardPasswordAuth(new PostgresCredentialStore(client));
  vi.stubEnv("MNEMO_DASHBOARD_SECRET", "integration-dashboard-secret-more-than-32-bytes");
  userStatus = new UserStatusService(new PostgresUserStatusSource(client));
  app = new Hono();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as 400);
  });
  const storageClient = createDrizzleClient(appUrl);
  const deps = {
    dashboardPasswordAuth: auth,
    metricsPgClient: client,
    userStatus,
    storage: new DrizzleStorageAdapter(storageClient.db, storageClient.pgClient),
  } as ServerDeps;
  mountDashboardAuth(app, deps);
  mountDashboardApi(app, deps);
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  await client?.end();
  await admin?.end();
  await container?.stop();
});

describe("dashboard password Postgres", () => {
  it("AUTH-01 authenticates under NOSUPERUSER and gets role from workspace membership", async () => {
    const res = await post("login", { email: email.toUpperCase(), password });
    expect(res.status).toBe(200);
    expect((await res.json()).role).toBe("admin");
    const session = await app.request("/dashboard/auth/session", {
      headers: { cookie: cookieOf(res, "mnemo_dash_token")! },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      workspaceName: "Personal",
      // The membership role and whether this is the user's own personal
      // workspace: the sidebar shows "Owner" (not the scope-derived "admin"),
      // and Members hides invitations in a personal workspace.
      workspaceRole: "owner",
      workspaceIsPersonal: true,
    });
  });
  it("reports a team workspace's membership role and that it is not personal", async () => {
    const [team] =
      await admin`SELECT * FROM mnemosyne.mnemo_provision_user('dashboard-team-owner@example.test', 'Team owner', 'Team workspace')`;
    await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${team!.workspace_id}, ${userId}, 'admin')`;
    try {
      const res = await post("login", { email, password });
      const choice = cookieOf(res, "mnemo_dash_choice")!;
      const picked = await post("workspace", { workspaceId: team!.workspace_id }, choice);
      expect(picked.status).toBe(200);
      const session = await app.request("/dashboard/auth/session", {
        headers: { cookie: cookieOf(picked, "mnemo_dash_token")! },
      });
      expect(await session.json()).toMatchObject({
        workspaceName: "Team workspace",
        workspaceRole: "admin",
        workspaceIsPersonal: false,
      });
    } finally {
      await admin`DELETE FROM mnemosyne.mnemo_workspace_member WHERE workspace_id = ${team!.workspace_id} AND user_id = ${userId}`;
    }
  });
  it("AUTH-10 FORCE RLS hides and refuses other users' credentials", async () => {
    await client.begin(async (tx) => {
      await tx`SET LOCAL ROLE app_user`;
      await tx`SELECT set_config('mnemosyne.actor_user_id', ${userId}, true), set_config('mnemosyne.actor_tenant_id', '', true)`;
      expect(
        await tx`SELECT user_id FROM mnemosyne.mnemo_user_credential WHERE user_id = ${otherId}`
      ).toHaveLength(0);
      const updated =
        await tx`UPDATE mnemosyne.mnemo_user_credential SET failed_attempts = 99 WHERE user_id = ${otherId} RETURNING user_id`;
      expect(updated).toHaveLength(0);
    });
    const [policy] =
      await admin`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'mnemosyne.mnemo_user_credential'::regclass`;
    expect(policy).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    await admin.unsafe(
      "CREATE ROLE dashboard_untrusted NOLOGIN; GRANT USAGE ON SCHEMA mnemosyne TO dashboard_untrusted;"
    );
    await expect(
      admin.begin(async (tx) => {
        await tx`SET LOCAL ROLE dashboard_untrusted`;
        await tx`SELECT * FROM mnemosyne.mnemo_dashboard_credential_lookup(${email})`;
      })
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("AUTH-13 Drizzle locks on the fifth failure, returns generic 401, and resets after expiry", async () => {
    const isolated = new Hono();
    mountDashboardAuth(isolated, { dashboardPasswordAuth: auth } as ServerDeps);
    const login = (value: string) =>
      isolated.request("/dashboard/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: value }),
      });
    const invalid = { error: "invalid_credentials", message: "Invalid email or password." };
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await login("incorrect password");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(invalid);
      const [row] =
        await admin`SELECT failed_attempts, locked_until > now() AS locked FROM mnemosyne.mnemo_user_credential WHERE user_id = ${userId}`;
      expect(row!.failed_attempts).toBe(attempt);
      expect(row!.locked).toBe(attempt === 5 ? true : null);
    }
    for (const value of [password, "incorrect password"]) {
      const res = await login(value);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(invalid);
      expect(cookieOf(res, "mnemo_dash_token")).toBeUndefined();
    }
    await admin`UPDATE mnemosyne.mnemo_user_credential SET locked_until = now() - interval '1 second' WHERE user_id = ${userId}`;
    expect((await login(password)).status).toBe(200);
    const [reset] =
      await admin`SELECT failed_attempts, locked_until FROM mnemosyne.mnemo_user_credential WHERE user_id = ${userId}`;
    expect(reset).toMatchObject({ failed_attempts: 0, locked_until: null });
    // A successful login also resets failures before the threshold is reached.
    expect((await login("incorrect password")).status).toBe(401);
    expect((await login(password)).status).toBe(200);
    const [success] =
      await admin`SELECT failed_attempts FROM mnemosyne.mnemo_user_credential WHERE user_id = ${userId}`;
    expect(success!.failed_attempts).toBe(0);
  });
  it("AUTH-04 concurrent failures are serialized without losing counters", async () => {
    await Promise.all(Array.from({ length: 5 }, () => auth.login(email, "incorrect password")));
    const [row] =
      await admin`SELECT failed_attempts, locked_until > now() AS locked FROM mnemosyne.mnemo_user_credential WHERE user_id = ${userId}`;
    expect(row).toMatchObject({ failed_attempts: 5, locked: true });
    expect(await auth.login(email, password)).toBeNull();
    await admin`UPDATE mnemosyne.mnemo_user_credential SET locked_until = now() - interval '1 second' WHERE user_id = ${userId}`;
    expect(await auth.login(email, password)).not.toBeNull();
  });
  it("AUTH-05 handles workspaces across tenants and rejects removed membership", async () => {
    await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${otherWorkspace}, ${userId}, 'read')`;
    const res = await post("login", { email, password });
    expect((await res.json()).requiresWorkspace).toBe(true);
    const choice = cookieOf(res, "mnemo_dash_choice")!;
    await admin`DELETE FROM mnemosyne.mnemo_workspace_member WHERE workspace_id = ${otherWorkspace} AND user_id = ${userId}`;
    expect((await post("workspace", { workspaceId: otherWorkspace }, choice)).status).toBe(401);
    expect((await post("workspace", { workspaceId }, choice)).status).toBe(200);
  });
  it("AUTH-08 changes hash and invalidates the old password in real storage", async () => {
    const login = await post("login", { email, password });
    const cookie = cookieOf(login, "mnemo_dash_token")!;
    const replacement = "integration replacement password";
    expect(
      (await post("password", { currentPassword: password, newPassword: replacement }, cookie))
        .status
    ).toBe(200);
    expect(await auth.login(email, password)).toBeNull();
    expect(await auth.login(email, replacement)).not.toBeNull();
    const [row] =
      await admin`SELECT password_hash FROM mnemosyne.mnemo_user_credential WHERE user_id = ${userId}`;
    expect(bcrypt.getRounds(row!.password_hash)).toBe(12);
  });
  it("AUTH-02 rejects ambiguous email case variants", async () => {
    const [variant] =
      await admin`SELECT * FROM mnemosyne.mnemo_provision_user(${email.toUpperCase()}, 'Duplicate', 'Duplicate')`;
    expect(await auth.login(email, "integration replacement password")).toBeNull();
    await admin`UPDATE mnemosyne.mnemo_user SET email = 'duplicate-retired@example.test' WHERE id = ${variant!.user_id}`;
  });
  it("AUTH-08 admin command provisions a test user and reads password exclusively on stdin", async () => {
    const child = spawn(
      process.execPath,
      [
        resolve(root, "packages/server/scripts/dashboard-password.mjs"),
        "--email",
        "dashboard-script@example.test",
        "--create",
      ],
      { env: { ...process.env, DATABASE_URL: appUrl }, stdio: ["pipe", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.resume();
    const exit = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
    child.stdin.end(password + "\n");
    expect(await exit).toBe(0);
    expect(output).toBe("Password set successfully.\n");
    const identity = await auth.login("dashboard-script@example.test", password);
    expect(identity!.memberships).toEqual([
      expect.objectContaining({ name: "Personal", role: "owner" }),
    ]);
  });
});

it("AUTH-17 --create --workspace grants only the requested workspace", async () => {
  const scriptEmail = "dashboard-assigned@example.test";
  const child = spawn(
    process.execPath,
    [
      resolve(root, "packages/server/scripts/dashboard-password.mjs"),
      "--email",
      scriptEmail,
      "--create",
      "--workspace",
      workspaceId,
    ],
    {
      env: { ...process.env, DATABASE_URL: appUrl },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  child.stdout.resume();
  child.stderr.resume();
  const exit = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  child.stdin.end(password + "\n");
  expect(await exit).toBe(0);
  const identity = await auth.login(scriptEmail, password);
  expect(identity!.memberships).toEqual([{ id: workspaceId, name: "Personal", role: "read" }]);
  const [personal] =
    await admin`SELECT count(*)::int AS count FROM mnemosyne.mnemo_workspace w JOIN mnemosyne.mnemo_user u ON w.tenant_id = u.personal_tenant_id WHERE u.id = ${identity!.userId}`;
  expect(personal!.count).toBe(0);
});

describe("live status on every session (accounts stage A)", () => {
  const liveEmail = "dashboard-live@example.test";
  let liveId: string;
  let liveWorkspace: string;
  const login = () => post("login", { email: liveEmail, password });
  const session = (cookie: string) =>
    app.request("/dashboard/auth/session", { headers: { cookie } });
  const writeFact = (cookie: string) =>
    // PATCH /facts/{id} is a real bridge route that needs memory:write.
    app.request("/dashboard/api/facts/00000000-0000-4000-8000-000000000000", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });

  beforeAll(async () => {
    const [user] =
      await admin`SELECT * FROM mnemosyne.mnemo_provision_user(${liveEmail}, 'Live', 'Live workspace')`;
    liveId = user!.user_id;
    liveWorkspace = user!.workspace_id;
    await admin`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${liveId}, ${await bcrypt.hash(password, 12)})`;
  });
  const reset = async () => {
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = NULL, sessions_valid_after = 'epoch' WHERE id = ${liveId}`;
    await admin`DELETE FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${liveId}`;
    await admin`UPDATE mnemosyne.mnemo_workspace_member SET role = 'owner' WHERE workspace_id = ${liveWorkspace} AND user_id = ${liveId}`;
    userStatus.invalidate(liveId);
  };

  it("stamps last_login_at when a session is minted", async () => {
    await reset();
    const res = await login();
    expect(res.status).toBe(200);
    const [row] =
      await admin`SELECT last_login_at > now() - interval '1 minute' AS recent FROM mnemosyne.mnemo_user WHERE id = ${liveId}`;
    expect(row!.recent).toBe(true);
  });

  it("refuses a disabled user's login with the generic body, audits disabled, counts no failure", async () => {
    await reset();
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${liveId}`;
    const log = vi.spyOn(logger, "info");
    try {
      const res = await login();
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "invalid_credentials",
        message: "Invalid email or password.",
      });
      expect(cookieOf(res, "mnemo_dash_token")).toBeUndefined();
      expect(log.mock.calls.map(([fields]) => fields)).toContainEqual(
        expect.objectContaining({ event: "dashboard.password_auth", reason: "disabled" })
      );
    } finally {
      log.mockRestore();
    }
    const [row] =
      await admin`SELECT failed_attempts FROM mnemosyne.mnemo_user_credential WHERE user_id = ${liveId}`;
    expect(row!.failed_attempts).toBe(0);
  });

  it("ends a disabled user's existing session on the next request", async () => {
    await reset();
    const cookie = cookieOf(await login(), "mnemo_dash_token")!;
    expect((await session(cookie)).status).toBe(200);
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${liveId}`;
    userStatus.invalidate(liveId);
    expect((await session(cookie)).status).toBe(401);
    const bridged = await app.request("/dashboard/api/facts", { headers: { cookie } });
    expect(bridged.status).toBe(401);
    expect(await bridged.json()).toEqual({ error: "no_session" });
  });

  it("sign out revokes that session in Postgres; the user's other session stays (AUD-007)", async () => {
    await reset();
    const signedOut = cookieOf(await login(), "mnemo_dash_token")!;
    const other = cookieOf(await login(), "mnemo_dash_token")!;
    expect(other).not.toBe(signedOut);
    expect((await session(signedOut)).status).toBe(200);

    const out = await app.request("/dashboard/auth/logout", {
      method: "POST",
      headers: { cookie: signedOut },
    });
    expect(out.status).toBe(200);

    expect((await session(signedOut)).status).toBe(401);
    const bridged = await app.request("/dashboard/api/facts", { headers: { cookie: signedOut } });
    expect(bridged.status).toBe(401);
    expect(await bridged.json()).toEqual({ error: "no_session" });
    expect((await session(other)).status).toBe(200);

    // Only the hash of the signed jti is stored.
    const token = signedOut.split("=")[1]!;
    const payload = (await verifyDashboardToken(
      "integration-dashboard-secret-more-than-32-bytes",
      token
    ))!;
    const [row] =
      await admin`SELECT session_hash, expires_at FROM mnemosyne.mnemo_dashboard_session_revocation WHERE session_hash = encode(sha256(convert_to(${payload.jti}, 'UTF8')), 'hex')`;
    expect(row!.session_hash).toBe(payload.sid);
    // Kept the session TTL plus an hour's margin from the sign-out: it outlives every token
    // of the session, a re-issue racing the sign-out and clock skew included.
    const until = new Date(row!.expires_at).getTime();
    expect(until).toBeGreaterThanOrEqual(payload.exp * 1000 + 3600_000 - 5_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 9 * 3600_000 + 5_000); // determinism-ok: bound on a server-side clock
    // The app role reaches the table only through the two functions.
    await expect(
      client`SELECT * FROM mnemosyne.mnemo_dashboard_session_revocation`
    ).rejects.toThrow(/permission denied/);
  });

  it("a workspace switch keeps the session: sign-out ends the pre- and post-switch tokens", async () => {
    // Its own account: the per-email sign-in budget of the live account is spent by the
    // other tests here.
    const switchEmail = "dashboard-switch@example.test";
    const [user] =
      await admin`SELECT * FROM mnemosyne.mnemo_provision_user(${switchEmail}, 'Switch', 'Switch personal')`;
    const [team] =
      await admin`SELECT * FROM mnemosyne.mnemo_provision_user('dashboard-switch-owner@example.test', 'Switch owner', 'Switch team')`;
    await admin`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${user!.user_id}, ${await bcrypt.hash(password, 12)})`;
    await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${team!.workspace_id}, ${user!.user_id}, 'write')`;
    // Two memberships: sign-in asks for the workspace first.
    const choice = cookieOf(
      await post("login", { email: switchEmail, password }),
      "mnemo_dash_choice"
    )!;
    const picked = await post("workspace", { workspaceId: user!.workspace_id }, choice);
    const before = cookieOf(picked, "mnemo_dash_token")!;
    const switched = await app.request(
      `/dashboard/api/my-workspaces/${team!.workspace_id}/switch`,
      {
        method: "POST",
        headers: { cookie: before },
      }
    );
    expect(switched.status).toBe(200);
    const after = cookieOf(switched, "mnemo_dash_token")!;
    expect(after).not.toBe(before);

    await app.request("/dashboard/auth/logout", { method: "POST", headers: { cookie: after } });

    expect((await session(after)).status).toBe(401);
    expect((await session(before)).status).toBe(401);
    expect(
      (await app.request("/dashboard/api/facts", { headers: { cookie: before } })).status
    ).toBe(401);
  });

  it("refuses a JWT issued before sessions_valid_after", async () => {
    await reset();
    const cookie = cookieOf(await login(), "mnemo_dash_token")!;
    await admin`UPDATE mnemosyne.mnemo_user SET sessions_valid_after = now() + interval '1 second' WHERE id = ${liveId}`;
    userStatus.invalidate(liveId);
    expect((await session(cookie)).status).toBe(401);
    expect((await app.request("/dashboard/api/facts", { headers: { cookie } })).status).toBe(401);
  });

  it("applies a demotion and a removal on the next request, without re-login", async () => {
    await reset();
    await admin`UPDATE mnemosyne.mnemo_workspace_member SET role = 'write' WHERE workspace_id = ${liveWorkspace} AND user_id = ${liveId}`;
    const cookie = cookieOf(await login(), "mnemo_dash_token")!;
    expect([401, 403]).not.toContain((await writeFact(cookie)).status);
    await admin`UPDATE mnemosyne.mnemo_workspace_member SET role = 'read' WHERE workspace_id = ${liveWorkspace} AND user_id = ${liveId}`;
    const demoted = await writeFact(cookie);
    expect(demoted.status).toBe(403);
    expect((await demoted.json()).error.code).toBe("INSUFFICIENT_SCOPE");
    expect((await (await session(cookie)).json()).role).toBe("viewer");
    await admin`DELETE FROM mnemosyne.mnemo_workspace_member WHERE workspace_id = ${liveWorkspace} AND user_id = ${liveId}`;
    try {
      expect((await writeFact(cookie)).status).toBe(401);
      expect((await session(cookie)).status).toBe(401);
    } finally {
      await admin`INSERT INTO mnemosyne.mnemo_workspace_member (workspace_id, user_id, role) VALUES (${liveWorkspace}, ${liveId}, 'owner')`;
    }
  });

  it("grants admin:workspace to a live superadmin only", async () => {
    await reset();
    const cookie = cookieOf(await login(), "mnemo_dash_token")!;
    const put = () =>
      app.request("/dashboard/api/admin/config/llm", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ provider: "openai" }),
      });
    expect((await put()).status).toBe(403);
    expect(await (await session(cookie)).json()).toMatchObject({
      isSuperadmin: false,
      email: liveEmail,
    });
    await admin`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${liveId}, 'test')`;
    userStatus.invalidate(liveId);
    expect([401, 403]).not.toContain((await put()).status);
    const body = await (await session(cookie)).json();
    expect(body.isSuperadmin).toBe(true);
    expect(body.scopes).toContain("admin:workspace");
    await reset();
  });

  it("password change ends other sessions and re-mints the caller's cookie after sessions_valid_after", async () => {
    await reset();
    const first = cookieOf(await login(), "mnemo_dash_token")!;
    const other = cookieOf(await login(), "mnemo_dash_token")!;
    const replacement = "live replacement password";
    const res = await post(
      "password",
      { currentPassword: password, newPassword: replacement },
      first
    );
    expect(res.status).toBe(200);
    const renewed = cookieOf(res, "mnemo_dash_token")!;
    expect(renewed).toBeDefined();
    expect((await session(renewed)).status).toBe(200);
    expect((await app.request("/dashboard/api/facts", { headers: { cookie: other } })).status).toBe(
      401
    );
    expect((await session(other)).status).toBe(401);
    expect((await session(first)).status).toBe(401);
    const [row] =
      await admin`SELECT extract(epoch FROM sessions_valid_after)::float8 AS after FROM mnemosyne.mnemo_user WHERE id = ${liveId}`;
    const payload = (await verifyDashboardToken(
      "integration-dashboard-secret-more-than-32-bytes",
      renewed.split("=")[1]!
    ))!;
    expect(payload.iat).toBeGreaterThanOrEqual(Math.ceil(row!.after));
    const old = (await verifyDashboardToken(
      "integration-dashboard-secret-more-than-32-bytes",
      other.split("=")[1]!
    ))!;
    expect(old.iat).toBeLessThan(Math.ceil(row!.after));
  });
});

/** Runs the admin script with the password on stdin; resolves to exit code and output. */
async function runScript(args: string[], env: Record<string, string | undefined>) {
  const child = spawn(
    process.execPath,
    [resolve(root, "packages/server/scripts/dashboard-password.mjs"), ...args],
    {
      env: { ...process.env, MNEMO_ADMIN_DATABASE_URL: undefined, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exit = new Promise<number | null>((res, rej) => {
    child.once("error", rej);
    child.once("exit", res);
  });
  child.stdin.end(password + "\n");
  return { code: await exit, output };
}
const statusOf = async (id: string) =>
  (await admin`SELECT * FROM mnemosyne.mnemo_user_status(${id})`)[0];

describe("first superadmin (accounts stage A, task 4)", () => {
  const saEmail = "dashboard-superadmin@example.test";

  it("script --superadmin without an administrator URL fails safely and changes nothing", async () => {
    const { code, output } = await runScript(["--email", saEmail, "--create", "--superadmin"], {
      DATABASE_URL: appUrl,
    });
    expect(code).toBe(1);
    expect(output).toContain("MNEMO_ADMIN_DATABASE_URL");
    expect(output).not.toContain(adminUrl);
    expect(await admin`SELECT 1 FROM mnemosyne.mnemo_user WHERE email = ${saEmail}`).toHaveLength(
      0
    );
  });

  it("script --create --superadmin makes the user a superadmin, and again is idempotent", async () => {
    const env = { DATABASE_URL: appUrl, MNEMO_ADMIN_DATABASE_URL: adminUrl };
    const first = await runScript(["--email", saEmail, "--create", "--superadmin"], env);
    expect(first.code).toBe(0);
    const [user] = await admin`SELECT id FROM mnemosyne.mnemo_user WHERE email = ${saEmail}`;
    expect((await statusOf(user!.id))!.is_superadmin).toBe(true);
    const [row] =
      await admin`SELECT granted_by FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${user!.id}`;
    expect(row!.granted_by).toBe("system:script");
    const again = await runScript(["--email", saEmail, "--superadmin"], env);
    expect(again.code).toBe(0);
    expect(
      await admin`SELECT 1 FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${user!.id}`
    ).toHaveLength(1);
  });

  it("script --superadmin refuses a disabled user", async () => {
    const [u] =
      await admin`SELECT * FROM mnemosyne.mnemo_provision_user('dashboard-disabled-sa@example.test', 'D', 'Personal')`;
    await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${u!.user_id}`;
    const { code, output } = await runScript(
      ["--email", "dashboard-disabled-sa@example.test", "--superadmin"],
      { DATABASE_URL: appUrl, MNEMO_ADMIN_DATABASE_URL: adminUrl }
    );
    expect(code).toBe(1);
    expect(output).toContain("disabled");
    expect(
      await admin`SELECT 1 FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${u!.user_id}`
    ).toHaveLength(0);
  });

  describe("POST /dashboard/bootstrap with adminEmail and adminPassword", () => {
    const adminEmail = "Bootstrap-Admin@Example.test";
    const adminPassword = "bootstrap admin password";
    let bootApp: Hono;
    let auditClient: ReturnType<typeof createDrizzleClient>;
    afterAll(async () => {
      await auditClient?.pgClient.end();
    });
    const boot = (extra: Record<string, unknown>, workspace = crypto.randomUUID()) =>
      bootApp.request("/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", "x-setup-token": (process.env["MNEMO_SETUP_TOKEN"] ??= "integration-setup-token-0001") },
        body: JSON.stringify({
          apiKey: `mns_test_${"a".repeat(24)}`,
          workspaceId: workspace,
          label: "Bootstrap team",
          ...extra,
        }),
      });

    beforeAll(async () => {
      await admin`DELETE FROM mnemosyne.mnemo_instance_admin`;
      await admin`DELETE FROM mnemosyne.mnemo_api_keys`;
      vi.stubEnv("DATABASE_URL", appUrl);
      bootApp = new Hono();
      auditClient = createDrizzleClient(adminUrl);
      mountBootstrap(bootApp, {
        storage: new DrizzleStorageAdapter(auditClient.db, auditClient.pgClient),
      });
    });

    it("rejects one field without the other, and a weak password, creating nothing", async () => {
      expect((await boot({ adminEmail })).status).toBe(400);
      expect((await boot({ adminPassword })).status).toBe(400);
      const weak = await boot({ adminEmail, adminPassword: "short" });
      expect(weak.status).toBe(400);
      expect(await admin`SELECT 1 FROM mnemosyne.mnemo_api_keys`).toHaveLength(0);
    });

    it("creates the superadmin, who logs in and sees isSuperadmin; a second bootstrap is refused", async () => {
      const workspace = crypto.randomUUID();
      const res = await boot({ adminEmail, adminPassword }, workspace);
      expect(res.status).toBe(201);
      expect((await res.json()).adminCreated).toBe(true);
      const [u] =
        await admin`SELECT id, personal_tenant_id FROM mnemosyne.mnemo_user WHERE email = ${adminEmail.toLowerCase()}`;
      const [grant] =
        await admin`SELECT granted_by FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${u!.id}`;
      expect(grant!.granted_by).toBe("system:bootstrap");
      const [wm] =
        await admin`SELECT role FROM mnemosyne.mnemo_workspace_member WHERE workspace_id = ${workspace} AND user_id = ${u!.id}`;
      expect(wm!.role).toBe("owner");
      const [tm] =
        await admin`SELECT count(*)::int AS n FROM mnemosyne.mnemo_tenant_member WHERE user_id = ${u!.id} AND role = 'owner'`;
      expect(tm!.n).toBe(2);
      // Two memberships (personal workspace, bootstrap workspace): pick one.
      const login = await post("login", { email: adminEmail, password: adminPassword });
      expect(login.status).toBe(200);
      const choice = cookieOf(login, "mnemo_dash_choice");
      const picked = choice ? await post("workspace", { workspaceId: workspace }, choice) : login;
      expect(picked.status).toBe(200);
      const session = await app.request("/dashboard/auth/session", {
        headers: { cookie: cookieOf(picked, "mnemo_dash_token")! },
      });
      expect((await session.json()).isSuperadmin).toBe(true);
      expect((await boot({ adminEmail: "x@example.test", adminPassword })).status).toBe(403);
      const audit = await admin`
        SELECT action, actor_id, actor_type, resource_id, workspace_id::text AS workspace_id, resource, metadata::text AS metadata
        FROM mnemosyne.mnemo_audit_log
        WHERE action IN ('user_created', 'superadmin_granted') ORDER BY action`;
      expect(audit.map((r) => r.action)).toEqual(["superadmin_granted", "user_created"]);
      for (const row of audit) {
        expect(row).toMatchObject({
          actor_id: "system:bootstrap",
          actor_type: "system",
          resource_id: u!.id,
          workspace_id: "00000000-0000-0000-0000-000000000000",
        });
        expect(JSON.stringify(row)).not.toContain(adminEmail.toLowerCase());
        expect(JSON.stringify(row)).not.toContain(adminPassword);
      }
    });

    it("bootstrap without admin fields still works and reports adminCreated false", async () => {
      await admin`DELETE FROM mnemosyne.mnemo_api_keys`;
      const res = await boot({});
      expect(res.status).toBe(201);
      expect((await res.json()).adminCreated).toBe(false);
      // Nothing new: still exactly the two rows from the admin bootstrap.
      const [n] =
        await admin`SELECT count(*)::int AS n FROM mnemosyne.mnemo_audit_log WHERE action IN ('user_created', 'superadmin_granted')`;
      expect(n!.n).toBe(2);
    });

    it("the bootstrap function refuses once a superadmin exists (42501) and is app-role only", async () => {
      const [u] =
        await admin`SELECT * FROM mnemosyne.mnemo_provision_user('dashboard-second-sa@example.test', 'S', 'Personal')`;
      await expect(
        client.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_user`;
          await tx`SELECT mnemosyne.mnemo_instance_bootstrap_admin(${u!.user_id})`;
        })
      ).rejects.toMatchObject({ code: "42501" });
      const [fn] = await admin`
        SELECT has_function_privilege('public', 'mnemosyne.mnemo_instance_bootstrap_admin(text)', 'EXECUTE') AS pub,
               has_function_privilege('app_user', 'mnemosyne.mnemo_instance_bootstrap_admin(text)', 'EXECUTE') AS au`;
      expect(fn).toMatchObject({ pub: false, au: true });
    });

    it("the bootstrap function refuses an installation with other keys, an unknown or a disabled user (I2)", async () => {
      await admin`DELETE FROM mnemosyne.mnemo_instance_admin`;
      const [u] =
        await admin`SELECT * FROM mnemosyne.mnemo_provision_user('dashboard-boot-i2@example.test', 'B', 'Personal')`;
      const target = u!.user_id as string;
      const bootstrapAdmin = (userId: string) =>
        client.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_user`;
          await tx`SELECT mnemosyne.mnemo_instance_bootstrap_admin(${userId})`;
        });
      const admins = () => admin`SELECT user_id FROM mnemosyne.mnemo_instance_admin`;
      await admin`DELETE FROM mnemosyne.mnemo_api_keys`;
      await admin`
        INSERT INTO mnemosyne.mnemo_api_keys (id, workspace_id, key_hash, name)
        VALUES ('i2-first', ${u!.workspace_id}, 'i2-hash-1', 'first'), ('i2-second', ${u!.workspace_id}, 'i2-hash-2', 'second')`;
      // An installation in use (more than the bootstrap's own key): zero
      // superadmins is no longer an invitation to claim the role.
      await expect(bootstrapAdmin(target)).rejects.toMatchObject({ code: "42501" });
      await admin`DELETE FROM mnemosyne.mnemo_api_keys WHERE id = 'i2-second'`;
      await expect(bootstrapAdmin("no-such-user")).rejects.toMatchObject({ code: "42501" });
      await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = now() WHERE id = ${target}`;
      await expect(bootstrapAdmin(target)).rejects.toMatchObject({ code: "42501" });
      expect(await admins()).toHaveLength(0);
      // With exactly the bootstrap's key and an enabled user it still works.
      await admin`UPDATE mnemosyne.mnemo_user SET disabled_at = NULL WHERE id = ${target}`;
      await bootstrapAdmin(target);
      expect(await admins()).toEqual([{ user_id: target }]);
    });
  });
});

describe("break-glass password reset ends existing sessions (I4)", () => {
  it("a session opened before the script runs is refused afterwards", async () => {
    const resetEmail = "dashboard-breakglass@example.test";
    const [user] =
      await admin`SELECT * FROM mnemosyne.mnemo_provision_user(${resetEmail}, 'Reset', 'Personal')`;
    const id = user!.user_id as string;
    await admin`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${id}, ${await bcrypt.hash("an older password 12", 12)})`;
    const login = await post("login", { email: resetEmail, password: "an older password 12" });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login, "mnemo_dash_token")!;
    const session = () => app.request("/dashboard/auth/session", { headers: { cookie } });
    expect((await session()).status).toBe(200);

    const { code } = await runScript(["--email", resetEmail], { DATABASE_URL: appUrl });
    expect(code).toBe(0);
    // Another process wrote it: the server learns of it when its status cache expires.
    userStatus.invalidate(id);
    expect((await session()).status).toBe(401);
    // The new password signs in, and that session lives.
    const fresh = await post("login", { email: resetEmail, password });
    expect(fresh.status).toBe(200);
    const freshCookie = cookieOf(fresh, "mnemo_dash_token")!;
    expect(
      (await app.request("/dashboard/auth/session", { headers: { cookie: freshCookie } })).status
    ).toBe(200);
  });
});

describe("own workspaces: list, create (with the per-user limit), switch", () => {
  const ownerEmail = "workspace-creator@example.test";
  let creatorId: string;
  let personalId: string;

  const api = (path: string, cookie: string, method = "GET", body?: unknown) =>
    app.request(`/dashboard/api${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const sessionOf = async (cookie: string) =>
    (await (await app.request("/dashboard/auth/session", { headers: { cookie } })).json()) as {
      workspaceId: string;
      workspaceName: string;
      workspaceRole: string;
      workspaceIsPersonal: boolean;
    };

  beforeAll(async () => {
    const [created] =
      await admin`SELECT * FROM mnemosyne.mnemo_provision_user(${ownerEmail}, 'Creator', 'Personal')`;
    creatorId = created!.user_id;
    personalId = created!.workspace_id;
    await admin`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${creatorId}, ${await bcrypt.hash(password, 12)})`;
    vi.stubEnv("MNEMO_WORKSPACE_LIMIT_PER_USER", "2");
  });
  afterAll(() => {
    vi.stubEnv("MNEMO_WORKSPACE_LIMIT_PER_USER", "");
  });

  it("creating a workspace continues the session: sign-out ends the tokens before and after", async () => {
    const chainEmail = "workspace-chain@example.test";
    const [chain] =
      await admin`SELECT * FROM mnemosyne.mnemo_provision_user(${chainEmail}, 'Chain', 'Personal')`;
    await admin`INSERT INTO mnemosyne.mnemo_user_credential (user_id, password_hash) VALUES (${chain!.user_id}, ${await bcrypt.hash(password, 12)})`;
    const before = cookieOf(
      await post("login", { email: chainEmail, password }),
      "mnemo_dash_token"
    )!;
    const created = await api("/my-workspaces", before, "POST", { name: "Chain team" });
    expect(created.status).toBe(201);
    const after = cookieOf(created, "mnemo_dash_token")!;
    expect(after).not.toBe(before);

    await app.request("/dashboard/auth/logout", { method: "POST", headers: { cookie: after } });

    for (const cookie of [before, after]) {
      const res = await app.request("/dashboard/auth/session", { headers: { cookie } });
      expect(res.status).toBe(401);
    }
  });

  it("creates a team workspace the user owns, in its own organization tenant, and moves the session there", async () => {
    const login = await post("login", { email: ownerEmail, password });
    const cookie = cookieOf(login, "mnemo_dash_token")!;
    const res = await api("/my-workspaces", cookie, "POST", { name: "  Orchester  " });
    expect(res.status).toBe(201);
    const { id, name } = (await res.json()) as { id: string; name: string };
    expect(name).toBe("Orchester");

    const moved = cookieOf(res, "mnemo_dash_token")!;
    expect(await sessionOf(moved)).toMatchObject({
      workspaceId: id,
      workspaceName: "Orchester",
      workspaceRole: "owner",
      workspaceIsPersonal: false,
    });

    const [row] = await admin`
      SELECT t.kind, tm.role AS tenant_role, wm.role AS workspace_role
      FROM mnemosyne.mnemo_workspace w
      JOIN mnemosyne.mnemo_tenant t ON t.id = w.tenant_id
      JOIN mnemosyne.mnemo_tenant_member tm ON tm.tenant_id = t.id AND tm.user_id = ${creatorId}
      JOIN mnemosyne.mnemo_workspace_member wm ON wm.workspace_id = w.id AND wm.user_id = ${creatorId}
      WHERE w.id = ${id}`;
    expect(row).toMatchObject({
      kind: "organization",
      tenant_role: "owner",
      workspace_role: "owner",
    });

    const list = (await (await api("/my-workspaces", moved)).json()) as {
      workspaces: Array<{ id: string; isPersonal: boolean; current: boolean; role: string }>;
      ownedTeamCount: number;
      limit: number | null;
    };
    expect(list.ownedTeamCount).toBe(1);
    expect(list.limit).toBe(2);
    expect(list.workspaces).toEqual([
      expect.objectContaining({ id: personalId, isPersonal: true, current: false, role: "owner" }),
      expect.objectContaining({ id, isPersonal: false, current: true, role: "owner" }),
    ]);

    // Each workspace's figures: live memories under the session's ceiling (the restricted one
    // is not counted), the last write and the members.
    await admin`
      INSERT INTO mnemosyne.mnemo_fact (id, workspace_id, scope, kind, subject, statement, status, sensitivity)
      VALUES ('orch_f1', ${id}, 'global', 'other', 's', 'one', 'active', 'internal'),
             ('orch_f2', ${id}, 'global', 'other', 's', 'two', 'active', 'restricted')
    `;
    // The restricted fact is the latest write: its timestamp must not show through.
    await admin`UPDATE mnemosyne.mnemo_fact SET created_at = now() - interval '1 day' WHERE id = 'orch_f1'`;
    const figures = (await (await api("/my-workspaces", moved)).json()) as {
      workspaces: Array<{
        id: string;
        factsLive: number | null;
        lastWriteAt: string | null;
        memberCount: number | null;
      }>;
    };
    const [one] = await admin<Array<{ created_at: Date }>>`
      SELECT created_at FROM mnemosyne.mnemo_fact WHERE id = 'orch_f1'`;
    expect(figures.workspaces.find((w) => w.id === id)).toMatchObject({
      factsLive: 1,
      lastWriteAt: one!.created_at.toISOString(),
      memberCount: 1,
    });
    expect(figures.workspaces.find((w) => w.id === personalId)).toMatchObject({
      factsLive: 0,
      lastWriteAt: null,
      memberCount: 1,
    });
  });

  it("refuses past the limit (409 workspace_limit), also when two requests race", async () => {
    const login = await post("login", { email: ownerEmail, password });
    const choice = cookieOf(login, "mnemo_dash_choice")!;
    const picked = await post("workspace", { workspaceId: personalId }, choice);
    const cookie = cookieOf(picked, "mnemo_dash_token")!;

    // One left under the limit of 2: of two concurrent requests, exactly one wins.
    const answers = await Promise.all([
      api("/my-workspaces", cookie, "POST", { name: "Race A" }),
      api("/my-workspaces", cookie, "POST", { name: "Race B" }),
    ]);
    expect(answers.map((r) => r.status).sort()).toEqual([201, 409]);
    const refused = answers.find((r) => r.status === 409)!;
    expect(await refused.json()).toEqual({ error: "workspace_limit", limit: 2 });

    const third = await api("/my-workspaces", cookie, "POST", { name: "One too many" });
    expect(third.status).toBe(409);
    const [{ count }] = (await admin`
      SELECT count(*)::int AS count FROM mnemosyne.mnemo_workspace_member
      WHERE user_id = ${creatorId} AND role = 'owner'`) as unknown as [{ count: number }];
    expect(count).toBe(3); // Personal + 2 team workspaces
  });

  it("refuses an empty or too long name", async () => {
    const login = await post("login", { email: ownerEmail, password });
    const choice = cookieOf(login, "mnemo_dash_choice")!;
    const cookie = cookieOf(
      await post("workspace", { workspaceId: personalId }, choice),
      "mnemo_dash_token"
    )!;
    for (const name of ["   ", "x".repeat(101), 42])
      expect((await api("/my-workspaces", cookie, "POST", { name })).status).toBe(400);
  });

  it("a superadmin has no limit", async () => {
    await admin`INSERT INTO mnemosyne.mnemo_instance_admin (user_id, granted_by) VALUES (${creatorId}, 'system:test') ON CONFLICT DO NOTHING`;
    userStatus.invalidate(creatorId);
    try {
      const login = await post("login", { email: ownerEmail, password });
      const choice = cookieOf(login, "mnemo_dash_choice")!;
      const cookie = cookieOf(
        await post("workspace", { workspaceId: personalId }, choice),
        "mnemo_dash_token"
      )!;
      expect(
        ((await (await api("/my-workspaces", cookie)).json()) as { limit: unknown }).limit
      ).toBeNull();
      expect((await api("/my-workspaces", cookie, "POST", { name: "Beyond" })).status).toBe(201);
    } finally {
      await admin`DELETE FROM mnemosyne.mnemo_instance_admin WHERE user_id = ${creatorId}`;
      userStatus.invalidate(creatorId);
    }
  });

  it("switches to a workspace the user belongs to, and refuses one they do not", async () => {
    const login = await post("login", { email: ownerEmail, password });
    const choice = cookieOf(login, "mnemo_dash_choice")!;
    const cookie = cookieOf(
      await post("workspace", { workspaceId: personalId }, choice),
      "mnemo_dash_token"
    )!;
    const list = (await (await api("/my-workspaces", cookie)).json()) as {
      workspaces: Array<{ id: string; name: string }>;
    };
    const orchester = list.workspaces.find((w) => w.name === "Orchester")!;
    const res = await api(`/my-workspaces/${orchester.id}/switch`, cookie, "POST");
    expect(res.status).toBe(200);
    expect(await sessionOf(cookieOf(res, "mnemo_dash_token")!)).toMatchObject({
      workspaceId: orchester.id,
      workspaceRole: "owner",
    });
    expect((await api(`/my-workspaces/${otherWorkspace}/switch`, cookie, "POST")).status).toBe(404);
  });
});
