import { sql } from "drizzle-orm";
import type {
  ApiKeyStore,
  ApiKeyRecord,
  ApiKeyType,
  KeyScope,
  KeyUsageEvent,
  KeyEscrowEntry,
  Sensitivity,
} from "@mnemo-ai/types";
import { SENSITIVITY_ORDER } from "@mnemo-ai/types";
import type { DrizzleClient } from "./DrizzleStorageAdapter.js";

/**
 * Validate a raw max_sensitivity column value against the canonical sensitivity
 * tiers. An unknown/NULL value yields undefined → the process-wide ceiling
 * applies (never a silently wrong per-key ceiling).
 */
function toSensitivity(raw: unknown): Sensitivity | undefined {
  return typeof raw === "string" && raw in SENSITIVITY_ORDER ? (raw as Sensitivity) : undefined;
}

/**
 * Production ApiKeyStore for the §6 scoped-key scheme (mnemo_scoped_api_keys +
 * usage + escrow tables). Backs ScopedApiKeyAdapter.
 *
 * These tables carry NO workspace RLS — auth lookups happen before any workspace
 * GUC is set — so queries here intentionally do NOT call mnemo_set_workspace.
 * Only key METADATA is escrowed; the secret never leaves the hashed column.
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  const raw = (result as { rows?: unknown[] }).rows ?? result;
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

function toRecord(r: Record<string, unknown>): ApiKeyRecord {
  return {
    keyId: r["key_id"] as string,
    prefix: r["prefix"] as ApiKeyType,
    hashedSecret: r["hashed_secret"] as string,
    workspaceId: r["workspace_id"] as string,
    scopes: (r["scopes"] as KeyScope[] | null) ?? [],
    status: r["status"] as ApiKeyRecord["status"],
    expiresAt: r["expires_at"] ? new Date(r["expires_at"] as string) : null,
    ...(r["rotated_from_id"] ? { rotatedFromId: r["rotated_from_id"] as string } : {}),
    ...(r["ip_allowlist"] ? { ipAllowlist: r["ip_allowlist"] as string[] } : {}),
    createdAt: new Date(r["created_at"] as string),
    ...(r["last_used_at"] ? { lastUsedAt: new Date(r["last_used_at"] as string) } : {}),
    deprecatedAt: r["deprecated_at"] ? new Date(r["deprecated_at"] as string) : null,
    mfaSecret: (r["mfa_secret"] as string | null) ?? null,
    isTest: (r["is_test"] as boolean | null) ?? false,
    userId: (r["user_id"] as string | null) ?? null,
    ...(toSensitivity(r["max_sensitivity"])
      ? { maxSensitivity: toSensitivity(r["max_sensitivity"])! }
      : {}),
  };
}

export class DrizzleApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: DrizzleClient) {}

  async lookup(prefix: ApiKeyType, keyId: string): Promise<ApiKeyRecord | null> {
    const res = await this.db.execute(sql`
      SELECT key_id, prefix, hashed_secret, workspace_id, scopes, status, expires_at,
             rotated_from_id, ip_allowlist, created_at, last_used_at, deprecated_at,
             mfa_secret, is_test, max_sensitivity, user_id
      FROM mnemosyne.mnemo_scoped_api_keys
      WHERE key_id = ${keyId} AND prefix = ${prefix}
      LIMIT 1`);
    const r = rowsOf(res)[0];
    return r ? toRecord(r) : null;
  }

  async markUsed(keyId: string, ipAddress: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO mnemosyne.mnemo_scoped_key_usage (key_id, ip_address)
        VALUES (${keyId}, ${ipAddress})`);
      await tx.execute(sql`
        UPDATE mnemosyne.mnemo_scoped_api_keys
        SET last_used_at = now() WHERE key_id = ${keyId}`);
    });
  }

  async revoke(keyId: string, _reason: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE mnemosyne.mnemo_scoped_api_keys
      SET status = 'revoked' WHERE key_id = ${keyId}`);
  }

  async recentUsage(keyId: string, limit: number): Promise<KeyUsageEvent[]> {
    const res = await this.db.execute(sql`
      SELECT ip_address, at FROM mnemosyne.mnemo_scoped_key_usage
      WHERE key_id = ${keyId} ORDER BY at DESC LIMIT ${limit}`);
    return rowsOf(res).map((r) => ({
      ipAddress: r["ip_address"] as string,
      at: new Date(r["at"] as string),
    }));
  }

  async deprecate(keyId: string, deprecatedAt: Date): Promise<void> {
    await this.db.execute(sql`
      UPDATE mnemosyne.mnemo_scoped_api_keys
      SET status = 'deprecated', deprecated_at = ${deprecatedAt.toISOString()}
      WHERE key_id = ${keyId}`);
  }

  async insert(record: ApiKeyRecord): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO mnemosyne.mnemo_scoped_api_keys
        (key_id, prefix, hashed_secret, workspace_id, scopes, status, expires_at,
         rotated_from_id, ip_allowlist, created_at, last_used_at, deprecated_at,
         mfa_secret, is_test, max_sensitivity, user_id)
      VALUES (
        ${record.keyId}, ${record.prefix}, ${record.hashedSecret}, ${record.workspaceId},
        ${JSON.stringify(record.scopes)}::jsonb, ${record.status},
        ${record.expiresAt ? record.expiresAt.toISOString() : null},
        ${record.rotatedFromId ?? null},
        ${record.ipAllowlist ? JSON.stringify(record.ipAllowlist) : null}::jsonb,
        ${record.createdAt.toISOString()},
        ${record.lastUsedAt ? record.lastUsedAt.toISOString() : null},
        ${record.deprecatedAt ? record.deprecatedAt.toISOString() : null},
        ${record.mfaSecret ?? null}, ${record.isTest ?? false},
        ${record.maxSensitivity ?? null}, ${record.userId ?? null})
      ON CONFLICT (key_id) DO NOTHING`);
  }

  async escrow(entry: KeyEscrowEntry): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO mnemosyne.mnemo_scoped_key_escrow
        (key_id, prefix, workspace_id, scopes, action, reason, escrowed_at)
      VALUES (${entry.keyId}, ${entry.prefix}, ${entry.workspaceId},
              ${JSON.stringify(entry.scopes)}::jsonb, ${entry.action}, ${entry.reason},
              ${entry.escrowedAt.toISOString()})`);
  }
}
