import { Hono } from "hono";
import bcrypt from "bcrypt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardPasswordAuth,
  DashboardLoginLimiter,
  passwordPolicyError,
  type Credential,
  type CredentialStore,
  type CredentialTx,
  type Membership,
} from "../../dashboard-password.js";
import { mountDashboardAuth } from "../../routes/dashboard-auth.js";
import { mintDashboardToken, verifyDashboardToken } from "../../dashboard-session.js";
import { logger } from "../../logging.js";
import type { ServerDeps } from "../../deps.js";
import { UserStatusService } from "../../user-status.js";

const SECRET = "dashboard-password-tests-secret-32-bytes";
const EMAIL = "person@example.test";
const PASSWORD = "a long test password";
const MEMBER: Membership = { id: "workspace-1", name: "First workspace", role: "write" };

function fixture() {
  let credential: Credential | null = {
    userId: "user-1",
    email: EMAIL,
    passwordHash: "stored-hash",
    passwordUpdatedAt: "2026-10-01T00:00:00.000Z",
    failedAttempts: 0,
    lockedUntil: null,
  };
  let members = [MEMBER];
  const tx: CredentialTx = {
    get credential() {
      return credential;
    },
    disabled: false,
    memberships: async () => members,
    touchLogin: vi.fn(async () => {}),
    failure: vi.fn(async (attempts, until) => {
      if (credential) {
        credential.failedAttempts = attempts;
        credential.lockedUntil = until;
      }
    }),
    resetFailures: vi.fn(async () => {
      if (credential) {
        credential.failedAttempts = 0;
        credential.lockedUntil = null;
      }
    }),
    setPassword: vi.fn(async (hash) => {
      if (credential) {
        credential.passwordHash = hash;
        credential.passwordUpdatedAt = "2026-10-02T00:00:00.000Z";
      }
    }),
  };
  const store: CredentialStore = {
    withEmail: async (_email, fn) => fn(tx),
    withUser: async (_user, fn) => fn(tx),
  };
  const compare = vi.fn(
    async (password: string, hash: string) => password === PASSWORD && hash === "stored-hash"
  );
  const hash = vi.fn(async () => "new-hash");
  let now = Date.parse("2026-10-01T01:00:00Z");
  const auth = new DashboardPasswordAuth(
    store,
    { compare, hash, dummyHash: "dummy-cost-12-hash" },
    () => now
  );
  // Live session checks (password change): enabled user, live role "write".
  const userStatus = new UserStatusService({
    load: async () => ({ disabledAt: null, sessionsValidAfter: new Date(0), isSuperadmin: false }),
  });
  const metricsPgClient = {
    begin: async (fn: (sql: unknown) => unknown) =>
      fn(async (strings: TemplateStringsArray) =>
        strings.join("?").includes("mnemo_workspace_member") ? [{ role: "write" }] : []
      ),
  };
  const app = new Hono();
  mountDashboardAuth(app, {
    dashboardPasswordAuth: auth,
    userStatus,
    metricsPgClient,
  } as unknown as ServerDeps);
  const post = (path: string, body: unknown, cookie?: string, ip = "192.0.2.1") =>
    app.request(`/dashboard/auth/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": ip,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  return {
    auth,
    store,
    tx,
    compare,
    hash,
    app,
    post,
    get credential() {
      return credential;
    },
    set credential(value) {
      credential = value;
    },
    set members(value: Membership[]) {
      members = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
function cookieOf(response: Response, name = "mnemo_dash_token") {
  return response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`) && !cookie.startsWith(`${name}=;`))
    ?.split(";")[0];
}

beforeEach(() => vi.stubEnv("MNEMO_DASHBOARD_SECRET", SECRET));
afterEach(() => vi.unstubAllEnvs());

