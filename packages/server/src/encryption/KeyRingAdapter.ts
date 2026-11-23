// KeyRingAdapter — the versioned HKDF key ring anticipated in LocalKmsAdapter.ts:10-12.
//
// Hierarchy (SECURITY.md §7):
//   MNEMO_MASTER_KEY  (32 bytes)
//        │  HKDF-SHA256(salt = "mnemo-kek-v<N>", info = workspaceId)
//        ▼
//   workspace KEK (per workspace, per version N)
//        │  AES-256-GCM wrap, AAD = "<workspaceId>|<actorId>"
//        ▼
//   per-actor DEK (32 random bytes) — wraps fact PII columns
//
// Quarterly rotation bumps N and re-wraps each DEK under the new KEK; the DEK
// plaintext is unchanged so existing ciphertext stays readable (no column
// rewrite). destroyDek (in the adapter) nulls the wrapped DEK → irrecoverable.

import {
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";
import type { EncryptedField } from "@mnemo-ai/types";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface KeyRingConfig {
  /** 64 hex chars (32 bytes). Read from MNEMO_MASTER_KEY. */
  masterKeyHex: string;
  /** Monotonically increasing version. Increment to rotate the KEK. */
  kekVersion: number;
}

export class KeyRingAdapter {
  private readonly master: Buffer;
  readonly kekVersion: number;

  constructor(config: KeyRingConfig) {
    if (!config.masterKeyHex || config.masterKeyHex.length !== 64) {
      throw new Error("KeyRingAdapter: MNEMO_MASTER_KEY must be 64 hex chars (32 bytes)");
    }
    this.master = Buffer.from(config.masterKeyHex, "hex");
    if (this.master.length !== KEY_BYTES) {
      throw new Error("KeyRingAdapter: master key decoded to wrong length");
    }
    this.kekVersion = config.kekVersion;
  }

  // ─── KEK derivation ─────────────────────────────────────────────────────────

  /** Derive the per-workspace KEK for the configured version. */
  private deriveKek(workspaceId: string): Buffer {
    const salt = Buffer.from(`mnemo-kek-v${this.kekVersion}`, "utf8");
    const info = Buffer.from(workspaceId, "utf8");
    return Buffer.from(hkdfSync("sha256", this.master, salt, info, KEY_BYTES));
  }

  // ─── DEK generation + wrap/unwrap ───────────────────────────────────────────

  /** Generate a fresh 32-byte plaintext DEK. Store only the wrapped form. */
  generateDek(): Buffer {
    return randomBytes(KEY_BYTES);
  }

  /**
   * Wrap a DEK under the workspace KEK.
   * AAD = "<workspaceId>|<actorId>" — binds to both workspace and actor.
   * Returns a base64-encoded blob (iv || tag || ciphertext).
   */
  wrapDek(workspaceId: string, actorId: string, dek: Buffer): string {
    const packed = this.gcmSeal(this.deriveKek(workspaceId), `${workspaceId}|${actorId}`, dek);
    return packed.toString("base64");
  }

  /**
   * Unwrap a wrapped DEK blob.
   * Throws on wrong workspace, wrong actor, or wrong KEK version — all produce
   * GCM authentication failure.
   */
  unwrapDek(workspaceId: string, actorId: string, wrappedBase64: string): Buffer {
    return this.gcmOpen(
      this.deriveKek(workspaceId),
      `${workspaceId}|${actorId}`,
      Buffer.from(wrappedBase64, "base64")
    );
  }

  // ─── Workspace-scoped secret encryption (F12) ───────────────────────────────
  // Encrypts an operational secret (e.g. a webhook HMAC signing key) directly
  // under the per-workspace KEK — no per-actor DEK, since webhooks are
  // workspace-scoped and have no owning actor. AAD binds the blob to the
  // workspace and a fixed context tag so a blob cannot be replayed across
  // workspaces or secret types.

  /**
   * Generalized secret encrypt. AAD = "${workspaceId}|${context}".
   * Returns base64(iv || tag || ciphertext).
   * Use this when the secret is NOT a webhook signing key.
   */
  encryptSecret(workspaceId: string, context: string, plaintext: string): string {
    const packed = this.gcmSeal(
      this.deriveKek(workspaceId),
      `${workspaceId}|${context}`,
      Buffer.from(plaintext, "utf8")
    );
    return packed.toString("base64");
  }

  /**
   * Generalized secret decrypt. AAD = "${workspaceId}|${context}".
   * Throws on wrong workspace, wrong context, or tampered blob.
   */
  decryptSecret(workspaceId: string, context: string, blobBase64: string): string {
    const plain = this.gcmOpen(
      this.deriveKek(workspaceId),
      `${workspaceId}|${context}`,
      Buffer.from(blobBase64, "base64")
    );
    return plain.toString("utf8");
  }

  /** Encrypt a workspace secret. Returns base64(iv || tag || ciphertext). */
  encryptWorkspaceSecret(workspaceId: string, plaintext: string): string {
    return this.encryptSecret(workspaceId, "webhook-secret", plaintext);
  }

  /** Decrypt a workspace secret blob produced by encryptWorkspaceSecret. */
  decryptWorkspaceSecret(workspaceId: string, blobBase64: string): string {
    return this.decryptSecret(workspaceId, "webhook-secret", blobBase64);
  }

  // ─── Field encryption ───────────────────────────────────────────────────────

  /** Encrypt a plaintext field value with a (plaintext) DEK. */
  encryptField(dek: Buffer, dekId: string, plaintext: string): EncryptedField {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dek, iv) as CipherGCM;
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: ct.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      dekId,
      algorithm: "AES-256-GCM",
    };
  }

  /** Decrypt an EncryptedField with the (plaintext) DEK. */
  decryptField(dek: Buffer, field: EncryptedField): string {
    const iv = Buffer.from(field.iv, "base64");
    const tag = Buffer.from(field.tag, "base64");
    const ct = Buffer.from(field.ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", dek, iv) as DecipherGCM;
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("KeyRingAdapter.decryptField: authentication failed (bad key or tampered)");
    }
  }

  // ─── GCM helpers (packed format: iv || authTag || ciphertext) ───────────────

  private gcmSeal(key: Buffer, aad: string, plaintext: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv) as CipherGCM;
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  private gcmOpen(key: Buffer, aad: string, packed: Buffer): Buffer {
    if (packed.length < IV_BYTES + TAG_BYTES) {
      throw new Error("KeyRingAdapter: blob too short");
    }
    const iv = packed.subarray(0, IV_BYTES);
    const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = packed.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv) as DecipherGCM;
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new Error(
        "KeyRingAdapter: GCM authentication failed — wrong key, context, or tampered"
      );
    }
  }
}

/**
 * Factory: reads MNEMO_MASTER_KEY + MNEMO_KEK_VERSION from process.env.
 * kekVersion defaults to 1 if unset.
 */
export function createKeyRingAdapter(): KeyRingAdapter {
  const masterKeyHex = process.env["MNEMO_MASTER_KEY"];
  if (!masterKeyHex) {
    throw new Error(
      "MNEMO_MASTER_KEY is not set. " +
        "Generate with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\""
    );
  }
  const kekVersion = parseInt(process.env["MNEMO_KEK_VERSION"] ?? "1", 10);
  return new KeyRingAdapter({ masterKeyHex, kekVersion });
}
