/**
 * Unit tests for p50-audit-log-emitters PR2 — keys.ts audit emission.
 *
 * Covers task 2.5: key_create/key_rotate/key_revoke each append an
 * AuditLogEntry with the right action/resourceKind/isTerminal and a
 * namespaced actorId (never the bare apiKeyPrefix constant, per S11).
 *
 * Pattern: OpenAPIHono + fake auth middleware (sets actorId like auth.ts
 * would) + vi.fn() SQL client + a spy `deps.storage.appendAuditEntry`.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { AuditLogEntry } from "@mnemo-ai/types";
import { mountKeys } from "../../routes/keys.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000aa";
const RAW_ACTOR_ID = "mk_aabbccddee112233"; // the calling key's own row id
const USER_ID = "user-123";
const KEY_ID = "mk_p50testkey00112233";

function activeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    label: "CI agent",
    scopes: ["memory:read"],
    plan: "free",
    ip_allowlist: [],
    expires_at: null,
    revoked_at: null,
    deprecated_at: null,
    user_id: null,
    tenant_id: null,
    key_kind: "workspace",
    ...overrides,
  };
}

/**
 * Builds a fake app with a real `deps.storage.appendAuditEntry` spy so tests
 * can assert on emitted entries. `selectRows` is returned for the 5th tx
 * call (the SELECT after the 4-step SET LOCAL/set_config preamble) — mirrors
 * keys-rotate-route.test.ts's convention.
 */
function makeApp(selectRows: unknown[]) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mk_live_");
    c.set("actorId", RAW_ACTOR_ID);
    c.set("actorType", "agent");
    c.set("userId", USER_ID);
    // SEC-1: the caller must hold every scope it mints or rotates.
    c.set("scopes", new Set(["admin:keys", "memory:read"]) as unknown as ReadonlyArray<string>);
    await next();
  });

  const fakeSql = vi.fn() as unknown as ServerDeps["metricsPgClient"];
  (fakeSql as unknown as Record<string, unknown>).array = (v: unknown) => v;
  (fakeSql as unknown as Record<string, unknown>).begin = async (
    fn: (tx: unknown) => Promise<unknown>
  ) => {
    let txCallCount = 0;
    const fakeTx = vi.fn().mockImplementation(() => {
      txCallCount++;
      if (txCallCount <= 4) return Promise.resolve([]); // SET LOCAL + set_config preamble
      if (txCallCount === 5) return Promise.resolve(selectRows); // SELECT (rotate/revoke read)
      return Promise.resolve([]); // INSERT/UPDATE
    });
    (fakeTx as unknown as Record<string, unknown>).array = (v: unknown) => v;
    return fn(fakeTx);
  };

  const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
  const fakeDeps = {
    metricsPgClient: fakeSql,
    storage: { appendAuditEntry } as unknown as ServerDeps["storage"],
  } as unknown as ServerDeps;

  mountKeys(app, fakeDeps);
  return { app, appendAuditEntry };
}

function firstEntry(spy: ReturnType<typeof vi.fn>): Omit<AuditLogEntry, "id" | "createdAt"> {
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0]![0] as Omit<AuditLogEntry, "id" | "createdAt">;
}

describe("POST /admin/keys — key_create audit emission", () => {
  it("emits a key_create entry with a namespaced actorId, never the apiKeyPrefix", async () => {
    const { app, appendAuditEntry } = makeApp([]);
    const res = await app.request("/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "CI agent", scopes: ["memory:read"] }),
    });
    expect(res.status).toBe(201);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("key_create");
    expect(entry.resourceKind).toBe("api_key");
    expect(entry.isTerminal).toBe(false);
    expect(entry.workspaceId).toBe(WORKSPACE_ID);
    expect(entry.actorType).toBe("agent");
    expect(entry.actorId).not.toBe("mk_live_"); // never the raw apiKeyPrefix constant (S11)
    expect(entry.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(entry.detail).toMatchObject({ userId: USER_ID, label: "CI agent" });
  });

  it("never leaks plainKey/keyHash/lookupHash into detail", async () => {
    const { app, appendAuditEntry } = makeApp([]);
    await app.request("/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "secret-free", scopes: ["memory:read"] }),
    });
    const entry = firstEntry(appendAuditEntry);
    const detailKeys = Object.keys(entry.detail ?? {});
    expect(detailKeys).not.toContain("plainKey");
    expect(detailKeys).not.toContain("keyHash");
    expect(detailKeys).not.toContain("lookupHash");
  });
});

