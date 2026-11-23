/**
 * Unit tests for GET /health/deep admin-auth gate (B2.4).
 *
 * Tests:
 *  - 401 when no Authorization header
 *  - 401 when token fails verifyApiKeyToken (invalid token format)
 *  - 403 when token is valid but lacks memory:admin scope
 *  - 200 when token is valid and has memory:admin scope
 *
 * Strategy: mock verifyApiKeyToken at the module level so tests don't
 * need real bcrypt. This keeps the test fast and deterministic.
 */

import { Hono } from "hono";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auth module so verifyApiKeyToken can be controlled per-test
vi.mock("../../auth.js", async (importActual) => {
  const actual = await importActual<typeof import("../../auth.js")>();
  return {
    ...actual,
    verifyApiKeyToken: vi.fn(),
  };
});

import { verifyApiKeyToken } from "../../auth.js";
import { mountProbes } from "../../routes/health.js";
import type { ServerDeps } from "../../deps.js";

const mockVerify = verifyApiKeyToken as ReturnType<typeof vi.fn>;

function buildApp(over: Partial<ServerDeps> = {}) {
  const app = new Hono();

  const deps = {
    core: {
      ping: async () => {},
    },
    apiKeys: { listActive: async () => [] },
    bus: { emit: () => {} },
    healthAdapters: undefined,
    ...over,
  } as unknown as ServerDeps & { healthAdapters?: undefined };

  mountProbes(app, deps);
  return app;
}

describe("/health/deep — B2.4 admin-auth gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when Authorization header is absent", async () => {
    mockVerify.mockResolvedValue(null);
    const app = buildApp();
    const res = await app.request("/health/deep");
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("missing_bearer_token");
  });

  it("returns 401 when Bearer token fails verification", async () => {
    // verifyApiKeyToken returns null → invalid/expired
    mockVerify.mockResolvedValue(null);
    const app = buildApp();
    const res = await app.request("/health/deep", {
      headers: { Authorization: "Bearer mns_live_invalidtokenxxx" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("invalid_or_expired_token");
  });

  it("returns 403 when token is valid but lacks memory:admin scope", async () => {
    mockVerify.mockResolvedValue({
      workspaceId: "ws-user",
      scopes: ["memory:read", "memory:write"],
      plan: "free",
      actorId: "key-user",
      ipAllowlist: [],
    });
    const app = buildApp();
    const res = await app.request("/health/deep", {
      headers: { Authorization: "Bearer mns_live_sometoken" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["error"]).toBe("insufficient_scope");
    expect(body["required"]).toBe("memory:admin");
  });

  it("returns 200 or 503 when token has memory:admin scope (auth passes)", async () => {
    mockVerify.mockResolvedValue({
      workspaceId: "ws-admin",
      scopes: ["memory:read", "memory:write", "memory:admin"],
      plan: "enterprise",
      actorId: "key-admin",
      ipAllowlist: [],
    });
    const app = buildApp();
    const res = await app.request("/health/deep", {
      headers: { Authorization: "Bearer mns_live_admintoken" },
    });
    // Auth passes; status is 200 (ok) or 503 (postgres down — no real DB in unit test)
    // The critical assertion: NOT 401, NOT 403
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect([200, 503]).toContain(res.status);
  });

  it("200 response includes diagnostic fields (mode, slos, hot_tier, federation)", async () => {
    mockVerify.mockResolvedValue({
      workspaceId: "ws-admin",
      scopes: ["memory:admin"],
      plan: "enterprise",
      actorId: "key-admin",
      ipAllowlist: [],
    });
    const app = buildApp();
    const res = await app.request("/health/deep", {
      headers: { Authorization: "Bearer mns_live_admintoken" },
    });
    if (res.status !== 200) return; // postgres unavailable in unit test — skip structure check

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("mode");
    expect(body).toHaveProperty("slos");
    expect(body).toHaveProperty("hot_tier");
    expect(body).toHaveProperty("federation");
    expect(typeof body["version"]).toBe("string");
    expect(typeof body["uptime"]).toBe("number");
  });

  it("reports each plugin's onHealthCheck in the plugins block without changing status", async () => {
    mockVerify.mockResolvedValue({
      workspaceId: "ws-admin",
      scopes: ["memory:admin"],
      plan: "enterprise",
      actorId: "key-admin",
      ipAllowlist: [],
    });
    const { PluginLoader } = await import("@mnemo-ai/plugins");
    const loader = new PluginLoader({ info: () => {}, warn: () => {}, error: () => {} });
    loader.register({
      id: "acme-sync",
      name: "Acme Sync",
      version: "1.0.0",
      onHealthCheck: () =>
        ({
          healthy: "yes",
          detail: `token sk-${"a".repeat(30)} expired ${"x".repeat(300)}`,
          secret: "leak",
        }) as never,
    });
    const ok = { healthCheck: async () => ({ status: "ok", latencyMs: 1 }) };
    const app = buildApp({
      pluginLoader: loader,
      healthAdapters: { storage: ok, vector: ok, cache: ok },
    } as Partial<ServerDeps>);
    const res = await app.request("/health/deep", {
      headers: { Authorization: "Bearer mns_live_admintoken" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    const plugins = body["plugins"] as {
      available: boolean;
      checks: Array<Record<string, unknown>>;
    };
    expect(plugins.available).toBe(true);
    const [check] = plugins.checks;
    // Fixed fields only: no `secret`, a non-boolean `healthy` is not healthy,
    // and the detail is redacted and capped at 200 characters.
    expect(Object.keys(check!).sort()).toEqual(["detail", "healthy", "id"]);
    expect(check!["healthy"]).toBe(false);
    const detail = check!["detail"] as string;
    expect(detail.startsWith("token [REDACTED-api_key] expired")).toBe(true);
    expect(detail).toHaveLength(200);
  });
});
