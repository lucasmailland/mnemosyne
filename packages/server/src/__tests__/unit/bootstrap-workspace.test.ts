/**
 * Unit tests for POST /bootstrap creating both workspace and api_key rows.
 *
 * Verifies that:
 *  - POST /bootstrap calls begin() and performs INSERT into mnemo_tenant,
 *    mnemo_workspace, AND mnemo_api_keys (P19 fix)
 *  - The response payload remains backward-compatible (ok, workspaceId, keyId)
 *  - Request body validation still rejects bad inputs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

// Track which table names are inserted into
let insertedTables: string[] = [];
let fakeApiKeyCount = 0;

type SqlFn = (tpl: TemplateStringsArray, ...args: unknown[]) => Promise<unknown[]>;

function makeFakeSql(): SqlFn & {
  array: (v: unknown[]) => unknown;
  begin: (fn: (tx: SqlFn & { array: (v: unknown[]) => unknown }) => Promise<unknown>) => Promise<unknown>;
  end: () => Promise<void>;
} {
  const sql = (tpl: TemplateStringsArray, ..._args: unknown[]): Promise<unknown[]> => {
    const query = tpl.join("?").toLowerCase();
    if (query.includes("count(*)")) {
      return Promise.resolve([{ count: fakeApiKeyCount }]);
    }
    // Track which tables are inserted into (outside begin)
    if (query.includes("insert into")) {
      const match = query.match(/insert into (\w+)/);
      if (match) insertedTables.push(match[1]);
    }
    return Promise.resolve([]);
  };
  sql.array = (v: unknown[]) => v;
  sql.begin = async (fn: (tx: typeof sql) => Promise<unknown>) => {
    // Track inserts inside the transaction
    const txSql = (tpl: TemplateStringsArray, ..._args: unknown[]): Promise<unknown[]> => {
      const query = tpl.join("?").toLowerCase();
      if (query.includes("insert into")) {
        const match = query.match(/insert into\s+(\w+)/);
        if (match) insertedTables.push(match[1]);
      }
      return Promise.resolve([]);
    };
    txSql.array = (v: unknown[]) => v;
    return fn(txSql as unknown as typeof sql);
  };
  sql.end = async () => { /* no-op */ };
  return sql as ReturnType<typeof makeFakeSql>;
}

vi.mock("postgres", () => ({
  default: () => makeFakeSql(),
}));

beforeEach(async () => {
  insertedTables = [];
  fakeApiKeyCount = 0;
  process.env["DATABASE_URL"] = "postgres://fake:fake@localhost:5432/fake";
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

let setupToken = "";

async function makeBootstrapApp() {
  const { mountBootstrap, generateSetupToken } = await import("../../routes/bootstrap.js");
  // APP-004: the first key is registered only with the setup token.
  setupToken = generateSetupToken();
  const app = new Hono();
  mountBootstrap(app);
  return app;
}

describe("POST /bootstrap creates both workspace and api_key rows", () => {
  it("inserts into mnemo_tenant, mnemo_workspace, and mnemo_api_keys", async () => {
    const app = await makeBootstrapApp();
    const res = await app.request("/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        apiKey: "mns_live_abcdefghij1234567890",
        workspaceId: "a0000000-0000-0000-0000-000000000001",
        label: "test-ws",
      }),
      headers: { "Content-Type": "application/json", "X-Setup-Token": setupToken },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; workspaceId: string; keyId: string };
    // Backward-compatible response
    expect(body.ok).toBe(true);
    expect(body.workspaceId).toBe("a0000000-0000-0000-0000-000000000001");
    expect(body.keyId).toMatch(/^bootstrap_/);
    // Both tables were inserted
    expect(insertedTables).toContain("mnemo_tenant");
    expect(insertedTables).toContain("mnemo_workspace");
    expect(insertedTables).toContain("mnemo_api_keys");
  });

  it("returns 403 when already bootstrapped", async () => {
    fakeApiKeyCount = 1;
    const app = await makeBootstrapApp();
    const res = await app.request("/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        apiKey: "mns_live_abcdefghij1234567890",
        workspaceId: "a0000000-0000-0000-0000-000000000001",
      }),
      headers: { "Content-Type": "application/json", "X-Setup-Token": setupToken },
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid apiKey format", async () => {
    const app = await makeBootstrapApp();
    const res = await app.request("/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        apiKey: "invalid-key",
        workspaceId: "a0000000-0000-0000-0000-000000000001",
      }),
      headers: { "Content-Type": "application/json", "X-Setup-Token": setupToken },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid workspaceId", async () => {
    const app = await makeBootstrapApp();
    const res = await app.request("/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        apiKey: "mns_live_abcdefghij1234567890",
        workspaceId: "not-a-uuid",
      }),
      headers: { "Content-Type": "application/json", "X-Setup-Token": setupToken },
    });
    expect(res.status).toBe(400);
  });
});
