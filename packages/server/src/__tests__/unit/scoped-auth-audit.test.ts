/**
 * p52-mfa-ip-denied-audit — authenticateScoped() audit emission.
 *
 * Covers spec requirements:
 *   - `ip_denied` is emitted (awaited) BEFORE the ForbiddenError throw when
 *     the adapter's failure result carries `auditAction` + `workspaceId`.
 *   - `mfa_verified` is emitted once on a successful `mk_admin_` request;
 *     never on a successful non-admin scoped request.
 *   - A rejecting `appendAuditEntry` never changes the 403/200 response the
 *     caller receives (emitAudit's swallow-and-log contract holds here too).
 *
 * Pattern: Hono app + createAuthMiddleware(lookup, opts, scopedAdapter) with
 * a fake AuthAdapter returning controlled AuthResult values, mirrored on
 * auth-ip-allowlist.test.ts's harness.
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { AuthAdapter, AuthResult } from "@mnemo-ai/types";

import { createAuthMiddleware } from "../../auth.js";
import { toErrorBody } from "../../errors.js";
import type { ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";

const WS_ID = "00000000-0000-0000-0000-0000000000ee";
const KEY_ID = "key-scoped-audit";
const SCOPED_TOKEN = "mk_live_key-scoped-audit_secretvalue";

function emptyLookup(): ApiKeyLookup {
  return {
    listActive: async () => [],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function fakeAdapter(result: AuthResult): AuthAdapter {
  return {
    id: "fake-scoped",
    authenticate: vi.fn().mockResolvedValue(result),
    authorize: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ status: "ok", latencyMs: 0 }),
  };
}

function buildApp(adapter: AuthAdapter, storage: ServerDeps["storage"]) {
  const app = new Hono();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  app.use("*", createAuthMiddleware(emptyLookup(), { storage }, adapter));
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

function bearer() {
  return { authorization: `Bearer ${SCOPED_TOKEN}` };
}

describe("authenticateScoped() — ip_denied audit emission", () => {
  it("emits one ip_denied entry (awaited) before the 403 for an IP-denied result", async () => {
    const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
    const adapter = fakeAdapter({
      ok: false,
      code: "FORBIDDEN",
      reason: "IP not in allowlist",
      workspaceId: WS_ID,
      keyId: KEY_ID,
      auditAction: "ip_denied",
    });
    const app = buildApp(adapter, { appendAuditEntry } as unknown as ServerDeps["storage"]);

    const res = await app.request("/probe", { headers: bearer() });

    expect(res.status).toBe(403);
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
    const entry = appendAuditEntry.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry.action).toBe("ip_denied");
    expect(entry.workspaceId).toBe(WS_ID);
    expect(entry.actorId).toBe(`key:${KEY_ID}`);
  });

  it("does not emit an audit entry for a failure without auditAction (e.g. MFA failure)", async () => {
    const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
    const adapter = fakeAdapter({
      ok: false,
      code: "FORBIDDEN",
      reason: "Break-glass MFA required",
      workspaceId: WS_ID,
      keyId: KEY_ID,
      // no auditAction
    });
    const app = buildApp(adapter, { appendAuditEntry } as unknown as ServerDeps["storage"]);

    const res = await app.request("/probe", { headers: bearer() });

    expect(res.status).toBe(403);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("leaves the 403 unchanged when appendAuditEntry rejects", async () => {
    const appendAuditEntry = vi.fn().mockRejectedValue(new Error("merkle lock timeout"));
    const adapter = fakeAdapter({
      ok: false,
      code: "FORBIDDEN",
      reason: "IP not in allowlist",
      workspaceId: WS_ID,
      keyId: KEY_ID,
      auditAction: "ip_denied",
    });
    const app = buildApp(adapter, { appendAuditEntry } as unknown as ServerDeps["storage"]);

    const res = await app.request("/probe", { headers: bearer() });

    expect(res.status).toBe(403);
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
  });
});

describe("authenticateScoped() — mfa_verified audit emission", () => {
  function successResult(keyType: "mk_admin_" | "mk_live_"): AuthResult {
    return {
      ok: true,
      context: {
        workspaceId: WS_ID,
        actorId: KEY_ID,
        actorType: "agent",
        scopes: ["memory:read"],
        keyType,
      },
    };
  }

  it("emits one mfa_verified entry on successful mk_admin_ authentication", async () => {
    const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
    const adapter = fakeAdapter(successResult("mk_admin_"));
    const app = buildApp(adapter, { appendAuditEntry } as unknown as ServerDeps["storage"]);

    const res = await app.request("/probe", { headers: bearer() });

    expect(res.status).toBe(200);
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
    const entry = appendAuditEntry.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry.action).toBe("mfa_verified");
    expect(entry.workspaceId).toBe(WS_ID);
    expect(entry.actorId).toBe(`key:${KEY_ID}`);
  });

  it("emits no mfa_verified entry on successful non-admin scoped authentication", async () => {
    const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
    const adapter = fakeAdapter(successResult("mk_live_"));
    const app = buildApp(adapter, { appendAuditEntry } as unknown as ServerDeps["storage"]);

    const res = await app.request("/probe", { headers: bearer() });

    expect(res.status).toBe(200);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("leaves the 200 unchanged when appendAuditEntry rejects on mfa_verified emission", async () => {
    const appendAuditEntry = vi.fn().mockRejectedValue(new Error("merkle lock timeout"));
    const adapter = fakeAdapter(successResult("mk_admin_"));
    const app = buildApp(adapter, { appendAuditEntry } as unknown as ServerDeps["storage"]);

    const res = await app.request("/probe", { headers: bearer() });

    expect(res.status).toBe(200);
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
  });
});
