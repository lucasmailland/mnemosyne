/**
 * Unit tests for S6 — user-token provisioning route family
 * (POST/GET /tenants/:tenantId/users/:userId/tokens, DELETE .../tokens/:keyId).
 *
 * Pattern: OpenAPIHono + fake auth middleware + fake SQL tag function that
 * pattern-matches on normalized SQL text, mirroring tenant-routes-rls.test.ts's
 * makeTenantSql() convention (repo calls and the route's own raw tx queries
 * all flow through the same tag function, since TenantRepository is
 * constructed on top of the same tx passed to mountUserTokens's handlers).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountUserTokens } from "../../routes/user-tokens.js";

const TENANT_ID = "tenant-1";
const CALLER_ID = "caller-1";
const TARGET_ID = "target-1";
const WORKSPACE_ID = "ws-1";

type QueryCall = { sql: string; values: readonly unknown[] };

function normalizeSql(strings: TemplateStringsArray): string {
  return strings.join("?").replace(/\s+/g, " ").trim();
}

interface Fixture {
  tenantRoles?: Record<string, string | null>;
  workspace?: { id: string; tenantId: string } | null;
  workspaceRoles?: Record<string, string | null>;
  tokenRows?: unknown[];
  revokeFound?: boolean;
}

function makeUserTokenSql(fixture: Fixture) {
  const calls: QueryCall[] = [];
  const tenantRoles = fixture.tenantRoles ?? {};
  const workspace = fixture.workspace ?? null;
  const workspaceRoles = fixture.workspaceRoles ?? {};

  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = normalizeSql(strings);
    calls.push({ sql, values });

    if (sql.startsWith("SELECT set_config")) return [];

    if (sql.includes("SELECT role") && sql.includes("mnemo_tenant_member")) {
      const userId = values[1] as string;
      const role = tenantRoles[userId] ?? null;
      return role ? [{ role }] : [];
    }

    if (
      sql.includes("mnemo_workspace") &&
      sql.includes("owner_user_id") &&
      sql.includes("visibility")
    ) {
      const id = values[0] as string;
      if (!workspace || id !== workspace.id) return [];
      return [
        {
          id: workspace.id,
          name: "Some workspace",
          slug: null,
          tenant_id: workspace.tenantId,
          owner_user_id: "someone",
          visibility: "private",
        },
      ];
    }

    if (sql.includes("SELECT role") && sql.includes("mnemo_workspace_member")) {
      const userId = values[1] as string;
      const role = workspaceRoles[userId] ?? null;
      return role ? [{ role }] : [];
    }

    if (sql.includes("INSERT INTO mnemo_api_keys")) {
      return [];
    }

    if (sql.includes("SELECT id, label, scopes, workspace_id")) {
      return fixture.tokenRows ?? [];
    }

    if (sql.includes("UPDATE mnemo_api_keys")) {
      if (fixture.revokeFound === false) return [];
      const keyId = values[1] as string;
      return [{ id: keyId }];
    }

    return [];
  }) as unknown as postgres.TransactionSql;

  (tx as unknown as Record<string, unknown>).array = (v: unknown) => v;

  const sql = (async () => []) as unknown as postgres.Sql;
  sql.begin = (async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    fn(tx)) as postgres.Sql["begin"];

  return { sql, calls };
}

function makeApp(
  fixture: Fixture,
  authOverrides: Partial<{
    scopes: string[];
    userId: string;
    tenantId: string;
    maxSensitivity: "public" | "internal" | "confidential" | "restricted";
  }> = {}
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  const fakeSql = makeUserTokenSql(fixture);

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "uk_live_");
    c.set("scopes", authOverrides.scopes ?? ["admin:tenant", "memory:read", "memory:write"]);
    c.set("plan", "free");
    c.set("userId", authOverrides.userId ?? CALLER_ID);
    c.set("tenantId", authOverrides.tenantId ?? TENANT_ID);
    c.set("actorId", authOverrides.userId ?? CALLER_ID);
    if (authOverrides.maxSensitivity) c.set("maxSensitivity", authOverrides.maxSensitivity);
    await next();
  });

  mountUserTokens(app, { metricsPgClient: fakeSql.sql } as unknown as ServerDeps);

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { app, calls: fakeSql.calls };
}

const HAPPY_FIXTURE: Fixture = {
  tenantRoles: { [CALLER_ID]: "admin", [TARGET_ID]: "member" },
  workspace: { id: WORKSPACE_ID, tenantId: TENANT_ID },
  workspaceRoles: { [TARGET_ID]: "read" },
};

describe("POST /tenants/:tenantId/users/:userId/tokens", () => {
  it("mints a token on the happy path", async () => {
    const { app, calls } = makeApp(HAPPY_FIXTURE);

    const res = await app.request(`/tenants/${TENANT_ID}/users/${TARGET_ID}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "for target", homeWorkspaceId: WORKSPACE_ID }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.key).toMatch(/^uk_live_/);
    expect(json.userId).toBe(TARGET_ID);
    expect(json.tenantId).toBe(TENANT_ID);
    expect(json.workspaceId).toBe(WORKSPACE_ID);

    const insertCall = calls.find((c) => c.sql.includes("INSERT INTO mnemo_api_keys"));
    expect(insertCall).toBeDefined();
    expect(insertCall?.values[1]).toBe(WORKSPACE_ID); // workspace_id
    expect(insertCall?.values[2]).toBe(TARGET_ID); // user_id
    expect(insertCall?.values[3]).toBe(TENANT_ID); // tenant_id
    expect(insertCall?.sql).toContain("'user'"); // key_kind is a literal, not a bound value
  });

  it("403s when the caller is not a tenant owner/admin", async () => {
    const { app } = makeApp({
      ...HAPPY_FIXTURE,
      tenantRoles: { [CALLER_ID]: "member", [TARGET_ID]: "member" },
    });

    const res = await app.request(`/tenants/${TENANT_ID}/users/${TARGET_ID}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "for target", homeWorkspaceId: WORKSPACE_ID }),
    });

    expect(res.status).toBe(403);
  });

  it("404s (anti-probing) when the target user is not a tenant member", async () => {
    const { app } = makeApp({
      ...HAPPY_FIXTURE,
      tenantRoles: { [CALLER_ID]: "admin" }, // target absent
    });

    const res = await app.request(`/tenants/${TENANT_ID}/users/${TARGET_ID}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "for target", homeWorkspaceId: WORKSPACE_ID }),
    });

    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.message).toMatch(/not a member of this tenant/);
  });

  it("404s when homeWorkspaceId does not belong to this tenant", async () => {
    const { app } = makeApp({
      ...HAPPY_FIXTURE,
      workspace: { id: WORKSPACE_ID, tenantId: "some-other-tenant" },
    });

    const res = await app.request(`/tenants/${TENANT_ID}/users/${TARGET_ID}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "for target", homeWorkspaceId: WORKSPACE_ID }),
    });

    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.message).toMatch(/does not belong to this tenant/);
  });

  it("400s when the target user is not a member of the home workspace", async () => {
    const { app } = makeApp({
      ...HAPPY_FIXTURE,
      workspaceRoles: {}, // target has no role there
    });

    const res = await app.request(`/tenants/${TENANT_ID}/users/${TARGET_ID}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "for target", homeWorkspaceId: WORKSPACE_ID }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.message).toMatch(/POST \/workspaces\/:id\/members/);
  });

  it("403s when requested scopes exceed the caller's own scopes", async () => {
    const { app } = makeApp(HAPPY_FIXTURE, { scopes: ["admin:tenant", "memory:read"] });

    const res = await app.request(`/tenants/${TENANT_ID}/users/${TARGET_ID}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "for target",
        homeWorkspaceId: WORKSPACE_ID,
        scopes: ["memory:hard_delete"],
      }),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.message).toMatch(/Cannot grant scopes the caller doesn't have/);
  });

  // SEC-1, as WP-11 closed it for POST /admin/keys: a token minted for another
  // user carries no scope that does not exist, none its minter lacks, and no
  // sensitivity ceiling above its minter's.
  describe("minting stays within the caller's own authority (SEC-1)", () => {
    function mint(app: OpenAPIHono<{ Variables: AuthVariables }>, body: Record<string, unknown>) {
      return app.request(`/tenants/${TENANT_ID}/users/${TARGET_ID}/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "for target", homeWorkspaceId: WORKSPACE_ID, ...body }),
      });
    }
    const inserted = (calls: QueryCall[]) =>
      calls.filter((c) => c.sql.includes("INSERT INTO mnemo_api_keys"));
    /** Bound values of the INSERT: scopes are the 9th, max_sensitivity the 12th. */
    const scopesOf = (call: QueryCall) => call.values[8];
    const ceilingOf = (call: QueryCall) => call.values[11];

    it("400s on a scope that does not exist, even one the caller's legacy key holds", async () => {
      const { app, calls } = makeApp(HAPPY_FIXTURE, {
        scopes: ["admin:tenant", "memory:read", "*"],
      });
      for (const scopes of [["*"], ["memory:read", "root"], ["memory:*"]]) {
        const res = await mint(app, { scopes });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { message: string }).message).toMatch(/Unknown scope/);
      }
      expect(inserted(calls)).toEqual([]);
    });

    it("403s on a scope the caller does not hold, and writes nothing", async () => {
      const { app, calls } = makeApp(HAPPY_FIXTURE, { scopes: ["admin:tenant", "memory:read"] });
      const res = await mint(app, { scopes: ["memory:read", "memory:write"] });
      expect(res.status).toBe(403);
      expect(inserted(calls)).toEqual([]);
    });

    it("403s on a ceiling above the caller's own, and writes nothing", async () => {
      const { app, calls } = makeApp(HAPPY_FIXTURE, { maxSensitivity: "internal" });
      for (const maxSensitivity of ["confidential", "restricted"]) {
        const res = await mint(app, { maxSensitivity });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { message: string }).message).toMatch(/sensitivity ceiling/);
      }
      expect(inserted(calls)).toEqual([]);
    });

    it("gives a capped caller's token the caller's own cap when it names none", async () => {
      const { app, calls } = makeApp(HAPPY_FIXTURE, { maxSensitivity: "internal" });
      const res = await mint(app, {});
      expect(res.status).toBe(201);
      expect(ceilingOf(inserted(calls)[0]!)).toBe("internal");
    });

    it("mints a subset of the caller's scopes at or below its ceiling", async () => {
      const { app, calls } = makeApp(HAPPY_FIXTURE, { maxSensitivity: "confidential" });
      const res = await mint(app, { scopes: ["memory:read"], maxSensitivity: "internal" });
      expect(res.status).toBe(201);
      expect(scopesOf(inserted(calls)[0]!)).toEqual(["memory:read"]);
      expect(ceilingOf(inserted(calls)[0]!)).toBe("internal");
    });

    it("leaves out of the default scope set what the caller holds but is no scope", async () => {
      const { app, calls } = makeApp(HAPPY_FIXTURE, {
        scopes: ["admin:tenant", "memory:read", "*"],
      });
      const res = await mint(app, {});
      expect(res.status).toBe(201);
      expect(scopesOf(inserted(calls)[0]!)).toEqual(["admin:tenant", "memory:read"]);
    });
  });
});

