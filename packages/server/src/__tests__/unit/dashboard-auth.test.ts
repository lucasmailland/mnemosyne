/**
 * Unit tests for the dashboard session layer (Fase 0 — auth foundation).
 *
 *   - dashboard-session.ts: secret validation, role derivation, JWT roundtrip
 *   - routes/dashboard-auth.ts: login/logout/session
 *
 * Pattern mirrors admin-route.test.ts: plain Hono app + fake deps, driven via
 * app.request() — no socket, no DB. bcrypt hashes use cost 4 for test speed
 * (bcrypt.compare reads the cost from the hash itself).
 */
import { Hono } from "hono";
import { sign } from "hono/jwt";
import bcrypt from "bcrypt";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AuthAdapter } from "@mnemo-ai/types";

import {
  DASHBOARD_COOKIE,
  DASHBOARD_SESSION_TTL_SECONDS,
  deriveDashboardRole,
  mintDashboardToken,
  readDashboardSecret,
  verifyDashboardToken,
} from "../../dashboard-session.js";
import { mountDashboardAuth } from "../../routes/dashboard-auth.js";
import { mountDashboardApi } from "../../routes/dashboard-api.js";
import { toErrorBody } from "../../errors.js";
import type { ServerDeps } from "../../deps.js";

const SECRET = "0123456789abcdef0123456789abcdef"; // 32 bytes
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";
const API_KEY = "mns_live_dashboardtestkey0001";

// ── dashboard-session.ts ──────────────────────────────────────────────────────

describe("readDashboardSecret", () => {
  it("returns null when unset", () => {
    expect(readDashboardSecret({})).toBeNull();
  });

  it("returns the secret when >= 32 bytes", () => {
    expect(readDashboardSecret({ MNEMO_DASHBOARD_SECRET: SECRET })).toBe(SECRET);
  });

  it("throws when set but shorter than 32 bytes", () => {
    expect(() => readDashboardSecret({ MNEMO_DASHBOARD_SECRET: "too-short" })).toThrow(
      /at least 32 bytes/
    );
  });
});

describe("deriveDashboardRole", () => {
  it("admin when admin:keys + memory:admin", () => {
    expect(deriveDashboardRole(["admin:keys", "memory:admin", "memory:read"])).toBe("admin");
  });

  it("contributor when memory:write without both admin scopes", () => {
    expect(deriveDashboardRole(["memory:read", "memory:write"])).toBe("contributor");
    expect(deriveDashboardRole(["memory:write", "admin:keys"])).toBe("contributor");
  });

  it("viewer for memory:read only (and for empty scopes)", () => {
    expect(deriveDashboardRole(["memory:read"])).toBe("viewer");
    expect(deriveDashboardRole([])).toBe("viewer");
  });
});

