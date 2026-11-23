import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { signPayload, verifyPayload, sealItem, openItem } from "../crypto.js";

describe("federation crypto — §20 Ed25519 + AES-256-GCM (lines 1579–1587)", () => {
  it("signs a payload and verifies with the matching public key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const body = JSON.stringify({ facts: [{ id: "f1" }], cursor: "c1" });
    const sig = signPayload(body, privateKey);
    expect(verifyPayload(body, sig, publicKey)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const sig = signPayload("original", privateKey);
    expect(verifyPayload("tampered", sig, publicKey)).toBe(false);
  });

  it("rejects a payload signed by a different key (MITM)", () => {
    const a = generateKeyPairSync("ed25519");
    const b = generateKeyPairSync("ed25519");
    const sig = signPayload("body", a.privateKey);
    expect(verifyPayload("body", sig, b.publicKey)).toBe(false);
  });

  it("AES-256-GCM round-trips an item; a bad key/tag throws on open", () => {
    const key = Buffer.alloc(32, 7);
    const sealed = sealItem({ statement: "redis 7.0" }, key);
    expect(openItem(sealed, key)).toEqual({ statement: "redis 7.0" });
    const wrong = Buffer.alloc(32, 9);
    expect(() => openItem(sealed, wrong)).toThrow();
  });
});
