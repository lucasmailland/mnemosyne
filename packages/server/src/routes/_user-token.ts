/**
 * Minting a `uk_*` user token from a tenant route. Shared by
 * `POST /tenants/:tenantId/users/:userId/tokens` (user-tokens.ts) and
 * `POST /tenants` with `issueOwnerToken` (tenants.ts), so both hold the same
 * SEC-1 rule WP-11 put on `POST /admin/keys`: no scope that does not exist,
 * none the caller lacks, no sensitivity ceiling above the caller's.
 *
 * The SEC-1 helpers below (KNOWN_SCOPES, scopesBeyondCaller,
 * ceilingBeyondCaller) are the single copy: keys.ts imports them too.
 */

import { randomBytes } from "node:crypto";
import { ALL_SCOPES, SENSITIVITY_ORDER, type Sensitivity } from "@mnemo-ai/types";
import bcrypt from "bcrypt";
import type postgres from "postgres";
import { BCRYPT_COST, computeLookupHash, generateKeySecret } from "./_key-secret.js";

export const KNOWN_SCOPES: ReadonlySet<string> = new Set(ALL_SCOPES);

/**
 * The scopes in `requested` that the caller does not hold. `held` is the
 * role-narrowed set auth.ts puts on the context — an array on most paths, a
 * Set on some — so it is read as an iterable, never with `.includes`.
 */
export function scopesBeyondCaller(requested: readonly string[], held: Iterable<string>): string[] {
  const heldSet = new Set(held);
  return requested.filter((s) => !heldSet.has(s));
}

/**
 * True when a token with ceiling `granted` (null = no per-key ceiling) could
 * read more than a caller capped at `callerCeiling`. An uncapped caller can
 * grant anything; a capped one its own cap or lower (S5: numeric).
 */
export function ceilingBeyondCaller(
  granted: string | null,
  callerCeiling: Sensitivity | undefined
): boolean {
  if (!callerCeiling) return false;
  if (granted === null) return true;
  return SENSITIVITY_ORDER[granted as Sensitivity] > SENSITIVITY_ORDER[callerCeiling];
}

export interface UserTokenInput {
  userId: string;
  tenantId: string;
  workspaceId: string;
  label: string;
  /** Already checked against the caller's own scopes. */
  scopes: string[];
  /** Already checked against the caller's own ceiling. */
  maxSensitivity: string | null;
  expiresAt: Date | null;
  ipAllowlist?: string[];
  test?: boolean;
}

/** Inserts the token row in `tx` and returns the plaintext key, shown once. */
export async function insertUserToken(
  tx: postgres.TransactionSql,
  input: UserTokenInput
): Promise<{ id: string; key: string; createdAt: string; expiresAt: string | null }> {
  const plainKey = generateKeySecret(input.test ? "uk_test" : "uk_live");
  const keyHash = await bcrypt.hash(plainKey, BCRYPT_COST);
  const lookupHash = computeLookupHash(plainKey);
  const keyId = `uk_${randomBytes(8).toString("hex")}`;
  const nowIso = new Date().toISOString();
  const expiresAtIso = input.expiresAt?.toISOString() ?? null;

  // mnemo_api_keys has no RLS (auth-bootstrap exception, CLAUDE.md) — the
  // tenant GUCs withTenantRls already set are for the repo reads above,
  // not required for this INSERT. Downgrade to app_user for defense in
  // depth, matching keys.ts's own createKeyRoute handler. search_path
  // must be set explicitly too: a legacy public.mnemo_api_keys (core
  // migration 0063, no key_kind column) coexists with the real
  // mnemosyne.mnemo_api_keys (adapter-postgres baseline) — withTenantRls
  // never touches search_path, so an unqualified reference here would
  // silently resolve to the wrong table without this (see keys.ts's
  // withKeysTx, which sets this for exactly the same reason).
  await tx`SET LOCAL ROLE app_user`;
  await tx`SET LOCAL search_path TO mnemosyne, public`;
  await tx`
    INSERT INTO mnemo_api_keys
      (id, workspace_id, user_id, tenant_id, key_kind, key_hash, lookup_hash, name, label, scopes, plan, ip_allowlist, expires_at, max_sensitivity, created_at)
    VALUES (
      ${keyId},
      ${input.workspaceId},
      ${input.userId},
      ${input.tenantId},
      'user',
      ${keyHash},
      ${lookupHash},
      ${input.label},
      ${input.label},
      ${tx.array(input.scopes)},
      'free',
      ${tx.array(input.ipAllowlist ?? [])},
      ${expiresAtIso},
      ${input.maxSensitivity},
      ${nowIso}
    )
  `;

  return { id: keyId, key: plainKey, createdAt: nowIso, expiresAt: expiresAtIso };
}
