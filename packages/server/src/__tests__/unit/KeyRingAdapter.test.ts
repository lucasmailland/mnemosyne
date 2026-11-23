import { describe, it, expect } from "vitest";
import { KeyRingAdapter } from "../../encryption/KeyRingAdapter.js";

const MASTER = "a".repeat(64); // 32 bytes as hex

describe("KeyRingAdapter — encryptSecret / decryptSecret", () => {
  it("round-trips a secret with a given context", () => {
    const k = new KeyRingAdapter({ masterKeyHex: MASTER, kekVersion: 1 });
    const blob = k.encryptSecret("ws-1", "llm-config", "sk-test-abc123");
    const plain = k.decryptSecret("ws-1", "llm-config", blob);
    expect(plain).toBe("sk-test-abc123");
  });

  it("throws when decrypting with a different context (AAD binding)", () => {
    const k = new KeyRingAdapter({ masterKeyHex: MASTER, kekVersion: 1 });
    const blob = k.encryptSecret("ws-1", "llm-config", "sk-test-abc123");
    expect(() => k.decryptSecret("ws-1", "webhook-secret", blob)).toThrow();
  });

  it("throws when decrypting with a different workspace (AAD binding)", () => {
    const k = new KeyRingAdapter({ masterKeyHex: MASTER, kekVersion: 1 });
    const blob = k.encryptSecret("ws-1", "llm-config", "sk-test-abc123");
    expect(() => k.decryptSecret("ws-2", "llm-config", blob)).toThrow();
  });

  it("encryptWorkspaceSecret / decryptWorkspaceSecret delegate to encryptSecret with webhook-secret context", () => {
    const k = new KeyRingAdapter({ masterKeyHex: MASTER, kekVersion: 1 });
    const blob = k.encryptWorkspaceSecret("ws-1", "my-webhook-secret");
    const plain = k.decryptWorkspaceSecret("ws-1", blob);
    expect(plain).toBe("my-webhook-secret");
    // Cross-context: blob encrypted as webhook-secret should NOT decrypt as llm-config
    expect(() => k.decryptSecret("ws-1", "llm-config", blob)).toThrow();
  });
});

describe("KeyRingAdapter — HKDF workspace KEK + DEK wrap/unwrap", () => {
  it("generates a DEK, wraps it, and unwraps to the same plaintext DEK", () => {
    const k = new KeyRingAdapter({ masterKeyHex: MASTER, kekVersion: 1 });
    const dek = k.generateDek();
    const wrapped = k.wrapDek("ws-1", "actor-1", dek);
    const unwrapped = k.unwrapDek("ws-1", "actor-1", wrapped);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it("fails to unwrap a DEK under a different workspace (AAD binding)", () => {
    const k = new KeyRingAdapter({ masterKeyHex: MASTER, kekVersion: 1 });
    const dek = k.generateDek();
    const wrapped = k.wrapDek("ws-1", "actor-1", dek);
    expect(() => k.unwrapDek("ws-2", "actor-1", wrapped)).toThrow();
  });

  it("encrypts a field with a DEK and decrypts it back", () => {
    const k = new KeyRingAdapter({ masterKeyHex: MASTER, kekVersion: 1 });
    const dek = k.generateDek();
    const field = k.encryptField(dek, "dek-1", "Jane Doe, SSN 123-45-6789");
    expect(field.algorithm).toBe("AES-256-GCM");
    expect(field.ciphertext).not.toContain("Jane");
    expect(k.decryptField(dek, field)).toBe("Jane Doe, SSN 123-45-6789");
  });

  it("rewraps a DEK under a new KEK version without changing the DEK", () => {
    const v1 = new KeyRingAdapter({ masterKeyHex: MASTER, kekVersion: 1 });
    const v2 = new KeyRingAdapter({ masterKeyHex: MASTER, kekVersion: 2 });
    const dek = v1.generateDek();
    const wrapped1 = v1.wrapDek("ws-1", "actor-1", dek);
    const dekPlain = v1.unwrapDek("ws-1", "actor-1", wrapped1);
    const wrapped2 = v2.wrapDek("ws-1", "actor-1", dekPlain);
    expect(v2.unwrapDek("ws-1", "actor-1", wrapped2).equals(dek)).toBe(true);
    // v1 can no longer unwrap the v2 blob (different KEK derived from different version).
    expect(() => v1.unwrapDek("ws-1", "actor-1", wrapped2)).toThrow();
  });
});