describe("dashboard password contract", () => {
  it("AUTH-01 logs in with normalized email, derives contributor and preserves user identity", async () => {
    const f = fixture();
    const res = await f.post("login", { email: " Person@Example.Test ", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      userId: "user-1",
      role: "contributor",
      scopes: expect.arrayContaining([
        "memory:read",
        "memory:write",
        "session:read",
        "entity:read",
      ]),
    });
    const cookie = cookieOf(res)!;
    const payload = await verifyDashboardToken(SECRET, cookie.slice(cookie.indexOf("=") + 1));
    expect(payload).toMatchObject({ userId: "user-1", actorId: "user-1", authMethod: "password" });
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });
  it("AUTH-02 gives identical responses and one comparison for bad, missing, locked and membership-less accounts", async () => {
    const bodies = [];
    for (const kind of ["bad", "missing", "locked", "no-membership"]) {
      const f = fixture();
      if (kind === "missing") f.credential = null;
      if (kind === "locked")
        f.credential!.lockedUntil = new Date(Date.parse("2026-10-01T01:10:00Z"));
      if (kind === "no-membership") f.members = [];
      const res = await f.post("login", {
        email: EMAIL,
        password: kind === "bad" ? "incorrect password" : PASSWORD,
      });
      expect(res.status).toBe(401);
      expect(cookieOf(res)).toBeUndefined();
      bodies.push(await res.json());
      expect(f.compare).toHaveBeenCalledTimes(1);
      expect(f.compare.mock.calls[0]![1]).toBe(
        kind === "missing" ? "dummy-cost-12-hash" : "stored-hash"
      );
    }
    expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
  });
  it("AUTH-03 locks after five failures and permits login after lock expiry", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) expect(await f.auth.login(EMAIL, "bad password")).toBeNull();
    expect(f.credential!.failedAttempts).toBe(5);
    expect(f.credential!.lockedUntil).toEqual(new Date("2026-10-01T01:15:00Z"));
    expect(await f.auth.login(EMAIL, PASSWORD)).toBeNull();
    f.advance(15 * 60_000);
    expect(await f.auth.login(EMAIL, PASSWORD)).toMatchObject({ userId: "user-1" });
    expect(f.credential!.failedAttempts).toBe(0);
  });
  it.each([
    ["owner", "admin"],
    ["admin", "admin"],
    ["write", "contributor"],
    ["read", "viewer"],
  ])("AUTH-01 maps membership %s to %s", async (role, expected) => {
    const f = fixture();
    f.members = [{ ...MEMBER, role: role as Membership["role"] }];
    const res = await f.post("login", { email: EMAIL, password: PASSWORD });
    const session = await res.json();
    expect(session.role).toBe(expected);
    expect(session.scopes).toEqual(expect.arrayContaining(["session:read", "entity:read"]));
    for (const scope of ["admin:tenant", "admin:billing", "admin:workspace"])
      expect(session.scopes).not.toContain(scope);
  });
  it("AUTH-05 requires a distinct selection cookie and rechecks current membership", async () => {
    const f = fixture();
    f.members = [MEMBER, { ...MEMBER, id: "workspace-2" }];
    const login = await f.post("login", { email: EMAIL, password: PASSWORD });
    expect(await login.json()).toMatchObject({
      requiresWorkspace: true,
      email: EMAIL,
      workspaces: [
        { id: MEMBER.id, name: MEMBER.name, role: MEMBER.role },
        { id: "workspace-2", name: MEMBER.name, role: MEMBER.role },
      ],
    });
    expect(cookieOf(login)).toBeUndefined();
    const choice = cookieOf(login, "mnemo_dash_choice")!;
    expect(await verifyDashboardToken(SECRET, choice.split("=")[1]!)).toBeNull();
    expect((await f.post("workspace", { workspaceId: "foreign" }, choice)).status).toBe(401);
    f.members = [{ ...MEMBER, role: "read" }];
    const selected = await f.post("workspace", { workspaceId: MEMBER.id }, choice);
    expect(selected.status).toBe(200);
    expect((await selected.json()).role).toBe("viewer");
  });
  it("AUTH-06 rejects forged, expired and password-stale workspace choices", async () => {
    const f = fixture();
    expect((await f.post("workspace", { workspaceId: MEMBER.id })).status).toBe(401);
    expect(
      (await f.post("workspace", { workspaceId: MEMBER.id }, "mnemo_dash_choice=garbage")).status
    ).toBe(401);
    f.members = [MEMBER, { ...MEMBER, id: "workspace-2" }];
    const login = await f.post("login", { email: EMAIL, password: PASSWORD });
    const choice = cookieOf(login, "mnemo_dash_choice")!;
    f.credential!.passwordUpdatedAt = "new-version";
    expect((await f.post("workspace", { workspaceId: MEMBER.id }, choice)).status).toBe(401);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 301_000); // determinism-ok: relative to the real time the choice cookie was signed at; only "past its 300 s expiry" is asserted
      expect((await f.post("workspace", { workspaceId: MEMBER.id }, choice)).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
  it("AUTH-07 rate limits normalized email across IPs with Retry-After", async () => {
    const f = fixture();
    for (let i = 0; i < 10; i++)
      await f.post(
        "login",
        { email: EMAIL.toUpperCase(), password: "bad" },
        undefined,
        `192.0.2.${i}`
      );
    const res = await f.post(
      "login",
      { email: EMAIL, password: PASSWORD },
      undefined,
      "192.0.2.99"
    );
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(f.compare).toHaveBeenCalledTimes(10);
  });
  it("AUTH-07 limits IP independently and uses a healthy Redis backend with memory fallback", async () => {
    const backend = {
      healthy: true,
      consumeToken: vi.fn(async () => ({ allowed: true, remaining: 1, resetSeconds: 1 })),
    };
    const limiter = new DashboardLoginLimiter(backend as never, () => 0);
    for (let i = 0; i < 30; i++) expect(await limiter.consume("same-ip", `mail-${i}`)).toBe(0);
    expect(backend.consumeToken).toHaveBeenCalledTimes(60);
    backend.healthy = false;
    expect(await limiter.consume("same-ip", "another-mail")).toBeGreaterThan(0);
    expect(await limiter.consume("new-ip", "another-mail")).toBe(0);
    backend.healthy = true;
    backend.consumeToken.mockRejectedValueOnce(new Error("unavailable"));
    expect(await limiter.consume("same-ip", "yet-another")).toBeGreaterThan(0);
  });
  it("AUTH-08 changes password only with valid current password and policy", async () => {
    const f = fixture();
    const login = await f.post("login", { email: EMAIL, password: PASSWORD });
    const cookie = cookieOf(login)!;
    expect(
      (
        await f.post(
          "password",
          { currentPassword: "wrong password", newPassword: "a different long password" },
          cookie
        )
      ).status
    ).toBe(401);
    expect(
      (await f.post("password", { currentPassword: PASSWORD, newPassword: "short" }, cookie)).status
    ).toBe(400);
    expect(f.tx.setPassword).not.toHaveBeenCalled();
    const res = await f.post(
      "password",
      { currentPassword: PASSWORD, newPassword: "a different long password" },
      cookie
    );
    expect(res.status).toBe(200);
    expect(f.tx.setPassword).toHaveBeenCalledWith("new-hash");
    expect(f.hash).toHaveBeenCalledWith("a different long password", 12);
    expect((await f.post("login", { email: EMAIL, password: PASSWORD })).status).toBe(401);
  });
  it("AUTH-08 rejects anonymous and API-key sessions for password changes", async () => {
    const f = fixture();
    expect(
      (await f.post("password", { currentPassword: PASSWORD, newPassword: PASSWORD })).status
    ).toBe(401);
    const { token } = await mintDashboardToken(SECRET, {
      workspaceId: MEMBER.id,
      keyPrefix: "mns_live_",
      scopes: ["memory:read"],
      plan: "free",
      actorId: "key-id",
      userId: "user-1",
    });
    const response = await f.post(
      "password",
      { currentPassword: PASSWORD, newPassword: PASSWORD },
      `mnemo_dash_token=${token}`
    );
    expect(response.status).toBe(401);
    expect(f.compare).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    {},
    { email: EMAIL },
    { email: EMAIL, password: PASSWORD, apiKey: "ambiguous" },
  ])("AUTH-09 rejects malformed login bodies", async (body) => {
    const f = fixture();
    expect((await f.post("login", body)).status).toBe(400);
    expect(f.compare).not.toHaveBeenCalled();
  });
  it("AUTH-08 enforces bcrypt limits and rejects the email as password", () => {
    expect(passwordPolicyError("12345678901", EMAIL)).toBeTruthy();
    expect(passwordPolicyError(EMAIL.toUpperCase(), EMAIL)).toBeTruthy();
    expect(passwordPolicyError("é".repeat(37), EMAIL)).toBeTruthy();
    expect(passwordPolicyError("é".repeat(36), EMAIL)).toBeNull();
    expect(passwordPolicyError("123456789012", EMAIL)).toBeNull();
  });
  it("AUTH-02 uses real cost-12 bcrypt for stored and dummy credentials", async () => {
    const f = fixture();
    const hash = await bcrypt.hash(PASSWORD, 12);
    f.credential!.passwordHash = hash;
    const auth = new DashboardPasswordAuth(f.store);
    const spy = vi.spyOn(bcrypt, "compare");
    try {
      expect(await auth.login(EMAIL, PASSWORD)).not.toBeNull();
      f.credential = null;
      expect(await auth.login(EMAIL, PASSWORD)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
      for (const call of spy.mock.calls) expect(bcrypt.getRounds(call[1] as string)).toBe(12);
    } finally {
      spy.mockRestore();
    }
  });
  it("AUTH-07 refills local buckets while rejected requests keep arriving", async () => {
    let now = 0;
    const limiter = new DashboardLoginLimiter(undefined, () => now);
    for (let i = 0; i < 10; i++) expect(await limiter.consume(`ip-${i}`, EMAIL)).toBe(0);
    now = 45_000;
    expect(await limiter.consume("new-ip", EMAIL)).toBe(45);
    now = 90_000;
    expect(await limiter.consume("new-ip", EMAIL)).toBe(0);
  });
  it("AUTH-07 the per-address burst comes from MNEMO_DASHBOARD_LOGIN_IP_BURST and falls back to 30", async () => {
    const burstOf = async (value: string | undefined) => {
      const limiter = new DashboardLoginLimiter(
        undefined,
        () => 0,
        value === undefined ? {} : { MNEMO_DASHBOARD_LOGIN_IP_BURST: value }
      );
      let allowed = 0;
      while ((await limiter.consumeIp("burst-ip")) === 0 && allowed < 400) allowed++;
      return allowed;
    };
    expect(await burstOf(undefined)).toBe(30);
    expect(await burstOf("300")).toBe(300);
    for (const invalid of ["", "abc", "0", "-5", "1.5", "30x", "100000"])
      expect(await burstOf(invalid)).toBe(30);
  });
  it("AUTH-05 remembers the last workspace and offers it again at the next choice", async () => {
    const f = fixture();
    f.members = [MEMBER, { ...MEMBER, id: "workspace-2" }];
    const first = await f.post("login", { email: EMAIL, password: PASSWORD });
    expect((await first.json()).preferredWorkspaceId).toBeUndefined();
    const choice = cookieOf(first, "mnemo_dash_choice")!;
    const selected = await f.post("workspace", { workspaceId: "workspace-2" }, choice);
    expect(selected.status).toBe(200);
    const header = selected.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("mnemo_last_workspace="))!;
    expect(header).toContain("mnemo_last_workspace=workspace-2");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Path=/dashboard");
    expect(header).toMatch(/Max-Age=31536000/i);

    const again = await f.post(
      "login",
      { email: EMAIL, password: PASSWORD },
      "mnemo_last_workspace=workspace-2"
    );
    expect((await again.json()).preferredWorkspaceId).toBe("workspace-2");
    // A workspace the person no longer belongs to is never offered.
    const stale = await f.post(
      "login",
      { email: EMAIL, password: PASSWORD },
      "mnemo_last_workspace=gone"
    );
    expect((await stale.json()).preferredWorkspaceId).toBeUndefined();
  });
  it("AUTH-02 audits success and failure without credentials or raw email", async () => {
    const log = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const f = fixture();
      await f.post("login", { email: EMAIL, password: "incorrect-password" });
      await f.post("login", { email: EMAIL, password: PASSWORD });
      const events = log.mock.calls
        .map(([event]) => event)
        .filter((event) => typeof event === "object" && event?.event === "dashboard.password_auth");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outcome: "failure" }),
          expect.objectContaining({ outcome: "success", userId: "user-1" }),
        ])
      );
      const serialized = JSON.stringify(events);
      for (const value of [
        EMAIL,
        PASSWORD,
        "stored-hash",
        "incorrect-password",
        "mnemo_dash_token",
      ])
        expect(serialized.includes(value)).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("AUTH-09 returns a generic 503 if credential storage is unavailable", async () => {
    const f = fixture();
    f.store.withEmail = async () => {
      throw new Error("database offline");
    };
    const response = await f.post("login", { email: EMAIL, password: PASSWORD });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "auth_unavailable",
      message: "Authentication service unavailable",
    });
  });

  it("AUTH-09 logs the failure class for operators, never the error message", async () => {
    const f = fixture();
    f.store.withEmail = async () => {
      throw Object.assign(new Error("permission denied for table mnemo_user_credential"), {
        code: "42501",
      });
    };
    const log = vi.spyOn(logger, "info");
    try {
      expect((await f.post("login", { email: EMAIL, password: PASSWORD })).status).toBe(503);
      const event = log.mock.calls
        .map(([fields]) => fields as Record<string, unknown>)
        .find((fields) => fields.reason === "login_unavailable");
      expect(event).toMatchObject({ errorCode: "42501" });
      expect(JSON.stringify(log.mock.calls)).not.toContain("permission denied");
    } finally {
      log.mockRestore();
    }
  });
});

