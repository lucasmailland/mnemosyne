/**
 * Characterization of the HTTP auth middleware's observable side effects:
 * which metric, log and span error code each post-resolve decision emits, and
 * the two inputs that can trigger a workspace switch besides the header.
 *
 * They describe what the middleware already did before the post-resolve
 * decisions moved to auth-evaluate.ts (they pass on that version too), so the
 * move is pinned beyond what the status-code suites cover.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { Hono } from "hono";
import bcrypt from "bcrypt";
import type { Span, Telemetry } from "@mnemo-ai/types";
import { createAuthMiddleware, type ApiKeyLookup, type AuthVariables } from "../../auth.js";
import { authFailuresTotal, authScopeNarrowedTotal } from "../../metrics/index.js";
import { logger } from "../../logging.js";

const HOME = "00000000-0000-0000-0000-000000000001";
const TARGET = "00000000-0000-0000-0000-000000000002";
const USER_TOKEN = "uk_live_1234567890123456789012";
const LEGACY_TOKEN = "mns_live_abcdefghijklmnopqrstu";
const DAY = 24 * 60 * 60 * 1000;

type Row = Awaited<ReturnType<ApiKeyLookup["listActive"]>>[number];

async function lookupFor(token: string, row: Partial<Row>, extra: Partial<ApiKeyLookup> = {}) {
  const keyHash = await bcrypt.hash(token, 4);
  const lookup: ApiKeyLookup = {
    listActive: async () => [
      {
        id: "key-1",
        keyHash,
        workspaceId: HOME,
        scopes: ["memory:read", "memory:write"],
        plan: "pro",
        ...row,
      },
    ],
    touch: vi.fn(),
    ...extra,
  };
  return lookup;
}

function spanRecorder() {
  const attrs: Record<string, unknown> = {};
  const span: Span = {
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    setStatus: () => {},
    end: () => {},
  };
  const telemetry = { startSpan: () => span } as unknown as Telemetry;
  return { attrs, telemetry };
}

async function call(
  lookup: ApiKeyLookup,
  token: string,
  init: { headers?: Record<string, string>; query?: string; telemetry?: Telemetry } = {}
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.onError((err, c) => {
    if (err && typeof err === "object" && "status" in err) {
      return c.json({ error: err.message }, (err as { status: number }).status as never);
    }
    throw err;
  });
  app.use("*", createAuthMiddleware(lookup, init.telemetry ? { telemetry: init.telemetry } : {}));
  app.get("/test", (c) => c.json({ workspaceId: c.get("workspaceId"), scopes: c.get("scopes") }));
  return app.request(`http://localhost/test${init.query ?? ""}`, {
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("HTTP auth — what triggers a workspace switch", () => {
  it("switches with a uk_ token whose row carries no user kind", async () => {
    const lookup = await lookupFor(
      USER_TOKEN,
      { userId: "usr-1", keyKind: null },
      { verifyWorkspaceMember: vi.fn(async () => true) }
    );
    const res = await call(lookup, USER_TOKEN, { headers: { "X-Workspace-Id": TARGET } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workspaceId: string }).workspaceId).toBe(TARGET);
  });

  it("switches on the workspaceId query parameter like on the header", async () => {
    const lookup = await lookupFor(
      USER_TOKEN,
      { userId: "usr-1", keyKind: "user" },
      { verifyWorkspaceMember: vi.fn(async () => true) }
    );
    const res = await call(lookup, USER_TOKEN, { query: `?workspaceId=${TARGET}` });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workspaceId: string }).workspaceId).toBe(TARGET);
  });
});

describe("HTTP auth — metrics, logs and span codes per decision", () => {
  it("IP outside the allowlist: logs auth.ip_denied, counts no failure, insufficient_scope", async () => {
    const inc = vi.spyOn(authFailuresTotal, "inc");
    const warn = vi.spyOn(logger, "warn");
    const { attrs, telemetry } = spanRecorder();
    const lookup = await lookupFor(LEGACY_TOKEN, { ipAllowlist: ["10.0.0.0/8"] });

    const res = await call(lookup, LEGACY_TOKEN, {
      headers: { "x-forwarded-for": "192.168.1.1" },
      telemetry,
    });

    expect(res.status).toBe(403);
    expect(warn).toHaveBeenCalledWith({ prefix: LEGACY_TOKEN.slice(0, 9) }, "auth.ip_denied");
    expect(inc).not.toHaveBeenCalled();
    expect(attrs["mnemo.error_code"]).toBe("mnemo.auth.insufficient_scope");
  });

  it("past sunset: counts deprecated_sunset, logs it, expired_key", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-16T12:00:00.000Z"), toFake: ["Date"] });
    const inc = vi.spyOn(authFailuresTotal, "inc");
    const warn = vi.spyOn(logger, "warn");
    const { attrs, telemetry } = spanRecorder();
    const lookup = await lookupFor(LEGACY_TOKEN, {
      deprecatedAt: new Date(Date.parse("2026-10-16T12:00:00.000Z") - 8 * DAY),
    });

    const res = await call(lookup, LEGACY_TOKEN, { telemetry });

    expect(res.status).toBe(401);
    expect(inc).toHaveBeenCalledWith({ adapter: "bearer", reason: "deprecated_sunset" });
    expect(warn).toHaveBeenCalledWith(
      { prefix: LEGACY_TOKEN.slice(0, 9) },
      "auth.deprecated_key_past_sunset"
    );
    expect(attrs["mnemo.error_code"]).toBe("mnemo.auth.expired_key");
  });

  it("switch with a user token bound to no user: counts it, sets no span code", async () => {
    const inc = vi.spyOn(authFailuresTotal, "inc");
    const { attrs, telemetry } = spanRecorder();
    const lookup = await lookupFor(USER_TOKEN, { keyKind: "user" });

    const res = await call(lookup, USER_TOKEN, {
      headers: { "X-Workspace-Id": TARGET },
      telemetry,
    });

    expect(res.status).toBe(403);
    expect(inc).toHaveBeenCalledWith({ adapter: "bearer", reason: "missing_user_binding" });
    expect(attrs).not.toHaveProperty("mnemo.error_code");
  });

  it("switch to a workspace the user is not in: counts not_member, insufficient_scope", async () => {
    const inc = vi.spyOn(authFailuresTotal, "inc");
    const { attrs, telemetry } = spanRecorder();
    const lookup = await lookupFor(
      USER_TOKEN,
      { userId: "usr-1", keyKind: "user" },
      { getWorkspaceMemberRole: vi.fn(async () => null) }
    );

    const res = await call(lookup, USER_TOKEN, {
      headers: { "X-Workspace-Id": TARGET },
      telemetry,
    });

    expect(res.status).toBe(403);
    expect(inc).toHaveBeenCalledWith({ adapter: "bearer", reason: "not_member" });
    expect(attrs["mnemo.error_code"]).toBe("mnemo.auth.insufficient_scope");
  });

  it("switch on membership alone: counts role_lookup_degraded and logs it", async () => {
    const inc = vi.spyOn(authFailuresTotal, "inc");
    const warn = vi.spyOn(logger, "warn");
    const lookup = await lookupFor(
      USER_TOKEN,
      { userId: "usr-1", keyKind: "user" },
      { verifyWorkspaceMember: vi.fn(async () => true) }
    );

    const res = await call(lookup, USER_TOKEN, { headers: { "X-Workspace-Id": TARGET } });

    expect(res.status).toBe(200);
    expect(inc).toHaveBeenCalledWith({ adapter: "bearer", reason: "role_lookup_degraded" });
    expect(warn).toHaveBeenCalledWith(
      { userId: "usr-1", workspaceId: TARGET },
      expect.stringMatching(/^auth\.role_lookup_degraded/)
    );
  });

  it("a key narrowed by its role counts that role", async () => {
    const narrowed = vi.spyOn(authScopeNarrowedTotal, "inc");
    const lookup = await lookupFor(
      LEGACY_TOKEN,
      { userId: "usr-1" },
      { getWorkspaceMemberRole: vi.fn(async () => "read") }
    );

    const res = await call(lookup, LEGACY_TOKEN);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { scopes: string[] }).scopes).toEqual(["memory:read"]);
    expect(narrowed).toHaveBeenCalledWith({ role: "read" });
  });

  it("a user-bound key with no row in its own workspace logs it and keeps its scopes", async () => {
    const warn = vi.spyOn(logger, "warn");
    const narrowed = vi.spyOn(authScopeNarrowedTotal, "inc");
    const lookup = await lookupFor(
      LEGACY_TOKEN,
      { userId: "usr-1" },
      { getWorkspaceMemberRole: vi.fn(async () => null) }
    );

    const res = await call(lookup, LEGACY_TOKEN);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { scopes: string[] }).scopes).toEqual([
      "memory:read",
      "memory:write",
    ]);
    expect(warn).toHaveBeenCalledWith(
      { userId: "usr-1", workspaceId: HOME },
      expect.stringMatching(/^auth\.role_missing_home_workspace/)
    );
    expect(narrowed).not.toHaveBeenCalled();
  });

  it("a deprecated key in grace keeps its Deprecation header on a later deny", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-16T12:00:00.000Z"), toFake: ["Date"] });
    const deprecatedAt = new Date(Date.parse("2026-10-16T12:00:00.000Z") - DAY);
    const lookup = await lookupFor(LEGACY_TOKEN, { deprecatedAt });

    const res = await call(lookup, LEGACY_TOKEN, { headers: { "X-Workspace-Id": TARGET } });

    expect(res.status).toBe(403);
    expect(res.headers.get("Deprecation")).toBe(deprecatedAt.toUTCString());
    expect(res.headers.get("Sunset")).toBe(
      new Date(deprecatedAt.getTime() + 7 * DAY).toUTCString()
    );
  });
});
