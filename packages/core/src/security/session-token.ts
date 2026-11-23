// Wave X — X2.2: Device binding + refresh-token rotation (pure logic).
//
// Uses node:crypto for hashing — already permitted in core (see remember.ts).
// No host-infrastructure imports.
//
// PURE MODULE.

import { createHash } from "node:crypto";

/**
 * Compute a stable device fingerprint from three signals that change when the
 * client device changes but are stable across sessions on the same device.
 *
 * SHA-256 is used so the original values are not exposed in storage.
 */
export function deviceFingerprint(opts: {
  userAgent: string;
  acceptLanguage: string;
  /** Masked IP prefix, e.g. "192.168.1.0/24" — avoids locking to exact IP
   * while still detecting network changes. */
  ipNetwork: string;
}): string {
  return createHash("sha256")
    .update(`${opts.userAgent}|${opts.acceptLanguage}|${opts.ipNetwork}`)
    .digest("hex");
}

/**
 * Hash a plaintext refresh token for storage.
 * The original token is NEVER stored — only this hash.
 */
export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

type RefreshDecision =
  | { action: "rotate" }
  | { action: "revoke_family"; reason: "refresh_reuse_detected" | "device_mismatch" }
  | { action: "reject" };

/**
 * Decide what to do with a presented refresh token.
 *
 * - Token not found → reject (no stored record)
 * - Token already used (usedAt != null) → revoke the entire family (replay attack)
 * - Device fingerprint mismatch → revoke the family (stolen token)
 * - Token valid, device matches → rotate (normal refresh flow)
 *
 * Callers MUST:
 *   1. Call markUsed() before issuing the new token.
 *   2. On revoke_family, call revokeFamily() and invalidate all active sessions.
 */
export function decideRefresh(opts: {
  stored: { usedAt: Date | null; deviceFingerprint: string } | null;
  presentedFingerprint: string;
}): RefreshDecision {
  if (!opts.stored) {
    return { action: "reject" };
  }
  if (opts.stored.usedAt !== null) {
    return { action: "revoke_family", reason: "refresh_reuse_detected" };
  }
  if (opts.stored.deviceFingerprint !== opts.presentedFingerprint) {
    return { action: "revoke_family", reason: "device_mismatch" };
  }
  return { action: "rotate" };
}
