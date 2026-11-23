/**
 * Unit tests for p50-audit-log-emitters PR3 — tenants.ts audit emission.
 *
 * Covers tasks 3.1/3.2: POST /tenants/:tenantId/workspaces emits a
 * `workspace_created` AuditLogEntry AFTER the `withTenantRls` transaction
 * resolves — never from inside that open tx (design D1/D8) — partitioned on
 * the NEW workspace's id, with a namespaced actorId and no plaintext leak.
 *
 * Pattern: mirrors workspace-routes-p12.test.ts's mock-sql factory (a
 * template-tagged fake tx registered via `sqlHandle.begin`), plus
 * keys-audit-emit.test.ts's `deps.storage.appendAuditEntry` spy so we can
 * assert both the emitted entry AND its ordering relative to the tx.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type postgres from "postgres";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { AuditLogEntry } from "@mnemo-ai/types";
import { mountTenants } from "../../routes/tenants.js";

const USER_ID = "user-p50-tenants-001";
const TENANT_ID = "tenant-p50-tenants-001";
const NEW_WORKSPACE_ID = "ws-p50-00000000-0000-0000-0002";
const RAW_ACTOR_ID = USER_ID;

const FIXTURE_TENANT = {
  id: TENANT_ID,
  name: "Acme Inc",
  kind: "organization",
  plan: "pro",
  created_at: "2026-01-01T00:00:00.000Z",
};

const FIXTURE_WORKSPACE = {
  id: NEW_WORKSPACE_ID,
  name: "New Workspace",
  slug: "new-workspace",
  tenant_id: TENANT_ID,
  owner_user_id: USER_ID,
  visibility: "private",
  created_at: "2026-01-01T00:00:00.000Z",
};

type QueryCall = { sql: string; values: readonly unknown[] };

function normalizeSql(strings: TemplateStringsArray): string {
  return strings.join("?").replace(/\s+/g, " ").trim();
}

interface MockSqlState {
  returnFor: Map<string, unknown[]>;
}

function makeMockSql(state: MockSqlState, order: string[]) {
  const calls: QueryCall[] = [];

  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = normalizeSql(strings);
    calls.push({ sql, values });
    for (const [fragment, rows] of state.returnFor) {
      if (sql.includes(fragment)) return rows;
    }
    return [];
  }) as unknown as postgres.TransactionSql;

  const sqlHandle = (async () => []) as unknown as postgres.Sql;
  sqlHandle.begin = (async (fn: (tx: postgres.TransactionSql) => Promise<unknown>) => {
    order.push("tx:start");
    const result = await fn(tx);
    order.push("tx:commit");
    return result;
  }) as unknown as postgres.Sql["begin"];

  return { sqlHandle, calls };
}

function makeApp(sqlState: MockSqlState, order: string[]) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  const { sqlHandle } = makeMockSql(sqlState, order);

  app.use("*", async (c, next) => {
    c.set("workspaceId", "ws-caller-unused-for-this-route");
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", ["admin:tenant"]);
    c.set("plan", "pro");
    c.set("userId", USER_ID);
    c.set("tenantId", TENANT_ID);
    c.set("actorId", RAW_ACTOR_ID);
    c.set("actorType", "user");
    await next();
  });

  const appendAuditEntry = vi.fn().mockImplementation(async () => {
    order.push("audit:appendAuditEntry");
  });
  const fakeDeps = {
    metricsPgClient: sqlHandle,
    storage: { appendAuditEntry } as unknown as ServerDeps["storage"],
  } as unknown as ServerDeps;

  mountTenants(app, fakeDeps);
  return { app, appendAuditEntry };
}

function firstEntry(spy: ReturnType<typeof vi.fn>): Omit<AuditLogEntry, "id" | "createdAt"> {
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0]![0] as Omit<AuditLogEntry, "id" | "createdAt">;
}

describe("POST /tenants/:tenantId/workspaces — workspace_created audit emission", () => {
  it("emits workspace_created AFTER the tenant tx commits, partitioned on the new workspace id", async () => {
    const order: string[] = [];
    const state: MockSqlState = {
      returnFor: new Map([
        ["SELECT role FROM mnemosyne.mnemo_tenant_member WHERE tenant_id", [{ role: "owner" }]],
        ["SELECT id, name, kind, plan", [FIXTURE_TENANT]],
        ["INSERT INTO mnemosyne.mnemo_workspace", [FIXTURE_WORKSPACE]],
        ["INSERT INTO mnemosyne.mnemo_workspace_member", []],
      ]),
    };
    const { app, appendAuditEntry } = makeApp(state, order);

    const res = await app.request(`/tenants/${TENANT_ID}/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "New Workspace",
        slug: "new-workspace",
        ownerUserId: USER_ID,
        visibility: "private",
      }),
    });

    expect(res.status).toBe(201);

    // Ordering: the tx must fully commit BEFORE the audit write is attempted —
    // appendAuditEntry opens its own tx and would not see an uncommitted row.
    expect(order).toEqual(["tx:start", "tx:commit", "audit:appendAuditEntry"]);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("workspace_created");
    expect(entry.resourceKind).toBe("workspace");
    expect(entry.resourceId).toBe(NEW_WORKSPACE_ID);
    expect(entry.isTerminal).toBe(false);
    // Partitioned on the NEW workspace's id, never the caller's own workspaceId.
    expect(entry.workspaceId).toBe(NEW_WORKSPACE_ID);
    expect(entry.actorType).toBe("user");
    expect(entry.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(entry.detail).toMatchObject({
      userId: USER_ID,
      tenantId: TENANT_ID,
      slug: "new-workspace",
      visibility: "private",
      ownerUserId: USER_ID,
    });
  });

  it("does NOT emit workspace_created when the tenant is not found (404)", async () => {
    const order: string[] = [];
    const state: MockSqlState = {
      returnFor: new Map([
        ["SELECT role FROM mnemosyne.mnemo_tenant_member WHERE tenant_id", [{ role: "owner" }]],
        ["SELECT id, name, kind, plan", []], // getTenant → not found
      ]),
    };
    const { app, appendAuditEntry } = makeApp(state, order);

    const res = await app.request(`/tenants/${TENANT_ID}/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ghost Workspace" }),
    });

    expect(res.status).toBe(404);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("still returns 201 when appendAuditEntry rejects (swallow-and-log)", async () => {
    const order: string[] = [];
    const state: MockSqlState = {
      returnFor: new Map([
        ["SELECT role FROM mnemosyne.mnemo_tenant_member WHERE tenant_id", [{ role: "owner" }]],
        ["SELECT id, name, kind, plan", [FIXTURE_TENANT]],
        ["INSERT INTO mnemosyne.mnemo_workspace", [FIXTURE_WORKSPACE]],
        ["INSERT INTO mnemosyne.mnemo_workspace_member", []],
      ]),
    };
    const { app, appendAuditEntry } = makeApp(state, order);
    appendAuditEntry.mockRejectedValueOnce(new Error("merkle lock failed"));

    const res = await app.request(`/tenants/${TENANT_ID}/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Resilient Workspace", ownerUserId: USER_ID }),
    });

    expect(res.status).toBe(201);
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
  });
});
