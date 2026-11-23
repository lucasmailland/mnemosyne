import { resolveTrafficOrigin } from "./provenance.js";
import { createHash, createHmac } from "node:crypto";
import { LRUCache } from "lru-cache";
import { registerAuthCaches } from "./auth-cache-registry.js";
import bcrypt from "bcrypt";
import type { MiddlewareHandler } from "hono";
import type { Context } from "hono";
import type { AuthAdapter, Sensitivity, Telemetry, StorageAdapter } from "@mnemo-ai/types";
import { MNEMO_SPAN_NAMES, isWorkspaceId, formatActorRef } from "@mnemo-ai/types";

import { UnauthorizedError, ForbiddenError, HttpError } from "./errors.js";
import { logger } from "./logging.js";
import { authFailuresTotal, authScopeNarrowedTotal } from "./metrics/index.js";
import { emitAudit } from "./audit-emit.js";
import {
  evaluateResolvedKey,
  keyUserAllowed,
  workspaceRoleScopesDisabled,
} from "./auth-evaluate.js";
import type { UserStatusService } from "./user-status.js";
import { clientIpOf } from "./client-ip.js";

/**
 * Bearer-token auth for Mnemosyne API.
 *
 * Design:
 *  - API keys are formatted "mns_live_<20+char-cuid>".
 *  - We store a bcrypt hash in `mnemo_api_keys.key_hash` — never the plaintext.
 *  - O(1) fast path (migration 0064): compute HMAC-SHA256(MNEMO_KEY_PEPPER, token),
 *    find the exact row, do ONE bcrypt.compare. Eliminates the O(n) DoS.
 *  - O(n) fallback for rows without lookup_hash (issued before 0064). On
 *    successful match, lazily backfills the lookup_hash for that row.
 *  - The LRU cache memoises {token -> workspaceId, scopes} for 60s so bcrypt is
 *    only paid once per key per minute.
 */

/** Format we accept. Loose enough to evolve, strict enough to fail fast.
 *  SEC-2: expanded to include canonical mk_* prefixes alongside the legacy mns_live/test format.
 */
const API_KEY_PATTERN =
  /^(mns_(live|test)|mk_(live|test|sess|fed|admin)|uk_(live|test))_[a-z0-9]{20,64}$/i;

/**
 * A token of the scoped scheme (`{prefix}{keyId}_{secret}`, `mnemo_scoped_api_keys`,
 * verified by ScopedApiKeyAdapter when MNEMO_SCOPED_AUTH=1). The `mk_*` keys
 * `POST /admin/keys` mints (`mk_live_`/`mk_test_`/`mk_fed_` + 32 hex, rows in
 * `mnemo_api_keys`) match API_KEY_PATTERN and never this: a scoped key's body
 * always holds a second underscore, which the pattern forbids. Each key is
 * verified against the table it lives in, nothing falls back to the other.
 */
export function isScopedSchemeToken(token: string): boolean {
  // Break-glass and session keys exist only in the scoped scheme, where TOTP
  // and the per-type TTL are checked: never let one reach the bcrypt path.
  if (token.startsWith("mk_admin_") || token.startsWith("mk_sess_")) return true;
  return token.startsWith("mk_") && !API_KEY_PATTERN.test(token);
}

/**
 * Compute the HMAC-SHA256 lookup hash for a given API key token.
 * Uses MNEMO_KEY_PEPPER from env; an empty string is allowed in dev
 * (the HMAC still works, just with a zero-length key — insecure but functional).
 */
function computeLookupHash(token: string, pepper = process.env.MNEMO_KEY_PEPPER ?? ""): string {
  return createHmac("sha256", pepper).update(token).digest("hex");
}

