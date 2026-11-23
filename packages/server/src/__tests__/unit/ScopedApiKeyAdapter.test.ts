import { describe, it, expect, vi } from "vitest";
import { MnemoAuthError } from "../../errors.js";
import bcrypt from "bcrypt";
import { ScopedApiKeyAdapter } from "../../auth/ScopedApiKeyAdapter.js";
import type { ApiKeyRecord, ApiKeyStore } from "@mnemo-ai/types";
import { BCRYPT_COST } from "../../auth.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    keyId: "key001",
    prefix: "mk_live_",
    workspaceId: "ws-test",
    hashedSecret: "", // set per-test
    status: "active",
    scopes: ["facts:read", "facts:write"],
    ipAllowlist: [],
    expiresAt: null,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    ...overrides,
  } as ApiKeyRecord;
}

function makeStore(record: ApiKeyRecord | null = null): ApiKeyStore {
  return {
    lookup: vi.fn().mockResolvedValue(record),
    markUsed: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApiKeyStore;
}

async function hashSecret(secret: string): Promise<string> {
  return bcrypt.hash(secret, BCRYPT_COST);
}

// ── Key parsing ──────────────────────────────────────────────────────────────

describe("ScopedApiKeyAdapter — key parsing", () => {
  it("rejects a credential with no API key", async () => {
    const adapter = new ScopedApiKeyAdapter({ store: makeStore() });
    const result = await adapter.authenticate({ apiKey: undefined });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("rejects a malformed key (no underscore separator)", async () => {
    const adapter = new ScopedApiKeyAdapter({ store: makeStore() });
    const result = await adapter.authenticate({ apiKey: "mk_live_invalidsecret" });
    expect(result.ok).toBe(false);
  });

  it("rejects a key with an unknown prefix", async () => {
    const adapter = new ScopedApiKeyAdapter({ store: makeStore(null) });
    // lookup returns null → INVALID
    const result = await adapter.authenticate({ apiKey: "mk_live_key001_secret" });
    expect(result.ok).toBe(false);
  });
});

// ── Secret verification ──────────────────────────────────────────────────────

describe("ScopedApiKeyAdapter — secret verification", () => {
  it("authenticates a valid key+secret pair", async () => {
    const secret = "supersecretvalue";
    const record = makeRecord({ hashedSecret: await hashSecret(secret) });
    const store = makeStore(record);
    const adapter = new ScopedApiKeyAdapter({ store });

    const result = await adapter.authenticate({ apiKey: "mk_live_key001_supersecretvalue" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.workspaceId).toBe("ws-test");
      expect(result.context.scopes).toContain("facts:read");
    }
  });

  it("rejects the wrong secret for a valid key ID", async () => {
    const record = makeRecord({ hashedSecret: await hashSecret("correctsecret") });
    const adapter = new ScopedApiKeyAdapter({ store: makeStore(record) });

    const result = await adapter.authenticate({ apiKey: "mk_live_key001_wrongsecret" });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("INVALID");
  });

  it("rejects a revoked key", async () => {
    const secret = "s3cr3t";
    const record = makeRecord({
      hashedSecret: await hashSecret(secret),
      status: "revoked",
    });
    const adapter = new ScopedApiKeyAdapter({ store: makeStore(record) });

    const result = await adapter.authenticate({ apiKey: `mk_live_key001_${secret}` });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("REVOKED");
  });

  it("rejects an expired key", async () => {
    const secret = "s3cr3t";
    const record = makeRecord({
      hashedSecret: await hashSecret(secret),
      expiresAt: new Date("2025-01-01T00:00:00Z"), // already expired
    });
    const adapter = new ScopedApiKeyAdapter({ store: makeStore(record) });

    const result = await adapter.authenticate({ apiKey: `mk_live_key001_${secret}` });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("TOKEN_EXPIRED");
  });
});

// ── IP allowlist (CIDR matching) ─────────────────────────────────────────────

describe("ScopedApiKeyAdapter — IP allowlist", () => {
  async function adapterWithIp(
    allowlist: string[],
    clientIp: string | undefined,
    secret = "secret"
  ) {
    const record = makeRecord({
      hashedSecret: await hashSecret(secret),
      ipAllowlist: allowlist,
    });
    const adapter = new ScopedApiKeyAdapter({ store: makeStore(record) });
    return adapter.authenticate({ apiKey: `mk_live_key001_${secret}`, clientIp });
  }

  it("allows a request when no allowlist is configured", async () => {
    const result = await adapterWithIp([], "1.2.3.4");
    expect(result.ok).toBe(true);
  });

  it("allows an exact-match IP in the allowlist", async () => {
    const result = await adapterWithIp(["10.0.0.5"], "10.0.0.5");
    expect(result.ok).toBe(true);
  });

  it("rejects an IP not in the allowlist", async () => {
    const result = await adapterWithIp(["10.0.0.5"], "10.0.0.6");
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("FORBIDDEN");
  });

  it("allows an IP matching a /24 CIDR block", async () => {
    const result = await adapterWithIp(["192.168.1.0/24"], "192.168.1.99");
    expect(result.ok).toBe(true);
  });

  it("rejects an IP outside a /24 CIDR block", async () => {
    const result = await adapterWithIp(["192.168.1.0/24"], "192.168.2.1");
    expect(result.ok).toBe(false);
  });

  it("allows an IP matching a /16 CIDR block", async () => {
    const result = await adapterWithIp(["10.10.0.0/16"], "10.10.255.1");
    expect(result.ok).toBe(true);
  });

  it("rejects when clientIp is undefined and allowlist is set", async () => {
    const result = await adapterWithIp(["10.0.0.0/8"], undefined);
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("FORBIDDEN");
  });

  it("allows a /32 CIDR (single host) matching the exact IP", async () => {
    const result = await adapterWithIp(["172.16.0.1/32"], "172.16.0.1");
    expect(result.ok).toBe(true);
  });

  it("matches any IP against /0 CIDR (wildcard)", async () => {
    const result = await adapterWithIp(["0.0.0.0/0"], "8.8.8.8");
    expect(result.ok).toBe(true);
  });
});

// ── audit metadata on failure (p52-mfa-ip-denied-audit) ─────────────────────

describe("ScopedApiKeyAdapter — audit metadata on failure", () => {
  it("IP-allowlist rejection carries workspaceId, keyId, and auditAction: ip_denied", async () => {
    const secret = "s3cr3t";
    const record = makeRecord({
      hashedSecret: await hashSecret(secret),
      ipAllowlist: ["10.0.0.0/8"],
      workspaceId: "ws-ip-denied",
      keyId: "key-ip-denied",
    });
    const adapter = new ScopedApiKeyAdapter({ store: makeStore(record) });

    const result = await adapter.authenticate({
      apiKey: `mk_live_key-ip-denied_${secret}`,
      clientIp: "8.8.8.8",
    });

    expect(result.ok).toBe(false);
    const failure = result as Extract<typeof result, { ok: false }>;
    expect(failure.code).toBe("FORBIDDEN");
    expect(failure.workspaceId).toBe("ws-ip-denied");
    expect(failure.keyId).toBe("key-ip-denied");
    expect(failure.auditAction).toBe("ip_denied");
  });

  it("break-glass MFA failure carries workspaceId and keyId but no auditAction", async () => {
    const secret = "s3cr3t";
    const record = makeRecord({
      hashedSecret: await hashSecret(secret),
      prefix: "mk_admin_",
      workspaceId: "ws-mfa-fail",
      keyId: "key-mfa-fail",
      mfaSecret: "JBSWY3DPEHPK3PXP",
    });
    const adapter = new ScopedApiKeyAdapter({ store: makeStore(record) });

    const result = await adapter.authenticate({
      apiKey: `mk_admin_key-mfa-fail_${secret}`,
      // no mfaToken supplied → MFA check fails
    });

    expect(result.ok).toBe(false);
    const failure = result as Extract<typeof result, { ok: false }>;
    expect(failure.code).toBe("FORBIDDEN");
    expect(failure.workspaceId).toBe("ws-mfa-fail");
    expect(failure.keyId).toBe("key-mfa-fail");
    expect(failure.auditAction).toBeUndefined();
  });
});

// ── authorize ────────────────────────────────────────────────────────────────

describe("ScopedApiKeyAdapter — authorize", () => {
  it("allows an action included in the scopes", async () => {
    const adapter = new ScopedApiKeyAdapter({ store: makeStore() });
    const ctx = {
      workspaceId: "ws",
      actorId: "k",
      actorType: "agent" as const,
      scopes: ["facts:read"] as ReadonlyArray<string>,
      keyType: "mk_live_" as const,
    };
    await expect(
      adapter.authorize(ctx as Parameters<typeof adapter.authorize>[0], {
        action: "facts:read" as never,
      })
    ).resolves.toBeUndefined();
  });

  it("throws MnemoAuthError MNEMO_AUTH_001 for an action not in scopes", async () => {
    const adapter = new ScopedApiKeyAdapter({ store: makeStore() });
    const ctx = {
      workspaceId: "ws",
      actorId: "k",
      actorType: "agent" as const,
      scopes: ["facts:read"] as ReadonlyArray<string>,
      keyType: "mk_live_" as const,
    };
    const err = await adapter
      .authorize(ctx as Parameters<typeof adapter.authorize>[0], { action: "facts:write" as never })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MnemoAuthError);
    expect((err as MnemoAuthError).errorCode).toBe("MNEMO_AUTH_001");
  });
});