describe("GET /tenants/:tenantId/users/:userId/tokens", () => {
  it("lists tokens with secrets masked", async () => {
    const { app } = makeApp({
      ...HAPPY_FIXTURE,
      tokenRows: [
        {
          id: "uk_abc",
          label: "for target",
          scopes: ["memory:read"],
          workspace_id: WORKSPACE_ID,
          expires_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
          last_used_at: null,
          revoked_at: null,
        },
      ],
    });

    const res = await app.request(`/tenants/${TENANT_ID}/users/${TARGET_ID}/tokens`);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { tokens: Array<Record<string, unknown>> };
    expect(json.tokens).toHaveLength(1);
    expect(json.tokens[0]).not.toHaveProperty("key");
    expect(json.tokens[0]).not.toHaveProperty("keyHash");
    expect(json.tokens[0]?.id).toBe("uk_abc");
  });

  it("404s (anti-probing) when the target user is not a tenant member", async () => {
    const { app } = makeApp({
      ...HAPPY_FIXTURE,
      tenantRoles: { [CALLER_ID]: "admin" },
    });

    const res = await app.request(`/tenants/${TENANT_ID}/users/${TARGET_ID}/tokens`);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /tenants/:tenantId/users/:userId/tokens/:keyId", () => {
  it("revokes a token", async () => {
    const { app } = makeApp(HAPPY_FIXTURE);

    const res = await app.request(`/tenants/${TENANT_ID}/users/${TARGET_ID}/tokens/uk_abc`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; revokedAt: string };
    expect(json.ok).toBe(true);
    expect(typeof json.revokedAt).toBe("string");
  });

  it("404s when the token is not found, already revoked, or belongs to someone else", async () => {
    const { app } = makeApp({ ...HAPPY_FIXTURE, revokeFound: false });

    const res = await app.request(`/tenants/${TENANT_ID}/users/${TARGET_ID}/tokens/uk_abc`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });

  it("403s when the caller is not a tenant owner/admin", async () => {
    const { app } = makeApp({
      ...HAPPY_FIXTURE,
      tenantRoles: { [CALLER_ID]: "member", [TARGET_ID]: "member" },
    });

    const res = await app.request(`/tenants/${TENANT_ID}/users/${TARGET_ID}/tokens/uk_abc`, {
      method: "DELETE",
    });

    expect(res.status).toBe(403);
  });
});