describe("mintDashboardToken / verifyDashboardToken", () => {
  const input = {
    workspaceId: WORKSPACE_ID,
    keyPrefix: "mns_live_",
    scopes: ["memory:read", "memory:write"],
    plan: "pro",
    actorId: "key_provenance_01",
    userId: "user_provenance_01",
  };

  it("roundtrips a valid token", async () => {
    const { token, expiresAt } = await mintDashboardToken(SECRET, input);
    const payload = await verifyDashboardToken(SECRET, token);
    expect(payload).not.toBeNull();
    expect(payload!.workspaceId).toBe(WORKSPACE_ID);
    expect(payload!.keyPrefix).toBe("mns_live_");
    expect(payload!.scopes).toEqual(["memory:read", "memory:write"]);
    expect(payload!.plan).toBe("pro");
    expect(new Date(expiresAt).getTime()).toBe(payload!.exp * 1000);
    expect(payload!.exp - payload!.iat).toBe(DASHBOARD_SESSION_TTL_SECONDS);
  });

  // p48: mint→verify roundtrip preserves actorId/userId (tasks 2.1)
  it("roundtrips actorId and a non-null userId", async () => {
    const { token } = await mintDashboardToken(SECRET, input);
    const payload = await verifyDashboardToken(SECRET, token);
    expect(payload).not.toBeNull();
    expect(payload!.actorId).toBe("key_provenance_01");
    expect(payload!.userId).toBe("user_provenance_01");
  });

  it("roundtrips actorId with a null userId", async () => {
    const { token } = await mintDashboardToken(SECRET, { ...input, userId: null });
    const payload = await verifyDashboardToken(SECRET, token);
    expect(payload).not.toBeNull();
    expect(payload!.actorId).toBe("key_provenance_01");
    expect(payload!.userId).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const { token } = await mintDashboardToken(SECRET, input);
    const other = "ffffffffffffffffffffffffffffffff";
    expect(await verifyDashboardToken(other, token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    // Mint 9 hours in the past — past the 8h TTL.
    const past = Date.now() - 9 * 60 * 60 * 1000; // determinism-ok: relative offset from now, tests TTL expiry — not asserted against a fixed value
    const { token } = await mintDashboardToken(SECRET, input, past);
    expect(await verifyDashboardToken(SECRET, token)).toBeNull();
  });

  it("rejects garbage tokens without throwing", async () => {
    expect(await verifyDashboardToken(SECRET, "not.a.jwt")).toBeNull();
    expect(await verifyDashboardToken(SECRET, "")).toBeNull();
  });

  // p48 task 2.2: a stale/pre-fix token (minted before actorId existed) must be
  // rejected, never crash a route with a missing-shape payload.
  it("rejects a hand-signed legacy payload with no actorId claim", async () => {
    const now = Math.floor(Date.now() / 1000); // determinism-ok: JWT iat/exp offset for a test-signed token, never asserted against wall-clock time
    const legacyPayload = {
      workspaceId: WORKSPACE_ID,
      keyPrefix: "mns_live_",
      scopes: ["memory:read"],
      plan: "free",
      iat: now,
      exp: now + DASHBOARD_SESSION_TTL_SECONDS,
      // no actorId, no userId — the pre-fix shape.
    };
    const legacyToken = await sign(legacyPayload, SECRET, "HS256");
    expect(await verifyDashboardToken(SECRET, legacyToken)).toBeNull();
  });

  // p48 task 2.3: a malformed actorId claim (wrong type or empty) is rejected.
  it.each([
    ["a number", 12345],
    ["an object", { id: "x" }],
    ["an empty string", ""],
  ])("rejects a token whose actorId is %s", async (_label, badActorId) => {
    const now = Math.floor(Date.now() / 1000); // determinism-ok: JWT iat/exp offset for a test-signed token, never asserted against wall-clock time
    const malformedPayload = {
      workspaceId: WORKSPACE_ID,
      keyPrefix: "mns_live_",
      scopes: ["memory:read"],
      plan: "free",
      actorId: badActorId,
      userId: null,
      iat: now,
      exp: now + DASHBOARD_SESSION_TTL_SECONDS,
    };
    const token = await sign(malformedPayload, SECRET, "HS256");
    expect(await verifyDashboardToken(SECRET, token)).toBeNull();
  });
});

// ── routes/dashboard-auth.ts ──────────────────────────────────────────────────

let keyHash: string;

function makeDeps(): ServerDeps {
  const row = {
    id: "key_dash_01",
    keyHash,
    workspaceId: WORKSPACE_ID,
    scopes: ["memory:read", "memory:write", "memory:admin", "admin:keys"],
    plan: "pro",
    userId: "user_dash_01",
  };
  return {
    apiKeys: {
      listActive: async () => [row],
      touch: () => {},
    },
  } as unknown as ServerDeps;
}

function makeApp(): Hono {
  const app = new Hono();
  mountDashboardAuth(app, makeDeps());
  return app;
}

/** A scoped (`mk_*`) auth adapter mock — mirrors scoped-auth-dispatch.test.ts. */
function makeScopedAdapter(ctxOverride: Record<string, unknown> = {}): AuthAdapter {
  return {
    id: "scoped",
    authenticate: async () => ({
      ok: true,
      context: {
        workspaceId: WORKSPACE_ID,
        actorId: "agent_dash_mk_01",
        actorType: "agent" as const,
        userId: "user_dash_mk_01",
        scopes: ["memory:read", "memory:write"],
        keyType: "mk_live_",
        ...ctxOverride,
      },
    }),
    authorize: async () => {},
    healthCheck: async () => ({ status: "ok", latencyMs: 0 }),
  } as unknown as AuthAdapter;
}

function makeAppWithScopedAdapter(): Hono {
  const deps = { ...makeDeps(), scopedAuthAdapter: makeScopedAdapter() } as ServerDeps;
  const app = new Hono();
  mountDashboardAuth(app, deps);
  return app;
}

/** Extract the mnemo_dash_token value from a Set-Cookie header. */
function cookieOf(res: Response): string | null {
  const header = res.headers.get("set-cookie");
  const match = header?.match(new RegExp(`${DASHBOARD_COOKIE}=([^;]*)`));
  return match?.[1] ?? null;
}

describe("dashboard auth routes", () => {
  beforeEach(async () => {
    process.env.MNEMO_DASHBOARD_SECRET = SECRET;
    // Cost 4: fast test hashes; compare() reads cost from the hash itself.
    keyHash ??= await bcrypt.hash(API_KEY, 4);
  });

  afterEach(() => {
    delete process.env.MNEMO_DASHBOARD_SECRET;
  });

  it("does not mount any route when MNEMO_DASHBOARD_SECRET is unset", async () => {
    delete process.env.MNEMO_DASHBOARD_SECRET;
    const app = makeApp();
    const res = await app.request("/dashboard/auth/session");
    expect(res.status).toBe(404);
  });

  it("login with a valid key sets the session cookie and returns session info", async () => {
    const app = makeApp();
    const res = await app.request("/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: API_KEY }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBe(WORKSPACE_ID);
    expect(body.keyPrefix).toBe(API_KEY.slice(0, 9));
    expect(body.role).toBe("admin");
    expect(body.plan).toBe("pro");
    expect(typeof body.expiresAt).toBe("string");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${DASHBOARD_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/dashboard");
    expect(setCookie).toContain("SameSite=Lax");
    // Raw API key must never appear in the cookie.
    expect(setCookie).not.toContain(API_KEY);

    // p48 task 2.4: login populates actorId/userId on the decoded cookie
    // payload for the mns_* (bcrypt) branch.
    const token = cookieOf(res)!;
    const payload = await verifyDashboardToken(SECRET, token);
    expect(payload).not.toBeNull();
    expect(payload!.actorId).toBe("key_dash_01");
    expect(payload!.userId).toBe("user_dash_01");
  });

  // p48 task 2.5: login populates actorId/userId on the decoded cookie
  // payload for the mk_* (scoped adapter) branch.
  it("login with an mk_* key populates actorId/userId from the scoped adapter context", async () => {
    const app = makeAppWithScopedAdapter();
    const res = await app.request("/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "mk_live_dashkey01_secretdashboardtestkey0001" }),
    });
    expect(res.status).toBe(200);
    const token = cookieOf(res)!;
    const payload = await verifyDashboardToken(SECRET, token);
    expect(payload).not.toBeNull();
    expect(payload!.actorId).toBe("agent_dash_mk_01");
    expect(payload!.userId).toBe("user_dash_mk_01");
  });

  it("login with an invalid key returns 401 and no cookie", async () => {
    const app = makeApp();
    const res = await app.request("/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "mns_live_wrongkeywrongkey01" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_key");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("login with a malformed body returns 400", async () => {
    const app = makeApp();
    const noJson = await app.request("/dashboard/auth/login", { method: "POST", body: "nope" });
    expect(noJson.status).toBe(400);
    const noKey = await app.request("/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(noKey.status).toBe(400);
  });

  it("session with a valid cookie returns the session; without returns 401", async () => {
    const app = makeApp();
    const login = await app.request("/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: API_KEY }),
    });
    const token = cookieOf(login)!;

    const ok = await app.request("/dashboard/auth/session", {
      headers: { cookie: `${DASHBOARD_COOKIE}=${token}` },
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.workspaceId).toBe(WORKSPACE_ID);
    expect(body.role).toBe("admin");

    const missing = await app.request("/dashboard/auth/session");
    expect(missing.status).toBe(401);
    expect((await missing.json()).error).toBe("no_session");

    const garbage = await app.request("/dashboard/auth/session", {
      headers: { cookie: `${DASHBOARD_COOKIE}=garbage` },
    });
    expect(garbage.status).toBe(401);
  });

  it("logout clears the cookie (fetch → 200 JSON, plain nav → 303)", async () => {
    const app = makeApp();
    const fetchRes = await app.request("/dashboard/auth/logout", { method: "POST" });
    expect(fetchRes.status).toBe(200);
    expect((await fetchRes.json()).ok).toBe(true);
    const cleared = fetchRes.headers.get("set-cookie") ?? "";
    expect(cleared).toContain(`${DASHBOARD_COOKIE}=;`);
    expect(cleared).toContain("Max-Age=0");

    const plainRes = await app.request("/dashboard/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-dest": "document", accept: "text/html" },
    });
    expect(plainRes.status).toBe(303);
    expect(plainRes.headers.get("location")).toBe("/dashboard/login");
  });
});

// ── routes/dashboard-api.ts cookie middleware — p48 provenance propagation ──

describe("dashboard-api.ts cookie middleware — actorId/userId provenance (p48)", () => {
  beforeEach(() => {
    process.env.MNEMO_DASHBOARD_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.MNEMO_DASHBOARD_SECRET;
  });

  function makeApiApp(deps: Partial<ServerDeps> = {}): Hono {
    const app = new Hono();
    // Same error → status mapping the real app.ts installs, so a thrown
    // NotFoundError (404) is distinguishable from an uncaught Error (500) —
    // the exact signal task 2.7 needs to prove resolveProvenance() didn't throw.
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err);
      return c.json(body, status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500);
    });
    // flatten-legacy-dual-core PR8: DELETE /facts/:id was ported from
    // deps.core.closeFact() to deps.storage.getFact()+archiveFact() — a
    // missing fact is now signaled by storage.getFact() resolving null.
    mountDashboardApi(app, {
      core: { closeFact: async () => false },
      storage: { getFact: async () => null },
      ...deps,
    } as ServerDeps);
    return app;
  }

  const WRITE_SCOPES = [
    "memory:read",
    "memory:write",
    "memory:delete",
    "memory:admin",
    "admin:keys",
  ];

  // Task 2.6: a stale/pre-fix cookie (no actorId claim) is rejected cleanly —
  // 401 + HX-Redirect, never a 500 crash.
  it("stale/pre-fix cookie on /dashboard/api/* → 401 no_session + HX-Redirect, never 500", async () => {
    const now = Math.floor(Date.now() / 1000); // determinism-ok: JWT iat/exp offset for a test-signed token, never asserted against wall-clock time
    const legacyToken = await sign(
      {
        workspaceId: WORKSPACE_ID,
        keyPrefix: "mns_live_",
        scopes: WRITE_SCOPES,
        plan: "free",
        iat: now,
        exp: now + DASHBOARD_SESSION_TTL_SECONDS,
        // pre-fix shape: no actorId, no userId.
      },
      SECRET,
      "HS256"
    );
    const app = makeApiApp();
    const res = await app.request("/dashboard/api/facts/fact_test_01", {
      method: "DELETE",
      headers: { cookie: `${DASHBOARD_COOKIE}=${legacyToken}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("hx-redirect")).toBe("/dashboard/login");
    expect((await res.json()).error).toBe("no_session");
  });

  // Task 2.7: a valid post-fix session sets actorId/userId on context AND
  // resolveProvenance(c) succeeds (no throw). Proven via a real route
  // (DELETE /facts/:id) that calls resolveProvenance(c) before touching
  // deps.core — pre-fix, the missing actorId made resolveProvenance() throw,
  // which surfaces as an uncaught 500 (mapped via app.onError above);
  // post-fix, it proceeds to deps.core.closeFact() (stubbed to return false),
  // producing a clean 404 instead.
  it("valid post-fix session sets actorId/userId on context and resolveProvenance succeeds (no throw)", async () => {
    const { token } = await mintDashboardToken(SECRET, {
      workspaceId: WORKSPACE_ID,
      keyPrefix: "mns_live_",
      scopes: WRITE_SCOPES,
      plan: "pro",
      actorId: "key_provenance_bridge_01",
      userId: "user_provenance_bridge_01",
    });
    const app = makeApiApp();
    const res = await app.request("/dashboard/api/facts/fact_test_01", {
      method: "DELETE",
      headers: { cookie: `${DASHBOARD_COOKIE}=${token}` },
    });
    // 404 (not_found) proves resolveProvenance(c) did NOT throw — the handler
    // reached deps.core.closeFact() and reported a clean "not found", instead
    // of dying with a 500 on a missing actorId.
    expect(res.status).toBe(404);
  });
});
