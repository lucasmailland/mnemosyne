/**
 * Live status on every dashboard request and user-bound key (accounts stage A,
 * Task 3). The JWT only says who the session belongs to; whether the user is
 * still enabled, whether the session predates a revocation, and which role the
 * user holds in the session workspace are read again on each request.
 */
import { Hono } from "hono";
import { sign } from "hono/jwt";
import bcrypt from "bcrypt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardPasswordAuth,
  type Credential,
  type CredentialStore,
  type CredentialTx,
} from "../../dashboard-password.js";
import { resolveLiveSession, waitForSessionEpoch } from "../../dashboard-live-session.js";
import { mountDashboardAuth } from "../../routes/dashboard-auth.js";
import { mountDashboardApi } from "../../routes/dashboard-api.js";
import { mintDashboardToken, verifyDashboardToken } from "../../dashboard-session.js";
import { UserStatusService, type UserStatus } from "../../user-status.js";
import {
  BCRYPT_COST,
  createAuthMiddleware,
  type ApiKeyLookup,
  type AuthVariables,
} from "../../auth.js";
import { toErrorBody } from "../../errors.js";
import { logger } from "../../logging.js";
import type { ServerDeps } from "../../deps.js";

const SECRET = "dashboard-live-session-secret-32-bytes!";
const USER = "user-1";
const WORKSPACE = "workspace-1";
const EMAIL = "person@example.test";
const PASSWORD = "a long test password";

beforeEach(() => vi.stubEnv("MNEMO_DASHBOARD_SECRET", SECRET));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const enabled = (overrides: Partial<UserStatus> = {}): UserStatus => ({
  disabledAt: null,
  sessionsValidAfter: new Date(0),
  isSuperadmin: false,
  ...overrides,
});

/**
 * Fake database behind the live checks: user status through a real
 * UserStatusService (ttl 0, so each request reads again), workspace roles
 * through a fake `metricsPgClient` that answers the membership query.
 */
function live() {
  const statuses = new Map<string, UserStatus | null>([[USER, enabled()]]);
  const roles = new Map<string, string>([[`${USER}:${WORKSPACE}`, "write"]]);
  const state = { roleError: null as Error | null, statusError: null as Error | null };
  // The 0059 revocation table, by token hash (mnemo_dashboard_session_revoke / _revoked).
  const revokedSessions = new Set<string>();
  /** The epoch-seconds expiry each revoke stored, by session hash. */
  const revokedUntil = new Map<string, number>();
  const source = {
    load: vi.fn(async (userId: string) => {
      if (state.statusError) throw state.statusError;
      return statuses.get(userId) ?? null;
    }),
  };
  const userStatus = new UserStatusService(source, { ttlMs: 0 });
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("mnemo_dashboard_session_revoked(")) {
      return [{ revoked: revokedSessions.has(values[0] as string) }];
    }
    if (text.includes("mnemo_dashboard_session_revoke(")) {
      revokedSessions.add(values[0] as string);
      revokedUntil.set(values[0] as string, values[1] as number);
      return [];
    }
    if (text.includes("mnemo_workspace_member")) {
      if (state.roleError) throw state.roleError;
      const [workspaceId, userId] = values as [string, string];
      const role = roles.get(`${userId}:${workspaceId}`);
      return role ? [{ role }] : [];
    }
    if (text.includes("SELECT name")) return [{ name: "Workspace One" }];
    if (text.includes("SELECT email")) return [{ email: EMAIL }];
    return [];
  });
  const metricsPgClient = { begin: vi.fn(async (fn: (sql: typeof query) => unknown) => fn(query)) };
  return {
    statuses,
    roles,
    state,
    source,
    userStatus,
    metricsPgClient,
    revokedSessions,
    revokedUntil,
  };
}

async function passwordCookie(
  overrides: Record<string, unknown> = {},
  now = Date.now() // determinism-ok: live session checks read the wall clock
) {
  const { token } = await mintDashboardToken(
    SECRET,
    {
      workspaceId: WORKSPACE,
      keyPrefix: "password",
      scopes: ["memory:read", "memory:write", "admin:workspace", "memory:admin"],
      plan: "free",
      actorId: USER,
      userId: USER,
      authMethod: "password",
      ...overrides,
    },
    now
  );
  return `mnemo_dash_token=${token}`;
}

