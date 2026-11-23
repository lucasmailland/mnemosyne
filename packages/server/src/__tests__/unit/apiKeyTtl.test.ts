import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultTtlMsForKeyType, KEY_TYPE_TTL_MS } from "../../auth/rotation.js";
import { ScopedApiKeyAdapter } from "../../auth/ScopedApiKeyAdapter.js";
import { hashSecret } from "../../auth/hash.js";
import type { ApiKeyRecord, ApiKeyStore } from "@mnemo-ai/types";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── defaultTtlMsForKeyType ──────────────────────────────────────────────────

describe("defaultTtlMsForKeyType", () => {
  it("mk_live_ → 90 days", () => {
    expect(defaultTtlMsForKeyType("mk_live_")).toBe(90 * DAY_MS);
  });
  it("mk_test_ → 30 days", () => {
    expect(defaultTtlMsForKeyType("mk_test_")).toBe(30 * DAY_MS);
  });
  it("mk_fed_ → 365 days", () => {
    expect(defaultTtlMsForKeyType("mk_fed_")).toBe(365 * DAY_MS);
  });
  it("mk_admin_ → 24h (spec §3.1 ceiling)", () => {
    expect(defaultTtlMsForKeyType("mk_admin_")).toBe(24 * 3600_000);
  });
  it("unknown prefix → 90 days (safe default)", () => {
    expect(defaultTtlMsForKeyType("mk_unknown_")).toBe(90 * DAY_MS);
  });
});

// ── KEY_TYPE_TTL_MS export ──────────────────────────────────────────────────

describe("KEY_TYPE_TTL_MS (exported single source of truth)", () => {
  it("mk_admin_ entry is 24h not 90d", () => {
    expect(KEY_TYPE_TTL_MS["mk_admin_"]).toBe(24 * 3600_000);
  });
  it("mk_live_ entry is 90d", () => {
    expect(KEY_TYPE_TTL_MS["mk_live_"]).toBe(90 * DAY_MS);
  });
  it("mk_test_ entry is 30d", () => {
    expect(KEY_TYPE_TTL_MS["mk_test_"]).toBe(30 * DAY_MS);
  });
  it("mk_fed_ entry is 365d", () => {
    expect(KEY_TYPE_TTL_MS["mk_fed_"]).toBe(365 * DAY_MS);
  });
});

// ── Per-type TTL ceiling enforcement (unified ceiling in ScopedApiKeyAdapter) ──

// Helper: fake timers so wall-clock expiry never fires during ceiling tests.
// We set system time to be within the key's valid window.
afterEach(() => {
  vi.useRealTimers();
});

function makeStore(record: ApiKeyRecord): ApiKeyStore {
  return {
    lookup: vi.fn().mockResolvedValue(record),
    markUsed: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
    recentUsage: vi.fn().mockResolvedValue([]),
    deprecate: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(undefined),
    escrow: vi.fn().mockResolvedValue(undefined),
  };
}

async function makeRecord(
  prefix: string,
  ttlMs: number,
  over: Partial<ApiKeyRecord> = {},
): Promise<ApiKeyRecord> {
  const createdAt = new Date("2026-01-01T00:00:00Z");
  const expiresAt = new Date(createdAt.getTime() + ttlMs);
  return {
    keyId: "k1",
    prefix: prefix as ApiKeyRecord["prefix"],
    hashedSecret: await hashSecret("secret"),
    workspaceId: "ws-test",
    scopes: ["facts:read"],
    status: "active",
    createdAt,
    expiresAt,
    ipAllowlist: [],
    isTest: false,
    ...over,
  };
}

async function tryAuth(
  record: ApiKeyRecord,
  creds: Record<string, unknown> = {},
): Promise<{ ok: boolean; code?: string }> {
  const adapter = new ScopedApiKeyAdapter({ store: makeStore(record) });
  const result = await adapter.authenticate({
    apiKey: `${record.prefix}${record.keyId}_secret`,
    ...creds,
  });
  return result.ok
    ? { ok: true }
    : { ok: false, code: (result as { code: string }).code };
}

describe("Per-type TTL ceiling — mk_live_ (max 90d)", () => {
  it("89d TTL → accepted", async () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const ttl = 89 * DAY_MS;
    const rec = await makeRecord("mk_live_", ttl);
    // Set wall clock to within the key's valid window (day 1).
    vi.useFakeTimers({ now: createdAt.getTime() + DAY_MS });
    const r = await tryAuth(rec);
    expect(r.ok).toBe(true);
  });

  it("91d TTL → rejected FORBIDDEN (ceiling exceeded)", async () => {
    const rec = await makeRecord("mk_live_", 91 * DAY_MS);
    // Wall clock within the created window (doesn't matter — ceiling fires first).
    vi.useFakeTimers({ now: new Date("2026-01-02T00:00:00Z").getTime() });
    const r = await tryAuth(rec);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("FORBIDDEN");
  });
});

