import { describe, it, expect } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  buildSecureItemsEnvelope,
  openSecureItemsEnvelope,
  canonicalizeSealedItems,
  isSecureEnvelope,
  FederationVerifyError,
  FederationDecryptError,
  FEDERATION_ENVELOPE_ALG,
} from "../secureEnvelope.js";
import type { FederatedItem } from "../SyncEngine.js";

function items(): FederatedItem[] {
  return [
    {
      remoteId: "fact-1",
      version: 3,
      peerDomain: "peer.example.com",
      payload: { statement: "redis 7.0", worth: 0.8 },
    },
    {
      remoteId: "fact-2",
      version: 1,
      peerDomain: "peer.example.com",
      vectorClock: { "peer.example.com": 4 },
      deletedAt: "2026-06-10T00:00:00Z",
      payload: { statement: "postgres 16" },
    },
  ];
}

describe("secureEnvelope — P0-1 sign+seal serve / verify+open pull (§20)", () => {
  it("round-trips: serve builds a signed+sealed envelope, pull verifies+opens it", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const symmetricKey = randomBytes(32);

    const env = buildSecureItemsEnvelope(items(), "cursor-1", {
      instancePrivateKey: privateKey,
      symmetricKey,
    });

    expect(env.alg).toBe(FEDERATION_ENVELOPE_ALG);
    expect(env.signature).toBeTypeOf("string");
    // Payloads must NOT be present in cleartext on the wire.
    expect(JSON.stringify(env)).not.toContain("redis 7.0");
    expect(JSON.stringify(env)).not.toContain("postgres 16");
    // Apply-path metadata stays in cleartext (needed before decrypt).
    expect(env.items[0]!.remoteId).toBe("fact-1");
    expect(env.items[1]!.deletedAt).toBe("2026-06-10T00:00:00Z");

    const opened = openSecureItemsEnvelope(env, {
      peerSigningPublicKey: publicKey,
      symmetricKey,
    });
    expect(opened.nextCursor).toBe("cursor-1");
    expect(opened.items).toHaveLength(2);
    expect(opened.items[0]!.payload).toEqual({ statement: "redis 7.0", worth: 0.8 });
    expect(opened.items[1]!.payload).toEqual({ statement: "postgres 16" });
    expect(opened.items[1]!.vectorClock).toEqual({ "peer.example.com": 4 });
    expect(opened.items[1]!.deletedAt).toBe("2026-06-10T00:00:00Z");
  });

  it("rejects a forged/wrong signing key (MITM) — FederationVerifyError", () => {
    const serve = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    const symmetricKey = randomBytes(32);

    const env = buildSecureItemsEnvelope(items(), null, {
      instancePrivateKey: serve.privateKey,
      symmetricKey,
    });

    expect(() =>
      openSecureItemsEnvelope(env, {
        peerSigningPublicKey: attacker.publicKey, // wrong key
        symmetricKey,
      }),
    ).toThrow(FederationVerifyError);
  });

  it("rejects a tampered sealed-item list (signature no longer matches)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const symmetricKey = randomBytes(32);

    const env = buildSecureItemsEnvelope(items(), null, {
      instancePrivateKey: privateKey,
      symmetricKey,
    });

    // Tamper: flip a cleartext metadata field after signing.
    env.items[0]!.version = 999;

    expect(() =>
      openSecureItemsEnvelope(env, { peerSigningPublicKey: publicKey, symmetricKey }),
    ).toThrow(FederationVerifyError);
  });

  it("rejects when the payload was sealed with a different symmetric key — FederationDecryptError", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const serveKey = randomBytes(32);
    const wrongKey = randomBytes(32);

    const env = buildSecureItemsEnvelope(items(), null, {
      instancePrivateKey: privateKey,
      symmetricKey: serveKey,
    });

    // Signature still verifies (same signing key), but decrypt must fail on the GCM tag.
    expect(() =>
      openSecureItemsEnvelope(env, { peerSigningPublicKey: publicKey, symmetricKey: wrongKey }),
    ).toThrow(FederationDecryptError);
  });

  it("canonicalization is order-stable and omits absent optional fields", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const symmetricKey = randomBytes(32);
    const env = buildSecureItemsEnvelope(items(), null, {
      instancePrivateKey: privateKey,
      symmetricKey,
    });
    const a = canonicalizeSealedItems(env.items);
    const b = canonicalizeSealedItems(env.items);
    expect(a).toBe(b);
    // fact-1 has no deletedAt → key must not appear for it
    const firstItemJson = JSON.stringify(JSON.parse(a)[0]);
    expect(firstItemJson).not.toContain("deletedAt");
  });

  it("isSecureEnvelope discriminates secure vs legacy plaintext bodies", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const env = buildSecureItemsEnvelope(items(), null, {
      instancePrivateKey: privateKey,
      symmetricKey: randomBytes(32),
    });
    expect(isSecureEnvelope(env)).toBe(true);
    // Legacy plaintext shape
    expect(
      isSecureEnvelope({ items: [{ remoteId: "x", version: 1, peerDomain: "p", payload: {} }], nextCursor: null }),
    ).toBe(false);
    expect(isSecureEnvelope(null)).toBe(false);
    expect(isSecureEnvelope({ signature: "sig" })).toBe(false);
  });

  it("handles an empty item list (signed empty batch round-trips)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const symmetricKey = randomBytes(32);
    const env = buildSecureItemsEnvelope([], null, {
      instancePrivateKey: privateKey,
      symmetricKey,
    });
    const opened = openSecureItemsEnvelope(env, { peerSigningPublicKey: publicKey, symmetricKey });
    expect(opened.items).toEqual([]);
  });
});
