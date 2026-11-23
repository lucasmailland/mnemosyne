// Local KMS adapter (TASK-10002, SECURITY.md §7).
//
// AES-256-GCM envelope encryption for secret material at rest.
// MNEMO_MASTER_KEY MUST be sourced from env — never from NEXT_PUBLIC_* or
// client bundles. Key is 32 bytes (64 hex chars).
//
// Wire format (base64url of packed bytes):
//   [iv: 12 bytes][authTag: 16 bytes][ciphertext: variable]
//
// Single-key implementation. For rotation, derive a versioned key ring via
// HKDF from the master and prepend a 1-byte version tag; that is out of scope
// for this adapter and delegated to a future KeyRingAdapter.

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

// ─── Config ───────────────────────────────────────────────────────────────────

export interface LocalKmsConfig {
  /** 32-byte master key as hex (64 chars). Read from MNEMO_MASTER_KEY env. */
  masterKeyHex: string;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class LocalKmsAdapter {
  private readonly key: Buffer;

  constructor(config: LocalKmsConfig) {
    if (!config.masterKeyHex || config.masterKeyHex.length !== 64) {
      throw new Error("LocalKmsAdapter: MNEMO_MASTER_KEY must be 64 hex characters (32 bytes)");
    }
    this.key = Buffer.from(config.masterKeyHex, "hex");
    if (this.key.length !== KEY_BYTES) {
      throw new Error("LocalKmsAdapter: key decoded to wrong length (expected 32 bytes)");
    }
  }

  /**
   * Encrypt plaintext string → base64url ciphertext blob.
   * Each call generates a fresh random IV — never reuse.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv) as CipherGCM;

    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Pack: iv || authTag || ciphertext
    const packed = Buffer.concat([iv, tag, encrypted]);
    return packed.toString("base64url");
  }

  /**
   * Decrypt base64url ciphertext blob → plaintext string.
   * Throws if authentication fails (tampered data or wrong key).
   */
  decrypt(blob: string): string {
    const packed = Buffer.from(blob, "base64url");
    if (packed.length < IV_BYTES + TAG_BYTES) {
      throw new Error("LocalKmsAdapter: ciphertext blob too short");
    }

    const iv = packed.subarray(0, IV_BYTES);
    const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv("aes-256-gcm", this.key, iv) as DecipherGCM;
    decipher.setAuthTag(tag);

    try {
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.toString("utf8");
    } catch {
      throw new Error("LocalKmsAdapter: decryption failed — bad key or tampered data");
    }
  }

  /** Derive a sub-key bound to a specific context (e.g. workspace ID). */
  encryptWithContext(plaintext: string, context: string): string {
    // Bind context as AAD (additional authenticated data) — it must match on decrypt.
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv) as CipherGCM;
    cipher.setAAD(Buffer.from(context, "utf8"));

    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, tag, encrypted]);
    return packed.toString("base64url");
  }

  decryptWithContext(blob: string, context: string): string {
    const packed = Buffer.from(blob, "base64url");
    if (packed.length < IV_BYTES + TAG_BYTES) {
      throw new Error("LocalKmsAdapter: ciphertext blob too short");
    }

    const iv = packed.subarray(0, IV_BYTES);
    const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv("aes-256-gcm", this.key, iv) as DecipherGCM;
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from(context, "utf8"));

    try {
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.toString("utf8");
    } catch {
      throw new Error(
        "LocalKmsAdapter: decryption failed — bad key, wrong context, or tampered data"
      );
    }
  }
}

/**
 * Factory: reads MNEMO_MASTER_KEY from process.env.
 * Call once at server startup — result is a singleton for the process lifetime.
 */
export function createLocalKmsAdapter(): LocalKmsAdapter {
  const masterKeyHex = process.env["MNEMO_MASTER_KEY"];
  if (!masterKeyHex) {
    throw new Error(
      "MNEMO_MASTER_KEY environment variable is not set. " +
        "Generate a 32-byte key with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return new LocalKmsAdapter({ masterKeyHex });
}
