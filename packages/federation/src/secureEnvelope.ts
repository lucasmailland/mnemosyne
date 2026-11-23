// Federation secure envelope — P0-1 app-layer crypto on the items transfer path.
// SECURITY.md §11, PLUGINS_AND_FEDERATION.md §20.
//
// crypto.ts provides the primitives (Ed25519 signPayload/verifyPayload +
// AES-256-GCM sealItem/openItem). This module wires them into the actual
// items pull/serve contract so they stop being dead exports:
//
//   SERVE side  (buildSecureItemsEnvelope):
//     1. Seal each item's `payload` with the shared symmetric key (AES-256-GCM).
//     2. Sign the canonical JSON of the sealed item list with the instance's
//        own Ed25519 private key.
//     3. Emit { alg, signature, items:[{ remoteId, version, peerDomain, sealed }] }.
//
//   PULL side  (openSecureItemsEnvelope):
//     1. Verify the signature over the canonical sealed-item list using the
//        peer's pinned signing public key. Reject the WHOLE batch on mismatch.
//     2. Open each sealed payload with the shared symmetric key. Reject the
//        WHOLE batch if any item fails to decrypt (tamper / wrong key).
//
// Backward-compat (do not hard-break existing deployments):
//   - If the SERVE side has no instance key / symmetric key configured, it emits
//     the legacy plaintext shape ({ items:[{ ...payload }] }) unchanged.
//   - If the PULL side has no peer signing key / symmetric key configured, OR the
//     wire body carries no `signature`, it accepts the legacy plaintext shape and
//     the caller logs a warning. When keys ARE configured AND the body is signed,
//     verification + decryption are ENFORCED (failure → throw, never silent).

import type { KeyObject } from "node:crypto";
import { signPayload, verifyPayload, sealItem, openItem, type SealedItem } from "./crypto.js";
import type { FederatedItem } from "./SyncEngine.js";

/** Algorithm tag carried on the wire so the reader knows how to handle the body. */
export const FEDERATION_ENVELOPE_ALG = "ed25519+aes-256-gcm" as const;

/** A single item whose `payload` has been sealed (AES-256-GCM). */
export interface SealedFederatedItem {
  remoteId: string;
  version: number;
  vectorClock?: Record<string, number>;
  attribution?: string;
  deletedAt?: string;
  peerDomain: string;
  /** AES-256-GCM ciphertext of the original `payload`. */
  sealed: SealedItem;
}

/**
 * The signed wire body returned by GET /memory/federation/items when crypto is
 * configured. `signature` covers the canonical JSON of `items` (the sealed list).
 */
export interface SecureItemsEnvelope {
  alg: typeof FEDERATION_ENVELOPE_ALG;
  signature: string;
  items: SealedFederatedItem[];
  nextCursor: string | null;
}

/** Keys the SERVE side needs to sign + seal. Both must be present to secure. */
export interface ServeCryptoKeys {
  /** This instance's own Ed25519 private key (from boot config). */
  instancePrivateKey: KeyObject;
  /** Shared/derived 32-byte symmetric key for sealing item payloads. */
  symmetricKey: Buffer;
}

/** Keys the PULL side needs to verify + open a peer's envelope. */
export interface PullCryptoKeys {
  /** The peer's pinned Ed25519 signing public key (from peer config). */
  peerSigningPublicKey: KeyObject;
  /** Shared/derived 32-byte symmetric key for opening sealed payloads. */
  symmetricKey: Buffer;
}

/**
 * Canonical serialization of the sealed item list for signing/verifying.
 *
 * Both sides MUST agree byte-for-byte, so we serialize each item with a fixed
 * key order rather than relying on insertion order of JSON.stringify. Optional
 * fields are omitted when absent (so a peer that never sets them produces the
 * same bytes as one that sets them to undefined).
 */
