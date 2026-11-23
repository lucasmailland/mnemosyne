// packages/server/src/__tests__/webhook-secret-cipher.test.ts
import { describe, it, expect } from "vitest";
import { KeyRingAdapter } from "../encryption/KeyRingAdapter.js";
import { createKeyRingWebhookCipher } from "../encryption/webhookSecretCipher.js";

const MASTER = "b".repeat(64); // 32-byte hex

describe("webhook secret cipher (F12)", () => {
  const keyRing = new KeyRingAdapter({ masterKeyHex: MASTER, kekVersion: 1 });
  const cipher = createKeyRingWebhookCipher(keyRing);

  it("round-trips a secret for a workspace", () => {
    const ws = "ws-1";
    const secret = "whsec_" + "f".repeat(40);
    const enc = cipher.encrypt(ws, secret);
    expect(enc).not.toContain(secret); // ciphertext must not leak plaintext
    expect(cipher.decrypt(ws, enc)).toBe(secret);
  });

  it("rejects decryption under a different workspace (AAD binding)", () => {
    const enc = cipher.encrypt("ws-1", "whsec_abc");
    expect(() => cipher.decrypt("ws-2", enc)).toThrow();
  });

  it("rejects a tampered ciphertext", () => {
    const enc = cipher.encrypt("ws-1", "whsec_abc");
    const tampered = enc.slice(0, -2) + (enc.endsWith("AA") ? "BB" : "AA");
    expect(() => cipher.decrypt("ws-1", tampered)).toThrow();
  });

  it("produces distinct ciphertexts for the same plaintext (random IV)", () => {
    const a = cipher.encrypt("ws-1", "whsec_same");
    const b = cipher.encrypt("ws-1", "whsec_same");
    expect(a).not.toBe(b);
    expect(cipher.decrypt("ws-1", a)).toBe(cipher.decrypt("ws-1", b));
  });
});