function bridge(l = live(), extra: Partial<ServerDeps> = {}) {
  const deps = {
    userStatus: l.userStatus,
    metricsPgClient: l.metricsPgClient,
    ...extra,
  } as unknown as ServerDeps;
  const app = new Hono();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as 400);
  });
  mountDashboardAuth(app, deps);
  mountDashboardApi(app, deps);
  return { app, l, deps };
}

describe("waitForSessionEpoch", () => {
  it("sleeps again when the timer wakes before the wall clock reaches the epoch", async () => {
    const target = 1_700_000_001_000;
    // Clock readings: the bound, the first check, then a timer that woke 1ms early.
    const clock = [target - 5, target - 5, target - 1, target];
    const now = vi.fn(() => clock.shift() ?? target);
    await waitForSessionEpoch(enabled({ sessionsValidAfter: new Date(target - 400) }), now);
    expect(now).toHaveBeenCalledTimes(4);
    expect(clock).toEqual([]);
  });
});

describe("resolveLiveSession", () => {
  it("passes API key sessions through unchanged", async () => {
    const l = live();
    const payload = (await verifyDashboardToken(
      SECRET,
      (
        await mintDashboardToken(SECRET, {
          workspaceId: WORKSPACE,
          keyPrefix: "mns_live_",
          scopes: ["memory:read"],
          plan: "free",
          actorId: "key-1",
          userId: null,
        })
      ).token
    ))!;
    const session = await resolveLiveSession({} as ServerDeps, payload);
    expect(session).toEqual({
      workspaceId: WORKSPACE,
      userId: null,
      role: null,
      scopes: ["memory:read"],
      isSuperadmin: false,
      viaInstance: false,
    });
    expect(l.source.load).not.toHaveBeenCalled();
  });

  it("reads the role live and ignores the scopes in the token", async () => {
    const l = live();
    l.roles.set(`${USER}:${WORKSPACE}`, "read");
    const cookie = await passwordCookie();
    const payload = (await verifyDashboardToken(SECRET, cookie.split("=")[1]!))!;
    const session = await resolveLiveSession(l as unknown as ServerDeps, payload);
    expect(session).toMatchObject({ role: "read", isSuperadmin: false, viaInstance: false });
    expect(session!.scopes).not.toContain("memory:write");
    expect(session!.scopes).not.toContain("admin:workspace");
  });

  it("refuses a disabled user, a session older than sessions_valid_after and an unknown user", async () => {
    const l = live();
    // A whole second in the recent past (the JWT library refuses a future iat).
    const now = Math.floor(Date.now() / 1000) * 1000 - 60_000; // determinism-ok: live session checks read the wall clock
    const payload = (await verifyDashboardToken(
      SECRET,
      (await passwordCookie({}, now)).split("=")[1]!
    ))!;
    const deps = l as unknown as ServerDeps;
    l.statuses.set(USER, enabled({ disabledAt: new Date(now) }));
    expect(await resolveLiveSession(deps, payload)).toBeNull();
    // Revoked 400 ms into the second the token was minted in: the token dies.
    l.statuses.set(USER, enabled({ sessionsValidAfter: new Date(now + 400) }));
    expect(await resolveLiveSession(deps, payload)).toBeNull();
    l.statuses.set(USER, enabled({ sessionsValidAfter: new Date(now - 1) }));
    expect(await resolveLiveSession(deps, payload)).not.toBeNull();
    l.statuses.set(USER, null);
    expect(await resolveLiveSession(deps, payload)).toBeNull();
  });

  it("allows a superadmin without membership only through an instance-opened session, as read", async () => {
    const l = live();
    l.roles.clear();
    l.statuses.set(USER, enabled({ isSuperadmin: true }));
    const deps = l as unknown as ServerDeps;
    const plain = (await verifyDashboardToken(SECRET, (await passwordCookie()).split("=")[1]!))!;
    expect(await resolveLiveSession(deps, plain)).toBeNull();
    const opened = (await verifyDashboardToken(
      SECRET,
      (await passwordCookie({ viaInstance: true })).split("=")[1]!
    ))!;
    expect(opened.viaInstance).toBe(true);
    const session = await resolveLiveSession(deps, opened);
    expect(session).toMatchObject({ role: "read", isSuperadmin: true, viaInstance: true });
    expect(session!.scopes).toContain("admin:workspace");
    expect(session!.scopes).not.toContain("memory:write");
    // A non-superadmin with the same instance-opened cookie gets nothing.
    l.statuses.set(USER, enabled());
    expect(await resolveLiveSession(deps, opened)).toBeNull();
  });

  it("fails closed when the status service is missing or erroring", async () => {
    const l = live();
    const payload = (await verifyDashboardToken(SECRET, (await passwordCookie()).split("=")[1]!))!;
    await expect(
      resolveLiveSession({ metricsPgClient: l.metricsPgClient } as unknown as ServerDeps, payload)
    ).rejects.toThrow();
    l.state.statusError = new Error("database offline");
    await expect(resolveLiveSession(l as unknown as ServerDeps, payload)).rejects.toThrow();
  });
});