it("AUTH-15 session workspace name comes from scoped metadata, including API key sessions", async () => {
  const queries: string[] = [];
  const query = vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    queries.push(text);
    return text.includes("SELECT name") ? [{ name: "Proyecto Alfa" }] : [];
  });
  const begin = vi.fn(async (fn: (sql: typeof query) => unknown) => fn(query));
  const app = new Hono();
  mountDashboardAuth(app, { metricsPgClient: { begin } } as unknown as ServerDeps);
  const { token } = await mintDashboardToken(SECRET, {
    workspaceId: "workspace-1",
    keyPrefix: "test",
    scopes: ["memory:read"],
    plan: "free",
    actorId: "test-key",
    userId: null,
  });
  const response = await app.request("/dashboard/auth/session", {
    headers: { cookie: `mnemo_dash_token=${token}` },
  });
  expect(response.status).toBe(200);
  expect((await response.json()).workspaceName).toBe("Proyecto Alfa");
  // Two transactions: the sign-out check (AUD-007), then the scoped metadata read.
  expect(queries).toHaveLength(6);
  expect(queries[2]).toContain("mnemo_dashboard_session_revoked(");
  const metadata = queries.slice(3);
  expect(metadata[0]).toBe("SET LOCAL ROLE app_user");
  expect(metadata[1]).toContain("set_config('mnemosyne.actor_user_id'");
  expect(metadata[1]).toContain("set_config('mnemosyne.actor_tenant_id'");
  expect(metadata[2]).toContain("SELECT name");
});

