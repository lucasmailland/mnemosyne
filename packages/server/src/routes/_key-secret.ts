// Shared API-key secret generation, extracted from keys.ts so user-tokens.ts
// (S6 — minting a uk_live_* token for another user) doesn't duplicate it.

import { createHmac, randomBytes } from "node:crypto";

export const BCRYPT_COST = 12;

export function computeLookupHash(token: string): string {
  const pepper = process.env.MNEMO_KEY_PEPPER ?? "";
  return createHmac("sha256", pepper).update(token).digest("hex");
}

export function generateKeySecret(prefix: string): string {
  const secret = randomBytes(16).toString("hex"); // 32 hex chars
  return `${prefix}_${secret}`;
}
