/**
 * APP-004 (audit 2026-11-22): on a freshly started instance anyone who could
 * reach the port could read the setup token over HTTP and register the first
 * API key, with a key of their own choosing. Measured live: GET /setup/token
 * answered 200 with the token, POST /bootstrap answered 201 without it, and the
 * chosen key then authenticated with every scope.
 *
 * The token is a secret printed in the server log. It is served over HTTP only
 * to a caller on the server's own loopback interface, and the first key cannot
 * be registered without it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

let insertedTables: string[] = [];
let lockStatements = 0;
let fakeApiKeyCount = 0;
let failInserts = false;

type SqlFn = (tpl: TemplateStringsArray, ...args: unknown[]) => Promise<unknown[]>;

function makeFakeSql() {
  const handle = (tpl: TemplateStringsArray): Promise<unknown[]> => {
    const query = tpl.join("?").toLowerCase();
    if (query.includes("pg_advisory_xact_lock")) lockStatements++;
    if (query.includes("count(*)")) return Promise.resolve([{ count: fakeApiKeyCount }]);
    if (query.includes("insert into")) {
      if (failInserts) return Promise.reject(new Error("connection reset"));
      const match = query.match(/insert into\s+(\w+)/);
      if (match) insertedTables.push(match[1]!);
    }
    return Promise.resolve([]);
  };
  const sql = ((tpl: TemplateStringsArray) => handle(tpl)) as SqlFn & {
    array: (v: unknown[]) => unknown;
    begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    end: () => Promise<void>;
  };
  sql.array = (v) => v;
  sql.begin = async (fn) => {
    const tx = ((tpl: TemplateStringsArray) => handle(tpl)) as SqlFn & { array: (v: unknown[]) => unknown };
    tx.array = (v) => v;
    return fn(tx);
  };
  sql.end = async () => undefined;
  return sql;
}

vi.mock("postgres", () => ({ default: () => makeFakeSql() }));

const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const LAN = { incoming: { socket: { remoteAddress: "192.168.1.50" } } };
const BODY = {
  apiKey: "mns_live_abcdefghij1234567890",
  workspaceId: "a0000000-0000-0000-0000-000000000001",
  label: "first",
};

beforeEach(() => {
  insertedTables = [];
  lockStatements = 0;
  fakeApiKeyCount = 0;
  failInserts = false;
  process.env["DATABASE_URL"] = "postgres://fake:fake@localhost:5432/fake";
  vi.resetModules();
});
afterEach(() => vi.resetModules());

async function makeApp() {
  const mod = await import("../../routes/bootstrap.js");
  const app = new Hono();
  mod.mountBootstrap(app);
  return { app, generateSetupToken: mod.generateSetupToken };
}

const post = (app: Hono, body: unknown, headers: Record<string, string> = {}, env: unknown = LAN) =>
  app.request(
    "/bootstrap",
    { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } },
    env as Record<string, unknown>
  );

describe("POST /bootstrap needs the setup token", () => {
  it("refuses a first key without a token and writes nothing", async () => {
    const { app, generateSetupToken } = await makeApp();
    generateSetupToken();
    const res = await post(app, BODY);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("setup_token_required");
    expect(insertedTables).toEqual([]);
  });

  it("refuses a wrong token", async () => {
    const { app, generateSetupToken } = await makeApp();
    generateSetupToken();
    const res = await post(app, { ...BODY, setupToken: "00000000-0000-4000-8000-000000000000" });
    expect(res.status).toBe(401);
    expect(insertedTables).toEqual([]);
  });

  it("refuses a caller on the loopback interface too: the token is the proof, not the address", async () => {
    const { app, generateSetupToken } = await makeApp();
    generateSetupToken();
    const res = await post(app, BODY, {}, LOOPBACK);
    expect(res.status).toBe(401);
  });

  it("registers the first key with the token in the body, under a lock", async () => {
    const { app, generateSetupToken } = await makeApp();
    const token = generateSetupToken();
    const res = await post(app, { ...BODY, setupToken: token });
    expect(res.status).toBe(201);
    expect(insertedTables).toContain("mnemo_api_keys");
    expect(lockStatements).toBe(1);
  });

  it("accepts the token in the X-Setup-Token header", async () => {
    const { app, generateSetupToken } = await makeApp();
    const token = generateSetupToken();
    const res = await post(app, BODY, { "X-Setup-Token": token });
    expect(res.status).toBe(201);
  });

  it("a token is single use", async () => {
    const { app, generateSetupToken } = await makeApp();
    const token = generateSetupToken();
    expect((await post(app, { ...BODY, setupToken: token })).status).toBe(201);
    // Still zero keys in the fake, so only the spent token can refuse this one.
    expect((await post(app, { ...BODY, setupToken: token })).status).toBe(401);
  });

  it("a database failure does not burn the token", async () => {
    const { app, generateSetupToken } = await makeApp();
    const token = generateSetupToken();
    failInserts = true;
    expect((await post(app, { ...BODY, setupToken: token })).status).toBe(500);
    failInserts = false;
    expect((await post(app, { ...BODY, setupToken: token })).status).toBe(201);
  });

  it("accepts the operator's MNEMO_SETUP_TOKEN, and ignores one too short to be a secret", async () => {
    process.env["MNEMO_SETUP_TOKEN"] = "operator-chosen-setup-token";
    try {
      const { app } = await makeApp();
      expect((await post(app, { ...BODY, setupToken: "operator-chosen-setup-tokeN" })).status).toBe(401);
      expect((await post(app, { ...BODY, setupToken: "operator-chosen-setup-token" })).status).toBe(201);
      process.env["MNEMO_SETUP_TOKEN"] = "short";
      expect((await post(app, { ...BODY, setupToken: "short" })).status).toBe(401);
    } finally {
      delete process.env["MNEMO_SETUP_TOKEN"];
    }
  });

  it("still answers 403 once keys exist, before looking at any token", async () => {
    fakeApiKeyCount = 1;
    const { app } = await makeApp();
    const res = await post(app, BODY);
    expect(res.status).toBe(403);
  });
});

describe("the setup token is not served to the network", () => {
  it("GET /setup/token answers 404 to a caller that is not on loopback", async () => {
    const { app, generateSetupToken } = await makeApp();
    generateSetupToken();
    const res = await app.request("/setup/token", {}, LAN as Record<string, unknown>);
    expect(res.status).toBe(404);
  });

  it("answers 404 when the peer address is unknown", async () => {
    const { app, generateSetupToken } = await makeApp();
    generateSetupToken();
    expect((await app.request("/setup/token")).status).toBe(404);
  });

  it("answers 404 to a loopback peer that is a reverse proxy forwarding someone else", async () => {
    const { app, generateSetupToken } = await makeApp();
    generateSetupToken();
    const res = await app.request(
      "/setup/token",
      { headers: { "X-Forwarded-For": "203.0.113.7" } },
      LOOPBACK as Record<string, unknown>
    );
    expect(res.status).toBe(404);
  });

  it("answers the token to the server's own loopback (docker exec, a local shell)", async () => {
    const { app, generateSetupToken } = await makeApp();
    const token = generateSetupToken();
    const res = await app.request("/setup/token", {}, LOOPBACK as Record<string, unknown>);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token: string }).token).toBe(token);
  });

  it("GET /setup does not write the live token into the page for a network caller", async () => {
    const { app, generateSetupToken } = await makeApp();
    const token = generateSetupToken();
    const res = await app.request("/setup", {}, LAN as Record<string, unknown>);
    expect(await res.text()).not.toContain(token);
  });
});
