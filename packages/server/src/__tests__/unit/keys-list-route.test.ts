/**
 * Unit tests for GET /admin/keys — the list the dashboard's API Keys page shows.
 *
 * Pattern: OpenAPIHono + fake auth middleware + vi.fn() SQL client (same as
 * keys-show-route.test.ts). No real DB.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountKeys } from "../../routes/keys.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000099";

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "mk_aabbccddee112233",
    label: "Orchester",
    name: "Orchester",
    scopes: ["memory:read", "memory:write"],
    plan: "free",
    ip_allowlist: null,
    expires_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    last_used_at: "2026-11-01T10:00:00.000Z",
    revoked_at: null,
    deprecated_at: null,
    max_sensitivity: null,
    ...overrides,
  };
}

function makeApp(sqlRows: unknown[]) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mk_live_");
    c.set("scopes", new Set(["admin:keys"]) as unknown as ReadonlyArray<string>);
    await next();
  });

  const fakeSql = vi.fn().mockResolvedValue(sqlRows) as unknown as ServerDeps["metricsPgClient"];
  (fakeSql as unknown as Record<string, unknown>).array = (v: unknown) => v;
  (fakeSql as unknown as Record<string, unknown>).begin = async (
    fn: (tx: unknown) => Promise<unknown>
  ) => {
    let calls = 0;
    const fakeTx = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(calls <= 4 ? [] : sqlRows); // withKeysTx preamble, then the SELECT
    });
    (fakeTx as unknown as Record<string, unknown>).array = (v: unknown) => v;
    return fn(fakeTx);
  };

  mountKeys(app, { metricsPgClient: fakeSql } as unknown as ServerDeps);
  return app;
}

describe("GET /admin/keys — list keys", () => {
  it("answers { keys: [...] } with masked metadata, never a secret", async () => {
    const res = await makeApp([makeRow()]).request("/admin/keys");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      id: "mk_aabbccddee112233",
      label: "Orchester",
      prefix: "mk_live_",
      scopes: ["memory:read", "memory:write"],
      deprecatedAt: null,
      sunsetAt: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/key_hash|lookup_hash|secret/i);
  });

  it("a rotated key carries when it was rotated and when it stops working (7 days later)", async () => {
    const res = await makeApp([makeRow({ deprecated_at: "2026-11-04T12:00:00.000Z" })]).request(
      "/admin/keys"
    );
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys[0]!.deprecatedAt).toBe("2026-11-04T12:00:00.000Z");
    expect(body.keys[0]!.sunsetAt).toBe("2026-11-11T12:00:00.000Z");
  });
});
