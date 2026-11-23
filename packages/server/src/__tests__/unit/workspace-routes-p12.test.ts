/**
 * P12 — workspace route unit tests.
 *
 * 5.4 POST /users — asserts personalWorkspace is returned in the response.
 * 5.5 GET /workspaces/mine — asserts correct workspaces returned for user.
 * 5.6 POST /workspaces/:id/members — asserts 403 for cross-tenant invite.
 * 5.3 GET /workspaces/:workspaceId — asserts 404 for non-member, 200 for member.
 *
 * Uses the pattern from tenant-routes-rls.test.ts: mock sql with a template-
 * tagged function that records calls and returns fixture rows.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect } from "vitest";
import type postgres from "postgres";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountTenants } from "../../routes/tenants.js";

// ── Mock sql factory ──────────────────────────────────────────────────────────

type QueryCall = {
  sql: string;
  values: readonly unknown[];
};

function normalizeSql(strings: TemplateStringsArray): string {
  return strings.join("?").replace(/\s+/g, " ").trim();
}

interface MockSqlState {
  /** Override return value for a given SQL fragment (substring match). */
  returnFor: Map<string, unknown[]>;
  /** Checked first; for answers that depend on the bound values. */
  respond?: (sql: string, values: readonly unknown[]) => unknown[] | undefined;
}

function makeMockSql(state: MockSqlState) {
  const calls: QueryCall[] = [];

  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = normalizeSql(strings);
    calls.push({ sql, values });

    const answer = state.respond?.(sql, values);
    if (answer) return answer;

    // Check registered overrides first
    for (const [fragment, rows] of state.returnFor) {
      if (sql.includes(fragment)) return rows;
    }

    return [];
  }) as unknown as postgres.TransactionSql;

  const sqlHandle = (async () => []) as unknown as postgres.Sql;
  sqlHandle.begin = (async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    fn(tx)) as postgres.Sql["begin"];

  return { sqlHandle, calls };
}

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp(userId: string, tenantId: string, sqlState: MockSqlState) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  const { sqlHandle, calls } = makeMockSql(sqlState);

  app.use("*", async (c, next) => {
    c.set("workspaceId", "ws-00000000-0000-0000-0000-000000000001");
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", ["admin:tenant", "memory:admin", "memory:write", "memory:read"]);
    c.set("plan", "free");
    c.set("userId", userId);
    c.set("tenantId", tenantId);
    c.set("actorId", userId);
    await next();
  });

  mountTenants(app, {
    metricsPgClient: sqlHandle,
  } as unknown as ServerDeps);

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { app, calls };
}

/**
 * A workspace-only key: no bound userId, scoped to `authWorkspaceId` by the
 * key itself (mirrors what the real auth middleware sets from the key's own
 * `workspace_id` column). Used to test the anti-probing branch that runs when
 * there is no userId to check membership with (SEC fix, B4.1 discovery).
 */
function makeWorkspaceOnlyApp(authWorkspaceId: string, sqlState: MockSqlState) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  const { sqlHandle, calls } = makeMockSql(sqlState);

  app.use("*", async (c, next) => {
    c.set("workspaceId", authWorkspaceId);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", ["memory:admin", "memory:write", "memory:read"]);
    c.set("plan", "free");
    c.set("userId", undefined);
    c.set("tenantId", undefined);
    c.set("actorId", `key:workspace-only`);
    await next();
  });

  mountTenants(app, {
    metricsPgClient: sqlHandle,
  } as unknown as ServerDeps);

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { app, calls };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ID = "user-p12-test-001";
const TENANT_ID = "tenant-p12-test-001";
const WORKSPACE_ID = "ws-p12-00000000-0000-0000-0001";

const FIXTURE_TENANT = {
  id: TENANT_ID,
  name: "test@example.com",
  kind: "personal",
  plan: "free",
  created_at: "2026-01-01T00:00:00.000Z",
};

const FIXTURE_USER = {
  id: USER_ID,
  email: "test@example.com",
  display_name: null,
  personal_tenant_id: TENANT_ID,
  created_at: "2026-01-01T00:00:00.000Z",
};

const FIXTURE_WORKSPACE = {
  id: WORKSPACE_ID,
  name: "test@example.com's workspace",
  slug: null,
  tenant_id: TENANT_ID,
  owner_user_id: USER_ID,
  visibility: "private",
  created_at: "2026-01-01T00:00:00.000Z",
};

// ── 5.4 POST /users ───────────────────────────────────────────────────────────

