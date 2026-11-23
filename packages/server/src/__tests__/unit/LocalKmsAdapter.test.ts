import { describe, it, expect } from "vitest";
import { LocalKmsAdapter } from "../../encryption/LocalKmsAdapter.js";

// A deterministic 32-byte hex key for tests — never use in production.
const TEST_KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

function makeAdapter(key = TEST_KEY): LocalKmsAdapter {
  return new LocalKmsAdapter({ masterKeyHex: key });
}

describe("LocalKmsAdapter", () => {
  // ── Constructor validation ──────────────────────────────────────────────────

  it("rejects a key shorter than 64 hex chars", () => {
    expect(() => new LocalKmsAdapter({ masterKeyHex: "abc" })).toThrow(
      "64 hex characters",
    );
  });

  it("rejects an empty master key", () => {
    expect(() => new LocalKmsAdapter({ masterKeyHex: "" })).toThrow();
  });

  // ── Basic encrypt / decrypt round-trip ─────────────────────────────────────

  it("round-trips a plaintext string", () => {
    const adapter = makeAdapter();
    const plaintext = "The capital of France is Paris.";
    const blob = adapter.encrypt(plaintext);
    expect(adapter.decrypt(blob)).toBe(plaintext);
  });

  it("produces a different blob each call (fresh IV per encrypt)", () => {
    const adapter = makeAdapter();
    const a = adapter.encrypt("same");
    const b = adapter.encrypt("same");
    expect(a).not.toBe(b);
  });

  it("round-trips an empty string", () => {
    const adapter = makeAdapter();
    expect(adapter.decrypt(adapter.encrypt(""))).toBe("");
  });

  it("round-trips a multi-line unicode string", () => {
    const adapter = makeAdapter();
    const payload = "Héllo\nWörld\n🔑";
    expect(adapter.decrypt(adapter.encrypt(payload))).toBe(payload);
  });

  // ── Authentication tag verification ────────────────────────────────────────

  it("throws on tampered ciphertext (GCM auth tag mismatch)", () => {
    const adapter = makeAdapter();
    const blob = adapter.encrypt("secret");
    // Flip one base64url char (checked at the SAME index we replace, so the
    // substitution is always a real change — never a no-op) → GCM auth-tag mismatch.
    const i = blob.length - 4;
    const tampered = blob.slice(0, i) + (blob[i] === "A" ? "B" : "A") + blob.slice(i + 1);
    expect(() => adapter.decrypt(tampered)).toThrow();
  });

  it("throws when decrypting with the wrong key", () => {
    const enc = makeAdapter(TEST_KEY);
    const dec = makeAdapter(OTHER_KEY);
    expect(() => dec.decrypt(enc.encrypt("secret"))).toThrow();
  });

  it("throws if the blob is too short to contain iv + authTag", () => {
    const adapter = makeAdapter();
    // base64url of 10 bytes (< 12 iv + 16 tag = 28)
    const short = Buffer.alloc(10).toString("base64url");
    expect(() => adapter.decrypt(short)).toThrow("too short");
  });

  // ── AAD context binding ─────────────────────────────────────────────────────

  it("round-trips with a context string", () => {
    const adapter = makeAdapter();
    const blob = adapter.encryptWithContext("ws-secret", "workspace-abc");
    expect(adapter.decryptWithContext(blob, "workspace-abc")).toBe("ws-secret");
  });

  it("rejects decryption with a different context (AAD mismatch)", () => {
    const adapter = makeAdapter();
    const blob = adapter.encryptWithContext("ws-secret", "workspace-abc");
    expect(() => adapter.decryptWithContext(blob, "workspace-XYZ")).toThrow();
  });

  it("rejects context blob decrypted without context", () => {
    const adapter = makeAdapter();
    const blob = adapter.encryptWithContext("ws-secret", "ctx");
    // decrypt() doesn't set AAD — GCM tag verification will fail
    expect(() => adapter.decrypt(blob)).toThrow();
  });
});
