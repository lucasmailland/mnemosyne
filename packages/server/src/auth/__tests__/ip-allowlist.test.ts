/**
 * IP allowlist tests for ScopedApiKeyAdapter (spec §5 Redis key isolation,
 * SECURITY.md §2.2, SEC-03 fix).
 *
 * Verifies:
 *   1. IPv4 allowlist enforces — request from outside CIDR → blocked
 *   2. IPv6 client against an IPv6 allowlist entry PASSES (the old IPv4-only
 *      matcher would have rejected it)
 *   3. Empty allowlist → no IP check (any IP passes)
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { ScopedApiKeyAdapter } from "../ScopedApiKeyAdapter.js";
import type { ApiKeyRecord, ApiKeyStore } from "@mnemo-ai/types";
import { BCRYPT_COST } from "../../auth.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const SECRET = "test_secret_value";
const KEY_RAW = `mk_live_key001_${SECRET}`;

function makeStore(record: ApiKeyRecord | null): ApiKeyStore {
  return {
    lookup: vi.fn().mockResolvedValue(record),
    markUsed: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApiKeyStore;
}

async function makeRecord(overrides: Partial<ApiKeyRecord> = {}): Promise<ApiKeyRecord> {
  return {
    keyId: "key001",
    prefix: "mk_live_",
    workspaceId: "ws-test",
    hashedSecret: await bcrypt.hash(SECRET, BCRYPT_COST),
    status: "active",
    scopes: ["memory:read"],
    ipAllowlist: [],
    expiresAt: null,
    createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    ...overrides,
  } as ApiKeyRecord;
}

async function authenticate(
  allowlist: string[],
  clientIp: string | undefined
): Promise<Awaited<ReturnType<ScopedApiKeyAdapter["authenticate"]>>> {
  const record = await makeRecord({ ipAllowlist: allowlist });
  const adapter = new ScopedApiKeyAdapter({ store: makeStore(record) });
  return adapter.authenticate({ apiKey: KEY_RAW, clientIp });
}

// ── 1. IPv4 allowlist enforcement ────────────────────────────────────────────

describe("IP allowlist — IPv4 CIDR enforcement", () => {
  it("blocks a request from an IP outside the CIDR", async () => {
    const result = await authenticate(["10.0.0.0/24"], "10.0.1.1");
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("FORBIDDEN");
  });

  it("allows a request from an IP inside the CIDR", async () => {
    const result = await authenticate(["10.0.0.0/24"], "10.0.0.42");
    expect(result.ok).toBe(true);
  });

  it("blocks when clientIp is absent and allowlist is non-empty", async () => {
    const result = await authenticate(["10.0.0.0/24"], undefined);
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("FORBIDDEN");
  });
});

// ── 2. IPv6 allowlist support ────────────────────────────────────────────────

describe("IP allowlist — IPv6 client against IPv6 entry", () => {
  it("allows an IPv6 client that matches an IPv6 CIDR entry", async () => {
    // 2001:db8::/32 is a documentation prefix; 2001:db8::1 is inside it
    const result = await authenticate(["2001:db8::/32"], "2001:db8::1");
    expect(result.ok).toBe(true);
  });

  it("blocks an IPv6 client outside the IPv6 CIDR", async () => {
    // 2001:db9::1 is outside 2001:db8::/32
    const result = await authenticate(["2001:db8::/32"], "2001:db9::1");
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe("FORBIDDEN");
  });
});

// ── 3. Empty allowlist → no IP check ────────────────────────────────────────

describe("IP allowlist — empty allowlist skips IP check", () => {
  it("allows any IP when allowlist is empty", async () => {
    const result = await authenticate([], "203.0.113.1");
    expect(result.ok).toBe(true);
  });

  it("allows an IPv6 client when allowlist is empty", async () => {
    const result = await authenticate([], "2001:db8::dead:beef");
    expect(result.ok).toBe(true);
  });

  it("allows even when clientIp is undefined and allowlist is empty", async () => {
    const result = await authenticate([], undefined);
    expect(result.ok).toBe(true);
  });
});