describe("dashboard bridge enforces live status", () => {
  const writeFact = (app: Hono, cookie: string) =>
    // PATCH /facts/{id} is a real bridge route that needs memory:write.
    app.request("/dashboard/api/facts/00000000-0000-4000-8000-000000000000", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({}),
    });

  it("returns 401 no_session for a disabled user's still-valid JWT", async () => {
    const { app, l } = bridge();
    const cookie = await passwordCookie();
    l.statuses.set(USER, enabled({ disabledAt: new Date() })); // determinism-ok: live session checks read the wall clock
    const res = await app.request("/dashboard/api/facts", { headers: { cookie } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "no_session" });
  });

  it("returns 401 for a JWT issued before sessions_valid_after", async () => {
    const { app, l } = bridge();
    const cookie = await passwordCookie({}, Date.now() - 5_000); // determinism-ok: live session checks read the wall clock
    l.statuses.set(USER, enabled({ sessionsValidAfter: new Date(Date.now() - 1_000) })); // determinism-ok: live session checks read the wall clock
    const res = await app.request("/dashboard/api/facts", { headers: { cookie } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "no_session" });
  });

  it("gives a demoted member 403 on a write route on the next request", async () => {
    const { app, l } = bridge();
    const cookie = await passwordCookie();
    expect([401, 403]).not.toContain((await writeFact(app, cookie)).status);
    l.roles.set(`${USER}:${WORKSPACE}`, "read");
    const res = await writeFact(app, cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("INSUFFICIENT_SCOPE");
  });

  it("gives a removed member 401 on the next request", async () => {
    const { app, l } = bridge();
    const cookie = await passwordCookie();
    l.roles.delete(`${USER}:${WORKSPACE}`);
    const res = await app.request("/dashboard/api/facts", { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  it("grants admin:workspace to a superadmin's session and not to a plain owner's", async () => {
    const { app, l } = bridge();
    l.roles.set(`${USER}:${WORKSPACE}`, "owner");
    const cookie = await passwordCookie();
    const put = () =>
      app.request("/dashboard/api/admin/config/llm", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ provider: "openai" }),
      });
    const owner = await put();
    expect(owner.status).toBe(403);
    expect((await owner.json()).error.code).toBe("INSUFFICIENT_SCOPE");
    l.statuses.set(USER, enabled({ isSuperadmin: true }));
    expect([401, 403]).not.toContain((await put()).status);
  });

  it("answers 503 auth_unavailable when the status or role lookup fails", async () => {
    const { app, l } = bridge();
    const cookie = await passwordCookie();
    l.state.statusError = new Error("database offline");
    let res = await app.request("/dashboard/api/facts", { headers: { cookie } });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("auth_unavailable");
    l.state.statusError = null;
    l.state.roleError = new Error("database offline");
    res = await app.request("/dashboard/api/facts", { headers: { cookie } });
    expect(res.status).toBe(503);
  });

  it("refuses password sessions when no status service is wired, keeps API key sessions", async () => {
    const { app } = bridge(live(), { userStatus: undefined });
    const res = await app.request("/dashboard/api/facts", {
      headers: { cookie: await passwordCookie() },
    });
    expect(res.status).toBe(503);
    const { token } = await mintDashboardToken(SECRET, {
      workspaceId: WORKSPACE,
      keyPrefix: "mns_live_",
      scopes: ["memory:read"],
      plan: "free",
      actorId: "key-1",
      userId: null,
    });
    const keyed = await app.request("/dashboard/auth/session", {
      headers: { cookie: `mnemo_dash_token=${token}` },
    });
    expect(keyed.status).toBe(200);
  });
});

describe("sign out revokes the session on the server (AUD-007)", () => {
  const session = (app: Hono, cookie: string) =>
    app.request("/dashboard/auth/session", { headers: { cookie } });
  const logout = (app: Hono, cookie: string) =>
    app.request("/dashboard/auth/logout", { method: "POST", headers: { cookie } });

  it("the signed-out cookie gets 401 at once; the user's other session stays", async () => {
    const { app } = bridge();
    const signedOut = await passwordCookie();
    const other = await passwordCookie({}, Date.now() - 2_000); // determinism-ok: a second, distinct token
    expect((await session(app, signedOut)).status).toBe(200);

    expect((await logout(app, signedOut)).status).toBe(200);

    const after = await session(app, signedOut);
    expect(after.status).toBe(401);
    const bridged = await app.request("/dashboard/api/facts", { headers: { cookie: signedOut } });
    expect(bridged.status).toBe(401);
    expect(await bridged.json()).toEqual({ error: "no_session" });
    expect((await session(app, other)).status).toBe(200);
  });

  it("a revoked token re-encoded with a non-canonical signature is still refused", async () => {
    const { app } = bridge();
    const cookie = await passwordCookie();
    const token = cookie.split("=")[1]!;
    await logout(app, cookie);
    // The HMAC-SHA256 signature is 43 base64url chars; the last one carries 4 bits and
    // 2 unused ones. Setting the unused bits gives another string for the same bytes.
    const sig = token.slice(token.lastIndexOf(".") + 1);
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = ALPHABET.indexOf(sig.at(-1)!);
    const variants = [1, 2, 3].map((bits) => token.slice(0, -1) + ALPHABET[(last & ~3) | bits]);
    for (const variant of variants) {
      expect(variant).not.toBe(token);
      const res = await session(app, `mnemo_dash_token=${variant}`);
      expect(res.status, variant).toBe(401);
    }
  });

  it("refuses a token minted without a jti (before sessions could be revoked)", async () => {
    const now = Math.floor(Date.now() / 1000); // determinism-ok: iat/exp of a hand-signed token
    const legacy = await sign(
      {
        workspaceId: WORKSPACE,
        keyPrefix: "password",
        scopes: [],
        plan: "free",
        actorId: USER,
        userId: USER,
        authMethod: "password",
        iat: now,
        exp: now + 3600,
      },
      SECRET,
      "HS256"
    );
    expect(await verifyDashboardToken(SECRET, legacy)).toBeNull();
  });

  it("a workspace switch keeps the session: signing out ends the pre- and post-switch tokens", async () => {
    const { app, l } = bridge();
    l.roles.set(`${USER}:workspace-2`, "read");
    const before = await passwordCookie();
    const switched = await app.request("/dashboard/api/my-workspaces/workspace-2/switch", {
      method: "POST",
      headers: { cookie: before },
    });
    expect(switched.status).toBe(200);
    const after = switched.headers
      .getSetCookie()
      .find((c) => c.startsWith("mnemo_dash_token=") && !c.startsWith("mnemo_dash_token=;"))!
      .split(";")[0]!;
    expect(after).not.toBe(before);
    const sid = async (cookie: string) =>
      (await verifyDashboardToken(SECRET, cookie.split("=")[1]!))!.sid;
    expect(await sid(after)).toBe(await sid(before));
    expect((await session(app, before)).status).toBe(200);

    await logout(app, after);

    expect((await session(app, after)).status).toBe(401);
    expect((await session(app, before)).status).toBe(401);
    expect(
      (await app.request("/dashboard/api/facts", { headers: { cookie: before } })).status
    ).toBe(401);
  });

  it("the revocation outlives every token of the session by an hour's margin", async () => {
    const { app, l } = bridge();
    const cookie = await passwordCookie();
    const sid = (await verifyDashboardToken(SECRET, cookie.split("=")[1]!))!.sid!;
    const signedOutAt = Math.floor(Date.now() / 1000); // determinism-ok: compared with a 5 s tolerance
    await logout(app, cookie);
    // TTL (8 h) for the latest possible token, plus 1 h for a re-issue racing the
    // sign-out and for clock skew between replicas and the database (0059 caps at 9 h).
    const until = l.revokedUntil.get(sid)!;
    expect(Math.abs(until - (signedOutAt + 9 * 3600))).toBeLessThanOrEqual(5);
  });

  it("revokes an API key session too", async () => {
    const { app } = bridge();
    const { token } = await mintDashboardToken(SECRET, {
      workspaceId: WORKSPACE,
      keyPrefix: "mns_live_",
      scopes: ["memory:read"],
      plan: "free",
      actorId: "key-1",
      userId: null,
    });
    const cookie = `mnemo_dash_token=${token}`;
    expect((await session(app, cookie)).status).toBe(200);
    await logout(app, cookie);
    expect((await session(app, cookie)).status).toBe(401);
  });

  it("records nothing for a cookie that does not verify; still clears it", async () => {
    const { app, l } = bridge();
    const res = await logout(app, "mnemo_dash_token=not-a-jwt");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    expect(l.revokedSessions.size).toBe(0);
  });

  it("answers 503 when the revocation cannot be stored, and still clears the cookie", async () => {
    const { app, l } = bridge();
    const cookie = await passwordCookie();
    l.metricsPgClient.begin.mockRejectedValueOnce(new Error("db down"));
    const res = await logout(app, cookie);
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });
});

describe("GET /dashboard/auth/session reports live state", () => {
  it("returns live scopes, isSuperadmin and email", async () => {
    const { app, l } = bridge();
    l.statuses.set(USER, enabled({ isSuperadmin: true }));
    l.roles.set(`${USER}:${WORKSPACE}`, "read");
    const res = await app.request("/dashboard/auth/session", {
      headers: { cookie: await passwordCookie() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      isSuperadmin: true,
      email: EMAIL,
      role: "viewer",
      workspaceName: "Workspace One",
    });
    expect(body.scopes).toContain("admin:workspace");
    expect(body.scopes).not.toContain("memory:write");
  });

  it("answers 401 for a disabled user and 503 when status is unavailable", async () => {
    const { app, l } = bridge();
    const cookie = await passwordCookie();
    l.statuses.set(USER, enabled({ disabledAt: new Date() })); // determinism-ok: live session checks read the wall clock
    expect((await app.request("/dashboard/auth/session", { headers: { cookie } })).status).toBe(
      401
    );
    l.state.statusError = new Error("database offline");
    expect((await app.request("/dashboard/auth/session", { headers: { cookie } })).status).toBe(
      503
    );
  });

  it("reports isSuperadmin false and email null for an API key session without a user", async () => {
    const { app } = bridge();
    const { token } = await mintDashboardToken(SECRET, {
      workspaceId: WORKSPACE,
      keyPrefix: "mns_live_",
      scopes: ["memory:read"],
      plan: "free",
      actorId: "key-1",
      userId: null,
    });
    const body = await (
      await app.request("/dashboard/auth/session", {
        headers: { cookie: `mnemo_dash_token=${token}` },
      })
    ).json();
    expect(body).toMatchObject({ isSuperadmin: false, email: null });
  });
});

/** Credential store fake with the lifecycle fields this task adds. */
function credentials(l: ReturnType<typeof live>) {
  const credential: Credential = {
    userId: USER,
    email: EMAIL,
    passwordHash: "stored-hash",
    passwordUpdatedAt: "2026-10-01T00:00:00.000Z",
    failedAttempts: 0,
    lockedUntil: null,
  };
  const flags = { disabled: false };
  const tx: CredentialTx = {
    credential,
    get disabled() {
      return flags.disabled;
    },
    memberships: async () => [{ id: WORKSPACE, name: "Workspace One", role: "write" }],
    failure: vi.fn(async () => {}),
    resetFailures: vi.fn(async () => {}),
    touchLogin: vi.fn(async () => {}),
    setPassword: vi.fn(async (hash: string) => {
      credential.passwordHash = hash;
      // The store bumps sessions_valid_after in the same transaction.
      l.statuses.set(USER, enabled({ sessionsValidAfter: new Date() })); // determinism-ok: live session checks read the wall clock
    }),
  };
  const store: CredentialStore = {
    withEmail: async (_email, fn) => fn(tx),
    withUser: async (_user, fn) => fn(tx),
  };
  const compare = vi.fn(
    async (password: string, hash: string) => password === PASSWORD && hash === "stored-hash"
  );
  const auth = new DashboardPasswordAuth(store, {
    compare,
    hash: async () => "new-hash",
    dummyHash: "dummy",
  });
  return { tx, flags, auth, compare };
}

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .find(
      (cookie) => cookie.startsWith("mnemo_dash_token=") && !cookie.startsWith("mnemo_dash_token=;")
    )
    ?.split(";")[0];

describe("password login and change", () => {
  function app() {
    const l = live();
    const c = credentials(l);
    const { app } = bridge(l, { dashboardPasswordAuth: c.auth });
    const post = (path: string, body: unknown, cookie?: string) =>
      app.request(`/dashboard/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
    return { app, l, c, post };
  }

  it("refuses a disabled user with the wrong-password body, audits disabled, counts no failure", async () => {
    const t = app();
    const wrong = await t.post("login", { email: EMAIL, password: "incorrect password" });
    const wrongBody = await wrong.json();
    t.c.flags.disabled = true;
    const log = vi.spyOn(logger, "info");
    try {
      const res = await t.post("login", { email: EMAIL, password: PASSWORD });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(wrongBody);
      expect(cookieOf(res)).toBeUndefined();
      const events = log.mock.calls
        .map(([fields]) => fields as Record<string, unknown>)
        .filter((fields) => fields?.event === "dashboard.password_auth");
      expect(events).toContainEqual(
        expect.objectContaining({ outcome: "failure", reason: "disabled" })
      );
      expect(JSON.stringify(events)).not.toContain(EMAIL);
    } finally {
      log.mockRestore();
    }
    // Only the wrong password counted.
    expect(t.c.tx.failure).toHaveBeenCalledTimes(1);
    expect(t.c.compare).toHaveBeenCalledTimes(2);
  });

  it("records the login time when a session is minted", async () => {
    const t = app();
    expect((await t.post("login", { email: EMAIL, password: PASSWORD })).status).toBe(200);
    expect(t.c.tx.touchLogin).toHaveBeenCalledTimes(1);
  });

  it("ends other sessions on password change and re-mints the caller's cookie, which keeps working", async () => {
    const t = app();
    const first = cookieOf(await t.post("login", { email: EMAIL, password: PASSWORD }))!;
    const other = cookieOf(await t.post("login", { email: EMAIL, password: PASSWORD }))!;
    const invalidate = vi.spyOn(t.l.userStatus, "invalidate");
    const res = await t.post(
      "password",
      { currentPassword: PASSWORD, newPassword: "a different long password" },
      first
    );
    expect(res.status).toBe(200);
    expect(invalidate).toHaveBeenCalledWith(USER);
    const renewed = cookieOf(res);
    expect(renewed).toBeDefined();
    const session = (cookie: string) =>
      t.app.request("/dashboard/auth/session", { headers: { cookie } });
    expect((await session(renewed!)).status).toBe(200);
    expect((await session(other)).status).toBe(401);
    expect((await session(first)).status).toBe(401);
    const payload = await verifyDashboardToken(SECRET, renewed!.split("=")[1]!);
    expect(payload).toMatchObject({ userId: USER, workspaceId: WORKSPACE, authMethod: "password" });
  });

  it("refuses a password change from a disabled user's session", async () => {
    const t = app();
    const cookie = cookieOf(await t.post("login", { email: EMAIL, password: PASSWORD }))!;
    t.l.statuses.set(USER, enabled({ disabledAt: new Date() })); // determinism-ok: live session checks read the wall clock
    const res = await t.post(
      "password",
      { currentPassword: PASSWORD, newPassword: "a different long password" },
      cookie
    );
    expect(res.status).toBe(401);
    expect(t.c.tx.setPassword).not.toHaveBeenCalled();
  });
});

describe("bearer keys bound to a user", () => {
  const token = "uk_live_1234567890123456789012";

  async function bearer() {
    const keyHash = await bcrypt.hash(token, BCRYPT_COST);
    const statuses = new Map<string, UserStatus | null>([["usr-001", enabled()]]);
    const state = { error: null as Error | null };
    const userStatus = new UserStatusService({
      load: async (userId) => {
        if (state.error) throw state.error;
        return statuses.get(userId) ?? null;
      },
    });
    const lookup: ApiKeyLookup = {
      listActive: async () => [
        {
          id: "uk-123",
          keyHash,
          workspaceId: "00000000-0000-0000-0000-000000000001",
          scopes: ["memory:read"],
          plan: "pro",
          userId: "usr-001",
          tenantId: "tnt-001",
          keyKind: "user",
        },
        {
          id: "key-legacy",
          keyHash: await bcrypt.hash("mns_live_abcdefghijklmnopqrstuv", BCRYPT_COST),
          workspaceId: "00000000-0000-0000-0000-000000000001",
          scopes: ["memory:read"],
          plan: "pro",
        },
      ],
      touch: vi.fn(),
      getWorkspaceMemberRole: async () => "read",
    };
    const app = new Hono<{ Variables: AuthVariables }>();
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err);
      return c.json(body, status as 400);
    });
    app.use("*", createAuthMiddleware(lookup, { userStatus }));
    app.get("/test", (c) => c.json({ userId: c.get("userId") ?? null }));
    const call = (value = token) =>
      app.request("http://localhost/test", { headers: { Authorization: `Bearer ${value}` } });
    return { statuses, state, userStatus, call };
  }

  it("gives a disabled user's uk_live token the invalid-key 401, and works again after re-enable", async () => {
    const b = await bearer();
    expect((await b.call()).status).toBe(200);
    const invalid = await b.call("uk_live_0000000000000000000000");
    const invalidBody = await invalid.json();
    b.statuses.set("usr-001", enabled({ disabledAt: new Date() })); // determinism-ok: live session checks read the wall clock
    b.userStatus.invalidate("usr-001");
    const disabled = await b.call();
    expect(disabled.status).toBe(401);
    expect(await disabled.json()).toEqual(invalidBody);
    b.statuses.set("usr-001", enabled());
    // Still cached as disabled until invalidated.
    expect((await b.call()).status).toBe(401);
    b.userStatus.invalidate("usr-001");
    expect((await b.call()).status).toBe(200);
  });

  it("fails closed with 503 when the status is unavailable, but keys without a user keep working", async () => {
    const b = await bearer();
    b.state.error = new Error("database offline");
    const res = await b.call();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("auth_unavailable");
    expect((await b.call("mns_live_abcdefghijklmnopqrstuv")).status).toBe(200);
  });
});

describe("scoped mk_ keys bound to a user", () => {
  it("refuses a disabled user's scoped key like an invalid key", async () => {
    const statuses = new Map<string, UserStatus | null>([["usr-001", enabled()]]);
    const userStatus = new UserStatusService({ load: async (id) => statuses.get(id) ?? null });
    const scoped = {
      authenticate: vi.fn(async () => ({
        ok: true as const,
        context: {
          workspaceId: "00000000-0000-0000-0000-000000000001",
          actorId: "mk-1",
          actorType: "agent" as const,
          userId: "usr-001",
          scopes: ["memory:read" as const],
          keyType: "mk_live_" as const,
        },
      })),
    };
    const app = new Hono<{ Variables: AuthVariables }>();
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err);
      return c.json(body, status as 400);
    });
    const lookup: ApiKeyLookup = { listActive: async () => [], touch: vi.fn() };
    app.use("*", createAuthMiddleware(lookup, { userStatus }, scoped as never));
    app.get("/test", (c) => c.json({ ok: true }));
    const call = () =>
      app.request("http://localhost/test", {
        headers: { Authorization: "Bearer mk_live_abcdefgh_ijklmnopqrstuv" },
      });
    expect((await call()).status).toBe(200);
    statuses.set("usr-001", enabled({ disabledAt: new Date() })); // determinism-ok: live session checks read the wall clock
    userStatus.invalidate("usr-001");
    const res = await call();
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("Invalid API key");
  });
});

describe("dashboard login with a user-bound API key", () => {
  it("refuses the key of a disabled user like an invalid key", async () => {
    const token = "uk_live_1234567890123456789012";
    const l = live();
    const apiKeys: ApiKeyLookup = {
      listActive: async () => [
        {
          id: "uk-123",
          keyHash: await bcrypt.hash(token, BCRYPT_COST),
          workspaceId: WORKSPACE,
          scopes: ["memory:read"],
          plan: "free",
          userId: USER,
          keyKind: "user",
        },
      ],
      touch: vi.fn(),
    };
    const { app } = bridge(l, { apiKeys });
    const login = () =>
      app.request("/dashboard/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: token }),
      });
    expect((await login()).status).toBe(200);
    l.statuses.set(USER, enabled({ disabledAt: new Date() })); // determinism-ok: live session checks read the wall clock
    const res = await login();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_key" });
    expect(cookieOf(res)).toBeUndefined();
  });
});

describe("API key dashboard sessions bound to a user", () => {
  async function keyCookie(userId: string | null) {
    const { token } = await mintDashboardToken(SECRET, {
      workspaceId: WORKSPACE,
      keyPrefix: "uk_live_",
      scopes: ["memory:read", "memory:write"],
      plan: "free",
      actorId: "uk-123",
      userId,
    });
    return `mnemo_dash_token=${token}`;
  }

  it("ends on the bridge and /session once the user is disabled, keeping JWT scopes otherwise", async () => {
    const { app, l } = bridge();
    const cookie = await keyCookie(USER);
    const session = () => app.request("/dashboard/auth/session", { headers: { cookie } });
    const ok = await session();
    expect(ok.status).toBe(200);
    expect((await ok.json()).scopes).toEqual(["memory:read", "memory:write"]);
    // sessions_valid_after does not apply to API key sessions.
    l.statuses.set(USER, enabled({ sessionsValidAfter: new Date(Date.now() + 60_000) })); // determinism-ok: live session checks read the wall clock
    expect((await session()).status).toBe(200);
    l.statuses.set(USER, enabled({ disabledAt: new Date() })); // determinism-ok: live session checks read the wall clock
    expect((await session()).status).toBe(401);
    const bridged = await app.request("/dashboard/api/facts", { headers: { cookie } });
    expect(bridged.status).toBe(401);
    expect(await bridged.json()).toEqual({ error: "no_session" });
    l.statuses.set(USER, enabled());
    expect((await session()).status).toBe(200);
  });

  it("answers 503 when the status is unreadable; sessions without a user are unaffected", async () => {
    const { app, l } = bridge();
    l.state.statusError = new Error("database offline");
    const withUser = await app.request("/dashboard/api/facts", {
      headers: { cookie: await keyCookie(USER) },
    });
    expect(withUser.status).toBe(503);
    const withoutUser = await app.request("/dashboard/auth/session", {
      headers: { cookie: await keyCookie(null) },
    });
    expect(withoutUser.status).toBe(200);
    expect(l.source.load).toHaveBeenCalledTimes(1);
  });

  it("keeps working without a status service (no Postgres)", async () => {
    const { app } = bridge(live(), { userStatus: undefined });
    const res = await app.request("/dashboard/auth/session", {
      headers: { cookie: await keyCookie(USER) },
    });
    expect(res.status).toBe(200);
  });
});
