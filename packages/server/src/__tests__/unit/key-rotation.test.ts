import { describe, it, expect, vi } from "vitest";
import { rotateKey } from "../../auth/rotation.js";
import type { ApiKeyRecord, ApiKeyStore } from "@mnemo-ai/types";

function rec(): ApiKeyRecord {
  return {
    keyId: "old1",
    prefix: "mk_live_",
    hashedSecret: "$argon2id$stub",
    workspaceId: "11111111-1111-1111-1111-111111111111",
    scopes: ["memory:read", "memory:write"],
    status: "active",
    createdAt: new Date("2026-03-01T00:00:00Z"),
    expiresAt: null,
  };
}

describe("rotateKey", () => {
  it("inserts a new key, deprecates the old one with a 7-day sunset, and escrows", async () => {
    const old = rec();
    const calls: string[] = [];
    const store: ApiKeyStore = {
      lookup: vi.fn().mockResolvedValue(old),
      markUsed: vi.fn(),
      revoke: vi.fn(),
      recentUsage: vi.fn(),
      deprecate: vi.fn(async () => void calls.push("deprecate")),
      insert: vi.fn(async () => void calls.push("insert")),
      escrow: vi.fn(async () => void calls.push("escrow")),
    };
    const now = new Date("2026-06-16T00:00:00Z");
    const result = await rotateKey(store, "mk_live_", "old1", { now, reason: "scheduled" });

    expect(result.newKey.startsWith("mk_live_")).toBe(true);
    expect(result.newKeyId).not.toBe("old1");
    // sunset = now + 7 days
    expect(result.sunset).toBe(new Date(now.getTime() + 7 * 86_400_000).toISOString());
    // insert the new key BEFORE deprecating the old (overlap window safety)
    expect(calls).toEqual(["insert", "deprecate", "escrow"]);
  });

  it("carries the old grant forward: TOTP secret, user, ceiling and the key's own lifetime", async () => {
    const old: ApiKeyRecord = {
      ...rec(),
      prefix: "mk_admin_",
      createdAt: new Date("2026-06-15T12:00:00Z"),
      expiresAt: new Date("2026-06-15T20:00:00Z"), // an 8-hour key
      mfaSecret: "JBSWY3DPEHPK3PXP",
      userId: "user-a",
      maxSensitivity: "internal",
    };
    const insert = vi.fn(async () => {});
    const store: ApiKeyStore = {
      lookup: vi.fn().mockResolvedValue(old),
      markUsed: vi.fn(),
      revoke: vi.fn(),
      recentUsage: vi.fn(),
      deprecate: vi.fn(async () => {}),
      insert,
      escrow: vi.fn(async () => {}),
    };
    const now = new Date("2026-06-15T13:00:00Z");
    await rotateKey(store, "mk_admin_", "old1", { now, reason: "manual" });

    const inserted = (insert.mock.calls[0] as unknown as [ApiKeyRecord])[0];
    expect(inserted).toMatchObject({
      prefix: "mk_admin_",
      mfaSecret: "JBSWY3DPEHPK3PXP",
      userId: "user-a",
      maxSensitivity: "internal",
      isTest: false,
      rotatedFromId: "old1",
    });
    expect(inserted.expiresAt?.toISOString()).toBe("2026-06-15T21:00:00.000Z");
  });
});
