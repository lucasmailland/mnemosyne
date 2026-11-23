import { describe, it, expect } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  parseEd25519PrivateKey,
  parseEd25519PublicKey,
  parseSymmetricKey,
  signPayload,
  verifyPayload,
} from "../crypto.js";

describe("crypto key-material parsing (boot config → KeyObject/Buffer)", () => {
  it("parses an Ed25519 private key from PEM and produces a verifiable signature", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

    const parsedPriv = parseEd25519PrivateKey(privPem);
    const sig = signPayload("hello", parsedPriv);
    expect(verifyPayload("hello", sig, publicKey)).toBe(true);
  });

  it("parses an Ed25519 public key from PEM and verifies a signature", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    const parsedPub = parseEd25519PublicKey(pubPem);
    const sig = signPayload("hello", privateKey);
    expect(verifyPayload("hello", sig, parsedPub)).toBe(true);
  });

  it("parses keys from raw base64-DER (no PEM headers)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const privDerB64 = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");
    const pubDerB64 = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");

    const parsedPriv = parseEd25519PrivateKey(privDerB64);
    const parsedPub = parseEd25519PublicKey(pubDerB64);
    const sig = signPayload("body", parsedPriv);
    expect(verifyPayload("body", sig, parsedPub)).toBe(true);
  });

  it("parses a 32-byte base64 symmetric key", () => {
    const raw = randomBytes(32);
    const parsed = parseSymmetricKey(raw.toString("base64"));
    expect(parsed.equals(raw)).toBe(true);
  });

  it("rejects a symmetric key that is not 32 bytes", () => {
    expect(() => parseSymmetricKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
