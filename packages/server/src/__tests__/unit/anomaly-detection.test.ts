import { describe, it, expect, vi } from "vitest";
import { ScopedApiKeyAdapter } from "../../auth/ScopedApiKeyAdapter.js";
import { hashSecret } from "../../auth/hash.js";
import type { ApiKeyRecord, ApiKeyStore, KeyUsageEvent } from "@mnemo-ai/types";

async function liveRecord(): Promise<ApiKeyRecord> {
  return {
    keyId: "live1",
    prefix: "mk_live_",
    hashedSecret: await hashSecret("secretpart"),
    workspaceId: "11111111-1111-1111-1111-111111111111",
    scopes: ["memory:read"],
    status: "active",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    expiresAt: null,
  };
}

describe("ScopedApiKeyAdapter — anomaly forced rotation", () => {
  it("revokes the key and rejects when the IP is brand new", async () => {
    const rec = await liveRecord();
    const history: KeyUsageEvent[] = [
      { ipAddress: "10.0.0.1", at: new Date("2026-06-15T00:00:00Z") },
    ];
    const revoke = vi.fn().mockResolvedValue(undefined);
    const store: ApiKeyStore = {
      lookup: vi.fn().mockResolvedValue(rec),
      markUsed: vi.fn().mockResolvedValue(undefined),
      revoke,
      recentUsage: vi.fn().mockResolvedValue(history),
      deprecate: vi.fn(),
      insert: vi.fn(),
      escrow: vi.fn().mockResolvedValue(undefined),
    };
    const a = new ScopedApiKeyAdapter({ store, anomalyDetection: true });
    const r = await a.authenticate({ apiKey: "mk_live_live1_secretpart", clientIp: "203.0.113.9" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("REVOKED");
    expect(revoke).toHaveBeenCalledWith("live1", expect.stringContaining("anomaly"));
  });
});