describe("5.4 POST /users bootstrap", () => {
  it("returns personalWorkspace in response when user is created", async () => {
    const state: MockSqlState = {
      returnFor: new Map<string, unknown[]>([
        ["SELECT role", [{ role: "owner" }]], // the caller is owner of its own tenant
        ["mnemo_find_user_id_by_email", [{ id: null }]], // no existing user
        [
          "mnemo_provision_user",
          [
            {
              user_id: USER_ID,
              user_email: FIXTURE_USER.email,
              user_display_name: null,
              user_created_at: FIXTURE_USER.created_at,
              tenant_id: TENANT_ID,
              tenant_name: FIXTURE_TENANT.name,
              tenant_kind: FIXTURE_TENANT.kind,
              tenant_plan: FIXTURE_TENANT.plan,
              tenant_created_at: FIXTURE_TENANT.created_at,
              workspace_id: WORKSPACE_ID,
              workspace_name: FIXTURE_WORKSPACE.name,
              workspace_slug: null,
              workspace_visibility: FIXTURE_WORKSPACE.visibility,
              workspace_created_at: FIXTURE_WORKSPACE.created_at,
            },
          ],
        ],
      ]),
    };

    const { app } = makeApp(USER_ID, TENANT_ID, state);

    const res = await app.request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("user");
    expect(body).toHaveProperty("personalTenant");
    expect(body).toHaveProperty("personalWorkspace");
    const ws = body["personalWorkspace"] as Record<string, unknown>;
    expect(ws["id"]).toBe(WORKSPACE_ID);
    expect(ws["tenantId"]).toBe(TENANT_ID);
  });
});

// ── 5.5 GET /workspaces/mine ──────────────────────────────────────────────────

describe("5.5 GET /workspaces/mine", () => {
  it("returns workspaces for authenticated user", async () => {
    const state: MockSqlState = {
      returnFor: new Map([
        [
          "SELECT wm.workspace_id",
          [
            {
              workspace_id: WORKSPACE_ID,
              workspace_name: "test@example.com's workspace",
              role: "owner",
              visibility: "private",
            },
          ],
        ],
      ]),
    };

    const { app } = makeApp(USER_ID, TENANT_ID, state);

    const res = await app.request("/workspaces/mine", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("workspaces");
    const list = body["workspaces"] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]?.["workspaceId"]).toBe(WORKSPACE_ID);
    expect(list[0]?.["role"]).toBe("owner");
  });
});

// ── 5.3 GET /workspaces/:workspaceId ─────────────────────────────────────────

describe("5.3 GET /workspaces/:workspaceId", () => {
  it("returns 404 for non-member (anti-probing)", async () => {
    const state: MockSqlState = {
      returnFor: new Map([
        // workspace exists
        ["SELECT id, name, slug, tenant_id", [FIXTURE_WORKSPACE]],
        // but user is not a member (getWorkspaceMemberRole returns empty)
        ["SELECT role FROM mnemosyne.mnemo_workspace_member WHERE workspace_id", []],
      ]),
    };

    const { app } = makeApp(USER_ID, TENANT_ID, state);

    const res = await app.request(`/workspaces/${WORKSPACE_ID}`, {
      method: "GET",
    });

    expect(res.status).toBe(404);
  });

  it("returns 200 with workspace data for member", async () => {
    const state: MockSqlState = {
      returnFor: new Map([
        // workspace exists
        ["SELECT id, name, slug, tenant_id", [FIXTURE_WORKSPACE]],
        // user is a member
        [
          "SELECT role FROM mnemosyne.mnemo_workspace_member WHERE workspace_id",
          [{ role: "owner" }],
        ],
      ]),
    };

    const { app } = makeApp(USER_ID, TENANT_ID, state);

    const res = await app.request(`/workspaces/${WORKSPACE_ID}`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["id"]).toBe(WORKSPACE_ID);
    expect(body["tenantId"]).toBe(TENANT_ID);
  });

  // SEC fix (B4.1 discovery): a workspace-only key (no bound userId) previously
  // hit no anti-probing check at all and could read ANY workspace by id. Now it
  // is checked against its OWN scoped workspaceId (set by auth middleware from
  // the key itself), same anti-probing outcome shape as the member/non-member
  // cases above.
  it("workspace-only key: returns 404 for a DIFFERENT workspace than its own (anti-probing)", async () => {
    const OTHER_WORKSPACE_ID = "ws-p12-00000000-0000-0000-9999";
    const state: MockSqlState = {
      returnFor: new Map([
        ["SELECT id, name, slug, tenant_id", [{ ...FIXTURE_WORKSPACE, id: OTHER_WORKSPACE_ID }]],
      ]),
    };

    // key is scoped to WORKSPACE_ID, but requests a different workspace's id
    const { app } = makeWorkspaceOnlyApp(WORKSPACE_ID, state);

    const res = await app.request(`/workspaces/${OTHER_WORKSPACE_ID}`, {
      method: "GET",
    });

    expect(res.status).toBe(404);
  });

  it("workspace-only key: returns 200 for its OWN scoped workspace", async () => {
    const state: MockSqlState = {
      returnFor: new Map([["SELECT id, name, slug, tenant_id", [FIXTURE_WORKSPACE]]]),
    };

    // key is scoped to WORKSPACE_ID, and requests that exact same workspace
    const { app } = makeWorkspaceOnlyApp(WORKSPACE_ID, state);

    const res = await app.request(`/workspaces/${WORKSPACE_ID}`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["id"]).toBe(WORKSPACE_ID);
  });
});

