/**
 * Public single-use link endpoints (accounts stage A, spec §3 and §4), under
 * /dashboard/auth, so they share its body limit, no-store, same-site and
 * JSON content-type rules (routes/dashboard-auth.ts mounts them):
 *
 *   GET  /dashboard/auth/link/:token  → { purpose, workspaceName, accountExists, expiresAt }
 *                                       | 404 link_invalid
 *   POST /dashboard/auth/link/:token  { password?, displayName? }
 *        → { ok: true, workspaceId, role, expiresAt } + a session cookie for the
 *          invited workspace (the personal one for account setup and reset)
 *        | 401 session_required: the account exists and the request has no
 *          live session of that account (sign in, then accept)
 *        | 404 link_invalid | 400 invalid_request / password_policy
 *
 * The token is the authority: no session is needed except to add an existing
 * account to a workspace. Only its SHA-256 reaches the database. Both
 * endpoints count toward the per-address sign-in budget. Whether the email
 * has an account is told to the link holder only (accepted risk, spec §4).
 * The password is hashed (bcrypt 12) before the consuming transaction.
 */
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import {
  passwordPolicyError,
  type DashboardLoginLimiter,
  type DashboardPasswordAuth,
} from "../dashboard-password.js";
import { asAppUser, readWorkspaceRole, resolveLiveSession } from "../dashboard-live-session.js";
import { issuePasswordSession, type dashboardCookieOptions } from "../dashboard-session-issue.js";
import { DASHBOARD_COOKIE, verifyDashboardToken } from "../dashboard-session.js";
import { emitAudit } from "../audit-emit.js";
import { resolveProvenance } from "../provenance.js";
import { GLOBAL_SENTINEL_ID } from "../config/WorkspaceConfigStore.js";
import { logger } from "../logging.js";
import { hashLinkToken, isLinkToken } from "../single-use-link.js";
import type { AuditAction } from "@mnemo-ai/types";

export interface DashboardLinkOptions {
  secret: string;
  cookieOptions: ReturnType<typeof dashboardCookieOptions>;
  passwordAuth: DashboardPasswordAuth | null;
  limiter: DashboardLoginLimiter;
  clientIp: (c: Context) => string;
  /** SQLSTATE or error class of an unexpected failure, safe to log. */
  errorCode: (err: unknown) => string;
}

interface DescribeRow {
  purpose: "invite" | "account_setup" | "password_reset";
  workspace_name: string | null;
  account_exists: boolean;
  expires_at: Date | string;
  email: string;
}

interface ConsumeRow {
  user_id: string;
  workspace_id: string | null;
  link_id: string;
  purpose: DescribeRow["purpose"];
  account_created: boolean;
}

const MAX_DISPLAY_NAME = 200;

