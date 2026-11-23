import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountTenants } from "../../routes/tenants.js";

type QueryCall = {
  sql: string;
  values: readonly unknown[];
};

function normalizeSql(strings: TemplateStringsArray): string {
  return strings.join("?").replace(/\s+/g, " ").trim();
}

function makeTenantSql() {
  const calls: QueryCall[] = [];

  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = normalizeSql(strings);
    calls.push({ sql, values });

    if (sql.includes("SELECT role") && sql.includes("mnemo_tenant_member")) {
      return values[1] === "user-1" ? [{ role: "owner" }] : [];
    }

    if (sql.includes("mnemo_workspace_tenant_id")) {
      return [{ tenant_id: "home-tenant" }]; // every key's home workspace is there
    }

    if (sql.includes("mnemo_provision_tenant")) {
      return [
        {
          tenant_id: "tenant-created",
          tenant_name: values[0],
          tenant_kind: values[1],
          tenant_plan: values[2],
          tenant_created_at: "2026-01-01T00:00:00.000Z",
          workspace_id: null, // no workspaceName: no first workspace
          workspace_name: null,
          workspace_slug: null,
          workspace_visibility: null,
          workspace_created_at: null,
        },
      ];
    }

    return [];
  }) as unknown as postgres.TransactionSql;

  const sql = (async () => []) as unknown as postgres.Sql;
  sql.begin = (async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    fn(tx)) as postgres.Sql["begin"];

  return { sql, calls };
}

function makeApp(
  identity: { userId?: string; tenantId?: string } = {
    userId: "user-1",
    tenantId: "tenant-1",
  }
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  const tenantSql = makeTenantSql();

  app.use("*", async (c, next) => {
    c.set("workspaceId", "workspace-1");
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", ["admin:tenant"]);
    c.set("plan", "free");
    c.set("actorId", "key-1");
    if (identity.userId) c.set("userId", identity.userId);
    if (identity.tenantId) c.set("tenantId", identity.tenantId);
    await next();
  });

  mountTenants(app, {
    metricsPgClient: tenantSql.sql,
  } as unknown as ServerDeps);

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { app, calls: tenantSql.calls };
}

describe("tenant routes RLS transaction binding", () => {
  it("sets tenant RLS GUCs before creating a tenant", async () => {
    const { app, calls } = makeApp();

    const res = await app.request("/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Acme", kind: "organization", plan: "pro" }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      id: "tenant-created",
      name: "Acme",
      kind: "organization",
      plan: "pro",
    });
    expect(calls.map((call) => call.sql)).toEqual([
      "SELECT set_config('mnemosyne.actor_user_id', ?, true)",
      "SELECT set_config('mnemosyne.actor_tenant_id', ?, true)",
      "SELECT role FROM mnemosyne.mnemo_tenant_member WHERE tenant_id = ? AND user_id = ? LIMIT 1",
      "SELECT * FROM mnemosyne.mnemo_provision_tenant( ?, ?, ?, ?)",
    ]);
    expect(calls[0]?.values).toEqual(["user-1"]);
    expect(calls[1]?.values).toEqual(["tenant-1"]);
    expect(calls[2]?.values).toEqual(["tenant-1", "user-1"]);
    expect(calls[3]?.values).toEqual(["Acme", "organization", "pro", null]);
  });

  it("refuses a caller that is not owner or admin of its own tenant, before writing", async () => {
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    const tenantSql = makeTenantSql();
    app.use("*", async (c, next) => {
      c.set("workspaceId", "workspace-1");
      c.set("apiKeyPrefix", "uk_live_");
      c.set("scopes", ["admin:tenant"]);
      c.set("plan", "free");
      c.set("userId", "user-2"); // the mock gives user-2 no tenant role
      c.set("tenantId", "tenant-1");
      await next();
    });
    mountTenants(app, { metricsPgClient: tenantSql.sql } as unknown as ServerDeps);
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err);
      return c.json(body, status as Parameters<typeof c.json>[1]);
    });

    for (const [path, body] of [
      ["/tenants", { name: "Acme" }],
      ["/users", { email: "someone@example.com" }],
    ] as const) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    }
    expect(tenantSql.calls.some((call) => call.sql.includes("mnemo_provision"))).toBe(false);
  });
});

describe("tenant routes RLS — the actor tenant of a key with no tenant (AUTH-TENANT-RLS-FALLBACK)", () => {
  it("a key with no tenant and no user runs with its home tenant as actor tenant", async () => {
    const { app, calls } = makeApp({});
    await app.request("/tenants/home-tenant/workspaces");
    expect(calls[0]?.sql).toBe(
      "SELECT mnemosyne.mnemo_workspace_tenant_id(k.workspace_id) AS tenant_id FROM mnemosyne.mnemo_api_keys k WHERE k.id = ?"
    );
    expect(calls[0]?.values).toEqual(["key-1"]);
    expect(calls[1]).toEqual({
      sql: "SELECT set_config('mnemosyne.actor_tenant_id', ?, true)",
      values: ["home-tenant"],
    });
  });

  it("a user-bound key with no tenant gets no actor tenant", async () => {
    const { app, calls } = makeApp({ userId: "user-1" });
    await app.request("/tenants/home-tenant/workspaces");
    expect(calls.some((c) => c.sql.includes("'mnemosyne.actor_tenant_id'"))).toBe(false);
    expect(calls[0]?.sql).toBe("SELECT set_config('mnemosyne.actor_user_id', ?, true)");
  });
});

