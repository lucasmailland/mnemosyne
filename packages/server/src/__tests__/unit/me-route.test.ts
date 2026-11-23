/**
 * Unit tests for GET /me — key introspection (P13).
 *
 * Pattern: OpenAPIHono + fake auth middleware + vi.fn() SQL client.
 * No real DB. withKeysTx mock sequence: SET LOCAL ROLE → SET LOCAL search_path → 2× set_config → actual query.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountKeys } from "../../routes/keys.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ACTOR_ID = "mk_live_aabbccddee112233";

function makeApp(keyRow: unknown | null) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("actorId", ACTOR_ID);
    c.set("apiKeyPrefix", "mk_live_");
    c.set("scopes", new Set(["memory:read", "memory:write"]) as unknown as ReadonlyArray<string>);
    c.set("plan", "pro");
    await next();
  });

  const sqlRows = keyRow ? [keyRow] : [];
  const fakeSql = vi.fn().mockResolvedValue(sqlRows) as unknown as ServerDeps["metricsPgClient"];
  (fakeSql as unknown as Record<string, unknown>).array = (v: unknown) => v;
  // withKeysTx sequence: SET LOCAL ROLE (1) → SET LOCAL search_path (2) →
  //   set_config GUC×2 (3-4) → actual SELECT (5+)
  (fakeSql as unknown as Record<string, unknown>).begin = async (
    fn: (tx: unknown) => Promise<unknown>
  ) => {
    let callCount = 0;
    const fakeTx = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 4) return Promise.resolve([]); // SET LOCAL + set_config preamble
      return Promise.resolve(sqlRows); // actual SELECT
    });
    (fakeTx as unknown as Record<string, unknown>).array = (v: unknown) => v;
    return fn(fakeTx);
  };

  const fakeDeps = { metricsPgClient: fakeSql } as unknown as ServerDeps;
  mountKeys(app, fakeDeps);
  return { app };
}

describe("GET /me — key introspection (P13)", () => {
  it("returns 200 with workspaceName from DB join", async () => {
    const { app } = makeApp({
      id: ACTOR_ID,
      expires_at: null,
      ip_allowlist: [],
      workspace_name: "Acme Corp",
    });
    const res = await app.request("/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.workspaceId).toBe(WORKSPACE_ID);
    expect(body.workspaceName).toBe("Acme Corp");
    expect(body.keyId).toBe(ACTOR_ID);
    expect(body.plan).toBe("pro");
    expect(body.scopes).toContain("memory:read");
    expect(body.keyPrefix).toBe("mk_live_");
    expect(body.expiresAt).toBeNull();
    expect(body.ipAllowlist).toEqual([]);
  });

  it("exposes workspaceRole and effectiveScopes for a read-role member", async () => {
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    app.use("*", async (c, next) => {
      c.set("workspaceId", WORKSPACE_ID);
      c.set("actorId", ACTOR_ID);
      c.set("apiKeyPrefix", "uk_live_");
      // Simulates auth.ts's S4 narrowing having already run: scopes here is
      // the NARROWED set (memory:write was stripped by the read role).
      c.set("scopes", ["memory:read"] as unknown as ReadonlyArray<string>);
      c.set("workspaceRole", "read");
      c.set("plan", "pro");
      await next();
    });
    const fakeSql = vi.fn().mockResolvedValue([]) as unknown as ServerDeps["metricsPgClient"];
    (fakeSql as unknown as Record<string, unknown>).array = (v: unknown) => v;
    (fakeSql as unknown as Record<string, unknown>).begin = async (
      fn: (tx: unknown) => Promise<unknown>
    ) => {
      let callCount = 0;
      const fakeTx = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve([]);
      });
      (fakeTx as unknown as Record<string, unknown>).array = (v: unknown) => v;
      return fn(fakeTx);
    };
    mountKeys(app, { metricsPgClient: fakeSql } as unknown as ServerDeps);
    const res = await app.request("/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.workspaceRole).toBe("read");
    expect(body.effectiveScopes).toEqual(["memory:read"]);
    expect(body.scopes).toEqual(["memory:read"]);
  });

  it("returns workspaceRole: null when the auth context never set one (workspace key, no user binding)", async () => {
    const { app } = makeApp({
      id: ACTOR_ID,
      expires_at: null,
      ip_allowlist: [],
      workspace_name: null,
    });
    const res = await app.request("/me");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.workspaceRole).toBeNull();
  });

  it("returns workspaceName: null when workspace row is missing", async () => {
    const { app } = makeApp({
      id: ACTOR_ID,
      expires_at: null,
      ip_allowlist: [],
      workspace_name: null,
    });
    const res = await app.request("/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.workspaceName).toBeNull();
  });

  it("returns workspaceName: null and empty fields when no key row found (best-effort)", async () => {
    const { app } = makeApp(null);
    const res = await app.request("/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.workspaceId).toBe(WORKSPACE_ID);
    expect(body.workspaceName).toBeNull();
    expect(body.expiresAt).toBeNull();
    expect(body.ipAllowlist).toEqual([]);
  });

  it("infers mk_live_ prefix for mk_ actorId", async () => {
    const { app } = makeApp(null);
    const res = await app.request("/me");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.keyPrefix).toBe("mk_live_");
  });

  it("infers mns_live_ prefix for bootstrap_ actorId", async () => {
    const app2 = new OpenAPIHono<{ Variables: AuthVariables }>();
    app2.use("*", async (c, next) => {
      c.set("workspaceId", WORKSPACE_ID);
      c.set("actorId", "bootstrap_seed");
      c.set("apiKeyPrefix", "mns_live_");
      c.set("scopes", new Set([]) as unknown as ReadonlyArray<string>);
      c.set("plan", "free");
      await next();
    });
    const fakeSql2 = vi.fn().mockResolvedValue([]) as unknown as ServerDeps["metricsPgClient"];
    (fakeSql2 as unknown as Record<string, unknown>).array = (v: unknown) => v;
    (fakeSql2 as unknown as Record<string, unknown>).begin = async (
      fn: (tx: unknown) => Promise<unknown>
    ) => {
      let c = 0;
      const t = vi.fn().mockImplementation(() => {
        c++;
        if (c <= 4) return Promise.resolve([]); // SET LOCAL + set_config preamble
        return Promise.resolve([]);
      });
      (t as unknown as Record<string, unknown>).array = (v: unknown) => v;
      return fn(t);
    };
    mountKeys(app2, { metricsPgClient: fakeSql2 } as unknown as ServerDeps);
    const res = await app2.request("/me");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.keyPrefix).toBe("mns_live_");
  });
});
