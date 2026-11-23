import {
  sign, verify, createCipheriv, createDecipheriv, randomBytes,
  createPrivateKey, createPublicKey,
  type KeyObject,
} from "node:crypto";

export function signPayload(body: string, privateKey: KeyObject): string {
  return sign(null, Buffer.from(body, "utf8"), privateKey).toString("base64");
}

export function verifyPayload(body: string, signatureB64: string, publicKey: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(body, "utf8"), publicKey, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

// ── Key-material parsing ────────────────────────────────────────────────────────
// The instance's own Ed25519 private key and each peer's signing public key are
// supplied as config strings (PEM at boot, or raw base64-DER). The shared
// symmetric key is a base64-encoded 32-byte value. These helpers turn those
// config strings into the KeyObject / Buffer shapes the crypto functions need,
// so callers (PullClient, server route) never touch node:crypto directly.

/** Parse an Ed25519 PRIVATE key from PEM (PKCS#8) or raw base64-DER. */
export function parseEd25519PrivateKey(material: string): KeyObject {
  const trimmed = material.trim();
  if (trimmed.includes("BEGIN")) {
    return createPrivateKey({ key: trimmed, format: "pem" });
  }
  return createPrivateKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "pkcs8" });
}

/** Parse an Ed25519 PUBLIC key from PEM (SPKI) or raw base64-DER. */
export function parseEd25519PublicKey(material: string): KeyObject {
  const trimmed = material.trim();
  if (trimmed.includes("BEGIN")) {
    return createPublicKey({ key: trimmed, format: "pem" });
  }
  return createPublicKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "spki" });
}

/**
 * Parse a base64-encoded 32-byte AES-256 symmetric key.
 * Throws if the decoded length is not exactly 32 bytes — a short key would
 * silently weaken the cipher, so this is a hard error rather than a fallback.
 */
export function parseSymmetricKey(material: string): Buffer {
  const key = Buffer.from(material.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(`Federation symmetric key must decode to 32 bytes (got ${key.length})`);
  }
  return key;
}

export interface SealedItem { iv: string; tag: string; ct: string; }

export function sealItem(item: unknown, key: Buffer): SealedItem {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(item), "utf8")), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function openItem<T = unknown>(sealed: SealedItem, key: Buffer): T {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}
