// Webhook secret cipher (F12).
//
// The webhook HMAC signing secret must not be stored in plaintext. This narrow
// port encrypts it under the workspace KEK at create time and decrypts it at
// sign time. Routes / dispatch / the delivery worker depend on the interface,
// not on KeyRingAdapter, so the secret stays opaque everywhere except the sign
// boundary.

import type { KeyRingAdapter } from "./KeyRingAdapter.js";

export interface WebhookSecretCipher {
  /** Encrypt a webhook signing secret for storage. */
  encrypt(workspaceId: string, secret: string): string;
  /** Decrypt a stored webhook signing secret for signing. */
  decrypt(workspaceId: string, blob: string): string;
}

/** Build a WebhookSecretCipher backed by the workspace-KEK key ring. */
export function createKeyRingWebhookCipher(keyRing: KeyRingAdapter): WebhookSecretCipher {
  return {
    encrypt: (workspaceId, secret) => keyRing.encryptWorkspaceSecret(workspaceId, secret),
    decrypt: (workspaceId, blob) => keyRing.decryptWorkspaceSecret(workspaceId, blob),
  };
}
