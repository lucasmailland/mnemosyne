/**
 * Dashboard auth routes — session cookie layer for the web dashboard.
 *
 * Mounted on the ROOT app (not the auth-gated v1 router) because login carries
 * the API key in the request body, not the Authorization header — the bearer
 * middleware would 401 it before the handler ran. Same placement rationale as
 * mountBootstrap (routes/bootstrap.ts).
 *
 *   POST /dashboard/auth/login    { apiKey } → Set-Cookie mnemo_dash_token
 *   POST /dashboard/auth/logout   revokes this session on the server, clears the cookie
 *   GET  /dashboard/auth/session  cookie → { workspaceId, keyPrefix, scopes, plan, role,
 *                                 email, isSuperadmin, viaInstance } (scopes and role are live)
 *   GET  /dashboard/auth/link/:token, POST /dashboard/auth/link/:token
 *                                 single-use links (routes/dashboard-links.ts)
 *
 * Plus two aliases so the Next.js app can proxy a single /dashboard/* prefix:
 *
 *   GET  /dashboard/bootstrap/status → GET  /bootstrap/status
 *   POST /dashboard/bootstrap        → POST /bootstrap
 *
 * All routes are no-ops (never mounted) unless MNEMO_DASHBOARD_SECRET is set —
 * a headless server keeps exactly its previous surface. Spec §2, ENGRAM gap
 * analysis §5.3.
 */
import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { bodyLimit } from "hono/body-limit";
import {
  DashboardLoginLimiter,
  DashboardPasswordAuth,
  PostgresCredentialStore,
  emailIdentifier,
  normalizeEmail,
  type Membership,
} from "../dashboard-password.js";

import { isScopedSchemeToken, verifyApiKeyToken } from "../auth.js";
import { keyUserAllowed } from "../auth-evaluate.js";
import {
  resolveLiveSession,
  revokeDashboardSession,
  waitForSessionEpoch,
} from "../dashboard-live-session.js";
import {
  LAST_WORKSPACE_COOKIE,
  dashboardCookieOptions,
  issuePasswordSession,
} from "../dashboard-session-issue.js";
import { mountDashboardLinks } from "./dashboard-links.js";
import { emitAudit } from "../audit-emit.js";
import { GLOBAL_SENTINEL_ID } from "../config/WorkspaceConfigStore.js";
import { formatActorRef } from "@mnemo-ai/types";
import type { ServerDeps } from "../deps.js";
import { ipInCidr } from "@mnemo-ai/core";
import { logger } from "../logging.js";
import {
  DASHBOARD_COOKIE,
  DASHBOARD_COOKIE_PATH,
  DASHBOARD_SESSION_TTL_SECONDS,
  deriveDashboardRole,
  mintDashboardToken,
  readDashboardSecret,
  verifyDashboardToken,
} from "../dashboard-session.js";
import { clientIpOf } from "../client-ip.js";


/**
 * A request is "plain navigation" when the browser is doing a top-level
 * document load (link click, address bar). Fetch/XHR/HTMX get a 401 +
 * HX-Redirect header instead of a 303 so client code can react (spec §2:
 * copy Engram's HTMX session-failure pattern exactly).
 */
function isPlainNavigation(c: Context): boolean {
  if (c.req.header("hx-request") === "true") return false;
  const secFetchDest = c.req.header("sec-fetch-dest");
  if (secFetchDest) return secFetchDest === "document";
  return (c.req.header("accept") ?? "").includes("text/html");
}

