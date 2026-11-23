/**
 * AUTH-TENANT-NULL — a key with no tenant binding acts in its home workspace's
 * tenant, and only there, on every tenant-plane route.
 *
 * The bootstrap and setup keys, every key minted from them and every mk_* key
 * carry no tenant_id. The tenant-plane guards used to read that as "unbound,
 * allow", which made such a key a principal of every tenant on the instance:
 * it could re-role another tenant's workspace members and mint user tokens
 * for another tenant's users.
 *
 * Same harness shape as tenant-routes-rls.test.ts: a fake auth middleware and
 * a fake SQL tag that answers by matching the normalized query text.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountTenants } from "../../routes/tenants.js";
import { mountUserTokens } from "../../routes/user-tokens.js";

const HOME_TENANT = "tenant-home";
const FOREIGN_TENANT = "tenant-foreign";
const HOME_WS = "ws-home";
const FOREIGN_WS = "ws-foreign";
/** mnemo_workspace: workspace id → tenant id. */
const WORKSPACE_TENANT: Record<string, string> = {
  [HOME_WS]: HOME_TENANT,
  [FOREIGN_WS]: FOREIGN_TENANT,
};
/** mnemo_api_keys: key id → the key's own (home) workspace. */
const KEY_HOME: Record<string, string> = {
  "key-bootstrap": HOME_WS,
  "key-user": HOME_WS,
};
/** Members of both tenants and both workspaces, so a route that got past its guard would act. */
const TENANT_ROLES: Record<string, string> = {
  [`${HOME_TENANT}:user-2`]: "member",
  [`${FOREIGN_TENANT}:user-2`]: "member",
  [`${FOREIGN_TENANT}:victim`]: "member",
  [`${HOME_TENANT}:user-1`]: "member",
};
const WORKSPACE_ROLES: Record<string, string> = {
  [`${FOREIGN_WS}:victim`]: "write",
};

type Caller = {
  workspaceId: string;
  apiKeyPrefix: string;
  actorId: string;
  scopes: string[];
  userId?: string;
  tenantId?: string;
};

const MEMORY_SCOPES = ["memory:read", "memory:write", "memory:admin"];

/** The key POST /bootstrap and POST /setup/complete mint: no tenant, no user. */
const BOOTSTRAP: Caller = {
  workspaceId: HOME_WS,
  apiKeyPrefix: "mns_live_",
  actorId: "key-bootstrap",
  scopes: MEMORY_SCOPES,
};
/** A key of the bootstrap lineage that was given admin:tenant. */
const NULL_TENANT_ADMIN: Caller = { ...BOOTSTRAP, scopes: ["admin:tenant", ...MEMORY_SCOPES] };
/** A scoped key: it has no tenant or user column at all. */
const SCOPED: Caller = {
  workspaceId: HOME_WS,
  apiKeyPrefix: "mk_live_",
  actorId: "mk-1",
  scopes: ["admin:tenant", ...MEMORY_SCOPES],
};
/**
 * A user token whose row has no tenant, switched by X-Workspace-Id into a
 * workspace of another tenant: auth puts the switched workspace on the context.
 */
const SWITCHED_USER: Caller = {
  workspaceId: FOREIGN_WS,
  apiKeyPrefix: "uk_live_x",
  actorId: "key-user",
  userId: "user-1",
  scopes: ["admin:tenant", ...MEMORY_SCOPES],
};

type QueryCall = { sql: string; values: readonly unknown[] };

function normalizeSql(strings: TemplateStringsArray): string {
  return strings.join("?").replace(/\s+/g, " ").trim();
}

