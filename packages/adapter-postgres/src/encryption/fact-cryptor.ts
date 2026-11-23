// Selective PII column encryption for facts (SECURITY.md §7).
//
// Design: this module is self-contained (node:crypto only).  The plaintext DEK
// (Buffer) is passed in by the caller (DrizzleStorageAdapter) after unwrapping
// from the KEK via KeyRingAdapter in packages/server.  This avoids a
// server→adapter-postgres import cycle while keeping hexagonal purity.
//
// Encrypted values carry the "enc:v1:" sentinel prefix so reads can
// distinguish ciphertext from legacy plaintext rows.
//
// Sensitivity gate: only "confidential" and "restricted" rows are encrypted.
// "public" and "internal" remain plaintext for FTS compatibility.

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";
import type { EncryptedField } from "@mnemo-ai/types";

const SENTINEL = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Sensitivity tiers that require PII encryption.
const ENCRYPTED_LEVELS = new Set<string>(["confidential", "restricted"]);

// ─── Pack/unpack helpers ─────────────────────────────────────────────────────

function pack(field: EncryptedField): string {
  return SENTINEL + Buffer.from(JSON.stringify(field), "utf8").toString("base64");
}

function unpack(value: string): EncryptedField {
  return JSON.parse(
    Buffer.from(value.slice(SENTINEL.length), "base64").toString("utf8")
  ) as EncryptedField;
}

// ─── Low-level AES-256-GCM ──────────────────────────────────────────────────

function aesGcmEncrypt(
  dek: Buffer,
  plaintext: string
): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dek, iv) as CipherGCM;
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function aesGcmDecrypt(dek: Buffer, field: EncryptedField): string {
  const iv = Buffer.from(field.iv, "base64");
  const tag = Buffer.from(field.tag, "base64");
  const ct = Buffer.from(field.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", dek, iv) as DecipherGCM;
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("fact-cryptor: GCM authentication failed — wrong DEK or tampered ciphertext");
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface PiiColumns {
  statement: string;
  subject: string;
  sensitivity: string;
}

export function encryptEncryptedField(dek: Buffer, dekId: string, plaintext: string): string {
  const encrypted = aesGcmEncrypt(dek, plaintext);
  return pack({ ...encrypted, dekId, algorithm: "AES-256-GCM" });
}

export function isEncryptedField(value: string): boolean {
  return value.startsWith(SENTINEL);
}

export function decryptEncryptedField(dek: Buffer, value: string): string {
  return isEncryptedField(value) ? aesGcmDecrypt(dek, unpack(value)) : value;
}

/**
 * Encrypt PII columns for write.
 *
 * @param dek     - 32-byte plaintext DEK (unwrapped by KeyRingAdapter before call)
 * @param dekId   - DEK identifier stored in the EncryptedField for rotation auditing
 * @param input   - raw fact columns
 * @returns       - columns ready to persist (may be ciphertext or plaintext)
 */
export function encryptPiiColumns(
  dek: Buffer,
  dekId: string,
  input: PiiColumns
): { statement: string; subject: string } {
  if (!ENCRYPTED_LEVELS.has(input.sensitivity)) {
    return { statement: input.statement, subject: input.subject };
  }
  return {
    statement: encryptEncryptedField(dek, dekId, input.statement),
    subject: encryptEncryptedField(dek, dekId, input.subject),
  };
}

/**
 * Decrypt PII columns on read.
 *
 * Non-encrypted (no sentinel) values are passed through unchanged — legacy
 * plaintext rows remain readable.
 *
 * @param dek    - 32-byte plaintext DEK (unwrapped by KeyRingAdapter before call)
 * @param row    - persisted column values (may be ciphertext or plaintext)
 * @returns      - plaintext column values
 */
export function decryptPiiColumns(
  dek: Buffer,
  row: { statement: string; subject: string }
): { statement: string; subject: string } {
  return {
    statement: decryptEncryptedField(dek, row.statement),
    subject: decryptEncryptedField(dek, row.subject),
  };
}

/**
 * Encrypt an arbitrary JSON-serialisable value as an audit detail blob.
 *
 * The output carries the "enc:v1:" sentinel so reads can distinguish
 * ciphertext from legacy plaintext rows.
 */
export function encryptJson(dek: Buffer, dekId: string, value: unknown): string {
  const enc = aesGcmEncrypt(dek, JSON.stringify(value ?? null));
  return pack({ ...enc, dekId, algorithm: "AES-256-GCM" });
}

/**
 * Decrypt an audit detail blob written by encryptJson.
 *
 * Legacy plaintext (no sentinel) is parsed as-is so old rows remain readable.
 */
export function decryptJson(dek: Buffer, blob: string): unknown {
  const json = blob.startsWith(SENTINEL) ? aesGcmDecrypt(dek, unpack(blob)) : blob;
  return JSON.parse(json);
}