export function canonicalizeSealedItems(items: SealedFederatedItem[]): string {
  return JSON.stringify(
    items.map((it) => {
      const out: Record<string, unknown> = {
        remoteId: it.remoteId,
        version: it.version,
        peerDomain: it.peerDomain,
        sealed: { iv: it.sealed.iv, tag: it.sealed.tag, ct: it.sealed.ct },
      };
      if (it.vectorClock !== undefined) out["vectorClock"] = it.vectorClock;
      if (it.attribution !== undefined) out["attribution"] = it.attribution;
      if (it.deletedAt !== undefined) out["deletedAt"] = it.deletedAt;
      return out;
    })
  );
}

/**
 * SERVE side: build the signed + sealed envelope from plaintext FederatedItems.
 *
 * Seals each item's `payload` and signs the canonical sealed list. The
 * `remoteId`/`version`/`peerDomain`/`vectorClock`/`deletedAt` fields stay in
 * cleartext because the pull side needs them for the apply path (resurrection
 * guard, version-inflation guard, tombstone handling) before it ever opens a
 * payload — and they are covered by the signature so they cannot be forged.
 */
export function buildSecureItemsEnvelope(
  items: FederatedItem[],
  nextCursor: string | null,
  keys: ServeCryptoKeys
): SecureItemsEnvelope {
  const sealedItems: SealedFederatedItem[] = items.map((it) => {
    const sealed: SealedFederatedItem = {
      remoteId: it.remoteId,
      version: it.version,
      peerDomain: it.peerDomain,
      sealed: sealItem(it.payload, keys.symmetricKey),
    };
    if (it.vectorClock !== undefined) sealed.vectorClock = it.vectorClock;
    if (it.attribution !== undefined) sealed.attribution = it.attribution;
    if (it.deletedAt !== undefined) sealed.deletedAt = it.deletedAt;
    return sealed;
  });

  const signature = signPayload(canonicalizeSealedItems(sealedItems), keys.instancePrivateKey);

  return { alg: FEDERATION_ENVELOPE_ALG, signature, items: sealedItems, nextCursor };
}

/** Discriminator: does this wire body look like a signed secure envelope? */
export function isSecureEnvelope(body: unknown): body is SecureItemsEnvelope {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b["signature"] === "string" &&
    Array.isArray(b["items"]) &&
    (b["items"] as unknown[]).every(
      (it) => it !== null && typeof it === "object" && "sealed" in (it as object)
    )
  );
}

export class FederationVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FederationVerifyError";
  }
}

export class FederationDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FederationDecryptError";
  }
}

/**
 * PULL side: verify the envelope signature, then open every sealed payload.
 *
 * REJECTS the whole batch (throws) on:
 *   - signature mismatch        → FederationVerifyError
 *   - any payload that fails to decrypt (tamper / wrong key) → FederationDecryptError
 *
 * Failure throws rather than returning a partial batch: a forged or tampered
 * pull must never reach SyncEngine.processBatch.
 */
export function openSecureItemsEnvelope(
  envelope: SecureItemsEnvelope,
  keys: PullCryptoKeys
): { items: FederatedItem[]; nextCursor: string | null } {
  const canonical = canonicalizeSealedItems(envelope.items);
  if (!verifyPayload(canonical, envelope.signature, keys.peerSigningPublicKey)) {
    throw new FederationVerifyError(
      "Federation envelope signature verification failed — rejecting batch"
    );
  }

  const items: FederatedItem[] = envelope.items.map((it, idx) => {
    let payload: Record<string, unknown>;
    try {
      payload = openItem<Record<string, unknown>>(it.sealed, keys.symmetricKey);
    } catch (err) {
      throw new FederationDecryptError(
        `Federation item ${idx} (remoteId=${it.remoteId}) failed to decrypt: ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
    const out: FederatedItem = {
      remoteId: it.remoteId,
      version: it.version,
      peerDomain: it.peerDomain,
      payload,
    };
    if (it.vectorClock !== undefined) out.vectorClock = it.vectorClock;
    if (it.attribution !== undefined) out.attribution = it.attribution;
    if (it.deletedAt !== undefined) out.deletedAt = it.deletedAt;
    return out;
  });

  return { items, nextCursor: envelope.nextCursor };
}