export interface ApiKeyLookup {
  /** Return all non-revoked, non-expired rows (O(n) fallback for pre-0064 rows). */
  listActive(): Promise<
    ReadonlyArray<{
      id: string;
      keyHash: string;
      workspaceId: string;
      scopes: string[];
      plan: string;
      ipAllowlist?: string[];
      deprecatedAt?: Date | null;
      userId?: string | null;
      tenantId?: string | null;
      keyKind?: string | null;
      maxSensitivity?: string | null;
      /**
       * APP-026 — the row already has a lookup hash, so the O(1) path would have
       * found it: the O(n) fallback skips it instead of paying a bcrypt for it.
       */
      hasLookupHash?: boolean;
    }>
  >;
  /** O(1) lookup by HMAC hash. Returns null if the column is not set. */
  findByLookupHash?(hash: string): Promise<{
    id: string;
    keyHash: string;
    workspaceId: string;
    scopes: string[];
    plan: string;
    ipAllowlist?: string[];
    deprecatedAt?: Date | null;
    userId?: string | null;
    tenantId?: string | null;
    keyKind?: string | null;
    maxSensitivity?: string | null;
  } | null>;
  /** Lazy backfill: set lookup_hash for a key that didn't have one. */
  setLookupHash?(id: string, hash: string): Promise<void>;
  /**
   * Best-effort: update last_used_at for telemetry, for the authenticating key
   * (`mnemo_api_keys.id`) only — never for a workspace (CHAOS-2).
   */
  touch(keyId: string): Promise<void> | void;
  /**
   * Check if a user is a member of a target workspace (P33).
   * @deprecated Prefer `getWorkspaceMemberRole` — this only answers
   * membership, not the role needed to narrow scopes. Kept as a degraded
   * fallback (membership-gate with no scope narrowing) for lookups that
   * haven't implemented the role-aware method yet.
   */
  verifyWorkspaceMember?(userId: string, workspaceId: string): Promise<boolean>;
  /**
   * Return the caller's role in a workspace (owner/admin/write/read), or
   * null if not a member. Drives per-workspace scope narrowing (S4) —
   * supersedes `verifyWorkspaceMember` wherever available.
   */
  getWorkspaceMemberRole?(userId: string, workspaceId: string): Promise<string | null>;
}

export type AuthVariables = {
  trafficOrigin?: import("@mnemo-ai/types").TrafficOrigin;
  /** Password dashboard sessions have a user principal rather than an API key. */
  actorRefKind?: "key" | "user";
  workspaceId: string;
  apiKeyPrefix: string;
  scopes: ReadonlyArray<string>;
  /** User who issued this key — null for system/legacy keys without user binding. */
  userId?: string | null;
  /** Tenant this key belongs to — null for legacy keys without tenant binding. */
  tenantId?: string | null;
  /**
   * Caller's membership role in the effective workspace (owner/admin/write/
   * read), when resolvable — set by the role-narrowing step (S4). Observability
   * only (surfaced via /me, injected into agent context by session-start.sh);
   * the actual enforcement point is the narrowed `scopes` field above, not
   * this one — never gate a route on `workspaceRole` directly. `null` when
   * the key has no user binding, or the user has no membership row for this
   * workspace (narrowing degrades to the key's own static scopes in that case).
   */
  workspaceRole?: string | null;
  /** Rate-limiting plan tier (from mnemo_api_keys.plan). */
  plan: "free" | "pro" | "enterprise";
  /** Agent/actor ID for RBAC policy lookup (set by auth middleware from the key record) */
  actorId?: string;
  /**
   * Origin of the request (set by auth middleware). Threaded into every audit
   * entry so the §6 audit trail records who acted — agent/user/system/federation
   * — instead of collapsing everything to 'user'. Absent → adapter defaults.
   */
  actorType?: "agent" | "user" | "system" | "federation";
  /**
   * Per-key recall sensitivity ceiling (§5). Set by the scoped-key path from
   * the key grant; absent for legacy mns_* keys. Recall handlers combine it
   * with the process-wide ceiling via effectiveCeiling() (most restrictive
   * wins), so a key can only lower its own ceiling, never raise it.
   */
  maxSensitivity?: Sensitivity;
  /**
   * §Idempotency RDD9: the active Idempotency-Key for this request, set by the
   * idempotency middleware only when the request is a NEW keyed mutation.
   * Absent for unkeyed requests and replays.
   */
  idempotencyKey?: string;
  /**
   * §Idempotency RDD9: the recovery point this keyed request resumed from
   * ('started' on a fresh claim). Multi-phase handlers read this to skip
   * already-completed phases on retry.
   */
  idempotencyRecoveryPoint?: import("./idempotency.js").RecoveryPoint;
  /**
   * §Idempotency RDD9: phase recorder bound to (workspaceId, key). Multi-phase
   * handlers call this to advance the recovery point as each phase completes.
   * Absent for unkeyed requests.
   */
  idempotencyRecordPhase?: (phase: import("./idempotency.js").RecoveryPoint) => Promise<void>;
  /**
   * Set only by the dashboard bridge: true when the request carries a password
   * session whose user is a superadmin right now (resolveLiveSession, never a
   * JWT claim). The instance plane (routes/instance.ts) admits nothing else.
   */
  instanceSuperadmin?: boolean;
  /**
   * The workspace's home region (mnemo_workspace.region), set by the region
   * lock right after authentication (middleware/region.ts). Absent when the
   * workspace has none.
   */
  workspaceRegion?: string;
};

