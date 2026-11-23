// Cloud-tier Scoped API Key auth adapter (TASK-10001, SECURITY.md §2.2).
//
// Verifies mk_live_/mk_test_/mk_sess_/mk_fed_/mk_admin_ API keys.
// Key format: `{prefix}{keyId}_{secret}` where prefix is one of the ApiKeyType values.
//
// Security properties (Wave T2):
// - Real argon2id hash verification (verifySecret auto-falls-back to bcrypt for legacy keys)
// - IP allowlist enforcement (SEC-03)
// - Status checks: active / deprecated (grace period) / revoked (reject)
// - Expiry enforcement
// - Break-glass (mk_admin_): requires TOTP MFA + enforced 24h TTL ceiling
// - Anomaly detection: revokes on new-IP or impossible geo-velocity
// - Deprecation grace: deprecated keys valid for 7 days post deprecatedAt

import type {
  AuthAdapter,
  AuthContext,
  AuthResult,
  AuthOperation,
  RawCredentials,
  ApiKeyStore,
  ApiKeyRecord,
  ApiKeyType,
  KeyScope,
  HealthStatus,
} from "@mnemo-ai/types";
import { ipInCidr, detectKeyAnomaly, verifyTotp } from "@mnemo-ai/core";
import { MnemoAuthError } from "../errors.js";
import { verifySecret } from "./hash.js";
import { KEY_TYPE_TTL_MS } from "./rotation.js";
import { validateTestKeyBinding } from "./test-key-isolation.js";

const GRACE_MS = 7 * 86_400_000;

export interface ScopedApiKeyConfig {
  store: ApiKeyStore;
  /** Enable markUsed-history anomaly detection (forced rotation on hit). */
  anomalyDetection?: boolean;
  /** Coarse IP→geo for velocity checks (default: null lookups = skip velocity). */
  geoLookup?: (ip: string) => { lat: number; lon: number } | null;
  /** Max plausible km/h before geo-velocity is flagged (default 1000). */
  maxKmPerHour?: number;
}

// Key format: `{prefix}{keyId}_{secret}`
function parseApiKey(raw: string): { prefix: ApiKeyType; keyId: string; secret: string } | null {
  const PREFIXES: ApiKeyType[] = ["mk_live_", "mk_test_", "mk_sess_", "mk_fed_", "mk_admin_"];
  const legacyPrefixMap: Record<string, ApiKeyType> = {
    mns_live_: "mk_live_",
    mns_test_: "mk_test_",
  };

  for (const [legacyPrefix, canonicalPrefix] of Object.entries(legacyPrefixMap)) {
    if (raw.startsWith(legacyPrefix)) {
      const rest = raw.slice(legacyPrefix.length);
      const underscoreIdx = rest.indexOf("_");
      if (underscoreIdx === -1) return null;
      return {
        prefix: canonicalPrefix,
        keyId: rest.slice(0, underscoreIdx),
        secret: rest.slice(underscoreIdx + 1),
      };
    }
  }

  for (const prefix of PREFIXES) {
    if (raw.startsWith(prefix)) {
      const rest = raw.slice(prefix.length);
      const underscoreIdx = rest.indexOf("_");
      if (underscoreIdx === -1) return null;
      return { prefix, keyId: rest.slice(0, underscoreIdx), secret: rest.slice(underscoreIdx + 1) };
    }
  }

  return null;
}

function checkIpAllowlist(clientIp: string | undefined, allowlist: string[]): boolean {
  if (!clientIp) return false;
  return allowlist.some((entry) => ipInCidr(clientIp, entry));
}

export class ScopedApiKeyAdapter implements AuthAdapter {
  readonly id = "scoped-api-key";

  constructor(private readonly config: ScopedApiKeyConfig) {}