function makeSql(extraTenantRoles: Record<string, string> = {}) {
  const calls: QueryCall[] = [];
  const tenantRoles = { ...TENANT_ROLES, ...extraTenantRoles };

  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = normalizeSql(strings);
    calls.push({ sql, values });

    if (sql.startsWith("SELECT set_config")) return [];

    // resolveCallerTenant, through mnemo_workspace_tenant_id (migration 0047).
    if (sql.includes("mnemo_workspace_tenant_id") && sql.includes("mnemo_api_keys")) {
      const home = KEY_HOME[values[0] as string];
      return home ? [{ tenant_id: WORKSPACE_TENANT[home] ?? null }] : [];
    }
    if (sql.startsWith("SELECT mnemosyne.mnemo_workspace_tenant_id(")) {
      return [{ tenant_id: WORKSPACE_TENANT[values[0] as string] ?? null }];
    }
    if (sql.includes("mnemo_workspace") && sql.includes("owner_user_id")) {
      const id = values[0] as string;
      const tenant = WORKSPACE_TENANT[id];
      return tenant
        ? [
            {
              id,
              name: "W",
              slug: null,
              tenant_id: tenant,
              owner_user_id: null,
              visibility: "private",
            },
          ]
        : [];
    }
    if (sql.includes("SELECT id, name, kind, plan") && sql.includes("mnemo_tenant")) {
      const id = values[0] as string;
      return id === HOME_TENANT || id === FOREIGN_TENANT
        ? [{ id, name: "T", kind: "organization", plan: "free" }]
        : [];
    }
    if (sql.includes("SELECT role") && sql.includes("mnemo_tenant_member")) {
      const role = tenantRoles[`${values[0] as string}:${values[1] as string}`];
      return role ? [{ role }] : [];
    }
    if (sql.includes("SELECT role") && sql.includes("mnemo_workspace_member")) {
      const role = WORKSPACE_ROLES[`${values[0] as string}:${values[1] as string}`];
      return role ? [{ role }] : [];
    }
    if (sql.includes("UPDATE mnemo_api_keys")) return [{ id: values[1] }];
    return [];
  }) as unknown as postgres.TransactionSql;
  (tx as unknown as Record<string, unknown>).array = (v: unknown) => v;

  const sql = (async () => []) as unknown as postgres.Sql;
  sql.begin = (async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    fn(tx)) as postgres.Sql["begin"];
  return { sql, calls };
}

function makeApp(caller: Caller, extraTenantRoles: Record<string, string> = {}) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  const fake = makeSql(extraTenantRoles);
  app.use("*", async (c, next) => {
    c.set("workspaceId", caller.workspaceId);
    c.set("apiKeyPrefix", caller.apiKeyPrefix);
    c.set("actorId", caller.actorId);
    c.set("scopes", caller.scopes);
    c.set("plan", "free");
    if (caller.userId) c.set("userId", caller.userId);
    if (caller.tenantId) c.set("tenantId", caller.tenantId);
    await next();
  });
  const deps = { metricsPgClient: fake.sql } as unknown as ServerDeps;
  mountTenants(app, deps);
  mountUserTokens(app, deps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  const request = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const writes = () => fake.calls.filter((call) => /^(INSERT|UPDATE|DELETE)\b/.test(call.sql));
  return { request, calls: fake.calls, writes };
}

const NOT_FOUND = { error: "not_found", message: "Workspace not found" };

const workspaceRoutes = (ws: string) =>
  [
    ["GET", `/workspaces/${ws}/members`, undefined],
    ["POST", `/workspaces/${ws}/members`, { userId: "user-2", role: "write" }],
    ["PATCH", `/workspaces/${ws}/members/user-2`, { role: "read" }],
    ["DELETE", `/workspaces/${ws}/members/user-2`, undefined],
  ] as const;

const tenantRoutes = (tenant: string) =>
  [
    ["GET", `/tenants/${tenant}`, undefined],
    ["GET", `/tenants/${tenant}/members`, undefined],
    ["POST", `/tenants/${tenant}/members`, { email: "victim@example.com", role: "admin" }],
    ["DELETE", `/tenants/${tenant}/members/victim`, undefined],
    ["GET", `/tenants/${tenant}/workspaces`, undefined],
    ["POST", `/tenants/${tenant}/workspaces`, { name: "Planted" }],
  ] as const;

const tokenRoutes = (tenant: string) =>
  [
    ["POST", `/tenants/${tenant}/users/victim/tokens`, { label: "x", homeWorkspaceId: FOREIGN_WS }],
    ["GET", `/tenants/${tenant}/users/victim/tokens`, undefined],
    ["DELETE", `/tenants/${tenant}/users/victim/tokens/key-victim`, undefined],
  ] as const;

describe("AUTH-TENANT-NULL: workspace routes", () => {
  it.each(workspaceRoutes(FOREIGN_WS))(
    "the bootstrap key cannot %s another tenant's workspace members (%s)",
    async (method, path, body) => {
      const { request, writes } = makeApp(BOOTSTRAP);
      const res = await request(method, path, body);
      expect(res.status).toBe(404);
      // Indistinguishable from a workspace that does not exist (S6).
      await expect(res.json()).resolves.toEqual(NOT_FOUND);
      expect(writes()).toEqual([]);
    }
  );

  it.each(workspaceRoutes(HOME_WS))(
    "the bootstrap key keeps %s on its own workspace's members (%s)",
    async (method, path, body) => {
      const { request } = makeApp(BOOTSTRAP);
      const res = await request(method, path, body);
      expect(res.status).toBe(200);
    }
  );

  it("a scoped key cannot list another tenant's workspace members", async () => {
    const { request } = makeApp(SCOPED);
    expect((await request("GET", `/workspaces/${FOREIGN_WS}/members`)).status).toBe(404);
    expect((await request("GET", `/workspaces/${HOME_WS}/members`)).status).toBe(200);
  });

  it("denies when the key's home workspace cannot be resolved", async () => {
    const { request } = makeApp({ ...BOOTSTRAP, actorId: "key-unknown" });
    expect((await request("GET", `/workspaces/${HOME_WS}/members`)).status).toBe(404);
  });
});

