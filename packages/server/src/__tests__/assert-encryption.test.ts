// packages/server/src/__tests__/assert-encryption.test.ts
import { describe, it, expect } from "vitest";
import { assertEncryptionAvailable } from "../encryption/assertEncryption.js";

describe("assertEncryptionAvailable", () => {
  it("throws in production when MNEMO_MASTER_KEY is absent", () => {
    expect(() =>
      assertEncryptionAvailable({ NODE_ENV: "production" }),
    ).toThrowError(/MNEMO_MASTER_KEY is required/);
  });

  it("throws when MNEMO_REQUIRE_ENCRYPTION=true regardless of NODE_ENV", () => {
    expect(() =>
      assertEncryptionAvailable({ NODE_ENV: "development", MNEMO_REQUIRE_ENCRYPTION: "true" }),
    ).toThrowError(/MNEMO_MASTER_KEY is required/);
  });

  it("throws in production when the key is present but malformed (not 64 hex)", () => {
    expect(() =>
      assertEncryptionAvailable({ NODE_ENV: "production", MNEMO_MASTER_KEY: "deadbeef" }),
    ).toThrowError(/64 hex/);
  });

  it("returns 'enabled' in production when a valid 64-hex key is present", () => {
    const key = "a".repeat(64);
    expect(assertEncryptionAvailable({ NODE_ENV: "production", MNEMO_MASTER_KEY: key })).toBe("enabled");
  });

  it("returns 'disabled' (warn, no throw) in dev when the key is absent and encryption is not required", () => {
    expect(assertEncryptionAvailable({ NODE_ENV: "development" })).toBe("disabled");
  });

  it("returns 'disabled' when NODE_ENV is unset and encryption is not required", () => {
    expect(assertEncryptionAvailable({})).toBe("disabled");
  });
});