/**
 * Extract all auth variables from a Hono context in one call.
 *
 * Replaces the repeated pattern:
 *   const workspaceId = c.get("workspaceId");
 *   const actorId = c.get("actorId");
 *   ...
 *
 * Usage:
 *   const { workspaceId, actorId, scopes } = getAuthCtx(c);
 */
export function getAuthCtx(c: import("hono").Context<{ Variables: AuthVariables }>) {
  return {
    workspaceId: c.get("workspaceId"),
    actorId: c.get("actorId"),
    actorType: c.get("actorType"),
    apiKeyPrefix: c.get("apiKeyPrefix"),
    scopes: c.get("scopes") ?? ([] as ReadonlyArray<string>),
    plan: c.get("plan"),
    maxSensitivity: c.get("maxSensitivity"),
    userId: c.get("userId") ?? null,
    tenantId: c.get("tenantId") ?? null,
    workspaceRole: c.get("workspaceRole") ?? null,
  } as const;
}

export interface AuthOptions {
  trafficOrigins?: Readonly<Record<string, import("@mnemo-ai/types").TrafficOrigin>>;
  ttlMs?: number;
  maxEntries?: number;
  /** Optional telemetry handle for emitting mnemo.auth spans. */
  telemetry?: Telemetry;
  /**
   * p52-mfa-ip-denied-audit: narrow storage handle so the scoped (`mk_*`)
   * auth path can emit `ip_denied` / `mfa_verified` audit entries. Absent →
   * no audit emission (server can boot without adapter-postgres).
   */
  storage?: StorageAdapter;
  /**
   * Live user status. A key bound to a disabled user does not authenticate
   * while the user is disabled. Absent (no Postgres) → no lifecycle check.
   */
  userStatus?: Pick<UserStatusService, "get">;
}

/**
 * Refuse a key whose bound user is disabled, with the same 401 an unknown key
 * gets. Fails closed: an unavailable status is a 503, never "allowed".
 */
async function assertKeyUserEnabled(
  userStatus: Pick<UserStatusService, "get">,
  userId: string,
  adapter: "bearer" | "scoped"
): Promise<void> {
  let allowed;
  try {
    allowed = await keyUserAllowed(userStatus, userId);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    logger.warn(
      { errorCode: typeof code === "string" ? code : err instanceof Error ? err.name : "unknown" },
      "auth.user_status_unavailable"
    );
    throw new HttpError(503, "auth_unavailable", "Authentication service unavailable");
  }
  if (!allowed) {
    authFailuresTotal.inc({ adapter, reason: "user_disabled" });
    throw new UnauthorizedError("Invalid API key");
  }
}

/**
 * Verify an API key token against the lookup store.
 * Used by both the HTTP auth middleware and the WebSocket handshake.
 * Returns { workspaceId, scopes } on success, null on failure.
 */
/** Tokens that just failed both lookups: sha256(token) → time to forget it. */
const rejectedTokens = new Map<string, number>();
const REJECTED_TTL_MS = 30_000;
const REJECTED_MAX = 10_000;

function recentlyRejected(tokenId: string): boolean {
  const until = rejectedTokens.get(tokenId);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  rejectedTokens.delete(tokenId);
  return false;
}

