/**
 * §6 scoped-key (mk_*) auth dispatch — the auth middleware routes mk_* keys to
 * the ScopedApiKeyAdapter while leaving live mns_* keys on the bcrypt path, and
 * normalises both onto the same AuthVariables. These tests use a fake adapter so
 * no DB is needed.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import type { AuthAdapter, AuthResult } from "@mnemo-ai/types";

import { createApp } from "../app.js";
import { ScopedApiKeyAdapter } from "../auth/ScopedApiKeyAdapter.js";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";

const WS = "00000000-0000-0000-0000-000000000014";
const MNS_KEY = "mns_live_legacykey0000000000000001";
// The shape POST /admin/keys mints (generateKeySecret: prefix, "_", 32 hex),
// stored in mnemo_api_keys like any mns_* key.
const MINTED_LIVE = "mk_live_0123456789abcdef0123456789abcdef";
const MINTED_FED = "mk_fed_fedcba9876543210fedcba9876543210";

async function makeLookup(): Promise<ApiKeyLookup> {
  const row = async (id: string, key: string, scopes: string[]) => ({
    id,
    keyHash: await bcrypt.hash(key, BCRYPT_COST),
    workspaceId: WS,
    scopes,
    plan: "free",
  });
  const rows = await Promise.all([
    row("legacy-1", MNS_KEY, ["memory:read"]),
    row("mk_0000000000000001", MINTED_LIVE, ["memory:read"]),
    row("mk_fed_0000000000000002", MINTED_FED, ["memory:federation"]),
  ]);
  return {
    listActive: async () => rows,
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

function okAdapter(ctxOverride: Record<string, unknown> = {}): {
  adapter: AuthAdapter;
  authenticate: ReturnType<typeof vi.fn>;
} {
  const authenticate = vi.fn(async () => ({
    ok: true,
    context: {
      workspaceId: "00000000-0000-0000-0000-000000000014",
      actorId: "agent-mk-1",
      actorType: "agent" as const,
      scopes: ["memory:read"],
      keyType: "mk_live_",
      ...ctxOverride,
    },
  }));
  return {
    adapter: {
      id: "scoped",
      authenticate,
      authorize: async () => {},
      healthCheck: async () => ({ status: "ok", latencyMs: 0 }),
    } as unknown as AuthAdapter,
    authenticate,
  };
}

function failAdapter(code: string): AuthAdapter {
  return {
    id: "scoped",
    authenticate: async () => ({ ok: false, code, reason: `denied:${code}` }) as AuthResult,
    authorize: async () => {},
    healthCheck: async () => ({ status: "ok", latencyMs: 0 }),
  } as unknown as AuthAdapter;
}

async function build(scopedAuthAdapter?: AuthAdapter) {
  const deps = {
    // flatten-legacy-dual-core PR9b: GET /facts (list) ported off
    // deps.core.listFacts onto deps.storage.queryFactsPage (D6.3).
    storage: {
      queryFactsPage: async () => ({ items: [], nextCursor: null, total: 0 }),
    },
    apiKeys: await makeLookup(),
    scopedAuthAdapter,
    llm: undefined,
    embedModel: "text-embedding-3-small",
  } as unknown as ServerDeps;
  return createApp({ deps, version: "0.0.0-test" });
}

const MK_KEY = "mk_live_keyid001_secretsecretsecret";

describe("§6 scoped-key auth dispatch", () => {
  it("routes mk_* keys to the scoped adapter and sets AuthVariables", async () => {
    const { adapter, authenticate } = okAdapter({});
    const app = await build(adapter);
    const res = await app.request("/facts", {
      method: "GET",
      headers: { authorization: `Bearer ${MK_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(authenticate).toHaveBeenCalledOnce();
    // The adapter received the raw token.
    expect(authenticate.mock.calls[0]?.[0]).toMatchObject({ apiKey: MK_KEY });
  });

  it("maps a FORBIDDEN scoped result to 403", async () => {
    const app = await build(failAdapter("FORBIDDEN"));
    const res = await app.request("/facts", {
      method: "GET",
      headers: { authorization: `Bearer ${MK_KEY}` },
    });
    expect(res.status).toBe(403);
  });

  it("maps a REVOKED scoped result to 401", async () => {
    const app = await build(failAdapter("REVOKED"));
    const res = await app.request("/facts", {
      method: "GET",
      headers: { authorization: `Bearer ${MK_KEY}` },
    });
    expect(res.status).toBe(401);
  });

  it("emits Deprecation/Sunset headers when the scoped key is in grace", async () => {
    const sunset = "2030-01-01T00:00:00.000Z";
    const { adapter } = okAdapter({ keyDeprecation: { deprecated: true, sunset } });
    const app = await build(adapter);
    const res = await app.request("/facts", {
      method: "GET",
      headers: { authorization: `Bearer ${MK_KEY}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Sunset")).toBe(sunset);
  });

  it("leaves live mns_* keys on the bcrypt path (scoped adapter NOT called)", async () => {
    const { adapter, authenticate } = okAdapter({});
    const app = await build(adapter);
    const res = await app.request("/facts", {
      method: "GET",
      headers: { authorization: `Bearer ${MNS_KEY}` },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects mk_* keys when the scoped scheme is disabled (no adapter)", async () => {
    const app = await build(undefined);
    const res = await app.request("/facts", {
      method: "GET",
      headers: { authorization: `Bearer ${MK_KEY}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("MNEMO_SCOPED_AUTH=1 accepts the mk_* keys /admin/keys mints", () => {
  // The real adapter over an empty scoped store: a scoped-scheme key it does
  // not know is refused, and a minted key must never be handed to it.
  function realAdapter() {
    const lookup = vi.fn(async () => null);
    const adapter = new ScopedApiKeyAdapter({
      store: { lookup } as unknown as ConstructorParameters<typeof ScopedApiKeyAdapter>[0]["store"],
    });
    return { adapter, lookup };
  }

  it("a minted mk_live_ key authenticates on the bcrypt path", async () => {
    const { adapter, lookup } = realAdapter();
    const app = await build(adapter);
    const res = await app.request("/facts", {
      method: "GET",
      headers: { authorization: `Bearer ${MINTED_LIVE}` },
    });
    expect(res.status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a minted mk_fed_ key authenticates (403 on a scope it lacks, not 401)", async () => {
    const { adapter } = realAdapter();
    const app = await build(adapter);
    const res = await app.request("/facts", {
      method: "GET",
      headers: { authorization: `Bearer ${MINTED_FED}` },
    });
    expect(res.status).toBe(403);
  });

  it("a scoped-scheme key still goes to the adapter, and an unknown one is refused", async () => {
    const { adapter, lookup } = realAdapter();
    const app = await build(adapter);
    const res = await app.request("/facts", {
      method: "GET",
      headers: { authorization: `Bearer ${MK_KEY}` },
    });
    expect(res.status).toBe(401);
    expect(lookup).toHaveBeenCalledWith("mk_live_", "keyid001");
  });

  it("a minted-shape mk_* key with no row is refused", async () => {
    const { adapter } = realAdapter();
    const app = await build(adapter);
    const res = await app.request("/facts", {
      method: "GET",
      headers: { authorization: `Bearer mk_live_ffffffffffffffffffffffffffffffff` },
    });
    expect(res.status).toBe(401);
  });
});

describe("isScopedSchemeToken", () => {
  it("sends break-glass and session keys to the scoped scheme even in issued-key shape", async () => {
    const { isScopedSchemeToken } = await import("../auth.js");
    const hex = "a".repeat(32);
    expect(isScopedSchemeToken(`mk_admin_${hex}`)).toBe(true);
    expect(isScopedSchemeToken(`mk_sess_${hex}`)).toBe(true);
    expect(isScopedSchemeToken(`mk_live_${hex}`)).toBe(false);
    expect(isScopedSchemeToken(`mk_fed_${hex}`)).toBe(false);
    expect(isScopedSchemeToken(`mk_live_key1_${hex}`)).toBe(true);
  });
});

describe("triggerFor", () => {
  it("puts crypto-erasure behind the delete approval gate", async () => {
    const { triggerFor } = await import("../middleware/rbac-policy.js");
    expect(triggerFor("POST", "/admin/erasure")).toBe("delete_fact");
  });
});
