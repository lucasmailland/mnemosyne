import { describe, expect, it, vi, afterEach } from "vitest";
import { Hono } from "hono";
import bcrypt from "bcrypt";
import {
  createAuthMiddleware,
  verifyApiKeyToken,
  BCRYPT_COST,
  type ApiKeyLookup,
  type AuthVariables,
} from "../../auth.js";

describe("P33 — User Token & Multi-Workspace Auth", () => {
  const plainToken = "uk_live_1234567890123456789012";

  it("accepts uk_live_* tokens in verifyApiKeyToken", async () => {
    const keyHash = await bcrypt.hash(plainToken, BCRYPT_COST);
    const lookup: ApiKeyLookup = {
      listActive: async () => [
        {
          id: "uk-123",
          keyHash,
          workspaceId: "00000000-0000-0000-0000-000000000001",
          scopes: ["memory:read", "memory:write"],
          plan: "pro",
          userId: "usr-001",
          tenantId: "tnt-001",
          keyKind: "user",
        },
      ],
      touch: vi.fn(),
    };

    const result = await verifyApiKeyToken(lookup, plainToken);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("usr-001");
  });

  it("resolves target workspace via X-Workspace-Id header when user is a member", async () => {
    const keyHash = await bcrypt.hash(plainToken, BCRYPT_COST);
    const defaultWs = "00000000-0000-0000-0000-000000000001";
    const targetWs = "00000000-0000-0000-0000-000000000002";

    const lookup: ApiKeyLookup = {
      listActive: async () => [
        {
          id: "uk-123",
          keyHash,
          workspaceId: defaultWs,
          scopes: ["memory:read"],
          plan: "pro",
          userId: "usr-001",
          tenantId: "tnt-001",
          keyKind: "user",
        },
      ],
      touch: vi.fn(),
      verifyWorkspaceMember: vi.fn(
        async (userId, wsId) => userId === "usr-001" && wsId === targetWs
      ),
    };

    const app = new Hono<{ Variables: AuthVariables }>();
    app.use("*", createAuthMiddleware(lookup));
    app.get("/test", (c) => c.json({ workspaceId: c.get("workspaceId"), userId: c.get("userId") }));

    const res = await app.request("http://localhost/test", {
      headers: {
        Authorization: `Bearer ${plainToken}`,
        "X-Workspace-Id": targetWs,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string; userId: string };
    expect(body.workspaceId).toBe(targetWs);
    expect(body.userId).toBe("usr-001");
  });

  it("rejects request when user is not a member of requested workspace", async () => {
    const keyHash = await bcrypt.hash(plainToken, BCRYPT_COST);
    const defaultWs = "00000000-0000-0000-0000-000000000001";
    const targetWs = "00000000-0000-0000-0000-000000000099";

    const lookup: ApiKeyLookup = {
      listActive: async () => [
        {
          id: "uk-123",
          keyHash,
          workspaceId: defaultWs,
          scopes: ["memory:read"],
          plan: "pro",
          userId: "usr-001",
          tenantId: "tnt-001",
          keyKind: "user",
        },
      ],
      touch: vi.fn(),
      verifyWorkspaceMember: vi.fn(async () => false),
    };

    const app = new Hono<{ Variables: AuthVariables }>();
    app.onError((err, c) => {
      if (err && typeof err === "object" && "status" in err) {
        return c.json({ error: err.message }, (err as { status: number }).status as never);
      }
      throw err;
    });
    app.use("*", createAuthMiddleware(lookup));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("http://localhost/test", {
      headers: {
        Authorization: `Bearer ${plainToken}`,
        "X-Workspace-Id": targetWs,
      },
    });

    expect(res.status).toBe(403);
  });

  it("fails closed (403) when verifyWorkspaceMember is undefined on lookup", async () => {
    const keyHash = await bcrypt.hash(plainToken, BCRYPT_COST);
    const defaultWs = "00000000-0000-0000-0000-000000000001";
    const targetWs = "00000000-0000-0000-0000-000000000002";

    const lookup: ApiKeyLookup = {
      listActive: async () => [
        {
          id: "uk-123",
          keyHash,
          workspaceId: defaultWs,
          scopes: ["memory:read"],
          plan: "pro",
          userId: "usr-001",
          tenantId: "tnt-001",
          keyKind: "user",
        },
      ],
      touch: vi.fn(),
      // verifyWorkspaceMember explicitly omitted!
    };

    const app = new Hono<{ Variables: AuthVariables }>();
    app.onError((err, c) => {
      if (err && typeof err === "object" && "status" in err) {
        return c.json({ error: err.message }, (err as { status: number }).status as never);
      }
      throw err;
    });
    app.use("*", createAuthMiddleware(lookup));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("http://localhost/test", {
      headers: {
        Authorization: `Bearer ${plainToken}`,
        "X-Workspace-Id": targetWs,
      },
    });

    expect(res.status).toBe(403);
  });

  it("rejects workspace switch attempt when keyKind is workspace even if userId is bound", async () => {
    const mkToken = "mk_live_1234567890123456789012";
    const keyHash = await bcrypt.hash(mkToken, BCRYPT_COST);
    const defaultWs = "00000000-0000-0000-0000-000000000001";
    const targetWs = "00000000-0000-0000-0000-000000000002";

    const lookup: ApiKeyLookup = {
      listActive: async () => [
        {
          id: "mk-123",
          keyHash,
          workspaceId: defaultWs,
          scopes: ["memory:read"],
          plan: "pro",
          userId: "usr-001",
          tenantId: "tnt-001",
          keyKind: "workspace", // Standard workspace key
        },
      ],
      touch: vi.fn(),
      verifyWorkspaceMember: vi.fn(async () => true),
    };

    const app = new Hono<{ Variables: AuthVariables }>();
    app.onError((err, c) => {
      if (err && typeof err === "object" && "status" in err) {
        return c.json({ error: err.message }, (err as { status: number }).status as never);
      }
      throw err;
    });
    app.use("*", createAuthMiddleware(lookup));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("http://localhost/test", {
      headers: {
        Authorization: `Bearer ${mkToken}`,
        "X-Workspace-Id": targetWs,
      },
    });

    expect(res.status).toBe(403);
  });
});

describe("S4 — workspace-role scope narrowing", () => {
  const plainToken = "uk_live_1234567890123456789012";
  const defaultWs = "00000000-0000-0000-0000-000000000001";
  const targetWs = "00000000-0000-0000-0000-000000000002";

  function makeApp(lookup: ApiKeyLookup): Hono<{ Variables: AuthVariables }> {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.onError((err, c) => {
      if (err && typeof err === "object" && "status" in err) {
        return c.json({ error: err.message }, (err as { status: number }).status as never);
      }
      throw err;
    });
    app.use("*", createAuthMiddleware(lookup));
    app.get("/test", (c) =>
      c.json({
        workspaceId: c.get("workspaceId"),
        scopes: c.get("scopes"),
        workspaceRole: c.get("workspaceRole") ?? null,
      })
    );
    return app;
  }

  async function makeLookup(
    scopes: string[],
    role: string | null,
    opts: { keyWorkspaceId?: string } = {}
  ): Promise<ApiKeyLookup> {
    const keyHash = await bcrypt.hash(plainToken, BCRYPT_COST);
    return {
      listActive: async () => [
        {
          id: "uk-123",
          keyHash,
          workspaceId: opts.keyWorkspaceId ?? defaultWs,
          scopes,
          plan: "pro",
          userId: "usr-001",
          tenantId: "tnt-001",
          keyKind: "user",
        },
      ],
      touch: vi.fn(),
      getWorkspaceMemberRole: vi.fn(async () => role),
    };
  }

  it("(a) a read-role member switching workspaces has memory:write stripped", async () => {
    const lookup = await makeLookup(["memory:read", "memory:write", "memory:admin"], "read");
    const app = makeApp(lookup);
    const res = await app.request("http://localhost/test", {
      headers: { Authorization: `Bearer ${plainToken}`, "X-Workspace-Id": targetWs },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes: string[]; workspaceRole: string };
    expect(body.scopes).toContain("memory:read");
    expect(body.scopes).not.toContain("memory:write");
    expect(body.scopes).not.toContain("memory:admin");
    expect(body.workspaceRole).toBe("read");
  });

  it("(b) the key's own HOME workspace is narrowed too, not just an explicit switch", async () => {
    const lookup = await makeLookup(["memory:read", "memory:write"], "read");
    const app = makeApp(lookup);
    // No X-Workspace-Id header — this hits the home-workspace narrowing branch.
    const res = await app.request("http://localhost/test", {
      headers: { Authorization: `Bearer ${plainToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toContain("memory:read");
    expect(body.scopes).not.toContain("memory:write");
  });

  it("(c) narrowing never adds a scope the key didn't already have (admin role, minimal key scopes)", async () => {
    const lookup = await makeLookup(["memory:read"], "admin");
    const app = makeApp(lookup);
    const res = await app.request("http://localhost/test", {
      headers: { Authorization: `Bearer ${plainToken}` },
    });
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["memory:read"]);
  });

  it("(d) missing home-workspace role fails OPEN — scopes unchanged", async () => {
    const lookup = await makeLookup(["memory:read", "memory:write"], null);
    const app = makeApp(lookup);
    const res = await app.request("http://localhost/test", {
      headers: { Authorization: `Bearer ${plainToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes: string[]; workspaceRole: string | null };
    expect(body.scopes).toEqual(["memory:read", "memory:write"]);
    expect(body.workspaceRole).toBeNull();
  });

  it("(e) getWorkspaceMemberRole absent, verifyWorkspaceMember present → membership enforced, no narrowing", async () => {
    const keyHash = await bcrypt.hash(plainToken, BCRYPT_COST);
    const lookup: ApiKeyLookup = {
      listActive: async () => [
        {
          id: "uk-123",
          keyHash,
          workspaceId: defaultWs,
          scopes: ["memory:read", "memory:write"],
          plan: "pro",
          userId: "usr-001",
          tenantId: "tnt-001",
          keyKind: "user",
        },
      ],
      touch: vi.fn(),
      verifyWorkspaceMember: vi.fn(async () => true),
      // getWorkspaceMemberRole deliberately omitted.
    };
    const app = makeApp(lookup);
    const res = await app.request("http://localhost/test", {
      headers: { Authorization: `Bearer ${plainToken}`, "X-Workspace-Id": targetWs },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes: string[]; workspaceId: string };
    expect(body.workspaceId).toBe(targetWs);
    expect(body.scopes).toEqual(["memory:read", "memory:write"]);
  });

  it("(h) role cache avoids a second DB lookup for the same user+workspace within its TTL", async () => {
    const lookup = await makeLookup(["memory:read", "memory:write"], "read");
    const app = makeApp(lookup);
    await app.request("http://localhost/test", {
      headers: { Authorization: `Bearer ${plainToken}`, "X-Workspace-Id": targetWs },
    });
    await app.request("http://localhost/test", {
      headers: { Authorization: `Bearer ${plainToken}`, "X-Workspace-Id": targetWs },
    });
    expect(lookup.getWorkspaceMemberRole).toHaveBeenCalledTimes(1);
  });
});

describe("S4 — MNEMO_DISABLE_WORKSPACE_ROLE_SCOPES kill switch", () => {
  const plainToken = "uk_live_1234567890123456789012";
  const defaultWs = "00000000-0000-0000-0000-000000000001";

  afterEach(() => {
    delete process.env["MNEMO_DISABLE_WORKSPACE_ROLE_SCOPES"];
    vi.resetModules();
  });

  it("disables narrowing entirely when set to 'true' — a read-role member keeps memory:write", async () => {
    process.env["MNEMO_DISABLE_WORKSPACE_ROLE_SCOPES"] = "true";
    vi.resetModules();
    const { createAuthMiddleware: freshCreateAuthMiddleware } = await import("../../auth.js");

    const keyHash = await bcrypt.hash(plainToken, BCRYPT_COST);
    const lookup: ApiKeyLookup = {
      listActive: async () => [
        {
          id: "uk-123",
          keyHash,
          workspaceId: defaultWs,
          scopes: ["memory:read", "memory:write"],
          plan: "pro",
          userId: "usr-001",
          tenantId: "tnt-001",
          keyKind: "user",
        },
      ],
      touch: vi.fn(),
      getWorkspaceMemberRole: vi.fn(async () => "read"),
    };

    const app = new Hono<{ Variables: AuthVariables }>();
    app.use("*", freshCreateAuthMiddleware(lookup));
    app.get("/test", (c) => c.json({ scopes: c.get("scopes") }));

    const res = await app.request("http://localhost/test", {
      headers: { Authorization: `Bearer ${plainToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes: string[] };
    expect(body.scopes).toEqual(["memory:read", "memory:write"]);
  });

  // CHAOS-2: `touch` used to receive the effective workspace id and update
  // last_used_at on EVERY key of that workspace — the workspace the caller
  // switched INTO, not even its own. It must name the authenticating credential.
  it("touches the authenticating key's id, never a workspace id (CHAOS-2)", async () => {
    const keyHash = await bcrypt.hash(plainToken, BCRYPT_COST);
    const defaultWs = "00000000-0000-0000-0000-000000000001";
    const targetWs = "00000000-0000-0000-0000-000000000002";
    const touch = vi.fn();
    const lookup: ApiKeyLookup = {
      listActive: async () => [
        {
          id: "uk-123",
          keyHash,
          workspaceId: defaultWs,
          scopes: ["memory:read"],
          plan: "pro",
          userId: "usr-001",
          tenantId: "tnt-001",
          keyKind: "user",
        },
      ],
      touch,
      verifyWorkspaceMember: vi.fn(async () => true),
    };

    const app = new Hono<{ Variables: AuthVariables }>();
    app.use("*", createAuthMiddleware(lookup));
    app.get("/test", (c) => c.json({ workspaceId: c.get("workspaceId") }));

    const res = await app.request("http://localhost/test", {
      headers: { Authorization: `Bearer ${plainToken}`, "X-Workspace-Id": targetWs },
    });
    expect(res.status).toBe(200);
    expect(touch).toHaveBeenCalledTimes(1);
    expect(touch).toHaveBeenCalledWith("uk-123");
    expect(touch).not.toHaveBeenCalledWith(targetWs);
    expect(touch).not.toHaveBeenCalledWith(defaultWs);
  });
});
