/**
 * Dashboard session layer — JWT mint/verify for the web dashboard.
 *
 * The browser dashboard never stores a raw API key. Login exchanges an API key
 * for a short-lived HS256 JWT carried in an HttpOnly cookie
 * (`mnemo_dash_token`). The JWT payload holds only derived, non-secret data:
 * workspaceId, keyPrefix, scopes, plan — never the key itself.
 *
 * Signing secret: MNEMO_DASHBOARD_SECRET (min 32 bytes). When unset, the
 * dashboard auth routes are not mounted at all — the server runs headless
 * exactly as before. Spec: openspec/dashboard/spec.md §2.
 */
import { createHash, randomUUID } from "node:crypto";
import { sign, verify } from "hono/jwt";

export const DASHBOARD_COOKIE = "mnemo_dash_token";

/** 8 hours, matching the Engram-derived session model (spec §2.2). */
export const DASHBOARD_SESSION_TTL_SECONDS = 8 * 60 * 60;

/** Cookie path — the dashboard app and its auth endpoints all live under /dashboard. */
export const DASHBOARD_COOKIE_PATH = "/dashboard";

export type DashboardRole = "admin" | "contributor" | "viewer";

export interface DashboardSessionPayload {
  workspaceId: string;
  keyPrefix: string;
  scopes: string[];
  plan: string;
  /**
   * Bare principal id — resolveProvenance() applies the `key:` prefix
   * for API key sessions and `user:` for password sessions. Required, non-empty. Load-bearing: a payload lacking it
   * fails verification (see verifyDashboardToken).
   */
  actorId: string;
  /** The platform account; always present for password sessions. */
  userId: string | null;
  /** Absent for existing API key sessions. */
  authMethod?: "password";
  /**
   * Set only on a session a superadmin opened from the instance plane. Lets a
   * live superadmin without membership in the workspace read it; ignored once
   * they are no longer superadmin (see resolveLiveSession).
   */
  viaInstance?: true;
  /** Random per session, signed. Required: a token without one is refused. */
  jti: string;
  /**
   * The SHA-256 of the signed jti, set by verifyDashboardToken from the verified
   * payload. Signing out stores it in mnemo_dashboard_session_revocation (0059).
   * Never derived from the token string: base64url lets one signature be spelled
   * several ways, and every spelling verifies.
   */
  sid?: string;
  iat: number;
  exp: number;
  /** hono/jwt JWTPayload index-signature compatibility. */
  [key: string]: unknown;
}

/**
 * Read and validate MNEMO_DASHBOARD_SECRET.
 *
 * - unset/empty → null (dashboard disabled — not an error)
 * - set but shorter than 32 bytes → throws (misconfiguration; boot must crash)
 * - valid → the secret string
 */
export function readDashboardSecret(
  env: Record<string, string | undefined> = process.env
): string | null {
  const secret = env["MNEMO_DASHBOARD_SECRET"];
  if (!secret) return null;
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(
      "MNEMO_DASHBOARD_SECRET must be at least 32 bytes (got " +
        `${Buffer.byteLength(secret, "utf8")}). Generate one with: openssl rand -hex 32`
    );
  }
  return secret;
}

/**
 * Derive the UI display role from the session's scopes (spec §2.5).
 * admin:keys + memory:admin → admin; memory:write → contributor; else viewer.
 */
export function deriveDashboardRole(scopes: ReadonlyArray<string>): DashboardRole {
  if (scopes.includes("admin:keys") && scopes.includes("memory:admin")) return "admin";
  if (scopes.includes("memory:write")) return "contributor";
  return "viewer";
}

export interface MintInput {
  workspaceId: string;
  keyPrefix: string;
  scopes: ReadonlyArray<string>;
  plan: string;
  /** Bare principal id — mirrors DashboardSessionPayload.actorId. */
  actorId: string;
  userId: string | null;
  /** Absent for existing API key sessions. */
  authMethod?: "password";
  /** Mirrors DashboardSessionPayload.viaInstance. */
  viaInstance?: true;
  /**
   * The session to continue (a workspace switch, an "open", a create): the new token
   * keeps it, so one sign-out ends every token of the browser session. New when absent.
   */
  jti?: string;
}

/** Mint a signed dashboard session JWT. `now` is injectable for tests. */
export async function mintDashboardToken(
  secret: string,
  input: MintInput,
  now: number = Date.now()
): Promise<{ token: string; expiresAt: string }> {
  const iat = Math.floor(now / 1000);
  const exp = iat + DASHBOARD_SESSION_TTL_SECONDS;
  const token = await sign(
    {
      workspaceId: input.workspaceId,
      keyPrefix: input.keyPrefix,
      scopes: [...input.scopes],
      plan: input.plan,
      actorId: input.actorId,
      userId: input.userId,
      ...(input.authMethod ? { authMethod: input.authMethod } : {}),
      ...(input.viaInstance === true ? { viaInstance: true } : {}),
      // The session's identity, which sign-out revokes (see `sid`). Unique, so two
      // sign-ins in the same second are two sessions.
      jti: input.jti ?? randomUUID(),
      iat,
      exp,
    },
    secret,
    "HS256"
  );
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Hex SHA-256 of a session's jti: what the revocation table stores. */
export function sessionIdOf(jti: string): string {
  return createHash("sha256").update(jti).digest("hex");
}

/**
 * Verify a dashboard session JWT. Returns the payload on success, null on any
 * failure (bad signature, expired, malformed, wrong shape). Never throws.
 */
export async function verifyDashboardToken(
  secret: string,
  token: string
): Promise<DashboardSessionPayload | null> {
  try {
    const payload = (await verify(token, secret, "HS256")) as Record<string, unknown>;
    if (
      typeof payload["workspaceId"] !== "string" ||
      typeof payload["keyPrefix"] !== "string" ||
      !Array.isArray(payload["scopes"]) ||
      typeof payload["plan"] !== "string" ||
      typeof payload["exp"] !== "number" ||
      typeof payload["actorId"] !== "string" ||
      payload["actorId"] === "" ||
      // A token without a jti predates server-side sign-out and could not be revoked:
      // refused, so those sessions sign in again once (AUD-007).
      typeof payload["jti"] !== "string" ||
      payload["jti"] === ""
    ) {
      return null;
    }
    if (
      payload["authMethod"] === "password" &&
      (typeof payload["userId"] !== "string" || !payload["userId"])
    )
      return null;
    // userId is legitimately absent for keys with no user binding — coerce
    // anything that isn't a string to null rather than rejecting the token
    // (actorId alone is load-bearing; see design's "userId strictness" ADR).
    payload["userId"] = typeof payload["userId"] === "string" ? payload["userId"] : null;
    // Only the literal `true` means an instance-opened session.
    if (payload["viaInstance"] !== true) delete payload["viaInstance"];
    payload["sid"] = sessionIdOf(payload["jti"]);
    return payload as unknown as DashboardSessionPayload;
  } catch {
    return null;
  }
}