describe("POST /tenants/:tenantId/members — createIfMissing auto-provision (S6)", () => {
  function makeAutoProvisionSql() {
    const calls: QueryCall[] = [];

    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = normalizeSql(strings);
      calls.push({ sql, values });

      if (sql.startsWith("SELECT set_config")) return [];

      if (sql.includes("SELECT role") && sql.includes("mnemo_tenant_member")) {
        // requireTenantAdmin checking the caller's own role in tenant-1.
        return values[1] === "user-1" ? [{ role: "admin" }] : [];
      }

      if (sql.includes("SELECT id, name, kind, plan") && sql.includes("mnemo_tenant ")) {
        return [{ id: "tenant-1", name: "Acme", kind: "organization", plan: "pro" }];
      }

      if (sql.includes("mnemo_find_user_id_by_email")) {
        // Only known@example.com is registered.
        return [{ id: values[0] === "known@example.com" ? "known-user" : null }];
      }

      // The whole account in one call (migration 0047).
      if (sql.includes("mnemo_provision_user")) {
        return [
          {
            user_id: "new-user-1",
            user_email: values[0],
            user_display_name: values[1],
            user_created_at: "2026-01-01T00:00:00.000Z",
            tenant_id: "personal-tenant-new",
            tenant_name: values[0],
            tenant_kind: "personal",
            tenant_plan: "free",
            tenant_created_at: "2026-01-01T00:00:00.000Z",
            workspace_id: "personal-ws-new",
            workspace_name: values[2],
            workspace_slug: null,
            workspace_visibility: "private",
            workspace_created_at: "2026-01-01T00:00:00.000Z",
          },
        ];
      }

      return [];
    }) as unknown as postgres.TransactionSql;

    const sql = (async () => []) as unknown as postgres.Sql;
    sql.begin = (async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      fn(tx)) as postgres.Sql["begin"];

    return { sql, calls };
  }

  function makeAutoProvisionApp() {
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    const tenantSql = makeAutoProvisionSql();

    app.use("*", async (c, next) => {
      c.set("workspaceId", "workspace-1");
      c.set("apiKeyPrefix", "mns_live_");
      c.set("scopes", ["admin:tenant"]);
      c.set("plan", "free");
      c.set("userId", "user-1");
      c.set("tenantId", "tenant-1");
      await next();
    });

    mountTenants(app, { metricsPgClient: tenantSql.sql } as unknown as ServerDeps);

    app.onError((err, c) => {
      const { status, body } = toErrorBody(err);
      return c.json(body, status as Parameters<typeof c.json>[1]);
    });

    return { app, calls: tenantSql.calls };
  }

  it("auto-provisions a user, personal tenant, and personal workspace when the invited email doesn't exist and createIfMissing is true", async () => {
    const { app, calls } = makeAutoProvisionApp();

    const res = await app.request("/tenants/tenant-1/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "newcomer@example.com",
        role: "member",
        createIfMissing: true,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    // The personal tenant, user, personal workspace and their owner
    // memberships come from one provisioning call…
    const provisionCalls = calls.filter((c) => c.sql.includes("mnemo_provision_user"));
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]?.values).toEqual([
      "newcomer@example.com",
      null,
      "newcomer@example.com's workspace",
    ]);

    // …and the route adds the membership in the invited-to tenant-1.
    const insertTenantMemberCalls = calls.filter((c) =>
      c.sql.includes("INSERT INTO mnemosyne.mnemo_tenant_member")
    );
    expect(insertTenantMemberCalls).toHaveLength(1);
    expect(insertTenantMemberCalls[0]?.values[0]).toBe("tenant-1");
    expect(insertTenantMemberCalls[0]?.values[1]).toBe("new-user-1");
    expect(insertTenantMemberCalls[0]?.values[2]).toBe("member");
  });

  it("adds a registered user it finds by email, without provisioning one", async () => {
    const { app, calls } = makeAutoProvisionApp();
    const res = await app.request("/tenants/tenant-1/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "known@example.com", role: "member", createIfMissing: true }),
    });

    expect(res.status).toBe(200);
    expect(calls.some((c) => c.sql.includes("mnemo_provision_user"))).toBe(false);
    const insertTenantMemberCalls = calls.filter((c) =>
      c.sql.includes("INSERT INTO mnemosyne.mnemo_tenant_member")
    );
    expect(insertTenantMemberCalls.map((c) => c.values.slice(0, 3))).toEqual([
      ["tenant-1", "known-user", "member"],
    ]);
  });

  it("still 404s when createIfMissing is false (default) and the email doesn't exist", async () => {
    const { app } = makeAutoProvisionApp();

    const res = await app.request("/tenants/tenant-1/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", role: "member" }),
    });

    expect(res.status).toBe(404);
  });
});