// ── 5.6 POST /workspaces/:id/members cross-tenant invite ─────────────────────

describe("5.6 POST /workspaces/:id/members cross-tenant invite", () => {
  it("returns 403 when invited user does not belong to this tenant", async () => {
    const INVITED_USER_ID = "user-other-tenant-002";
    const state: MockSqlState = {
      returnFor: new Map([
        // workspace found
        ["SELECT id, name, slug, tenant_id", [FIXTURE_WORKSPACE]],
        // caller is workspace admin (getWorkspaceMemberRole for caller)
        [
          "SELECT role FROM mnemosyne.mnemo_workspace_member WHERE workspace_id",
          [{ role: "owner" }],
        ],
        // invited user NOT in tenant (getTenantMemberRole returns empty)
        ["SELECT role FROM mnemosyne.mnemo_tenant_member WHERE tenant_id", []],
      ]),
    };

    const { app } = makeApp(USER_ID, TENANT_ID, state);

    const res = await app.request(`/workspaces/${WORKSPACE_ID}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: INVITED_USER_ID, role: "read" }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body["message"] ?? "")).toMatch(/does not belong to this tenant/i);
  });

  it("returns 200 when invited user belongs to the same tenant", async () => {
    const INVITED_USER_ID = "user-same-tenant-003";
    const state: MockSqlState = {
      returnFor: new Map([
        // workspace found
        ["SELECT id, name, slug, tenant_id", [FIXTURE_WORKSPACE]],
        // caller is workspace admin
        [
          "SELECT role FROM mnemosyne.mnemo_workspace_member WHERE workspace_id",
          [{ role: "owner" }],
        ],
        // invited user IS in tenant
        ["SELECT role FROM mnemosyne.mnemo_tenant_member WHERE tenant_id", [{ role: "member" }]],
        // member insert
        ["INSERT INTO mnemosyne.mnemo_workspace_member", []],
      ]),
    };

    const { app } = makeApp(USER_ID, TENANT_ID, state);

    const res = await app.request(`/workspaces/${WORKSPACE_ID}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: INVITED_USER_ID, role: "read" }),
    });

    expect(res.status).toBe(200);
  });
});

// ── PRIM-17 POST /tenants/:tenantId/workspaces owner ─────────────────────────

describe("PRIM-17 POST /tenants/:tenantId/workspaces owner", () => {
  const TEAMMATE_ID = "user-p12-teammate-002";
  const FOREIGN_ID = "user-p12-foreign-003";

  /** The caller owns TENANT_ID; TEAMMATE_ID is a member of it; FOREIGN_ID is not. */
  function tenantState(): MockSqlState {
    return {
      returnFor: new Map<string, unknown[]>([
        ["SELECT id, name, kind, plan", [FIXTURE_TENANT]],
        ["INSERT INTO mnemosyne.mnemo_workspace (", [FIXTURE_WORKSPACE]],
      ]),
      respond: (sql, values) => {
        if (!sql.startsWith("SELECT role FROM mnemosyne.mnemo_tenant_member")) return undefined;
        if (values[1] === USER_ID) return [{ role: "owner" }];
        if (values[1] === TEAMMATE_ID) return [{ role: "member" }];
        return [];
      },
    };
  }

  function ownerInserts(calls: QueryCall[]): unknown[][] {
    return calls
      .filter((c) => c.sql.includes("INSERT INTO mnemosyne.mnemo_workspace_member"))
      .map((c) => [...c.values]);
  }

  async function create(app: OpenAPIHono<{ Variables: AuthVariables }>, body: object) {
    return app.request(`/tenants/${TENANT_ID}/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Project", ...body }),
    });
  }

  it("makes the caller the owner when ownerUserId is omitted", async () => {
    const { app, calls } = makeApp(USER_ID, TENANT_ID, tenantState());
    const res = await create(app, {});
    expect(res.status).toBe(201);
    expect(ownerInserts(calls)).toEqual([[WORKSPACE_ID, USER_ID, "owner"]]);
  });

  it("seeds an explicit owner from the same tenant, and only that owner", async () => {
    const { app, calls } = makeApp(USER_ID, TENANT_ID, tenantState());
    const res = await create(app, { ownerUserId: TEAMMATE_ID });
    expect(res.status).toBe(201);
    expect(ownerInserts(calls)).toEqual([[WORKSPACE_ID, TEAMMATE_ID, "owner"]]);
  });

  it("refuses an owner outside the tenant before writing anything", async () => {
    const { app, calls } = makeApp(USER_ID, TENANT_ID, tenantState());
    const res = await create(app, { ownerUserId: FOREIGN_ID });
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false);
  });
});