function rememberRejected(tokenId: string): void {
  // ponytail: FIFO eviction by insertion order; an LRU if eviction ever matters.
  if (rejectedTokens.size >= REJECTED_MAX) {
    const oldest = rejectedTokens.keys().next().value;
    if (oldest !== undefined) rejectedTokens.delete(oldest);
  }
  rejectedTokens.set(tokenId, Date.now() + REJECTED_TTL_MS);
}

/** Test hook: forget the rejected-token cache. */
export function resetRejectedTokenCacheForTests(): void {
  rejectedTokens.clear();
}

export async function verifyApiKeyToken(
  lookup: ApiKeyLookup,
  token: string
): Promise<{
  workspaceId: string;
  scopes: string[];
  plan: string;
  actorId: string;
  ipAllowlist: string[];
  deprecatedAt?: Date | null;
  userId?: string | null;
  tenantId?: string | null;
  keyKind?: string | null;
  maxSensitivity?: string | null;
} | null> {
  if (!API_KEY_PATTERN.test(token)) return null;

  // ── O(1) fast path (migration 0064) ──────────────────────────────────────
  if (lookup.findByLookupHash) {
    const hash = computeLookupHash(token);
    let row = await lookup.findByLookupHash(hash);
    // Final review I3: stored lookup hashes are keyed with the pepper of the
    // day they were written. While a pepper change rolls out, set
    // MNEMO_KEY_PEPPER_PREVIOUS (the old value, possibly empty) so keys still
    // match, and each one is re-keyed to the current pepper on its next use.
    const previous = process.env.MNEMO_KEY_PEPPER_PREVIOUS;
    let rekey = false;
    if (!row && previous !== undefined) {
      row = await lookup.findByLookupHash(computeLookupHash(token, previous));
      rekey = row !== null && row !== undefined;
    }
    if (row) {
      const ok = await bcrypt.compare(token, row.keyHash);
      if (ok && rekey && lookup.setLookupHash) {
        Promise.resolve(lookup.setLookupHash(row.id, hash)).catch((err) => {
          logger.warn({ err }, "auth.lookup_hash_rekey_failed");
        });
      }
      if (ok) {
        return {
          workspaceId: row.workspaceId,
          scopes: row.scopes ?? [],
          plan: row.plan ?? "free",
          actorId: row.id,
          ipAllowlist: row.ipAllowlist ?? [],
          deprecatedAt: row.deprecatedAt ?? null,
          userId: row.userId ?? null,
          tenantId: row.tenantId ?? null,
          keyKind: row.keyKind ?? "workspace",
          maxSensitivity: row.maxSensitivity ?? null,
        };
      }
    }
  }

  // ── O(n) fallback for pre-0064 rows without lookup_hash ──────────────────
  // APP-026: an unknown token used to cost one bcrypt (cost 12) per ACTIVE key,
  // before any rate limit, so random tokens starved authentication. Only rows
  // the O(1) path cannot see are compared, and a token that just failed is not
  // tried again for a short while.
  const tokenId = createHash("sha256").update(token).digest("hex");
  if (recentlyRejected(tokenId)) return null;
  const candidates = await lookup.listActive();
  for (const row of candidates) {
    if (lookup.findByLookupHash && row.hasLookupHash === true) continue;
    const ok = await bcrypt.compare(token, row.keyHash);
    if (ok) {
      // Lazy backfill
      if (lookup.setLookupHash) {
        const hash = computeLookupHash(token);
        Promise.resolve(lookup.setLookupHash(row.id, hash)).catch((err) => {
          logger.warn({ err }, "auth.lookup_hash_backfill_failed");
        });
      }
      return {
        workspaceId: row.workspaceId,
        scopes: row.scopes ?? [],
        plan: row.plan ?? "free",
        actorId: row.id,
        ipAllowlist: row.ipAllowlist ?? [],
        deprecatedAt: row.deprecatedAt ?? null,
        userId: row.userId ?? null,
        tenantId: row.tenantId ?? null,
        keyKind: row.keyKind ?? "workspace",
        maxSensitivity: row.maxSensitivity ?? null,
      };
    }
  }

  rememberRejected(tokenId);
  return null;
}

/**
 * Transport-agnostic API key verifier. Checks cache first, then bcrypt.
 * Used by both the Hono middleware and the gRPC interceptor.
 */