describe("AUTH-04 bcrypt never runs inside a credential transaction", () => {
  /** Wrap the fixture store so compare/hash can see whether a transaction is open. */
  function tracked() {
    const f = fixture();
    let open = 0;
    const inside: string[] = [];
    const wrap =
      <K extends "withEmail" | "withUser">(name: K) =>
      async <T>(key: string, fn: (tx: CredentialTx) => Promise<T>): Promise<T> => {
        open += 1;
        try {
          return await (f.store[name] as CredentialStore[K])(key, fn);
        } finally {
          open -= 1;
        }
      };
    const store: CredentialStore = { withEmail: wrap("withEmail"), withUser: wrap("withUser") };
    const compare = vi.fn(async (password: string, hash: string) => {
      if (open) inside.push("compare");
      return f.compare(password, hash);
    });
    const hash = vi.fn(async () => {
      if (open) inside.push("hash");
      return "new-hash";
    });
    const auth = new DashboardPasswordAuth(store, {
      compare,
      hash,
      dummyHash: "dummy-cost-12-hash",
    });
    return { f, auth, inside, compare, hash };
  }

  it("compares outside the transaction for existing and missing accounts", async () => {
    for (const missing of [false, true]) {
      const t = tracked();
      if (missing) t.f.credential = null;
      await t.auth.login(EMAIL, PASSWORD);
      await t.auth.login(EMAIL, "incorrect password");
      expect(t.compare).toHaveBeenCalledTimes(2);
      expect(t.inside).toEqual([]);
    }
  });

  it("compares and hashes outside the transaction when changing a password", async () => {
    const t = tracked();
    expect(await t.auth.change("user-1", PASSWORD, "a brand new password")).toBe("ok");
    expect(t.hash).toHaveBeenCalledTimes(1);
    expect(t.inside).toEqual([]);
    expect(t.f.credential!.passwordHash).toBe("new-hash");
  });

  it("does not hash a replacement that the policy or the current password rejects", async () => {
    const t = tracked();
    expect(await t.auth.change("user-1", "incorrect password", "a brand new password")).toBe(
      "invalid"
    );
    expect(await t.auth.change("user-1", PASSWORD, "short")).not.toBe("ok");
    expect(t.hash).not.toHaveBeenCalled();
  });

  it("compares outside the transaction when re-entering a password", async () => {
    const t = tracked();
    expect(await t.auth.verify("user-1", PASSWORD)).toBe(true);
    expect(await t.auth.verify("user-1", "incorrect password")).toBe(false);
    expect(t.compare).toHaveBeenCalledTimes(2);
    expect(t.inside).toEqual([]);
  });

  it("denies without counting a failure when the password changed after the snapshot", async () => {
    const f = fixture();
    // The comparison succeeds against the snapshot, then the stored hash is
    // replaced before the result is recorded (a concurrent password change).
    f.compare.mockImplementationOnce(async () => {
      f.credential = { ...f.credential!, passwordHash: "replaced-hash" };
      return true;
    });
    expect(await f.auth.login(EMAIL, PASSWORD)).toBeNull();
    expect(f.tx.failure).not.toHaveBeenCalled();
    expect(f.tx.resetFailures).not.toHaveBeenCalled();
  });
});

describe("password re-entry (instance plane grant/revoke)", () => {
  it("a wrong password counts toward the lockout; a right one resets the count", async () => {
    const f = fixture();
    expect(await f.auth.verify("user-1", "incorrect password")).toBe(false);
    expect(f.credential!.failedAttempts).toBe(1);
    expect(await f.auth.verify("user-1", PASSWORD)).toBe(true);
    expect(f.credential!.failedAttempts).toBe(0);
  });

  it("locks after five failures, then refuses the right password too", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) expect(await f.auth.verify("user-1", "incorrect")).toBe(false);
    expect(f.credential!.lockedUntil).not.toBeNull();
    expect(await f.auth.verify("user-1", PASSWORD)).toBe(false);
    // The lockout is shared with sign-in.
    expect(await f.auth.login(EMAIL, PASSWORD)).toBeNull();
  });

  it("refuses a disabled user and an unknown one", async () => {
    const f = fixture();
    (f.tx as { disabled: boolean }).disabled = true;
    expect(await f.auth.verify("user-1", PASSWORD)).toBe(false);
    const g = fixture();
    g.credential = null;
    expect(await g.auth.verify("user-1", PASSWORD)).toBe(false);
  });
});