export function mountDashboardLinks(app: Hono, deps: ServerDeps, opts: DashboardLinkOptions) {
  const sql = deps.metricsPgClient;
  const { limiter, passwordAuth } = opts;

  const invalidLink = (c: Context) =>
    c.json({ error: "link_invalid", message: "This link is invalid or has expired." }, 404);
  const unavailable = (c: Context) =>
    c.json({ error: "auth_unavailable", message: "Authentication service unavailable" }, 503);
  const log = (outcome: string, fields: Record<string, unknown> = {}) =>
    logger.info({ event: "dashboard.link", outcome, ...fields }, "dashboard single-use link");

  /** Per-address budget shared with sign-in (MNEMO_DASHBOARD_LOGIN_IP_BURST, default 30, per 15 minutes). */
  const limited = async (c: Context) => {
    const retry = await limiter.consumeIp(opts.clientIp(c) || "unknown");
    if (!retry) return null;
    c.header("Retry-After", String(retry));
    log("failure", { reason: "rate_limit" });
    return c.json({ error: "rate_limited", message: "Too many attempts. Try again later." }, 429);
  };

  const describe = async (token: string): Promise<DescribeRow | null> => {
    const rows = await asAppUser(
      sql!,
      "",
      (tx) =>
        tx<DescribeRow[]>`SELECT * FROM mnemosyne.mnemo_link_describe(${hashLinkToken(token)})`
    );
    return rows[0] ?? null;
  };

  /** The user of a live password session on this request, or null. */
  const sessionUser = async (c: Context): Promise<string | null> => {
    const cookie = getCookie(c, DASHBOARD_COOKIE);
    const payload = cookie ? await verifyDashboardToken(opts.secret, cookie) : null;
    if (!payload || payload.authMethod !== "password") return null;
    const live = await resolveLiveSession(deps, payload);
    return live?.userId ?? null;
  };

  app.get("/dashboard/auth/link/:token", async (c) => {
    c.header("Referrer-Policy", "no-referrer");
    const rate = await limited(c);
    if (rate) return rate;
    const token = c.req.param("token");
    if (!isLinkToken(token)) return invalidLink(c);
    if (!sql) return unavailable(c);
    let link: DescribeRow | null;
    try {
      link = await describe(token);
    } catch (err) {
      log("failure", { reason: "describe_unavailable", errorCode: opts.errorCode(err) });
      return unavailable(c);
    }
    if (!link) return invalidLink(c);
    return c.json({
      purpose: link.purpose,
      workspaceName: link.workspace_name,
      accountExists: link.account_exists,
      expiresAt: new Date(link.expires_at).toISOString(),
    });
  });

  app.post("/dashboard/auth/link/:token", async (c) => {
    c.header("Referrer-Policy", "no-referrer");
    const rate = await limited(c);
    if (rate) return rate;
    const token = c.req.param("token");
    if (!isLinkToken(token)) return invalidLink(c);
    if (!sql || !passwordAuth) return unavailable(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "invalid_request" }, 400);
    const { password, displayName } = body as { password?: unknown; displayName?: unknown };
    if (
      (password !== undefined &&
        (typeof password !== "string" || Buffer.byteLength(password, "utf8") > 72)) ||
      (displayName !== undefined &&
        (typeof displayName !== "string" || displayName.length > MAX_DISPLAY_NAME))
    )
      return c.json({ error: "invalid_request" }, 400);

    let link: DescribeRow | null;
    try {
      link = await describe(token);
    } catch (err) {
      log("failure", { reason: "describe_unavailable", errorCode: opts.errorCode(err) });
      return unavailable(c);
    }
    if (!link) {
      log("failure", { reason: "link_invalid" });
      return invalidLink(c);
    }

    // A new account or a reset chooses a password; an existing account joins
    // a workspace as itself, through its own live session.
    const needsPassword = link.purpose === "password_reset" || !link.account_exists;
    let passwordHash: string | null = null;
    let actingUser: string | null = null;
    if (needsPassword) {
      if (typeof password !== "string" || !password)
        return c.json({ error: "invalid_request", message: "Choose a password." }, 400);
      const policy = passwordPolicyError(password, link.email);
      if (policy) return c.json({ error: "password_policy", message: policy }, 400);
      passwordHash = await passwordAuth.hashNew(password);
    } else {
      try {
        actingUser = await sessionUser(c);
      } catch (err) {
        log("failure", { reason: "session_unavailable", errorCode: opts.errorCode(err) });
        return unavailable(c);
      }
    }

    const sessionRequired = () =>
      c.json(
        { error: "session_required", message: "Sign in to this account to accept the invitation." },
        401
      );
    if (!needsPassword && !actingUser) return sessionRequired();

    let used: ConsumeRow;
    try {
      const rows = await asAppUser(
        sql,
        "",
        (tx) => tx<ConsumeRow[]>`
          SELECT * FROM mnemosyne.mnemo_link_consume(
            ${hashLinkToken(token)}, ${passwordHash}, ${actingUser},
            ${typeof displayName === "string" ? displayName : null})`
      );
      used = rows[0]!;
    } catch (err) {
      const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown };
      if (code === "P0002" && message === "link_invalid") {
        log("failure", { reason: "link_invalid" });
        return invalidLink(c);
      }
      if (code === "28000" && message === "session_required") return sessionRequired();
      // The account appeared or vanished since the link was read: read it again.
      if (code === "22023" && message === "password_required")
        return c.json({ error: "invalid_request", message: "Choose a password." }, 400);
      if (code === "23505") return c.json({ error: "conflict" }, 409);
      log("failure", { reason: "consume_unavailable", errorCode: opts.errorCode(err) });
      return unavailable(c);
    }

    const userId = used.user_id;
    deps.userStatus?.invalidate(userId);
    log("success", { purpose: used.purpose, userId, accountCreated: used.account_created });

    // The person who used the link is the actor of what it did.
    const vars = c as unknown as Context<{ Variables: AuthVariables }>;
    vars.set("actorType", "user");
    vars.set("actorRefKind", "user");
    vars.set("actorId", userId);
    vars.set("userId", userId);
    const provenance = resolveProvenance(vars);
    const audit = (
      action: AuditAction,
      workspaceId: string,
      resourceKind: string,
      resourceId: string,
      detail?: Record<string, unknown>
    ) =>
      emitAudit(deps, {
        workspaceId,
        actorType: provenance.actorType,
        actorId: provenance.actorId,
        action,
        resourceKind,
        resourceId,
        ...(detail ? { detail } : {}),
        isTerminal: false,
      });
    if (used.account_created)
      await audit("user_created", GLOBAL_SENTINEL_ID, "user", userId, { via: used.purpose });
    if (used.purpose === "invite" && used.workspace_id)
      await audit("invitation_accepted", used.workspace_id, "invitation", used.link_id);
    if (used.purpose === "password_reset")
      await audit("password_reset", GLOBAL_SENTINEL_ID, "user", userId);

    if (!used.workspace_id) return c.json({ ok: true, workspaceId: null });
    try {
      const role = await readWorkspaceRole(sql, userId, used.workspace_id);
      if (!role) return c.json({ ok: true, workspaceId: null });
      const { expiresAt } = await issuePasswordSession(
        c,
        deps,
        opts.secret,
        // An existing account accepts only from its own live session (actingUser): the new
        // token continues that session. A new account or a reset starts a new one.
        { userId, workspaceId: used.workspace_id, role, continueSession: actingUser === userId },
        opts.cookieOptions
      );
      try {
        await passwordAuth.touchLogin(userId);
      } catch (err) {
        log("touch_login_failed", { userId, errorCode: opts.errorCode(err) });
      }
      return c.json({ ok: true, workspaceId: used.workspace_id, role, expiresAt });
    } catch (err) {
      // The link did its work; the person signs in normally.
      log("failure", { reason: "session_unavailable", errorCode: opts.errorCode(err) });
      return c.json({ ok: true, workspaceId: null });
    }
  });
}
