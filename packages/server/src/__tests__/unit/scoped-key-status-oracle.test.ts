import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import bcrypt from "bcrypt";
import type { ApiKeyRecord, ApiKeyStore } from "@mnemo-ai/types";
import { BCRYPT_COST, createAuthMiddleware, type ApiKeyLookup } from "../../auth.js";
import { ScopedApiKeyAdapter } from "../../auth/ScopedApiKeyAdapter.js";
import { hashSecret } from "../../auth/hash.js";
import { toErrorBody } from "../../errors.js";
import type { ServerDeps } from "../../deps.js";

const SECRET = "correct-oracle-test-secret";
const DAY = 86_400_000;
const now = Date.now(); // determinism-ok: relative expiry/grace fixtures, not asserted
const states: {
  name: string;
  overrides: Partial<ApiKeyRecord>;
  status: number;
  reason?: string;
  clientIp?: string;
}[] = [
  { name: "active", overrides: {}, status: 200 },
  { name: "revoked", overrides: { status: "revoked" }, status: 401, reason: "Key revoked" },
  {
    name: "expired",
    overrides: { expiresAt: new Date(now - DAY) },
    status: 401,
    reason: "Key expired",
  },
  {
    name: "deprecated within grace",
    overrides: { status: "deprecated", deprecatedAt: new Date(now - DAY) },
    status: 200,
  },
  {
    name: "deprecated past sunset",
    overrides: { status: "deprecated", deprecatedAt: new Date(now - 8 * DAY) },
    status: 401,
    reason: "Deprecated key past sunset",
  },
  {
    name: "IP denied",
    overrides: { ipAllowlist: ["10.0.0.0/8"] },
    clientIp: "203.0.113.7",
    status: 403,
    reason: "IP not in allowlist",
  },
  {
    name: "IP missing",
    overrides: { ipAllowlist: ["10.0.0.0/8"] },
    status: 403,
    reason: "IP not in allowlist",
  },
  {
    name: "test/prod mismatch",
    overrides: { prefix: "mk_test_", isTest: false },
    status: 403,
    reason: "test/prod key mismatch",
  },
  {
    name: "TTL above ceiling",
    overrides: { expiresAt: new Date(now + 91 * DAY) },
    status: 403,
    reason: "Key TTL exceeds mk_live_ maximum",
  },
  {
    name: "break-glass without MFA",
    overrides: { prefix: "mk_admin_", mfaSecret: "JBSWY3DPEHPK3PXP" },
    status: 403,
    reason: "Break-glass MFA required",
  },
];

function record(hashedSecret: string, overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    keyId: "oracle-key",
    prefix: "mk_live_",
    workspaceId: "00000000-0000-0000-0000-000000000077",
    scopes: ["memory:read"],
    status: "active",
    hashedSecret,
    createdAt: new Date(now),
    expiresAt: null,
    ...overrides,
  };
}

function setup(key: ApiKeyRecord | null) {
  const store = {
    lookup: vi.fn().mockResolvedValue(key),
    markUsed: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
    recentUsage: vi.fn().mockResolvedValue([]),
    deprecate: vi.fn(),
    insert: vi.fn(),
    escrow: vi.fn().mockResolvedValue(undefined),
  } satisfies ApiKeyStore;
  const appendAuditEntry = vi.fn().mockResolvedValue(undefined);
  const app = new Hono();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  app.use(
    "*",
    createAuthMiddleware(
      { listActive: async () => [], touch: async () => {} } as unknown as ApiKeyLookup,
      { storage: { appendAuditEntry } as unknown as ServerDeps["storage"] },
      new ScopedApiKeyAdapter({ store, anomalyDetection: true })
    )
  );
  app.get("/probe", (c) => c.json({ ok: true }));
  return {
    store,
    appendAuditEntry,
    request: (secret: string, clientIp?: string) =>
      app.request("/probe", {
        headers: {
          authorization: `Bearer ${key?.prefix ?? "mk_live_"}oracle-key_${secret}`,
          ...(clientIp ? { "x-real-ip": clientIp } : {}),
        },
      }),
  };
}

async function expectGeneric401(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: {
      type: "authentication_error",
      code: "unauthorized",
      message: "Invalid API key",
      retryable: false,
    },
  });
}

describe.each(["argon2id", "bcrypt"] as const)("P77 — %s secret verification", (algorithm) => {
  let hashedSecret: string;
  beforeAll(async () => {
    hashedSecret =
      algorithm === "argon2id" ? await hashSecret(SECRET) : await bcrypt.hash(SECRET, BCRYPT_COST);
  });

  it.each(states)("FM-P77-01: wrong secret hides $name and writes nothing", async (state) => {
    const { request, store, appendAuditEntry } = setup(record(hashedSecret, state.overrides));
    const response = await request("wrong-secret", state.clientIp);
    expect(store.escrow).not.toHaveBeenCalled();
    expect(appendAuditEntry).not.toHaveBeenCalled();
    expect(store.markUsed).not.toHaveBeenCalled();
    expect(store.recentUsage).not.toHaveBeenCalled();
    expect(store.revoke).not.toHaveBeenCalled();
    await expectGeneric401(response);
  });

  it("FM-P77-01: nonexistent key has the same generic 401 and no audit", async () => {
    const { request, store, appendAuditEntry } = setup(null);
    await expectGeneric401(await request("wrong-secret"));
    expect(store.escrow).not.toHaveBeenCalled();
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it.each(states)("FM-P77-02: correct secret preserves $name behavior", async (state) => {
    const { request, store, appendAuditEntry } = setup(record(hashedSecret, state.overrides));
    const response = await request(SECRET, state.clientIp);
    expect(response.status).toBe(state.status);
    if (state.reason) expect(await response.json()).toHaveProperty("error.message", state.reason);
    else expect(await response.json()).toEqual({ ok: true });
    expect(store.escrow).toHaveBeenCalledTimes(state.name === "revoked" ? 1 : 0);
    expect(appendAuditEntry).toHaveBeenCalledTimes(state.reason === "IP not in allowlist" ? 1 : 0);
    if (state.reason === "IP not in allowlist") {
      expect(appendAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ip_denied" })
      );
    }
  });
});

it.each(["active", "revoked"] as const)(
  "FM-P77-03: invalid hash hides %s state",
  async (status) => {
    const { request, store, appendAuditEntry } = setup(record("invalid-hash", { status }));
    await expectGeneric401(await request(SECRET));
    expect(store.escrow).not.toHaveBeenCalled();
    expect(appendAuditEntry).not.toHaveBeenCalled();
  }
);