export async function resolveApiKey(
  lookup: ApiKeyLookup,
  token: string,
  cache?: LRUCache<
    string,
    {
      workspaceId: string;
      scopes: string[];
      plan: string;
      actorId: string;
      ipAllowlist: string[];
      deprecatedAt?: Date | null;
      userId?: string | null;
      tenantId?: string | null;
      keyKind?: string | null;
      maxSensitivity?: string | null;
    }
  >
): Promise<{
  workspaceId: string;
  scopes: string[];
  plan: string;
  actorId: string;
  ipAllowlist: string[];
  deprecatedAt?: Date | null;
  userId?: string | null;
  tenantId?: string | null;
  keyKind?: string | null;
  maxSensitivity?: string | null;
} | null> {
  const cached = cache?.get(token);
  if (cached) return cached;
  const result = await verifyApiKeyToken(lookup, token);
  if (result) cache?.set(token, result);
  return result;
}


/**
 * §6 scoped-key (`mk_*`) authentication via ScopedApiKeyAdapter. Normalises the
 * adapter's AuthContext onto the same AuthVariables the rest of the app reads
 * (workspaceId / apiKeyPrefix / scopes / plan / actorId) so downstream RBAC,
 * scope enforcement, and rate limiting work identically for both key schemes.
 * Scoped keys have no plan tier yet → default to the most-restrictive "free".
 */
async function authenticateScoped(
  c: Context<{ Variables: AuthVariables }>,
  adapter: AuthAdapter,
  token: string,
  storage?: StorageAdapter,
  userStatus?: Pick<UserStatusService, "get">,
  resolveRole?: (userId: string, workspaceId: string) => Promise<string | null>
): Promise<void> {
  let result;
  try {
    const mfaToken = c.req.header("x-mnemo-mfa");
    result = await adapter.authenticate({
      apiKey: token,
      clientIp: clientIpOf(c),
      ...(mfaToken ? { mfaToken } : {}),
    });
  } catch (err) {
    logger.error({ err }, "auth.scoped_adapter_error");
    throw new UnauthorizedError("Authentication service unavailable");
  }
  if (!result.ok) {
    authFailuresTotal.inc({ adapter: "scoped", reason: result.code.toLowerCase() });
    logger.debug({ code: result.code, reason: result.reason }, "auth.scoped_rejected");
    // p52-mfa-ip-denied-audit: the adapter already knows *why* it rejected —
    // emit the audit entry (awaited, swallow-and-log) BEFORE throwing so a
    // rejected/aborted request still leaves an audit trail for security-
    // relevant denials (currently only ip_denied; MFA failure is intentionally
    // unaudited — see spec Notes).
    if (result.auditAction && result.workspaceId && storage) {
      await emitAudit(
        { storage },
        {
          workspaceId: result.workspaceId,
          actorId: formatActorRef("key", result.keyId ?? "unknown"),
          actorType: "agent",
          action: result.auditAction,
          resourceKind: "api_key",
          resourceId: result.keyId,
          isTerminal: false,
          ipAddress: clientIpOf(c),
          detail: { reason: result.reason },
        }
      );
    }
    if (result.code === "FORBIDDEN") throw new ForbiddenError(result.reason ?? "Forbidden");
    throw new UnauthorizedError(result.reason ?? "Invalid API key");
  }
  const ctx = result.context;
  if (!isWorkspaceId(ctx.workspaceId)) {
    logger.warn({ workspace_id: ctx.workspaceId }, "auth.invalid_workspace_id");
    return c.json({ error: "invalid_workspace" }, 400) as never;
  }
  if (ctx.userId && userStatus) await assertKeyUserEnabled(userStatus, ctx.userId, "scoped");
  // A user-bound scoped key is narrowed by its user's role in the workspace,
  // the same decision as for a user-bound mns_* key (auth-evaluate.ts): a
  // demoted user's keys lose what the new role does not carry.
  let scopes = ctx.scopes as ReadonlyArray<string>;
  let workspaceRole: string | null = null;
  if (ctx.userId && resolveRole) {
    const decision = await evaluateResolvedKey(
      { workspaceId: ctx.workspaceId, scopes, userId: ctx.userId },
      { clientIp: "", tokenIsUserKind: false, allowWorkspaceSwitch: false, now: Date.now() },
      { resolveRole, disableRoleScopes: workspaceRoleScopesDisabled }
    );
    if (!decision.ok) throw new ForbiddenError(decision.message);
    scopes = decision.scopes;
    workspaceRole = decision.workspaceRole;
    if (decision.roleNarrowed && workspaceRole) authScopeNarrowedTotal.inc({ role: workspaceRole });
  }
  // p52-mfa-ip-denied-audit: break-glass (mk_admin_) success re-presents TOTP
  // on every request, so this fires once per authenticated request (not once
  // per challenge) — a deliberate volume characteristic, not a bug.
  if (ctx.keyType === "mk_admin_" && storage) {
    await emitAudit(
      { storage },
      {
        workspaceId: ctx.workspaceId,
        actorId: formatActorRef("key", ctx.actorId),
        actorType: "agent",
        action: "mfa_verified",
        resourceKind: "api_key",
        resourceId: ctx.actorId,
        isTerminal: false,
        ipAddress: clientIpOf(c),
      }
    );
  }
  c.set("workspaceId", ctx.workspaceId);
  c.set("apiKeyPrefix", ctx.keyType ?? token.slice(0, 8));
  c.set("scopes", scopes);
  c.set("plan", "free");
  if (ctx.actorId) c.set("actorId", ctx.actorId);
  c.set("actorType", ctx.actorType);
  // Break-glass dual control keys on the human (rbac-policy.ts, break-glass.ts).
  if (ctx.userId) c.set("userId", ctx.userId);
  if (workspaceRole) c.set("workspaceRole", workspaceRole);
  // §5 per-key recall ceiling: only set when the key grant carries one. Legacy
  // mns_* keys never reach here, so they leave maxSensitivity undefined → the
  // process-wide MNEMO_SENSITIVITY_CEILING applies unchanged.
  if (ctx.maxSensitivity) c.set("maxSensitivity", ctx.maxSensitivity);
  if (ctx.keyDeprecation) {
    c.header("Deprecation", ctx.keyDeprecation.sunset);
    c.header("Sunset", ctx.keyDeprecation.sunset);
  }
}

