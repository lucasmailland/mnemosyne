import { describe, it, expect, vi, afterEach } from "vitest";
import { ScopedApiKeyAdapter } from "../../auth/ScopedApiKeyAdapter.js";
import { hashSecret } from "../../auth/hash.js";
import { generateTotp } from "@mnemo-ai/core";
import type { ApiKeyRecord, ApiKeyStore } from "@mnemo-ai/types";

const MFA_SECRET = "JBSWY3DPEHPK3PXP";

async function adminRecord(over: Partial<ApiKeyRecord> = {}): Promise<ApiKeyRecord> {
  const createdAt = new Date("2026-06-16T00:00:00Z");
  return {
    keyId: "admin1",
    prefix: "mk_admin_",
    hashedSecret: await hashSecret("topsecret"),
    workspaceId: "11111111-1111-1111-1111-111111111111",
    scopes: ["memory:admin"],
    status: "active",
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 24 * 3600_000), // exactly 24h
    mfaSecret: MFA_SECRET,
    ...over,
  };
}

function storeOf(rec: ApiKeyRecord): ApiKeyStore {
  return {
    lookup: vi.fn().mockResolvedValue(rec),
    markUsed: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
    recentUsage: vi.fn().mockResolvedValue([]),
    deprecate: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    escrow: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ScopedApiKeyAdapter — break-glass (mk_admin_)", () => {
  it("rejects an admin key with no MFA token", async () => {
    const rec = await adminRecord();
    // Freeze time within the key's valid window (TTL ceiling passes, MFA fires).
    vi.useFakeTimers({ now: rec.createdAt.getTime() + 3600_000 }); // 1h in
    const a = new ScopedApiKeyAdapter({ store: storeOf(rec) });
    const r = await a.authenticate({ apiKey: "mk_admin_admin1_topsecret", clientIp: "10.0.0.1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("FORBIDDEN");
  });

  it("accepts an admin key with a valid TOTP", async () => {
    const rec = await adminRecord();
    // Freeze time within the key's valid window so wall-clock expiry doesn't fire.
    vi.useFakeTimers({ now: rec.createdAt.getTime() + 3600_000 }); // 1h in
    const a = new ScopedApiKeyAdapter({ store: storeOf(rec) });
    const r = await a.authenticate({
      apiKey: "mk_admin_admin1_topsecret",
      clientIp: "10.0.0.1",
      mfaToken: generateTotp(MFA_SECRET),
    });
    expect(r.ok).toBe(true);
  });

  it("rejects an admin key whose TTL exceeds 24h (§3.1)", async () => {
    const createdAt = new Date("2026-06-16T00:00:00Z");
    const rec = await adminRecord({
      expiresAt: new Date(createdAt.getTime() + 48 * 3600_000), // 48h — too long
    });
    // Even with time frozen within the window, the ceiling check rejects it.
    vi.useFakeTimers({ now: createdAt.getTime() + 3600_000 });
    const a = new ScopedApiKeyAdapter({ store: storeOf(rec) });
    const r = await a.authenticate({
      apiKey: "mk_admin_admin1_topsecret",
      clientIp: "10.0.0.1",
      mfaToken: generateTotp(MFA_SECRET),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("FORBIDDEN");
  });
});
