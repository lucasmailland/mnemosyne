// Key rotation orchestration (SECURITY.md §2.2).
//
// Step order is load-bearing: the NEW key is inserted and active BEFORE the
// OLD key is deprecated, so the 7-day dual-validity overlap window is never
// a gap.  Metadata (never the secret) is escrowed for incident forensics.

import { randomBytes } from "node:crypto";
import type { ApiKeyStore, ApiKeyType, RotateKeyResult } from "@mnemo-ai/types";
import { hashSecret } from "./hash.js";

const GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export const KEY_TYPE_TTL_MS: Record<string, number> = {
  mk_live_: 90 * DAY_MS,
  mk_test_: 30 * DAY_MS,
  mk_fed_: 365 * DAY_MS,
  mk_admin_: 24 * 3600_000,
};

/** Returns the default TTL in milliseconds for an API key prefix (spec §3.3). */
export function defaultTtlMsForKeyType(prefix: string): number {
  return KEY_TYPE_TTL_MS[prefix] ?? 90 * DAY_MS;
}

// base62 (matches SECURITY.md §2.2 key format).
const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function base62(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (const b of bytes) out += B62[b % 62];
  return out;
}

export interface RotateOptions {
  now?: Date;
  reason: string;
}

export async function rotateKey(
  store: ApiKeyStore,
  prefix: ApiKeyType,
  oldKeyId: string,
  opts: RotateOptions
): Promise<RotateKeyResult> {
  const now = opts.now ?? new Date();
  const old = await store.lookup(prefix, oldKeyId);
  if (!old) throw new Error(`rotateKey: key not found ${prefix}${oldKeyId}`);

  // 1. Generate the new key (§3.4: 12-char keyId, 43-char secret).
  const newKeyId = base62(12);
  const secret = base62(43);
  const hashedSecret = await hashSecret(secret);

  // 1b. Insert the new key as active. It keeps the old key's lifetime (a
  // session key stays short-lived), else the per-type TTL (§3.3 step 1), and
  // everything the old key's grant held: TOTP secret, user binding, test flag
  // and sensitivity ceiling. Dropping any of them would brick a break-glass
  // key or silently widen what the new key may read.
  const lifetimeMs = old.expiresAt
    ? old.expiresAt.getTime() - old.createdAt.getTime()
    : defaultTtlMsForKeyType(prefix);
  await store.insert({
    keyId: newKeyId,
    prefix,
    hashedSecret,
    workspaceId: old.workspaceId,
    scopes: old.scopes,
    status: "active",
    expiresAt: new Date(now.getTime() + lifetimeMs),
    rotatedFromId: oldKeyId,
    ipAllowlist: old.ipAllowlist,
    createdAt: now,
    mfaSecret: old.mfaSecret ?? null,
    userId: old.userId ?? null,
    isTest: old.isTest ?? false,
    ...(old.maxSensitivity ? { maxSensitivity: old.maxSensitivity } : {}),
  });

  // 2/3. Deprecate the old key with the grace window.
  await store.deprecate(oldKeyId, now);

  // Escrow METADATA only (never the secret).
  await store.escrow({
    keyId: oldKeyId,
    prefix,
    workspaceId: old.workspaceId,
    scopes: old.scopes,
    action: "rotate",
    reason: opts.reason,
    escrowedAt: now,
  });

  const sunset = new Date(now.getTime() + GRACE_DAYS * 86_400_000).toISOString();
  return { newKey: `${prefix}${newKeyId}_${secret}`, newKeyId, sunset };
}
