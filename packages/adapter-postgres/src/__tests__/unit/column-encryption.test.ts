/**
 * T3.4 — Column-level PII encryption proof.
 *
 * Tests the fact-cryptor seam directly (no live DB, no KeyRingAdapter import
 * from server — caller passes a pre-unwrapped Buffer DEK).
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decryptEncryptedField,
  decryptPiiColumns,
  encryptEncryptedField,
  encryptPiiColumns,
} from "../../encryption/fact-cryptor.js";

function freshDek(): Buffer {
  return randomBytes(32);
}

describe("fact column encryption — ciphertext at rest / plaintext on read", () => {
  it("encrypts statement+subject for confidential facts (sentinel prefix)", () => {
    const dek = freshDek();
    const { statement, subject } = encryptPiiColumns(dek, "dek-1", {
      statement: "patient has condition X",
      subject: "patient:42",
      sensitivity: "confidential",
    });
    expect(statement.startsWith("enc:v1:")).toBe(true);
    expect(statement).not.toContain("condition");
    expect(subject.startsWith("enc:v1:")).toBe(true);
    expect(subject).not.toContain("patient:42");
  });

  it("leaves internal facts as plaintext (selective encryption, §7.1)", () => {
    const dek = freshDek();
    const { statement } = encryptPiiColumns(dek, "dek-1", {
      statement: "build passed",
      subject: "ci",
      sensitivity: "internal",
    });
    expect(statement).toBe("build passed");
  });

  it("round-trips: encrypt-on-write then decrypt-on-read returns plaintext", () => {
    const dek = freshDek();
    const enc = encryptPiiColumns(dek, "dek-1", {
      statement: "SSN 123-45-6789",
      subject: "user:7",
      sensitivity: "restricted",
    });
    const dec = decryptPiiColumns(dek, { statement: enc.statement, subject: enc.subject });
    expect(dec.statement).toBe("SSN 123-45-6789");
    expect(dec.subject).toBe("user:7");
  });

  it("passes through legacy plaintext rows on read (no sentinel)", () => {
    const dek = freshDek();
    const dec = decryptPiiColumns(dek, { statement: "old plaintext", subject: "x" });
    expect(dec.statement).toBe("old plaintext");
    expect(dec.subject).toBe("x");
  });

  it("encrypts and decrypts one field with the existing sentinel format", () => {
    const dek = freshDek();
    const encrypted = encryptEncryptedField(dek, "dek-1", "replacement statement");

    expect(encrypted.startsWith("enc:v1:")).toBe(true);
    expect(encrypted).not.toContain("replacement statement");
    expect(decryptEncryptedField(dek, encrypted)).toBe("replacement statement");
  });

  it("passes plaintext through the single-field decrypt helper", () => {
    expect(decryptEncryptedField(freshDek(), "legacy plaintext")).toBe("legacy plaintext");
  });

  it("rejects a single encrypted field when the DEK is wrong", () => {
    const encrypted = encryptEncryptedField(freshDek(), "dek-1", "secret");
    expect(() => decryptEncryptedField(freshDek(), encrypted)).toThrow(/authentication failed/i);
  });
});