export function createAuthMiddleware(
  lookup: ApiKeyLookup,
  opts: AuthOptions = {},
  scopedAdapter?: AuthAdapter
): MiddlewareHandler<{ Variables: AuthVariables }> {
  const cache = new LRUCache<
    string,
    {
      workspaceId: string;
      scopes: string[];
      plan: string;
      actorId: string;
      ipAllowlist: string[];
      deprecatedAt?: Date | null;
      userId?: string | null;
      maxSensitivity?: string | null;
    }
  >({
    max: opts.maxEntries ?? 10_000,
    ttl: opts.ttlMs ?? 60_000,
  });

  // Workspace-membership-role cache, keyed `${userId}:${workspaceId}`.
  // Deliberately SHORTER TTL than the key cache above — a role demotion
  // (e.g. admin -> read) must propagate faster than a full key revocation,
  // since it's the routine "reduce someone's access" operation, not the rare
  // "kill a credential" one.
  // lru-cache's value type must be non-nullish, so a "no role" result is
  // wrapped in { role: null } rather than cached as a bare null.
  const roleCache = new LRUCache<string, { role: string | null }>({
    max: Number(process.env.MNEMO_ROLE_CACHE_MAX ?? 5_000),
    ttl: Number(process.env.MNEMO_ROLE_CACHE_TTL_MS ?? 30_000),
  });
  // A member removal revokes the member's keys there and drops them from
  // these caches at once (auth-cache-registry.ts).
  registerAuthCaches(cache, roleCache);

  async function resolveWorkspaceRole(userId: string, workspaceId: string): Promise<string | null> {
    const key = `${userId}:${workspaceId}`;
    const cached = roleCache.get(key);
    if (cached) return cached.role;
    const role = lookup.getWorkspaceMemberRole
      ? await lookup.getWorkspaceMemberRole(userId, workspaceId)
      : null;
    roleCache.set(key, { role });
    return role;
  }

  return async (c, next) => {
    const span = opts.telemetry?.startSpan(MNEMO_SPAN_NAMES.auth, {});
    try {
      let header = c.req.header("authorization") ?? c.req.header("Authorization");
      // APP-024: a WebSocket upgrade cannot carry a header from a browser or the
      // SDK, so on that one path the key may come as ?token=. The socket handler
      // reads the same value (ws.ts wsTokenOf), so the scopes checked here and
      // the identity it uses are one key. No other path takes a query-string key.
      if (!header && /\/memory\/ws$/.test(c.req.path)) {
        const queryToken = c.req.query("token")?.trim();
        if (queryToken) header = `Bearer ${queryToken}`;
      }
      if (!header || !header.toLowerCase().startsWith("bearer ")) {
        authFailuresTotal.inc({ adapter: "bearer", reason: "missing_token" });
        span?.setAttribute("mnemo.error_code", "mnemo.auth.missing_key");
        throw new UnauthorizedError("Missing bearer token");
      }
      const token = header.slice("bearer ".length).trim();

      // §6 dark-launch: when the scoped subsystem is enabled, scoped-scheme `mk_*`
      // keys go through ScopedApiKeyAdapter (their `keyId_secret` body fails the
      // pattern, so this dispatch MUST precede the pattern check). Keys this
      // server mints at /admin/keys, `mk_*` included, stay on the bcrypt path.
      if (scopedAdapter && isScopedSchemeToken(token)) {
        await authenticateScoped(
          c,
          scopedAdapter,
          token,
          opts.storage,
          opts.userStatus,
          lookup.getWorkspaceMemberRole ? resolveWorkspaceRole : undefined
        );
        resolveTrafficOrigin(c, opts.trafficOrigins);
        return next();
      }

      if (!API_KEY_PATTERN.test(token)) {
        authFailuresTotal.inc({ adapter: "bearer", reason: "malformed" });
        span?.setAttribute("mnemo.error_code", "mnemo.auth.missing_key");
        throw new UnauthorizedError("Malformed API key");
      }

      const result = await resolveApiKey(lookup, token, cache);

      if (!result) {
        authFailuresTotal.inc({ adapter: "bearer", reason: "invalid_key" });
        logger.debug({ prefix: token.slice(0, 9) }, "auth.invalid_key");
        span?.setAttribute("mnemo.error_code", "mnemo.auth.missing_key");
        throw new UnauthorizedError("Invalid API key");
      }

      // IP allowlist, deprecation sunset, workspace switch and role narrowing
      // are decided in auth-evaluate.ts, which the gRPC interceptor shares.
      // This middleware maps the decision onto HTTP errors, metrics and logs.
      const decision = await evaluateResolvedKey(
        result,
        {
          clientIp: clientIpOf(c),
          // P33: Multi-workspace User Token target workspace resolution
          requestedWorkspaceId:
            c.req.header("x-workspace-id") ??
            c.req.header("X-Workspace-Id") ??
            c.req.query("workspaceId"),
          tokenIsUserKind: result.keyKind === "user" || token.startsWith("uk_"),
          allowWorkspaceSwitch: true,
          now: Date.now(),
        },
        {
          ...(lookup.getWorkspaceMemberRole ? { resolveRole: resolveWorkspaceRole } : {}),
          ...(lookup.verifyWorkspaceMember
            ? { verifyMember: lookup.verifyWorkspaceMember.bind(lookup) }
            : {}),
          disableRoleScopes: workspaceRoleScopesDisabled,
        }
      );

      // §6 key lifecycle (deep re-audit P0-2): while a deprecated key is in its
      // grace window, emit the standard Deprecation + Sunset headers so clients
      // rotate — also on a request denied by a later check.
      if (decision.deprecation) {
        c.header("Deprecation", decision.deprecation.deprecatedAt.toUTCString());
        c.header("Sunset", decision.deprecation.sunset.toUTCString());
      }

      if (!decision.ok) {
        switch (decision.reason) {
          case "ip_denied":
            logger.warn({ prefix: token.slice(0, 9) }, "auth.ip_denied");
            span?.setAttribute("mnemo.error_code", "mnemo.auth.insufficient_scope");
            throw new ForbiddenError(decision.message);
          case "deprecated_sunset":
            authFailuresTotal.inc({ adapter: "bearer", reason: "deprecated_sunset" });
            logger.warn({ prefix: token.slice(0, 9) }, "auth.deprecated_key_past_sunset");
            span?.setAttribute("mnemo.error_code", "mnemo.auth.expired_key");
            throw new UnauthorizedError(decision.message);
          case "missing_user_binding":
            authFailuresTotal.inc({ adapter: "bearer", reason: "missing_user_binding" });
            throw new ForbiddenError(decision.message);
          default:
            // not_user_token, not_member, verifier_missing. HTTP allows the
            // switch, so workspace_switch_unsupported never reaches here.
            authFailuresTotal.inc({ adapter: "bearer", reason: decision.reason });
            span?.setAttribute("mnemo.error_code", "mnemo.auth.insufficient_scope");
            throw new ForbiddenError(decision.message);
        }
      }

      // Accounts stage A: a key bound to a disabled user stops authenticating
      // (and works again once the user is re-enabled and the cache busted).
      if (result.userId && opts.userStatus) {
        await assertKeyUserEnabled(opts.userStatus, result.userId, "bearer");
      }

      if (decision.note === "role_lookup_degraded") {
        authFailuresTotal.inc({ adapter: "bearer", reason: "role_lookup_degraded" });
        logger.warn(
          { userId: result.userId, workspaceId: decision.workspaceId },
          "auth.role_lookup_degraded — lookup only implements verifyWorkspaceMember; scopes will not be narrowed by role"
        );
      } else if (decision.note === "home_role_missing") {
        logger.warn(
          { userId: result.userId, workspaceId: result.workspaceId },
          "auth.role_missing_home_workspace — user-bound key has no membership row for its own home workspace; scopes left unnarrowed"
        );
      }

      const effectiveWorkspaceId = decision.workspaceId;
      const workspaceRole = decision.workspaceRole;

      if (!isWorkspaceId(effectiveWorkspaceId)) {
        logger.warn({ workspace_id: effectiveWorkspaceId }, "auth.invalid_workspace_id");
        return c.json({ error: "invalid_workspace" }, 400);
      }

      // CHAOS-2: the credential that authenticated, not the (possibly
      // switched-into) workspace — that updated every key in it.
      Promise.resolve(lookup.touch(result.actorId)).catch((err) => {
        logger.warn({ err }, "auth.touch_failed");
      });

      // Role -> scope narrowing (S4) already happened in the evaluator; it can
      // only ever REMOVE scopes from the key's own static list.
      const effectiveScopes = decision.scopes;
      if (decision.roleNarrowed && workspaceRole) {
        authScopeNarrowedTotal.inc({ role: workspaceRole });
      }

      c.set("workspaceId", effectiveWorkspaceId);
      c.set("apiKeyPrefix", token.slice(0, 9));
      c.set("scopes", effectiveScopes);
      c.set("workspaceRole", workspaceRole);
      c.set("plan", (result.plan ?? "free") as "free" | "pro" | "enterprise");
      c.set("actorId", result.actorId);
      // Legacy mns_* keys are human/user keys (the scoped mk_* path carries a real
      // actorType). Stamp 'user' so recall audits from legacy keys are attributed.
      c.set("actorType", "user");
      // Gap 5: bind user_id and tenant_id from the key row so downstream handlers
      // can use them for multi-level recall (workspace + user + tenant facts).
      if (result.userId) c.set("userId", result.userId);
      if (result.tenantId) c.set("tenantId", result.tenantId);
      // P8: per-key sensitivity ceiling — unify mns_* and mk_* enforcement.
      // NULL/undefined = no per-key restriction; the process-wide ceiling governs.
      if (result.maxSensitivity) c.set("maxSensitivity", result.maxSensitivity as Sensitivity);
      resolveTrafficOrigin(c, opts.trafficOrigins);
      return next();
    } finally {
      span?.end();
    }
  };
}

export const BCRYPT_COST = 12;
export function hashApiKey(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

/** Compute and return the lookup_hash for a newly issued API key. */
export function apiKeyLookupHash(plaintext: string): string {
  return computeLookupHash(plaintext);
}