  async authenticate(credentials: RawCredentials): Promise<AuthResult> {
    const raw = credentials.apiKey;
    if (!raw) return { ok: false, code: "UNAUTHORIZED", reason: "Invalid API key" };

    const parsed = parseApiKey(raw);
    if (!parsed) return { ok: false, code: "INVALID", reason: "Invalid API key" };

    const { prefix, keyId, secret } = parsed;
    let record: ApiKeyRecord | null;
    try {
      record = await this.config.store.lookup(prefix, keyId);
    } catch {
      return { ok: false, code: "INVALID", reason: "Invalid API key" };
    }

    if (!record) return { ok: false, code: "INVALID", reason: "Invalid API key" };

    // Prove possession before revealing state or producing state-specific audit writes.
    // Keep the real Argon2id / legacy bcrypt verification on every existing key.
    let valid: boolean;
    try {
      valid = await verifySecret(secret, record.hashedSecret);
    } catch {
      return { ok: false, code: "INVALID", reason: "Invalid API key" };
    }
    if (!valid) return { ok: false, code: "INVALID", reason: "Invalid API key" };

    // AB6.2: test/prod key isolation — mk_test_ keys may only access test workspaces.
    // If the store did not populate isTest, default to false (fail-safe: test keys blocked).
    if (!validateTestKeyBinding(prefix, record.isTest ?? false)) {
      return { ok: false, code: "FORBIDDEN", reason: "test/prod key mismatch" };
    }

    if (record.status === "revoked") {
      // Alert on revoked-key use (escrow row).
      void this.config.store
        .escrow?.({
          keyId: record.keyId,
          prefix: record.prefix,
          workspaceId: record.workspaceId,
          scopes: record.scopes,
          action: "revoke",
          reason: "revoked_key_used",
          escrowedAt: new Date(),
        })
        .catch(() => undefined);
      return { ok: false, code: "REVOKED", reason: "Key revoked" };
    }

    // Unified per-type TTL ceiling (SECURITY.md §2.2).
    // mk_sess_ keys have no ceiling (they are managed by session lifecycle).
    // All other types are checked against KEY_TYPE_TTL_MS from the single source of truth.
    if (record.prefix !== "mk_sess_") {
      const maxTtl = KEY_TYPE_TTL_MS[record.prefix];
      if (
        maxTtl !== undefined &&
        record.expiresAt != null &&
        record.expiresAt.getTime() - record.createdAt.getTime() > maxTtl
      ) {
        return {
          ok: false,
          code: "FORBIDDEN",
          reason: `Key TTL exceeds ${record.prefix} maximum`,
        };
      }
    }

    // Break-glass: mk_admin_ additionally requires TOTP MFA (SECURITY.md §2.2).
    // This check runs AFTER the ceiling check above.
    if (record.prefix === "mk_admin_") {
      const mfaOk =
        !!record.mfaSecret &&
        !!credentials.mfaToken &&
        verifyTotp(record.mfaSecret, credentials.mfaToken);
      if (!mfaOk) {
        return {
          ok: false,
          code: "FORBIDDEN",
          reason: "Break-glass MFA required",
          workspaceId: record.workspaceId,
          keyId: record.keyId,
        };
      }
    }

    // Wall-clock expiry check (all key types, including admin).
    if (record.expiresAt && record.expiresAt < new Date()) {
      return { ok: false, code: "TOKEN_EXPIRED", reason: "Key expired" };
    }

    // Deprecation grace ceiling: a deprecated key is valid only until
    // deprecatedAt + 7 days (defence-in-depth if the sweeper lags).
    let deprecation: AuthContext["keyDeprecation"] | undefined;
    if (record.status === "deprecated") {
      const base = record.deprecatedAt ?? record.createdAt;
      const sunset = new Date(base.getTime() + GRACE_MS);
      if (sunset < new Date()) {
        return { ok: false, code: "REVOKED", reason: "Deprecated key past sunset" };
      }
      deprecation = { deprecated: true, sunset: sunset.toISOString() };
    }

    // IP allowlist enforcement (SEC-03).
    const clientIp = credentials.clientIp;
    if (record.ipAllowlist && record.ipAllowlist.length > 0) {
      if (!clientIp || !checkIpAllowlist(clientIp, record.ipAllowlist)) {
        return {
          ok: false,
          code: "FORBIDDEN",
          reason: "IP not in allowlist",
          workspaceId: record.workspaceId,
          keyId: record.keyId,
          auditAction: "ip_denied",
        };
      }
    }

    // Anomaly detection over markUsed history (forced rotation, SECURITY.md §2.2).
    if (this.config.anomalyDetection && clientIp) {
      const history = await this.config.store.recentUsage(record.keyId, 50);
      const verdict = detectKeyAnomaly({
        currentIp: clientIp,
        now: new Date(),
        history,
        geoLookup: this.config.geoLookup ?? (() => null),
        maxKmPerHour: this.config.maxKmPerHour ?? 1000,
      });
      if (verdict.anomalous) {
        await this.config.store.revoke(record.keyId, `anomaly:${verdict.reason}`);
        return { ok: false, code: "REVOKED", reason: `Anomaly detected (${verdict.reason})` };
      }
    }

    // Mark last-used asynchronously.
    void this.config.store.markUsed(record.keyId, clientIp ?? "unknown").catch(() => undefined);

    return {
      ok: true,
      context: {
        workspaceId: record.workspaceId,
        actorId: record.keyId,
        actorType: "agent" as const,
        scopes: record.scopes as ReadonlyArray<KeyScope>,
        keyType: record.prefix,
        // The issuing user: break-glass dual control and role narrowing key on it.
        ...(record.userId ? { userId: record.userId } : {}),
        ...(deprecation ? { keyDeprecation: deprecation } : {}),
        // Per-key recall ceiling grant (§5). Only set when the key carries one;
        // downstream it can only LOWER the effective ceiling, never raise it.
        ...(record.maxSensitivity ? { maxSensitivity: record.maxSensitivity } : {}),
      },
    };
  }

  async authorize(context: AuthContext, operation: AuthOperation): Promise<void> {
    if (!context.scopes.includes(operation.action)) {
      throw new MnemoAuthError("MNEMO_AUTH_001", `Scope '${operation.action}' not granted`);
    }
  }

  healthCheck(): Promise<HealthStatus> {
    return Promise.resolve({ status: "ok", latencyMs: 0 });
  }
}
