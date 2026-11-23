/**
 * Unit tests for POST /admin/keys/:keyId/rotate — key rotation.
 *
 * Pattern: OpenAPIHono + fake auth middleware + vi.fn() SQL client.
 * No real DB, no bcrypt (bcrypt is called internally — we just verify the response).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountKeys } from "../../routes/keys.js";
import { DEPRECATION_GRACE_MS } from "../../auth-evaluate.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000099";
const OLD_KEY_ID = "mk_aabbccddee112233";

function activeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OLD_KEY_ID,
    label: "CI agent",
    scopes: ["memory:read"],
    plan: "free",
    ip_allowlist: [],
    expires_at: null,
    revoked_at: null,
    deprecated_at: null,
    ...overrides,
  };
}

/**
 * Build a fake app where the SELECT call returns `selectRows` and
 * INSERT/UPDATE calls return empty arrays.
 *
 * withKeysTx wraps everything in sql.begin(), so we mock begin() to run
 * the callback with a fake tx. The tx receives 4 preamble calls first (SET LOCAL ROLE,
 * SET LOCAL search_path, 2× set_config), then the SELECT, then INSERT and UPDATE.
 */
function makeApp(selectRows: unknown[]) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  // Fake auth middleware
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mk_live_");
    c.set("actorId", OLD_KEY_ID); // admin:keys routes are always authenticated (resolveProvenance requires it)
    c.set("actorType", "agent");
    // SEC-1: the caller must hold every scope it mints or rotates.
    c.set("scopes", new Set(["admin:keys", "memory:read"]) as unknown as ReadonlyArray<string>);
    await next();
  });

  const fakeSql = vi.fn() as unknown as ServerDeps["metricsPgClient"];
  (fakeSql as unknown as Record<string, unknown>).array = (v: unknown) => v;
  // withKeysTx sequence (no pg_has_role after RLS fix):
  //   1: SET LOCAL ROLE   2: SET LOCAL search_path   3-4: set_config GUCs
  //   5: SELECT   6+: INSERT, UPDATE
  (fakeSql as unknown as Record<string, unknown>).begin = async (
    fn: (tx: unknown) => Promise<unknown>
  ) => {
    let txCallCount = 0;
    const fakeTx = vi.fn().mockImplementation(() => {
      txCallCount++;
      if (txCallCount <= 4) return Promise.resolve([]); // SET LOCAL + set_config preamble
      if (txCallCount === 5) return Promise.resolve(selectRows); // SELECT
      return Promise.resolve([]); // INSERT, UPDATE
    });
    (fakeTx as unknown as Record<string, unknown>).array = (v: unknown) => v;
    return fn(fakeTx);
  };

  const fakeDeps = {
    metricsPgClient: fakeSql,
  } as unknown as ServerDeps;

  mountKeys(app, fakeDeps);
  return { app, fakeSql };
}