describe("AUTH-TENANT-NULL: tenant routes", () => {
  it.each(tenantRoutes(FOREIGN_TENANT))(
    "a null-tenant admin:tenant key cannot %s %s",
    async (method, path, body) => {
      const { request, writes } = makeApp(NULL_TENANT_ADMIN);
      const res = await request(method, path, body);
      expect(res.status).toBe(403);
      expect(writes()).toEqual([]);
    }
  );

  it.each(tenantRoutes(FOREIGN_TENANT).slice(0, 2))(
    "a scoped key cannot %s %s",
    async (method, path) => {
      const { request } = makeApp(SCOPED);
      expect((await request(method, path)).status).toBe(403);
    }
  );

  it("keeps the null-tenant key's access to its own tenant", async () => {
    const { request } = makeApp(NULL_TENANT_ADMIN);
    expect((await request("GET", `/tenants/${HOME_TENANT}`)).status).toBe(200);
    expect((await request("GET", `/tenants/${HOME_TENANT}/members`)).status).toBe(200);
    expect((await request("GET", `/tenants/${HOME_TENANT}/workspaces`)).status).toBe(200);
  });

  it("keeps the scoped key's access to its own tenant", async () => {
    const { request } = makeApp(SCOPED);
    expect((await request("GET", `/tenants/${HOME_TENANT}/members`)).status).toBe(200);
  });

  it("denies when the key's home workspace cannot be resolved", async () => {
    const { request } = makeApp({ ...NULL_TENANT_ADMIN, actorId: "key-unknown" });
    expect((await request("GET", `/tenants/${HOME_TENANT}`)).status).toBe(403);
  });

  it("takes the tenant from the key's own row, not from the workspace a header selected", async () => {
    const { request } = makeApp(SWITCHED_USER, { [`${HOME_TENANT}:user-1`]: "admin" });
    expect((await request("GET", `/tenants/${FOREIGN_TENANT}/members`)).status).toBe(403);
    expect((await request("GET", `/tenants/${HOME_TENANT}/members`)).status).toBe(200);
  });

  it("checks the role of a user-bound key even when its row has no tenant", async () => {
    // user-1 is a plain member of the home tenant.
    const { request, writes } = makeApp({ ...SWITCHED_USER, workspaceId: HOME_WS });
    const res = await request("DELETE", `/tenants/${HOME_TENANT}/members/user-2`);
    expect(res.status).toBe(403);
    expect(writes()).toEqual([]);
  });

  // AUTH-TENANT-RLS-FALLBACK: RLS confines a key with no user to the same
  // tenant the guards do, instead of running it with no GUC.
  it("sets the derived tenant as actor tenant for a key with no user", async () => {
    const { request, calls } = makeApp(NULL_TENANT_ADMIN);
    await request("GET", `/tenants/${HOME_TENANT}/members`);
    const gucs = calls.filter((call) => call.sql.includes("mnemosyne.actor_tenant_id"));
    expect(gucs.map((call) => call.values)).toEqual([[HOME_TENANT]]);
  });

  it("sets no tenant GUC for a user-bound key whose row has no tenant", async () => {
    const { request, calls } = makeApp({ ...SWITCHED_USER, workspaceId: HOME_WS });
    await request("GET", `/tenants/${HOME_TENANT}/members`);
    expect(calls.some((call) => call.sql.includes("mnemosyne.actor_tenant_id"))).toBe(false);
  });
});

describe("AUTH-TENANT-NULL: user tokens", () => {
  it.each(tokenRoutes(FOREIGN_TENANT))(
    "a null-tenant admin:tenant key cannot %s another tenant's user tokens (%s)",
    async (method, path, body) => {
      const { request, writes } = makeApp(NULL_TENANT_ADMIN);
      const res = await request(method, path, body);
      expect(res.status).toBe(403);
      expect(writes()).toEqual([]);
    }
  );

  it("a scoped key cannot mint a token for another tenant's user", async () => {
    const { request, writes } = makeApp(SCOPED);
    const [method, path, body] = tokenRoutes(FOREIGN_TENANT)[0];
    expect((await request(method, path, body)).status).toBe(403);
    expect(writes()).toEqual([]);
  });
});
