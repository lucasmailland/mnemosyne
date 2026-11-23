/**
 * The cipher the boot hands DrizzlePeerStore for peer api_key/symmetric_key:
 * the MNEMO_MASTER_KEY key ring, bound to the peer and column context.
 */
import { describe, it, expect } from "vitest";
import { peerSecretCipherFromEnv } from "../../boot/federation.js";

const ENV = { MNEMO_MASTER_KEY: "ab".repeat(32) };

describe("peerSecretCipherFromEnv", () => {
  it("is undefined without a master key in dev", () => {
    expect(peerSecretCipherFromEnv({})).toBeUndefined();
  });

  it("round-trips a secret and never stores it in the clear", () => {
    const cipher = peerSecretCipherFromEnv(ENV)!;
    const blob = cipher.encrypt("federation-peer|acme.example|api_key", "mk_fed_fixture");
    expect(blob).not.toContain("mk_fed_fixture");
    expect(cipher.decrypt("federation-peer|acme.example|api_key", blob)).toBe("mk_fed_fixture");
  });

  it("refuses a blob moved to another peer or column", () => {
    const cipher = peerSecretCipherFromEnv(ENV)!;
    const blob = cipher.encrypt("federation-peer|acme.example|api_key", "mk_fed_fixture");
    expect(() => cipher.decrypt("federation-peer|larkspur.example|api_key", blob)).toThrow();
    expect(() => cipher.decrypt("federation-peer|acme.example|symmetric_key", blob)).toThrow();
  });

  it("refuses a blob sealed under another master key", () => {
    const blob = peerSecretCipherFromEnv(ENV)!.encrypt("ctx", "secret");
    const other = peerSecretCipherFromEnv({ MNEMO_MASTER_KEY: "cd".repeat(32) })!;
    expect(() => other.decrypt("ctx", blob)).toThrow();
  });
});