export function mountDashboardAuth(app: Hono, deps: ServerDeps): void {
  // Throws on a set-but-short secret: createApp fails fast on misconfiguration
  // (index.ts validates earlier for a cleaner boot error message).
  const secret = readDashboardSecret();
  if (!secret) {
    logger.info("mountDashboardAuth: MNEMO_DASHBOARD_SECRET not set — dashboard auth disabled");
    return;
  }

  const insecureCookie = process.env.MNEMO_DASHBOARD_INSECURE_COOKIE === "true";
  if (insecureCookie) {
    logger.warn(
      "MNEMO_DASHBOARD_INSECURE_COOKIE=true — dashboard cookie sent without Secure flag (dev only)"
    );
  }

  const passwordAuth =
    deps.dashboardPasswordAuth ??
    (deps.metricsPgClient
      ? new DashboardPasswordAuth(new PostgresCredentialStore(deps.metricsPgClient))
      : null);
  const limiter = new DashboardLoginLimiter(deps.rateLimitBackend);
  const CHOICE_COOKIE = "mnemo_dash_choice";
  const cookieOptions = dashboardCookieOptions();
  const invalid = (c: Context) =>
    c.json({ error: "invalid_credentials", message: "Invalid email or password." }, 401);
  const unavailable = (c: Context) =>
    c.json({ error: "auth_unavailable", message: "Authentication service unavailable" }, 503);
  const audit = (outcome: string, fields: Record<string, unknown> = {}) =>
    logger.info(
      { event: "dashboard.password_auth", outcome, ...fields },
      "dashboard authentication"
    );
  /**
   * Diagnostic class of an unexpected failure, safe to log: a Postgres SQLSTATE
   * (e.g. 42501 for an RLS/permission denial) or the error's class name. Never
   * the message, which can carry SQL text or connection details.
   */
  const errorCode = (err: unknown): string => {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/i.test(code)) return code;
    return err instanceof Error ? err.name : "unknown";
  };
  /**
   * Sign-ins in the security audit, under the global workspace. A failure
   * carries the email's hash only, never the email or the password; a success
   * names the user. Not awaited: the write takes the audit chain's lock, and a
   * sign-in must answer with the same status and timing whether it lands or
   * not (emitAudit never rejects).
   */
  const auditLogin = (
    outcome:
      | { action: "login_success"; userId: string; workspaceId: string }
      | { action: "login_failure"; identifier: string; reason: "invalid_credentials" | "disabled" }
  ) => {
    void emitAudit(
      deps,
      outcome.action === "login_success"
        ? {
            workspaceId: GLOBAL_SENTINEL_ID,
            actorType: "user",
            actorId: formatActorRef("user", outcome.userId),
            action: "login_success",
            resourceKind: "user",
            resourceId: outcome.userId,
            detail: { workspaceId: outcome.workspaceId },
            isTerminal: false,
          }
        : {
            workspaceId: GLOBAL_SENTINEL_ID,
            actorType: "system",
            actorId: formatActorRef("system", "dashboard-login"),
            action: "login_failure",
            resourceKind: "login",
            detail: { identifier: outcome.identifier, reason: outcome.reason },
            isTerminal: false,
          }
    );
  };
  const limited = async (c: Context, identifier: string) => {
    const retry = await limiter.consume(clientIpOf(c) || "unknown", identifier);
    if (!retry) return null;
    c.header("Retry-After", String(retry));
    audit("failure", { reason: "rate_limit", identifier: emailIdentifier(identifier) });
    return c.json({ error: "rate_limited", message: "Too many attempts. Try again later." }, 429);
  };
  const finish = async (c: Context, userId: string, member: Membership) => {
    const { session, expiresAt } = await issuePasswordSession(
      c,
      deps,
      secret,
      { userId, workspaceId: member.id, role: member.role },
      cookieOptions
    );
    deleteCookie(c, CHOICE_COOKIE, { path: DASHBOARD_COOKIE_PATH });
    try {
      // Informational: a failed stamp must not refuse a verified sign-in.
      await passwordAuth?.touchLogin(userId);
    } catch (err) {
      audit("touch_login_failed", { userId, errorCode: errorCode(err) });
    }
    audit("success", { userId, workspaceId: member.id });
    auditLogin({ action: "login_success", userId, workspaceId: member.id });
    return c.json({ ...session, role: deriveDashboardRole(session.scopes), expiresAt });
  };
  // Bound anonymous bcrypt requests before JSON parsing. Browser mutations use
  // JSON and same-site cookies; reject explicit cross-origin requests as well.
  app.use("/dashboard/auth/*", bodyLimit({ maxSize: 4096 }));
  app.use("/dashboard/auth/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method === "POST") {
      if (c.req.header("sec-fetch-site") === "cross-site")
        return c.json({ error: "invalid_origin" }, 403);
      if (
        c.req.path !== "/dashboard/auth/logout" &&
        !/^application\/json(?:;|$)/i.test(c.req.header("content-type") ?? "")
      )
        return c.json({ error: "invalid_content_type" }, 400);
    }
    return next();
  });

  // Single-use links (invitations, account setup, password reset).
  mountDashboardLinks(app, deps, {
    secret,
    cookieOptions,
    passwordAuth,
    limiter,
    clientIp: clientIpOf,
    errorCode,
  });

  app.post("/dashboard/auth/workspace", async (c) => {
    if (!passwordAuth) return unavailable(c);
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body || typeof body.workspaceId !== "string")
      return c.json({ error: "invalid_request" }, 400);
    try {
      const token = getCookie(c, CHOICE_COOKIE);
      let choice: Record<string, unknown>;
      try {
        choice = token ? await verify(token, secret, "HS256") : {};
      } catch {
        return invalid(c);
      }
      if (
        choice.purpose !== "dashboard-workspace-choice" ||
        typeof choice.userId !== "string" ||
        typeof choice.version !== "string"
      )
        return invalid(c);
      const member = await passwordAuth.select(choice.userId, choice.version, body.workspaceId);
      if (!member) {
        audit("failure", { reason: "workspace_selection" });
        return invalid(c);
      }
      return finish(c, choice.userId, member);
    } catch (err) {
      audit("failure", { reason: "selection_unavailable", errorCode: errorCode(err) });
      return unavailable(c);
    }
  });

  app.post("/dashboard/auth/password", async (c) => {
    const token = getCookie(c, DASHBOARD_COOKIE);
    const session = token ? await verifyDashboardToken(secret, token) : null;
    if (!session || session.authMethod !== "password" || !session.userId)
      return c.json({ error: "no_session" }, 401);
    if (!passwordAuth) return unavailable(c);
    let live;
    try {
      live = await resolveLiveSession(deps, session);
    } catch (err) {
      audit("failure", { reason: "session_unavailable", errorCode: errorCode(err) });
      return unavailable(c);
    }
    if (!live) return c.json({ error: "no_session" }, 401);
    const userId = session.userId;
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (
      !body ||
      typeof body.currentPassword !== "string" ||
      !body.currentPassword ||
      Buffer.byteLength(body.currentPassword, "utf8") > 72 ||
      typeof body.newPassword !== "string"
    )
      return c.json({ error: "invalid_request" }, 400);
    const rate = await limited(c, `user:${session.userId}`);
    if (rate) return rate;
    try {
      const result = await passwordAuth.change(
        session.userId,
        body.currentPassword,
        body.newPassword
      );
      audit(result === "ok" ? "password_changed" : "failure", {
        userId: session.userId,
        reason: result === "ok" ? undefined : "password_change",
      });
      if (result === "invalid") return invalid(c);
      if (result !== "ok") return c.json({ error: "password_policy", message: result }, 400);
      // Security audit, like a reset: the user acted on their own account.
      await emitAudit(deps, {
        workspaceId: GLOBAL_SENTINEL_ID,
        actorType: "user",
        actorId: formatActorRef("user", userId),
        action: "password_changed",
        resourceKind: "user",
        resourceId: userId,
        isTerminal: false,
      });
    } catch (err) {
      audit("failure", { reason: "password_change_unavailable", errorCode: errorCode(err) });
      return unavailable(c);
    }
    // The change moved sessions_valid_after: every session, this one included,
    // is now dead. Re-mint the caller's after it, so only the others end.
    try {
      deps.userStatus!.invalidate(userId);
      await waitForSessionEpoch(await deps.userStatus!.get(userId));
      const { token: renewed } = await mintDashboardToken(secret, {
        workspaceId: session.workspaceId,
        keyPrefix: session.keyPrefix,
        scopes: live.scopes,
        plan: session.plan,
        actorId: session.actorId,
        userId,
        authMethod: "password",
        ...(session.viaInstance ? { viaInstance: true as const } : {}),
      });
      setCookie(c, DASHBOARD_COOKIE, renewed, {
        ...cookieOptions,
        maxAge: DASHBOARD_SESSION_TTL_SECONDS,
      });
    } catch (err) {
      // The password did change; the caller signs in again.
      audit("failure", { reason: "session_renewal_unavailable", errorCode: errorCode(err) });
      deleteCookie(c, DASHBOARD_COOKIE, { path: DASHBOARD_COOKIE_PATH });
    }
    return c.json({ ok: true });
  });

  // ── POST /dashboard/auth/login ─────────────────────────────────────────────
  app.post("/dashboard/auth/login", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "invalid_request" }, 400);
    const fields = body as Record<string, unknown>;
    if ("email" in fields || "password" in fields) {
      if (
        "apiKey" in fields ||
        typeof fields.email !== "string" ||
        typeof fields.password !== "string" ||
        !normalizeEmail(fields.email) ||
        fields.email.length > 254 ||
        !fields.password ||
        Buffer.byteLength(fields.password, "utf8") > 72
      )
        return c.json({ error: "invalid_request" }, 400);
      const email = normalizeEmail(fields.email);
      const rate = await limited(c, email);
      if (rate) return rate;
      if (!passwordAuth) return unavailable(c);
      try {
        const identity = await passwordAuth.login(email, fields.password);
        if (identity === "disabled") {
          audit("failure", { identifier: emailIdentifier(email), reason: "disabled" });
          auditLogin({
            action: "login_failure",
            identifier: emailIdentifier(email),
            reason: "disabled",
          });
          return invalid(c);
        }
        if (!identity) {
          audit("failure", { identifier: emailIdentifier(email), reason: "invalid_credentials" });
          auditLogin({
            action: "login_failure",
            identifier: emailIdentifier(email),
            reason: "invalid_credentials",
          });
          return invalid(c);
        }
        if (identity.memberships.length === 1)
          return finish(c, identity.userId, identity.memberships[0]!);
        const preferred = getCookie(c, LAST_WORKSPACE_COOKIE);
        const now = Math.floor(Date.now() / 1000);
        const choice = await sign(
          {
            purpose: "dashboard-workspace-choice",
            userId: identity.userId,
            version: identity.passwordUpdatedAt,
            iat: now,
            exp: now + 300,
          },
          secret,
          "HS256"
        );
        setCookie(c, CHOICE_COOKIE, choice, { ...cookieOptions, maxAge: 300 });
        // A prior full session must not bypass workspace choice in this login.
        deleteCookie(c, DASHBOARD_COOKIE, { path: DASHBOARD_COOKIE_PATH });
        audit("password_verified", { userId: identity.userId });
        return c.json({
          requiresWorkspace: true,
          email,
          workspaces: identity.memberships.map(({ id, name, role }) => ({ id, name, role })),
          // The workspace of the last sign-in, only while the person still belongs to it.
          ...(preferred && identity.memberships.some((m) => m.id === preferred)
            ? { preferredWorkspaceId: preferred }
            : {}),
        });
      } catch (err) {
        audit("failure", { reason: "login_unavailable", errorCode: errorCode(err) });
        return unavailable(c);
      }
    }
    const apiKey = fields["apiKey"];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      return c.json({ error: "invalid_request", message: "apiKey is required" }, 400);
    }

    // Resolve the key through the same paths the bearer middleware uses:
    // scoped-scheme mk_* → ScopedApiKeyAdapter (when wired), every key this
    // server mints (mns_*, uk_*, /admin/keys mk_*) → bcrypt lookup.
    let session: {
      workspaceId: string;
      keyPrefix: string;
      scopes: string[];
      plan: string;
      actorId: string;
      userId: string | null;
    } | null = null;
    if (deps.scopedAuthAdapter && isScopedSchemeToken(apiKey)) {
      try {
        const result = await deps.scopedAuthAdapter.authenticate({
          apiKey,
          clientIp: clientIpOf(c),
        });
        if (result.ok) {
          session = {
            workspaceId: result.context.workspaceId,
            keyPrefix: result.context.keyType ?? apiKey.slice(0, 8),
            scopes: [...result.context.scopes],
            plan: "free",
            actorId: result.context.actorId,
            userId: result.context.userId ?? null,
          };
        }
      } catch (err) {
        logger.error({ err }, "dashboard.login: scoped adapter error");
        return c.json(
          { error: "auth_unavailable", message: "Authentication service unavailable" },
          503
        );
      }
    } else {
      const result = await verifyApiKeyToken(deps.apiKeys, apiKey);
      if (result) {
        // Mirror the bearer middleware's per-key IP allowlist enforcement.
        const allow = result.ipAllowlist ?? [];
        if (allow.length > 0) {
          const ip = clientIpOf(c);
          const ok = ip !== "" && allow.some((entry) => ipInCidr(ip, entry));
          if (!ok) {
            logger.warn({ prefix: apiKey.slice(0, 9) }, "dashboard.login: ip_denied");
            return c.json({ error: "invalid_key" }, 401);
          }
        }
        session = {
          workspaceId: result.workspaceId,
          keyPrefix: apiKey.slice(0, 9),
          scopes: result.scopes,
          plan: result.plan ?? "free",
          actorId: result.actorId,
          userId: result.userId ?? null,
        };
      }
    }

    // A key bound to a disabled user does not authenticate (same answer as an
    // unknown key). Without a status service, API key sign-in works as before.
    if (session?.userId) {
      try {
        if (!(await keyUserAllowed(deps.userStatus, session.userId))) session = null;
      } catch (err) {
        logger.warn({ errorCode: errorCode(err) }, "dashboard.login: user status unavailable");
        return unavailable(c);
      }
    }

    if (!session) {
      logger.debug({ prefix: apiKey.slice(0, 9) }, "dashboard.login: invalid key");
      return c.json({ error: "invalid_key" }, 401);
    }

    const { token, expiresAt } = await mintDashboardToken(secret, session);
    deleteCookie(c, CHOICE_COOKIE, { path: DASHBOARD_COOKIE_PATH });
    setCookie(c, DASHBOARD_COOKIE, token, {
      ...cookieOptions,
      maxAge: DASHBOARD_SESSION_TTL_SECONDS,
    });
    logger.info(
      { workspace_id: session.workspaceId, key_prefix: session.keyPrefix },
      "dashboard.login: session minted"
    );
    return c.json({
      workspaceId: session.workspaceId,
      keyPrefix: session.keyPrefix,
      scopes: session.scopes,
      plan: session.plan,
      role: deriveDashboardRole(session.scopes),
      expiresAt,
    });
  });

  // ── POST /dashboard/auth/logout ────────────────────────────────────────────
  // Revokes the session on the server (AUD-007), then clears the cookies. Only this
  // session ends; the user's other sessions stay. A cookie that does not verify is
  // only cleared: nothing to revoke. If the revocation cannot be stored the cookie is
  // still cleared and the answer is 503, since the token would keep working.
  app.post("/dashboard/auth/logout", async (c) => {
    const token = getCookie(c, DASHBOARD_COOKIE);
    const payload = token ? await verifyDashboardToken(secret, token) : null;
    deleteCookie(c, DASHBOARD_COOKIE, { path: DASHBOARD_COOKIE_PATH });
    deleteCookie(c, CHOICE_COOKIE, { path: DASHBOARD_COOKIE_PATH });
    if (payload && deps.metricsPgClient) {
      try {
        await revokeDashboardSession(deps.metricsPgClient, payload);
      } catch (err) {
        logger.warn({ errorCode: errorCode(err) }, "dashboard.logout: revocation unavailable");
        return unavailable(c);
      }
    }
    if (isPlainNavigation(c)) {
      return c.redirect("/dashboard/login", 303);
    }
    return c.json({ ok: true });
  });

  // ── GET /dashboard/auth/session ────────────────────────────────────────────
  app.get("/dashboard/auth/session", async (c) => {
    const token = getCookie(c, DASHBOARD_COOKIE);
    const payload = token ? await verifyDashboardToken(secret, token) : null;
    if (!payload) {
      return c.json({ error: "no_session" }, 401);
    }
    // Same live checks as the /dashboard/api bridge: a disabled user, a
    // session older than sessions_valid_after or a lost membership is no
    // session; an unavailable check is 503 (the dashboard shows login on any
    // non-200).
    let live;
    try {
      live = await resolveLiveSession(deps, payload);
    } catch (err) {
      logger.warn({ errorCode: errorCode(err) }, "dashboard.session: live checks unavailable");
      return unavailable(c);
    }
    if (!live) return c.json({ error: "no_session" }, 401);
    let workspaceName: string | null = null;
    let email: string | null = null;
    // The signed-in user's own personal workspace (their personal tenant).
    // Personal workspaces take no other members, so the dashboard hides the
    // invite and membership controls there.
    let workspaceIsPersonal = false;
    if (deps.metricsPgClient) {
      try {
        // Tenant table exception: scope this metadata query with explicit GUCs.
        const metadata = (await deps.metricsPgClient.begin(async (sql) => {
          await sql`SET LOCAL ROLE app_user`;
          await sql`SELECT set_config('mnemosyne.actor_user_id', ${payload.userId ?? ""}, true), set_config('mnemosyne.actor_tenant_id', '', true)`;
          const [workspace] =
            await sql`SELECT name, tenant_id FROM mnemosyne.mnemo_workspace WHERE id = ${payload.workspaceId}`;
          // mnemo_user_own: the actor reads their own row only.
          const [user] = payload.userId
            ? await sql`SELECT email, personal_tenant_id FROM mnemosyne.mnemo_user WHERE id = ${payload.userId}`
            : [];
          const personalTenant = (user?.personal_tenant_id as string | null | undefined) ?? null;
          return {
            workspaceName: (workspace?.name as string | undefined) ?? null,
            email: (user?.email as string | undefined) ?? null,
            isPersonal:
              personalTenant !== null &&
              String(workspace?.tenant_id ?? "") === String(personalTenant),
          };
        })) as { workspaceName: string | null; email: string | null; isPersonal: boolean };
        workspaceName = metadata.workspaceName;
        email = metadata.email;
        workspaceIsPersonal = metadata.isPersonal;
      } catch {
        // Metadata failure must not discard an otherwise valid session.
      }
    }
    return c.json({
      workspaceId: live.workspaceId,
      workspaceName,
      userId: payload.userId,
      email,
      authMethod: payload.authMethod ?? "apiKey",
      keyPrefix: payload.keyPrefix,
      scopes: live.scopes,
      plan: payload.plan,
      role: deriveDashboardRole(live.scopes),
      // The membership role (owner, admin, write, read) of a password session;
      // null for an API key session, which has scopes and no membership.
      workspaceRole: live.role,
      workspaceIsPersonal,
      isSuperadmin: live.isSuperadmin,
      viaInstance: live.viaInstance,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    });
  });

  // ── Bootstrap aliases (single /dashboard/* proxy prefix for the Next app) ──
  app.get("/dashboard/bootstrap/status", async (c) => {
    const newUrl = new URL(c.req.url);
    newUrl.pathname = "/bootstrap/status";
    return app.fetch(new Request(newUrl.toString(), { method: "GET", headers: c.req.raw.headers }));
  });

  app.post("/dashboard/bootstrap", async (c) => {
    const newUrl = new URL(c.req.url);
    newUrl.pathname = "/bootstrap";
    const newReq = new Request(newUrl.toString(), {
      method: "POST",
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      // @ts-ignore — duplex is required for streaming bodies in some runtimes
      duplex: "half",
    });
    return app.fetch(newReq);
  });

  logger.info("mountDashboardAuth: dashboard auth routes mounted at /dashboard/auth/*");
}