describe("Per-type TTL ceiling — mk_test_ (max 30d)", () => {
  it("29d TTL → accepted", async () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const rec = await makeRecord("mk_test_", 29 * DAY_MS, { isTest: true });
    vi.useFakeTimers({ now: createdAt.getTime() + DAY_MS });
    const r = await tryAuth(rec);
    expect(r.ok).toBe(true);
  });

  it("31d TTL → rejected FORBIDDEN", async () => {
    const rec = await makeRecord("mk_test_", 31 * DAY_MS, { isTest: true });
    vi.useFakeTimers({ now: new Date("2026-01-02T00:00:00Z").getTime() });
    const r = await tryAuth(rec);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("FORBIDDEN");
  });
});

describe("Per-type TTL ceiling — mk_fed_ (max 365d)", () => {
  it("364d TTL → accepted", async () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const rec = await makeRecord("mk_fed_", 364 * DAY_MS);
    vi.useFakeTimers({ now: createdAt.getTime() + DAY_MS });
    const r = await tryAuth(rec);
    expect(r.ok).toBe(true);
  });

  it("366d TTL → rejected FORBIDDEN", async () => {
    const rec = await makeRecord("mk_fed_", 366 * DAY_MS);
    vi.useFakeTimers({ now: new Date("2026-01-02T00:00:00Z").getTime() });
    const r = await tryAuth(rec);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("FORBIDDEN");
  });
});

describe("Per-type TTL ceiling — mk_admin_ (max 24h)", () => {
  // NOTE: mk_admin_ also requires MFA (TOTP). Ceiling tests use fake timers
  // within the key's window; we rely on the ceiling firing BEFORE the MFA check.
  it("23h TTL → rejected FORBIDDEN (MFA missing, but ceiling passes — MFA fires next)", async () => {
    // 23h TTL is within ceiling — so ceiling passes.  No MFA token → FORBIDDEN for MFA.
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const rec = await makeRecord("mk_admin_", 23 * 3600_000, {
      mfaSecret: "JBSWY3DPEHPK3PXP",
    });
    vi.useFakeTimers({ now: createdAt.getTime() + 3600_000 }); // 1h in
    const r = await tryAuth(rec); // no mfaToken → MFA check fires
    expect(r.ok).toBe(false);
    expect(r.code).toBe("FORBIDDEN");
  });

  it("25h TTL → rejected FORBIDDEN (ceiling exceeded, even with MFA)", async () => {
    const { generateTotp } = await import("@mnemo-ai/core");
    const MFA_SECRET = "JBSWY3DPEHPK3PXP";
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const rec = await makeRecord("mk_admin_", 25 * 3600_000, { mfaSecret: MFA_SECRET });
    vi.useFakeTimers({ now: createdAt.getTime() + 3600_000 });
    const r = await tryAuth(rec, { mfaToken: generateTotp(MFA_SECRET) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("FORBIDDEN");
  });
});

describe("Per-type TTL ceiling — mk_sess_ (no ceiling)", () => {
  it("mk_sess_ with expiresAt=null is not ceiling-checked", async () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const rec: ApiKeyRecord = {
      keyId: "k1",
      prefix: "mk_sess_",
      hashedSecret: await hashSecret("secret"),
      workspaceId: "ws-test",
      scopes: ["facts:read"],
      status: "active",
      createdAt,
      expiresAt: null,
      ipAllowlist: [],
      isTest: false,
    };
    vi.useFakeTimers({ now: createdAt.getTime() + DAY_MS });
    const r = await tryAuth(rec);
    expect(r.ok).toBe(true);
  });

  it("mk_sess_ with a very long TTL (999d) is not ceiling-checked", async () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const rec: ApiKeyRecord = {
      keyId: "k1",
      prefix: "mk_sess_",
      hashedSecret: await hashSecret("secret"),
      workspaceId: "ws-test",
      scopes: ["facts:read"],
      status: "active",
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 999 * DAY_MS),
      ipAllowlist: [],
      isTest: false,
    };
    vi.useFakeTimers({ now: createdAt.getTime() + DAY_MS });
    const r = await tryAuth(rec);
    expect(r.ok).toBe(true);
  });
});