describe("POST /admin/keys/:keyId/rotate — key_rotate audit emission", () => {
  it("emits a key_rotate entry only after the tx resolves ok", async () => {
    const { app, appendAuditEntry } = makeApp([activeKeyRow()]);
    const res = await app.request(`/admin/keys/${KEY_ID}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("key_rotate");
    expect(entry.resourceKind).toBe("api_key");
    expect(entry.isTerminal).toBe(false);
    expect(entry.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(entry.detail).toMatchObject({ userId: USER_ID, rotatedFromId: KEY_ID });
    expect((entry.detail as Record<string, unknown>).oldKeySunsetAt).toBeTypeOf("string");
  });

  it("does NOT emit key_rotate when the key is already revoked (409, no mutation)", async () => {
    const revoked = activeKeyRow({ revoked_at: "2026-06-01T00:00:00.000Z" });
    const { app, appendAuditEntry } = makeApp([revoked]);
    const res = await app.request(`/admin/keys/${KEY_ID}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});

describe("DELETE /admin/keys/:keyId — key_revoke audit emission", () => {
  it("emits a key_revoke entry after the row is found and revoked", async () => {
    type UpdateResult = { id: string };
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    app.use("*", async (c, next) => {
      c.set("workspaceId", WORKSPACE_ID);
      c.set("apiKeyPrefix", "mk_live_");
      c.set("actorId", RAW_ACTOR_ID);
      c.set("actorType", "agent");
      c.set("userId", USER_ID);
      // SEC-1: the caller must hold every scope it mints or rotates.
      c.set("scopes", new Set(["admin:keys", "memory:read"]) as unknown as ReadonlyArray<string>);
      await next();
    });

    const fakeSql = vi.fn() as unknown as ServerDeps["metricsPgClient"];
    (fakeSql as unknown as Record<string, unknown>).array = (v: unknown) => v;
    (fakeSql as unknown as Record<string, unknown>).begin = async (
      fn: (tx: unknown) => Promise<unknown>
    ) => {
      const fakeTx = vi.fn().mockImplementation(() => {
        return Promise.resolve([{ id: KEY_ID } satisfies UpdateResult]); // RETURNING id
      });
      (fakeTx as unknown as Record<string, unknown>).array = (v: unknown) => v;
      return fn(fakeTx);
    };

    const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
    const fakeDeps = {
      metricsPgClient: fakeSql,
      storage: { appendAuditEntry } as unknown as ServerDeps["storage"],
    } as unknown as ServerDeps;
    mountKeys(app, fakeDeps);

    const res = await app.request(`/admin/keys/${KEY_ID}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const entry = firstEntry(appendAuditEntry);
    expect(entry.action).toBe("key_revoke");
    expect(entry.resourceKind).toBe("api_key");
    expect(entry.resourceId).toBe(KEY_ID);
    expect(entry.isTerminal).toBe(false);
    expect(entry.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(entry.detail).toMatchObject({ userId: USER_ID });
    expect((entry.detail as Record<string, unknown>).revokedAt).toBeTypeOf("string");
  });

  it("does NOT emit key_revoke when the key is not found (404)", async () => {
    const { app, appendAuditEntry } = makeApp([]);
    const res = await app.request(`/admin/keys/nonexistent-key`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });
});

describe("emitAudit swallow-and-log — key handlers still 2xx when the audit write rejects", () => {
  it("key_create still returns 201 when appendAuditEntry rejects", async () => {
    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    app.use("*", async (c, next) => {
      c.set("workspaceId", WORKSPACE_ID);
      c.set("apiKeyPrefix", "mk_live_");
      c.set("actorId", RAW_ACTOR_ID);
      c.set("actorType", "agent");
      c.set("userId", USER_ID);
      // SEC-1: the caller must hold every scope it mints or rotates.
      c.set("scopes", new Set(["admin:keys", "memory:read"]) as unknown as ReadonlyArray<string>);
      await next();
    });

    const fakeSql = vi.fn() as unknown as ServerDeps["metricsPgClient"];
    (fakeSql as unknown as Record<string, unknown>).array = (v: unknown) => v;
    (fakeSql as unknown as Record<string, unknown>).begin = async (
      fn: (tx: unknown) => Promise<unknown>
    ) => {
      const fakeTx = vi.fn().mockResolvedValue([]);
      (fakeTx as unknown as Record<string, unknown>).array = (v: unknown) => v;
      return fn(fakeTx);
    };

    const appendAuditEntry = vi.fn().mockRejectedValue(new Error("merkle lock failed"));
    const fakeDeps = {
      metricsPgClient: fakeSql,
      storage: { appendAuditEntry } as unknown as ServerDeps["storage"],
    } as unknown as ServerDeps;
    mountKeys(app, fakeDeps);

    const res = await app.request("/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "resilient", scopes: ["memory:read"] }),
    });
    expect(res.status).toBe(201);
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
  });
});
