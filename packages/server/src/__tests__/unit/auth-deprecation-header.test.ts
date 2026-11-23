/**
 * T2.6 — Auth middleware deprecation header emission.
 *
 * When `result.context.keyDeprecation` is set on a successful auth, the
 * middleware should append:
 *   Deprecation: <sunset ISO timestamp>
 *   Sunset: <sunset ISO timestamp>
 *   Mnemosyne-Key-Deprecated: true
 * to the response AFTER calling next().
 *
 * The x-mnemo-mfa header must be forwarded as credentials.mfaToken.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createV3AuthMiddleware } from "../../middleware/auth.js";
import type { AuthAdapter, AuthContext, RawCredentials, AuthResult } from "../../middleware/auth.js";

function makeAdapter(overrides: Partial<AuthAdapter> = {}): AuthAdapter {
  return {
    id: "test",
    authenticate: vi.fn().mockResolvedValue({ ok: true, context: baseCtx() }),
    authorize: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }),
    ...overrides,
  };
}

function baseCtx(): AuthContext {
  return {
    workspaceId: "11111111-1111-1111-1111-111111111111",
    actorId: "key1",
    actorType: "agent",
    scopes: ["memory:read"],
  };
}

describe("createV3AuthMiddleware — deprecation headers", () => {
  it("emits Deprecation/Sunset/Mnemosyne-Key-Deprecated when keyDeprecation is set", async () => {
    const sunset = "2026-06-23T00:00:00.000Z";
    const adapter = makeAdapter({
      authenticate: vi.fn().mockResolvedValue({
        ok: true,
        context: { ...baseCtx(), keyDeprecation: { deprecated: true, sunset } },
      } satisfies AuthResult),
    });

    const app = new Hono();
    app.use("*", createV3AuthMiddleware(adapter));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { "x-mnemo-key": "mk_live_key1_somesecretthatisfortycharacterstotestthelength" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBe(sunset);
    expect(res.headers.get("Sunset")).toBe(sunset);
    expect(res.headers.get("Mnemosyne-Key-Deprecated")).toBe("true");
  });

  it("does NOT emit deprecation headers when keyDeprecation is absent", async () => {
    const adapter = makeAdapter();

    const app = new Hono();
    app.use("*", createV3AuthMiddleware(adapter));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { "x-mnemo-key": "mk_live_key1_somesecretthatisfortycharacterstotestthelength" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Mnemosyne-Key-Deprecated")).toBeNull();
  });

  it("passes x-mnemo-mfa as mfaToken in credentials", async () => {
    const authenticate = vi.fn().mockResolvedValue({ ok: true, context: baseCtx() } satisfies AuthResult);
    const adapter = makeAdapter({ authenticate });

    const app = new Hono();
    app.use("*", createV3AuthMiddleware(adapter));
    app.get("/test", (c) => c.json({ ok: true }));

    await app.request("/test", {
      headers: {
        "x-mnemo-key": "mk_live_key1_somesecretthatisfortycharacterstotestthelength",
        "x-mnemo-mfa": "123456",
      },
    });

    const creds: RawCredentials = (authenticate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(creds.mfaToken).toBe("123456");
  });
});
