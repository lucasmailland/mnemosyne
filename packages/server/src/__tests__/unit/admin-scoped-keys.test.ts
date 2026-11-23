/**
 * POST/DELETE /admin/scoped-keys: the server issues, rotates and revokes the
 * scoped-scheme keys MNEMO_SCOPED_AUTH=1 verifies. The app runs with the real
 * ScopedApiKeyAdapter over an in-memory ApiKeyStore, so an issued key goes
 * through the same verification as in production (argon2id, TOTP, sunset).
 * The Postgres version, under a NOSUPERUSER role, is
 * integration/scoped-key-issuance.integration.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import { generateTotp } from "@mnemo-ai/core";
import type { ApiKeyRecord, ApiKeyStore, ApiKeyType } from "@mnemo-ai/types";

import { createApp } from "../../app.js";
import { BCRYPT_COST } from "../../auth.js";
import type { ApiKeyLookup } from "../../auth.js";
import { ScopedApiKeyAdapter } from "../../auth/ScopedApiKeyAdapter.js";
import type { ServerDeps } from "../../deps.js";

const WS = "00000000-0000-4000-8000-0000000000c5";
const OTHER_WS = "00000000-0000-4000-8000-0000000000c6";
// A user-bound owner key, a workspace key with the same scopes and no user,
// and a narrow key.
const OWNER = "mns_live_scopedissueowner000000001";
const NO_USER = "mns_live_scopedissuenouser00000002";
const NARROW = "mns_live_scopedissuenarrow00000003";
const OWNER_SCOPES = ["memory:read", "memory:write", "admin:keys"];

function memoryStore(): ApiKeyStore & { rows: Map<string, ApiKeyRecord> } {
  const rows = new Map<string, ApiKeyRecord>();
  return {
    rows,
    lookup: async (prefix: ApiKeyType, keyId: string) => {
      const r = rows.get(keyId);
      return r && r.prefix === prefix ? { ...r } : null;
    },
    markUsed: async () => {},
    revoke: async (keyId) => {
      rows.get(keyId)!.status = "revoked";
    },
    recentUsage: async () => [],
    deprecate: async (keyId, at) => {
      Object.assign(rows.get(keyId)!, { status: "deprecated", deprecatedAt: at });
    },
    insert: async (record) => {
      rows.set(record.keyId, { ...record });
    },
    escrow: async () => {},
  };
}

async function build() {
  const row = async (id: string, key: string, scopes: string[], userId: string | null) => ({
    id,
    keyHash: await bcrypt.hash(key, BCRYPT_COST),
    workspaceId: WS,
    scopes,
    plan: "free",
    userId,
  });
  const rows = await Promise.all([
    row("key_owner", OWNER, OWNER_SCOPES, "user-a"),
    row("key_nouser", NO_USER, OWNER_SCOPES, null),
    row("key_narrow", NARROW, ["memory:read", "admin:keys"], "user-n"),
  ]);
  const apiKeys = {
    listActive: async () => rows,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const store = memoryStore();
  const audit = vi.fn(async () => {});
  const deps = {
    storage: { appendAuditEntry: audit },
    apiKeys,
    scopedAuthAdapter: new ScopedApiKeyAdapter({ store }),
    scopedKeyStore: store,
    llm: undefined,
    embedModel: "text-embedding-3-small",
  } as unknown as ServerDeps;
  return { app: createApp({ deps, version: "0.0.0-test" }), store, audit };
}

type App = Awaited<ReturnType<typeof build>>["app"];

function call(app: App, method: string, path: string, key: string, body?: object, mfa?: string) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(mfa ? { "x-mnemo-mfa": mfa } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function issue(app: App, key: string, body: object) {
  const res = await call(app, "POST", "/admin/scoped-keys", key, body);
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /admin/scoped-keys", () => {
  it("issues an mk_live_ key that authenticates through the scoped adapter, bound to its issuer", async () => {
    const { app, store, audit } = await build();
    const { status, body } = await issue(app, OWNER, { scopes: ["memory:read"] });
    expect(status).toBe(201);
    expect(body.key).toMatch(/^mk_live_[0-9A-Za-z]{12}_[0-9A-Za-z]{43}$/);
    expect(body.key.startsWith(`${body.id}_`)).toBe(true);
    expect(body.mfaSecret).toBeUndefined();

    const row = [...store.rows.values()][0]!;
    expect(row.hashedSecret.startsWith("$argon2id$")).toBe(true);
    expect(row.userId).toBe("user-a");
    expect(row.expiresAt!.getTime() - row.createdAt.getTime()).toBe(90 * 86_400_000);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "key_create", resourceId: body.id })
    );

    const me = await call(app, "GET", "/me", body.key);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { scopes: string[] }).scopes).toEqual(["memory:read"]);
    // The key holds memory:read only.
    expect(
      (await call(app, "POST", "/admin/scoped-keys", body.key, { scopes: ["memory:read"] })).status
    ).toBe(403);
  });

  it("grants no scope, ceiling or lifetime beyond the rules", async () => {
    const { app, store } = await build();
    expect((await issue(app, NARROW, { scopes: ["memory:read", "memory:write"] })).status).toBe(
      403
    );
    expect((await issue(app, OWNER, { scopes: ["memory:read", "*"] })).status).toBe(400);
    expect(
      (await issue(app, OWNER, { type: "sess", scopes: ["memory:read"], expiresIn: "25h" })).status
    ).toBe(400);
    expect(
      (await issue(app, OWNER, { type: "admin", scopes: ["memory:read"], expiresIn: "2d" })).status
    ).toBe(400);
    expect(store.rows.size).toBe(0);
    const sess = await issue(app, OWNER, {
      type: "sess",
      scopes: ["memory:read"],
      expiresIn: "2h",
    });
    expect(sess.status).toBe(201);
    expect(sess.body.key.startsWith("mk_sess_")).toBe(true);
  });

  it("an mk_admin_ key returns its TOTP secret once and refuses a request without the right code", async () => {
    const { app, store } = await build();
    const { status, body } = await issue(app, OWNER, { type: "admin", scopes: ["memory:read"] });
    expect(status).toBe(201);
    expect(body.mfaSecret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauthUri).toContain(`secret=${body.mfaSecret}`);
    const row = [...store.rows.values()][0]!;
    expect(row.mfaSecret).toBe(body.mfaSecret);
    expect(row.userId).toBe("user-a");
    expect(row.expiresAt!.getTime() - row.createdAt.getTime()).toBe(24 * 3_600_000);

    expect((await call(app, "GET", "/me", body.key)).status).toBe(403);
    const good = generateTotp(body.mfaSecret!);
    const wrong = good === "000000" ? "111111" : "000000";
    expect((await call(app, "GET", "/me", body.key, undefined, wrong)).status).toBe(403);
    expect((await call(app, "GET", "/me", body.key, undefined, good)).status).toBe(200);
  });

  it("refuses an mk_admin_ key to a caller with no user: nobody could pass the two-person gate with it", async () => {
    const { app, store } = await build();
    const res = await issue(app, NO_USER, { type: "admin", scopes: ["memory:read"] });
    expect(res.status).toBe(403);
    expect(store.rows.size).toBe(0);
  });
});

describe("rotate and revoke", () => {
  it("a rotated key keeps its grace period and stops past the sunset; a revoked one stops at once", async () => {
    const { app } = await build();
    const old = (await issue(app, OWNER, { scopes: ["memory:read"] })).body;

    const rot = await call(app, "POST", `/admin/scoped-keys/${old.id}/rotate`, OWNER, {});
    expect(rot.status).toBe(201);
    const rotated = (await rot.json()) as { newKey: string; newId: string; oldKeySunsetAt: string };
    expect(rotated.newId).not.toBe(old.id);
    expect((await call(app, "GET", "/me", rotated.newKey)).status).toBe(200);
    const inGrace = await call(app, "GET", "/me", old.key);
    expect(inGrace.status).toBe(200);
    expect(inGrace.headers.get("Sunset")).toBe(rotated.oldKeySunsetAt);
    // A rotated key cannot be rotated again.
    expect((await call(app, "POST", `/admin/scoped-keys/${old.id}/rotate`, OWNER, {})).status).toBe(
      409
    );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(rotated.oldKeySunsetAt) + 1000);
    expect((await call(app, "GET", "/me", old.key)).status).toBe(401);
    expect((await call(app, "GET", "/me", rotated.newKey)).status).toBe(200);
    vi.useRealTimers();

    const del = await call(app, "DELETE", `/admin/scoped-keys/${rotated.newId}`, OWNER);
    expect(del.status).toBe(200);
    expect((await call(app, "GET", "/me", rotated.newKey)).status).toBe(401);
    expect((await call(app, "DELETE", `/admin/scoped-keys/${rotated.newId}`, OWNER)).status).toBe(
      404
    );
  });

  it("a rotated mk_admin_ key keeps its TOTP secret, and only its own user may rotate it", async () => {
    const { app, store } = await build();
    const admin = (await issue(app, OWNER, { type: "admin", scopes: ["memory:read"] })).body;
    expect(
      (await call(app, "POST", `/admin/scoped-keys/${admin.id}/rotate`, NARROW, {})).status
    ).toBe(403);
    const rot = await call(app, "POST", `/admin/scoped-keys/${admin.id}/rotate`, OWNER, {});
    expect(rot.status).toBe(201);
    const { newKey } = (await rot.json()) as { newKey: string };
    expect([...store.rows.values()].every((r) => r.mfaSecret === admin.mfaSecret)).toBe(true);
    expect((await call(app, "GET", "/me", newKey)).status).toBe(403);
    expect(
      (await call(app, "GET", "/me", newKey, undefined, generateTotp(admin.mfaSecret!))).status
    ).toBe(200);
  });

  it("a narrow caller cannot rotate a broader key into a fresh secret", async () => {
    const { app } = await build();
    const broad = (await issue(app, OWNER, { scopes: ["memory:read", "memory:write"] })).body;
    expect(
      (await call(app, "POST", `/admin/scoped-keys/${broad.id}/rotate`, NARROW, {})).status
    ).toBe(403);
  });

  it("a key of another workspace, or a malformed id, is not found", async () => {
    const { app, store } = await build();
    store.rows.set("foreignKey01", {
      keyId: "foreignKey01",
      prefix: "mk_live_",
      hashedSecret: "$argon2id$x",
      workspaceId: OTHER_WS,
      scopes: ["memory:read"],
      status: "active",
      expiresAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(
      (await call(app, "DELETE", "/admin/scoped-keys/mk_live_foreignKey01", OWNER)).status
    ).toBe(404);
    expect(
      (await call(app, "POST", "/admin/scoped-keys/mk_live_foreignKey01/rotate", OWNER, {})).status
    ).toBe(404);
    expect((await call(app, "DELETE", "/admin/scoped-keys/mns_live_whatever", OWNER)).status).toBe(
      404
    );
    expect(store.rows.get("foreignKey01")!.status).toBe("active");
  });
});
