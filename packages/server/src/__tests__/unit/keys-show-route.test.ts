/**
 * Unit tests for GET /admin/keys/:keyId — show single key metadata.
 *
 * Pattern: OpenAPIHono + fake auth middleware + vi.fn() SQL client.
 * No real DB, no bcrypt.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountKeys } from "../../routes/keys.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000099";
const KEY_ID = "mk_aabbccddee112233";

function makeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    label: "CI agent",
    scopes: ["memory:read", "memory:write"],
    ip_allowlist: ["10.0.0.0/8"],
    expires_at: "2027-01-01T00:00:00.000Z",
    last_used_at: "2026-07-01T10:00:00.000Z",
    revoked_at: null,
    deprecated_at: null,
    rotated_from_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeApp(sqlRows: unknown[]) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  // Fake auth middleware — sets required context variables
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mk_live_");
    c.set("scopes", new Set(["admin:keys"]) as unknown as ReadonlyArray<string>);
    await next();
  });

  // Fake SQL client used for outer calls (not actually invoked by mountKeys)
  const fakeSql = vi.fn().mockResolvedValue(sqlRows) as unknown as ServerDeps["metricsPgClient"];
  (fakeSql as unknown as Record<string, unknown>).array = (v: unknown) => v;
  // Simulate sql.begin(fn) — withKeysTx sequence (no pg_has_role check after RLS fix):
  //   call 1: SET LOCAL ROLE app_user     → []
  //   call 2: SET LOCAL search_path       → []
  //   call 3: set_config app.workspace_id → []
  //   call 4: set_config mnemosyne.wid    → []
  //   call 5+: actual SELECT/INSERT/UPDATE → sqlRows
  (fakeSql as unknown as Record<string, unknown>).begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    let txCallCount = 0;
    const fakeTx = vi.fn().mockImplementation(() => {
      txCallCount++;
      if (txCallCount <= 4) return Promise.resolve([]); // SET LOCAL + set_config preamble
      return Promise.resolve(sqlRows); // actual query
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

describe("GET /admin/keys/:keyId — show key", () => {
  it("returns 200 with full metadata for an active key", async () => {
    const { app } = makeApp([makeKeyRow()]);
    const res = await app.request(`/admin/keys/${KEY_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe(KEY_ID);
    expect(body.label).toBe("CI agent");
    expect(body.scopes).toEqual(["memory:read", "memory:write"]);
    expect(body.ipAllowlist).toEqual(["10.0.0.0/8"]);
    expect(body.expiresAt).toContain("2027-01-01");
    expect(body.lastUsedAt).toContain("2026-07-01");
    expect(body.revokedAt).toBeNull();
    expect(body.rotatedFromId).toBeNull();
    expect(body.createdAt).toContain("2026-01-01");
  });

  it("returns 200 with revokedAt populated for a revoked key (not 404)", async () => {
    const revokedAt = "2026-06-15T12:00:00.000Z";
    const { app } = makeApp([makeKeyRow({ revoked_at: revokedAt })]);
    const res = await app.request(`/admin/keys/${KEY_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.revokedAt).toContain("2026-06-15");
  });

  it("returns 404 when key is not found", async () => {
    const { app } = makeApp([]); // empty result set
    const res = await app.request(`/admin/keys/nonexistent-key`);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  it("does not include key, keyHash, or lookupHash fields in response body", async () => {
    const { app } = makeApp([makeKeyRow()]);
    const res = await app.request(`/admin/keys/${KEY_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect("key" in body).toBe(false);
    expect("keyHash" in body).toBe(false);
    expect("lookupHash" in body).toBe(false);
    expect("key_hash" in body).toBe(false);
    expect("lookup_hash" in body).toBe(false);
  });

  it("includes rotatedFromId when key was produced by rotation", async () => {
    const predecessorId = "mk_predecessor0011223344";
    const { app } = makeApp([makeKeyRow({ rotated_from_id: predecessorId })]);
    const res = await app.request(`/admin/keys/${KEY_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.rotatedFromId).toBe(predecessorId);
  });
});
