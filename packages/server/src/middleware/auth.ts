/**
 * Mnemosyne — Auth middleware (TASK-7002).
 *
 * Responsibilities:
 *  1. Extract raw credentials from the incoming request.
 *  2. Delegate to an injected AuthAdapter.authenticate().
 *  3. Set c.var.auth (AuthContext) + c.var.workspaceId on success.
 *  4. Return RFC 6750 401 with WWW-Authenticate on failure.
 *
 * The middleware is transport-agnostic: it builds a RawCredentials bag
 * and passes it to the adapter — Bearer tokens, API keys, and mTLS
 * client certificates are all handled by the adapter, not here.
 *
 * Constant-time comparison:
 *   ScopedApiKeyAdapter (Team/Cloud mode) MUST use crypto.timingSafeEqual
 *   for secret verification. The middleware does not call timingSafeEqual
 *   itself — it delegates entirely to the injected adapter. The adapter
 *   implementation is responsible for timing-safe verification.
 *
 *   Example (in ScopedApiKeyAdapter.authenticate):
 *     const isValid = crypto.timingSafeEqual(
 *       Buffer.from(computedHash), Buffer.from(storedHash)
 *     )
 *
 * GUC note:
 *   The PostgreSQL GUC `mnemosyne.workspace_id` is set per-transaction by
 *   DrizzleStorageAdapter (mnemo_set_workspace). The middleware does NOT
 *   call SET LOCAL directly — doing so outside a transaction is a no-op
 *   under connection pooling. The workspaceId placed in c.var is used by
 *   each storage call to set the GUC within its own transaction.
 */

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

import { UnauthorizedError } from "../errors.js";
import { logger } from "../logging.js";

// ─── Auth type definitions (structural — matches @mnemo-ai/types/security) ──
// Defined locally so this file compiles without @mnemo-ai/types in deps.
// When @mnemo-ai/types is added to server's dependencies, replace with:
//   import type { AuthAdapter, AuthContext, RawCredentials } from "@mnemo-ai/types";

export interface RawCredentials {
  bearer?: string;
  apiKey?: string;
  clientCert?: Uint8Array; // DER-encoded mTLS peer certificate
  /** TOTP code for break-glass (mk_admin_) keys — from x-mnemo-mfa header. */
  mfaToken?: string;
  /** Originating IP address (extracted from request for anomaly detection). */
  clientIp?: string;
  inherited?: {
    workspaceId: string;
    actorId: string;
    actorType: "agent" | "user" | "system";
    scopes: string[];
    hostSignature?: string;
  };
}

export interface AuthContext {
  workspaceId: string;
  actorId: string;
  actorType: "agent" | "user" | "system" | "federation";
  scopes: ReadonlyArray<string>;
  keyType?: string;
  federationPeer?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  /** Set by ScopedApiKeyAdapter when the key is deprecated but within grace period. */
  keyDeprecation?: { deprecated: true; sunset: string };
}

export type AuthResult =
  | { ok: true; context: AuthContext }
  | {
      ok: false;
      code: "UNAUTHORIZED" | "FORBIDDEN" | "TOKEN_EXPIRED" | "REVOKED" | "INVALID";
      reason: string;
    };

export interface AuthAdapter {
  readonly id: string;
  authenticate(credentials: RawCredentials): Promise<AuthResult>;
  authorize(context: AuthContext, operation: { action: string; resource?: string; workspaceId?: string }): Promise<void>;
  healthCheck(): Promise<{ status: "healthy" | "degraded" | "down"; latencyMs?: number }>;
}

// Re-export timingSafeEqual for use by adapter implementations so they
// don't need to import node:crypto themselves.
export { timingSafeEqual };

/**
 * Hono c.var shape set by this middleware.
 * Downstream handlers get workspaceId directly (no extra getEntity call).
 */
export type V3AuthVariables = {
  auth: AuthContext;
  workspaceId: string;
};

/** Minimum token length to reject trivially-malformed tokens early. */
const MIN_TOKEN_LENGTH = 16;

/**
 * Build the auth Hono middleware.
 *
 * @param adapter - AuthAdapter implementation. Injected by the server
 *   factory; never instantiated inside this function.
 *
 * Usage:
 *   const v1 = new OpenAPIHono<{ Variables: V3AuthVariables }>();
 *   v1.use("*", createV3AuthMiddleware(deps.auth));
 */
export function createV3AuthMiddleware(
  adapter: AuthAdapter,
): MiddlewareHandler<{ Variables: V3AuthVariables }> {
  return async (c, next) => {
    const credentials = extractCredentials(c.req.raw);

    if (!hasAnyCredential(credentials)) {
      return sendUnauthorized(c, "missing_credentials", "No credentials provided");
    }

    let result;
    try {
      result = await adapter.authenticate(credentials);
    } catch (err) {
      logger.error({ err }, "auth.adapter_error");
      throw new UnauthorizedError("Authentication service unavailable");
    }

    if (!result.ok) {
      const code = result.code.toLowerCase() as Lowercase<typeof result.code>;
      logger.debug(
        { code, reason: result.reason },
        "auth.rejected",
      );
      return sendUnauthorized(
        c,
        code,
        result.reason,
      );
    }

    c.set("auth", result.context);
    c.set("workspaceId", result.context.workspaceId);

    await next();

    // T2.6 — Emit deprecation headers on deprecated (but still valid) keys.
    if (result.context.keyDeprecation) {
      const { sunset } = result.context.keyDeprecation;
      c.header("Deprecation", sunset);
      c.header("Sunset", sunset);
      c.header("Mnemosyne-Key-Deprecated", "true");
    }
  };
}