describe("POST /admin/keys/:keyId/rotate — rotate key", () => {
  it("returns 201 with newKey, newKeyId, oldKeySunsetAt for an active key", async () => {
    const { app } = makeApp([activeKeyRow()]);
    const res = await app.request(`/admin/keys/${OLD_KEY_ID}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "scheduled" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.newKey).toBe("string");
    expect((body.newKey as string).length).toBeGreaterThan(10);
    expect(typeof body.newKeyId).toBe("string");
    expect(body.newKeyId).not.toBe(OLD_KEY_ID);
    expect(typeof body.oldKeySunsetAt).toBe("string");
  });

  it("oldKeySunsetAt is approximately 7 days after now", async () => {
    const { app } = makeApp([activeKeyRow()]);
    const before = Date.now(); // determinism-ok: bracketing wall-clock to verify 7-day offset, not snapshot
    const res = await app.request(`/admin/keys/${OLD_KEY_ID}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const after = Date.now(); // determinism-ok: bracketing wall-clock to verify 7-day offset, not snapshot
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    const sunsetMs = new Date(body.oldKeySunsetAt as string).getTime();
    const sevenDaysMs = 7 * 86_400_000;
    expect(sunsetMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
    expect(sunsetMs).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
  });

  it("stores the rotation time as deprecated_at, so auth's sunset (deprecated_at + grace) is the promised one", async () => {
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    app.use("*", async (c, next) => {
      c.set("workspaceId", WORKSPACE_ID);
      c.set("apiKeyPrefix", "mk_live_");
      c.set("actorId", OLD_KEY_ID);
      c.set("actorType", "agent");
      c.set("scopes", new Set(["admin:keys", "memory:read"]) as unknown as ReadonlyArray<string>);
      await next();
    });
    let deprecatedAt: string | undefined;
    const fakeSql = vi.fn() as unknown as ServerDeps["metricsPgClient"];
    (fakeSql as unknown as Record<string, unknown>).array = (v: unknown) => v;
    (fakeSql as unknown as Record<string, unknown>).begin = async (
      fn: (tx: unknown) => Promise<unknown>
    ) => {
      let calls = 0;
      const fakeTx = vi
        .fn()
        .mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
          calls++;
          if (strings.join("?").includes("SET deprecated_at")) deprecatedAt = values[0] as string;
          if (calls === 5) return Promise.resolve([activeKeyRow()]);
          return Promise.resolve([]);
        });
      (fakeTx as unknown as Record<string, unknown>).array = (v: unknown) => v;
      return fn(fakeTx);
    };
    mountKeys(app, { metricsPgClient: fakeSql } as unknown as ServerDeps);

    const before = Date.now(); // determinism-ok: bracketing wall-clock around the rotation
    const res = await app.request(`/admin/keys/${OLD_KEY_ID}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const after = Date.now(); // determinism-ok: bracketing wall-clock around the rotation
    expect(res.status).toBe(201);
    const body = (await res.json()) as { oldKeySunsetAt: string };

    expect(deprecatedAt).toBeDefined();
    const deprecatedMs = new Date(deprecatedAt!).getTime();
    expect(deprecatedMs).toBeGreaterThanOrEqual(before - 1000);
    expect(deprecatedMs).toBeLessThanOrEqual(after + 1000);
    expect(new Date(body.oldKeySunsetAt).getTime()).toBe(deprecatedMs + DEPRECATION_GRACE_MS);
  });

  it("calls INSERT before UPDATE (overlap safety)", async () => {
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    app.use("*", async (c, next) => {
      c.set("workspaceId", WORKSPACE_ID);
      c.set("apiKeyPrefix", "mk_live_");
      c.set("actorId", OLD_KEY_ID);
      c.set("actorType", "agent");
      // SEC-1: the caller must hold every scope it mints or rotates.
      c.set("scopes", new Set(["admin:keys", "memory:read"]) as unknown as ReadonlyArray<string>);
      await next();
    });

    const callOrder: string[] = [];
    const fakeSql = vi.fn() as unknown as ServerDeps["metricsPgClient"];
    (fakeSql as unknown as Record<string, unknown>).array = (v: unknown) => v;
    (fakeSql as unknown as Record<string, unknown>).begin = async (
      fn: (tx: unknown) => Promise<unknown>
    ) => {
      let txCallCount = 0;
      const fakeTx = vi.fn().mockImplementation((...args: unknown[]) => {
        txCallCount++;
        if (txCallCount <= 4) return Promise.resolve([]); // SET LOCAL + set_config preamble
        if (txCallCount === 5) return Promise.resolve([activeKeyRow()]); // SELECT
        // Inspect the SQL string to determine INSERT vs UPDATE
        const sqlStr = String(args[0]);
        if (sqlStr.includes("INSERT")) callOrder.push("insert");
        else if (sqlStr.includes("UPDATE")) callOrder.push("update");
        return Promise.resolve([]);
      });
      (fakeTx as unknown as Record<string, unknown>).array = (v: unknown) => v;
      return fn(fakeTx);
    };

    mountKeys(app, { metricsPgClient: fakeSql } as unknown as ServerDeps);

    await app.request(`/admin/keys/${OLD_KEY_ID}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // INSERT must happen before UPDATE (new key created before old is deprecated)
    const insertIdx = callOrder.indexOf("insert");
    const updateIdx = callOrder.indexOf("update");
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(insertIdx);
  });

  it("returns 409 when key is already revoked", async () => {
    const revokedKey = activeKeyRow({ revoked_at: "2026-06-01T00:00:00.000Z" });
    const { app } = makeApp([revokedKey]);
    const res = await app.request(`/admin/keys/${OLD_KEY_ID}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("key_revoked");
  });

  it("returns 422 when key is expired", async () => {
    const expiredKey = activeKeyRow({ expires_at: "2020-01-01T00:00:00.000Z" });
    const { app } = makeApp([expiredKey]);
    const res = await app.request(`/admin/keys/${OLD_KEY_ID}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("key_expired");
  });

  it("returns 404 when key does not exist", async () => {
    const { app } = makeApp([]); // empty result = key not found
    const res = await app.request(`/admin/keys/nonexistent-key/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });
});