// ─── Trusted-proxy boundary ──────────────────────────────────────────────────
//
// MNEMO_TRUSTED_PROXY_IP: when set, the x-mnemo-client-cert header is ONLY
// trusted when the immediate upstream IP matches this value. Any other source
// is silently ignored to prevent header spoofing by untrusted callers.
//
// When MNEMO_TRUSTED_PROXY_IP is not set, the header is trusted from any
// source (backward-compatible behaviour for single-node / dev deployments).
//
// See docs/architecture/MTLS_BOUNDARY.md for the full trust-model.

const TRUSTED_PROXY_IP = process.env["MNEMO_TRUSTED_PROXY_IP"];

/**
 * Return the immediate upstream IP for a Fetch API Request.
 *
 * In raw node:http mode (no Hono Request socket access) the best we can
 * do is read the first X-Forwarded-For entry, which is set by the TLS
 * terminator before it forwards to us.  If the terminator is the *only*
 * hop allowed to reach this process, X-Forwarded-For[0] IS the proxy IP.
 */
function extractRemoteAddr(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    return xff.split(",")[0]!.trim();
  }
  return "";
}

// ─── Credential extraction ────────────────────────────────────────────────────

function extractCredentials(req: Request): RawCredentials {
  const credentials: RawCredentials = {};

  // 1. Authorization: Bearer <token>
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const lower = authHeader.toLowerCase();
    if (lower.startsWith("bearer ")) {
      const token = authHeader.slice(7).trim();
      if (token.length >= MIN_TOKEN_LENGTH) {
        credentials.bearer = token;
      }
    }
  }

  // 2. X-Mnemo-Key: <api-key>
  //    Preferred for server-to-server — avoids caching by proxies that
  //    treat Authorization as opaque.
  const apiKeyHeader = req.headers.get("x-mnemo-key");
  if (apiKeyHeader && apiKeyHeader.length >= MIN_TOKEN_LENGTH) {
    credentials.apiKey = apiKeyHeader.trim();
  }

  // 3. mTLS client certificate — passed through by the TLS terminator
  //    as a DER-encoded binary in the X-Mnemo-Client-Cert header
  //    (base64url encoded). Federation peers use this path.
  //
  //    Trusted-proxy guard: if MNEMO_TRUSTED_PROXY_IP is configured, only
  //    accept this header when the immediate upstream IP matches.  Otherwise
  //    silently ignore it — a spoofed header from an untrusted caller must
  //    never grant certificate-level access.
  const certHeader = req.headers.get("x-mnemo-client-cert");
  const fromTrustedProxy =
    !TRUSTED_PROXY_IP || extractRemoteAddr(req) === TRUSTED_PROXY_IP;
  if (certHeader && fromTrustedProxy) {
    try {
      const decoded = Buffer.from(certHeader, "base64url");
      if (decoded.length > 0) {
        credentials.clientCert = new Uint8Array(decoded);
      }
    } catch {
      // Malformed cert header — let the adapter reject it
    }
  }

  // 4. Inherited context — for in-process plugins (EMBEDDED mode).
  //    The host passes workspace context via a trusted internal header.
  //    Only accepted on loopback / unix socket in production.
  const inheritedHeader = req.headers.get("x-mnemo-inherited-ctx");
  if (inheritedHeader) {
    try {
      credentials.inherited = JSON.parse(inheritedHeader) as RawCredentials["inherited"];
    } catch {
      // Malformed — ignore; adapter will reject if no other credential matches
    }
  }

  // 5. T2.6 — Break-glass MFA token (6-digit TOTP for mk_admin_ keys).
  const mfaHeader = req.headers.get("x-mnemo-mfa");
  if (mfaHeader) {
    credentials.mfaToken = mfaHeader.trim();
  }

  // 6. Client IP — used by anomaly detection.
  //    Prefer X-Forwarded-For (set by trusted reverse proxy), fall back to
  //    CF-Connecting-IP (Cloudflare), then X-Real-IP.
  const xForwardedFor = req.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    // Take the first (leftmost) address — the actual originating client.
    credentials.clientIp = xForwardedFor.split(",")[0]!.trim();
  } else {
    const cfIp = req.headers.get("cf-connecting-ip");
    const realIp = req.headers.get("x-real-ip");
    credentials.clientIp = (cfIp ?? realIp) ?? undefined;
  }

  return credentials;
}

function hasAnyCredential(c: RawCredentials): boolean {
  return !!(c.bearer || c.apiKey || c.clientCert || c.inherited);
}

// ─── 401 helper ──────────────────────────────────────────────────────────────

function sendUnauthorized(
  c: Parameters<MiddlewareHandler>[0],
  code: string,
  reason: string,
): Response {
  // RFC 6750 §3 — Bearer token challenges
  c.header(
    "WWW-Authenticate",
    `Bearer realm="mnemosyne", charset="UTF-8", error="${code}", error_description="${reason}"`,
  );
  return c.json(
    {
      error: {
        code: "unauthorized",
        message: reason,
      },
    },
    401,
  );
}
