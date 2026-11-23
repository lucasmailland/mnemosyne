/**
 * Instance plane — installation-wide administration for superadmins
 * (accounts stage A, spec §1). Mounted on the dashboard cookie bridge only
 * (routes/dashboard-api.ts), so no API key reaches it.
 *
 *   GET    /instance/users                       → { users: InstanceUser[] }
 *   POST   /instance/users/:userId/disable       → { ok: true }
 *   POST   /instance/users/:userId/enable        → { ok: true }
 *   POST   /instance/users/:userId/superadmin    { password } → { ok: true }
 *   DELETE /instance/users/:userId/superadmin    { password } → { ok: true }
 *   POST   /instance/users/:userId/offboard      { newOwners?: { [workspaceId]: userId } }
 *                                                 → { ok: true } | 409 owner_required
 *                                                 (also removes a superadmin grant)
 *   GET    /instance/workspaces                  → { workspaces: InstanceWorkspace[] }
 *                                                 each with factsLive (under the caller's
 *                                                 ceiling) and lastWriteAt; null if unreadable
 *   GET    /instance/workspaces/:id/members      → { members: InstanceMember[] }
 *   POST   /instance/workspaces/:id/members      { email, role } → 201 { ok, userId }
 *                                                 (409 unknown_email | already_member |
 *                                                 personal_workspace | user_disabled)
 *   PATCH  /instance/workspaces/:id/members/:userId  { role } → { ok: true }
 *   DELETE /instance/workspaces/:id/members/:userId  → { ok: true }
 *   POST   /instance/workspaces/:id/open         → { ok: true } + a session cookie for
 *                                                 that workspace (viaInstance)
 *   POST   /instance/users                       { email, displayName? } → 201 { id, link, expiresAt }
 *                                                 (an account setup link; 409 email_taken)
 *   POST   /instance/users/:userId/reset-link    → 201 { id, link, expiresAt } (password reset)
 *   GET    /instance/settings                    → InstanceSettingsView (instance-settings.ts)
 *   PUT    /instance/settings                    { invitationsEnabled?, publicBaseUrl?,
 *                                                   workspaceLlmOverride? }
 *                                                 → InstanceSettingsView (400 invalid_request |
 *                                                 invalid_public_base_url; 501 encryption_required)
 *   GET    /instance/audit?action&actor&from&to&cursor
 *                                                 → { entries: InstanceAuditEntry[], nextCursor }
 *                                                 the security actions (0050's and API key
 *                                                 create/rotate/revoke) of every workspace,
 *                                                 newest first, 50 per page
 *   GET    /instance/audit/stats?days=30         → { days: [{ day, count }], byAction: [{ action,
 *                                                 count }], failedSignIns7d } those security
 *                                                 actions counted per UTC day (7 to 90 days)
 *
 * Access: `instanceGuard` admits a password session whose user is a superadmin
 * right now, as resolveLiveSession read it on this request; everyone else gets
 * the plain 404 of an unknown route (anti-probing). The bridge runs it before
 * the scope guard, whose rule for /instance/ (admin:workspace) is a second
 * layer. The database functions re-check the actor themselves.
 *
 * Granting and revoking superadmin take the caller's password again. It is
 * checked by DashboardPasswordAuth.verify, outside any transaction, and a
 * wrong one counts toward the sign-in lockout.
 *
 * Opening a workspace mints a password session for it marked viaInstance: the
 * superadmin's real role there when they are a member, read otherwise. The
 * bridge re-checks superadmin on every request (resolveLiveSession), so a
 * revoked superadmin loses a workspace they are not a member of at once.
 * Content reads there are not audited one by one; the opening is.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type postgres from "postgres";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { AuditAction } from "@mnemo-ai/types";
import { tiersAtOrBelow, utcDayKeys } from "@mnemo-ai/types";
import { resolveCeiling } from "../rbac.js";
import {
  DashboardPasswordAuth,
  PostgresCredentialStore,
  type Membership,
} from "../dashboard-password.js";
import { readDashboardSecret } from "../dashboard-session.js";
import { dashboardCookieOptions, issuePasswordSession } from "../dashboard-session-issue.js";
import { emitAudit } from "../audit-emit.js";
import { resolveProvenance } from "../provenance.js";
import { GLOBAL_SENTINEL_ID } from "../config/WorkspaceConfigStore.js";
import { logger } from "../logging.js";
import { asAppUser } from "../dashboard-live-session.js";
import { forgetUserAuth } from "../auth-cache-registry.js";
import {
  LINK_TTL_SECONDS,
  linkIssueRefused,
  linkBaseUrl,
  linkTtl,
  linkUrl,
  newLinkToken,
} from "../single-use-link.js";
import { parseEmail } from "./workspace-members.js";
import {
  InstanceSettingsUnavailable,
  parseSettingsPatch,
  readInstanceSettings,
  writeInstanceSettings,
} from "../instance-settings.js";

type Env = { Variables: AuthVariables };

export interface InstanceUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  disabledAt: string | null;
  /** Holds the superadmin grant; with disabledAt set it is not active. */
  isSuperadmin: boolean;
  workspaces: Array<{ id: string; name: string; role: string }>;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  created_at: Date | string;
  last_login_at: Date | string | null;
  disabled_at: Date | string | null;
  is_superadmin: boolean;
  workspaces: Array<{ id: string; name: string; role: string }> | string;
}

export interface InstanceWorkspace {
  id: string;
  name: string;
  tenantId: string;
  tenantName: string;
  /** Its tenant is some user's personal tenant (never judged by tenant kind). */
  isPersonal: boolean;
  visibility: string;
  memberCount: number;
  owners: Array<{ id: string; email: string; displayName: string | null }>;
  /** Live facts at or under the caller's ceiling; null when the figures could not be read. */
  factsLive: number | null;
  lastWriteAt: string | null;
}

export interface InstanceMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: Membership["role"];
  joinedAt: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  tenant_id: string;
  tenant_name: string;
  is_personal: boolean;
  visibility: string;
  member_count: number;
  owners: Array<{ id: string; email: string; display_name: string | null }> | string;
}

interface MemberRow {
  user_id: string;
  email: string;
  display_name: string | null;
  role: Membership["role"];
  joined_at: Date | string;
}

/** One row of the security audit. `detail` is null when it is stored encrypted. */
export interface InstanceAuditEntry {
  id: string;
  workspaceId: string;
  actorType: string;
  actorId: string;
  /** The acting user's email when the actor is a user. */
  actorEmail: string | null;
  action: AuditAction;
  resourceKind: string;
  resourceId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

interface AuditRow {
  id: string | number;
  workspace_id: string;
  actor_type: string;
  actor_id: string;
  actor_email: string | null;
  action: AuditAction;
  resource: string;
  resource_id: string | null;
  metadata: unknown;
  created_at: Date | string;
  cursor_at: string;
}

/**
 * The actions GET /instance/audit lists, as mnemo_instance_audit (0055) does:
 * those of migration 0050 and API key creation, rotation and revocation.
 */
export const SECURITY_AUDIT_ACTIONS: ReadonlyArray<AuditAction> = [
  "login_success",
  "login_failure",
  "user_created",
  "user_disabled",
  "user_enabled",
  "user_offboarded",
  "superadmin_granted",
  "superadmin_revoked",
  "member_added",
  "member_removed",
  "member_role_changed",
  "invitation_created",
  "invitation_revoked",
  "invitation_accepted",
  "link_created",
  "password_changed",
  "password_reset",
  "settings_changed",
  "workspace_opened",
  "key_create",
  "key_rotate",
  "key_revoke",
];

const AUDIT_PAGE_SIZE = 50;
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** An opaque page cursor: the last row's created_at (microseconds, UTC) and id. */
const encodeCursor = (at: string, id: string) =>
  Buffer.from(JSON.stringify([at, id]), "utf8").toString("base64url");

function decodeCursor(value: string): { at: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      CURSOR_AT.test(parsed[0]) &&
      // A real calendar instant (no 2026-02-30), so Postgres never rejects it.
      new Date(parsed[0]).toISOString().slice(0, 19) === parsed[0].slice(0, 19) &&
      typeof parsed[1] === "string" &&
      /^\d{1,18}$/.test(parsed[1])
    )
      return { at: parsed[0], id: parsed[1] };
  } catch {
    /* not a cursor */
  }
  return null;
}

/** An ISO date or date-time for a filter bound, or null. */
function parseInstant(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}(?:T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

const ROLES: ReadonlyArray<string> = ["owner", "admin", "write", "read"];
const isRole = (value: unknown): value is Membership["role"] =>
  typeof value === "string" && ROLES.includes(value);

/** Live superadmin with a password session, or the unknown-route 404. */
export function instanceGuard(): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (c.get("instanceSuperadmin") !== true || !c.get("userId")) return c.notFound();
    return next();
  };
}

// Drizzle shares the postgres-js client and installs string timestamp codecs.
const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const MAX_ID_LENGTH = 200;
/** Bound on an offboard's newOwners map (one entry per workspace the user owns). */
const MAX_NEW_OWNERS = 1000;
const validId = (value: string | undefined): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;

const parseJson = <T>(value: T | string): T =>
  typeof value === "string" ? (JSON.parse(value) as T) : value;

type Refusal =
  | { status: 404 }
  | { status: 409; body: { error: string; workspaces?: Array<{ id: string; name: string }> } };

/**
 * The workspaces of an owner_required refusal: its DETAIL lists {id, name};
 * the message (owner_required:<ids>) is the fallback, without names.
 */
function ownerRequiredWorkspaces(message: string, detail: unknown) {
  try {
    const parsed = JSON.parse(String(detail)) as unknown;
    if (Array.isArray(parsed))
      return parsed.map((w: { id?: unknown; name?: unknown }) => ({
        id: String(w.id),
        name: String(w.name),
      }));
  } catch {
    /* fall back to the ids */
  }
  return message
    .slice("owner_required:".length)
    .split(",")
    .map((id) => ({ id, name: id }));
}

/** Database refusals the routes answer; anything else is a server error. */
function refusal(err: unknown): Refusal | null {
  const { code, message, detail } = (err ?? {}) as {
    code?: unknown;
    message?: unknown;
    detail?: unknown;
  };
  // The actor lost superadmin since the guard ran: same answer as the guard.
  if (code === "42501" && message === "not_superadmin") return { status: 404 };
  if (
    code === "P0002" &&
    typeof message === "string" &&
    ["user_not_found", "workspace_not_found", "member_not_found"].includes(message)
  )
    return { status: 404 };
  if (code === "23514" && typeof message === "string") {
    if (message.startsWith("owner_required:"))
      return {
        status: 409,
        body: { error: "owner_required", workspaces: ownerRequiredWorkspaces(message, detail) },
      };
    if (
      [
        "last_superadmin",
        "self",
        "user_disabled",
        "last_owner",
        "invalid_new_owner",
        "ambiguous_email",
        "unknown_email",
        "already_member",
        "personal_workspace",
      ].includes(message)
    )
      return { status: 409, body: { error: message } };
  }
  if (code === "23505" && message === "email_taken")
    return { status: 409, body: { error: message } };
  return null;
}

export function mountInstance(api: OpenAPIHono<Env>, deps: ServerDeps): void {
  const sql = deps.metricsPgClient;
  // The bridge mounts only with a secret; null keeps open answering 503.
  const secret = readDashboardSecret();
  const cookieOptions = dashboardCookieOptions();
  const passwordAuth =
    deps.dashboardPasswordAuth ??
    (sql ? new DashboardPasswordAuth(new PostgresCredentialStore(sql)) : null);

  const unavailable = (c: Context<Env>) =>
    c.json(
      { error: "instance_unavailable", message: "Instance administration is unavailable" },
      503
    );

  /** Runs as app_user; the functions called are SECURITY DEFINER and take the actor. */
  const asActor = <T>(actor: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    asAppUser(sql!, actor, fn);

  const audit = (
    c: Context<Env>,
    action: AuditAction,
    targetUserId: string,
    detail?: Record<string, unknown>
  ) => {
    const provenance = resolveProvenance(c);
    return emitAudit(deps, {
      workspaceId: GLOBAL_SENTINEL_ID,
      actorType: provenance.actorType,
      actorId: provenance.actorId,
      action,
      resourceKind: "user",
      resourceId: targetUserId,
      ...(detail ? { detail } : {}),
      isTerminal: false,
    });
  };

  /** A refusal as its response: the unknown-route 404 or a 409 body. */
  const refuse = (c: Context<Env>, refused: Refusal) =>
    refused.status === 404 ? c.notFound() : c.json(refused.body, 409);

  /** Read through a definer function; a 404 refusal becomes the unknown-route 404. */
  const read = async <T>(
    c: Context<Env>,
    run: (tx: postgres.TransactionSql, actor: string) => Promise<T>
  ): Promise<T | Response> => {
    const actor = c.get("userId")!;
    try {
      return await asActor(actor, (tx) => run(tx, actor));
    } catch (err) {
      if (refusal(err)?.status === 404) return c.notFound();
      throw err;
    }
  };

  /** A JSON body; an empty body reads as {}. null when it is not JSON. */
  const optionalJson = async (c: Context<Env>): Promise<unknown> => {
    const text = await c.req.text();
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  };

  /**
   * Run a mutation, then bust the target's cached status and audit it. A
   * refusal from the database becomes its 404/409; the rest propagates.
   */
  const mutate = async (
    c: Context<Env>,
    targetUserId: string,
    action: AuditAction,
    run: (tx: postgres.TransactionSql, actor: string) => Promise<unknown>,
    detail?: Record<string, unknown>
  ) => {
    const actor = c.get("userId")!;
    try {
      await asActor(actor, (tx) => run(tx, actor));
    } catch (err) {
      const refused = refusal(err);
      if (!refused) throw err;
      return refuse(c, refused);
    }
    deps.userStatus?.invalidate(targetUserId);
    // Role changes, removals (which revoke the member's keys there) and
    // offboarding (which revokes them all) reach API keys at once in this process.
    forgetUserAuth(targetUserId);
    await audit(c, action, targetUserId, detail);
    return c.json({ ok: true });
  };

  api.get("/instance/users", async (c) => {
    if (!sql) return unavailable(c);
    const actor = c.get("userId")!;
    const rows = await read(
      c,
      (tx) => tx<UserRow[]>`SELECT * FROM mnemosyne.mnemo_instance_list_users(${actor})`
    );
    if (rows instanceof Response) return rows;
    const users: InstanceUser[] = rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      createdAt: iso(row.created_at)!,
      lastLoginAt: iso(row.last_login_at),
      disabledAt: iso(row.disabled_at),
      isSuperadmin: row.is_superadmin,
      workspaces: parseJson(row.workspaces),
    }));
    return c.json({ users });
  });

  for (const [segment, disabled, action] of [
    ["disable", true, "user_disabled"],
    ["enable", false, "user_enabled"],
  ] as const) {
    api.post(`/instance/users/:userId/${segment}`, async (c) => {
      if (!sql) return unavailable(c);
      const userId = c.req.param("userId");
      if (!validId(userId)) return c.notFound();
      return mutate(
        c,
        userId,
        action,
        (tx, actor) =>
          tx`SELECT mnemosyne.mnemo_instance_set_disabled(${actor}, ${userId}, ${disabled})`
      );
    });
  }

  const superadminRoute = (grant: boolean) => async (c: Context<Env>) => {
    if (!sql || !passwordAuth) return unavailable(c);
    const userId = c.req.param("userId");
    if (!validId(userId)) return c.notFound();
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const password = (body as { password?: unknown } | null)?.password;
    if (typeof password !== "string" || !password || Buffer.byteLength(password, "utf8") > 72)
      return c.json({ error: "invalid_request" }, 400);
    // bcrypt runs here, outside every transaction (dashboard-password.ts).
    if (!(await passwordAuth.verify(c.get("userId")!, password))) {
      logger.info(
        { event: "instance.password_reentry", outcome: "failure", grant },
        "instance plane: password re-entry refused"
      );
      return c.json({ error: "invalid_credentials", message: "Invalid password." }, 401);
    }
    return mutate(c, userId, grant ? "superadmin_granted" : "superadmin_revoked", (tx, actor) =>
      grant
        ? tx`SELECT mnemosyne.mnemo_instance_grant_admin(${actor}, ${userId})`
        : tx`SELECT mnemosyne.mnemo_instance_revoke_admin(${actor}, ${userId})`
    );
  };
  api.post("/instance/users/:userId/superadmin", superadminRoute(true));
  api.delete("/instance/users/:userId/superadmin", superadminRoute(false));

  api.post("/instance/users/:userId/offboard", async (c) => {
    if (!sql) return unavailable(c);
    const userId = c.req.param("userId");
    if (!validId(userId)) return c.notFound();
    const body = await optionalJson(c);
    if (body === null) return c.json({ error: "invalid_json" }, 400);
    const newOwners = (body as { newOwners?: unknown } | undefined)?.newOwners ?? {};
    if (
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof newOwners !== "object" ||
      newOwners === null ||
      Array.isArray(newOwners) ||
      Object.keys(newOwners).length > MAX_NEW_OWNERS ||
      !Object.entries(newOwners).every(([ws, owner]) => validId(ws) && validId(owner))
    )
      return c.json({ error: "invalid_request" }, 400);
    // Offboarding removes a superadmin grant too; it is audited as its own action.
    let revokedSuperadmin = false;
    const res = await mutate(
      c,
      userId,
      "user_offboarded",
      async (tx, actor) => {
        const [row] = await tx<[{ revoked: boolean }]>`
          SELECT mnemosyne.mnemo_instance_offboard(${actor}, ${userId}, ${JSON.stringify(newOwners)}::jsonb) AS revoked`;
        revokedSuperadmin = row?.revoked === true;
      },
      { newOwners }
    );
    if (revokedSuperadmin) await audit(c, "superadmin_revoked", userId);
    return res;
  });

  /** Issuing a link counts toward the acting user's 30 per 15 minutes. */
  const issueLimited = (c: Context<Env>) => linkIssueRefused(c, deps, c.get("userId")!);

  /**
   * Issue an account setup or password reset link (superadmin only, checked
   * again by mnemo_link_issue). The link is in the response only.
   */
  const issueLink = async (
    c: Context<Env>,
    purpose: "account_setup" | "password_reset",
    email: string,
    displayName: string | null
  ): Promise<{ id: string; link: string; expiresAt: string } | Response> => {
    const limited = await issueLimited(c);
    if (limited) return limited;
    // Read before issuing: a failure here must not leave a link nobody saw.
    const base = await linkBaseUrl(c, deps);
    const { token, hash } = newLinkToken();
    let id: string;
    try {
      id = await asActor(c.get("userId")!, async (tx) => {
        const [row] = await tx<[{ id: string }]>`
          SELECT mnemosyne.mnemo_link_issue(${c.get("userId")!}, ${purpose}, ${email}, NULL, NULL,
                                            ${hash}, ${linkTtl(purpose)}::interval, ${displayName}) AS id`;
        return row!.id;
      });
    } catch (err) {
      const refused = refusal(err);
      if (!refused) throw err;
      return refuse(c, refused);
    }
    return {
      id,
      link: linkUrl(base, token),
      expiresAt: new Date(Date.now() + LINK_TTL_SECONDS[purpose] * 1000).toISOString(),
    };
  };

  api.post("/instance/users", async (c) => {
    if (!sql) return unavailable(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const { email: rawEmail, displayName } = (body ?? {}) as {
      email?: unknown;
      displayName?: unknown;
    };
    const email = parseEmail(rawEmail);
    if (
      !email ||
      (displayName !== undefined &&
        displayName !== null &&
        (typeof displayName !== "string" || displayName.length > 200))
    )
      return c.json({ error: "invalid_request" }, 400);
    const issued = await issueLink(
      c,
      "account_setup",
      email,
      typeof displayName === "string" ? displayName : null
    );
    if (issued instanceof Response) return issued;
    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId: GLOBAL_SENTINEL_ID,
      actorType: provenance.actorType,
      actorId: provenance.actorId,
      action: "link_created",
      resourceKind: "link",
      resourceId: issued.id,
      detail: { purpose: "account_setup" },
      isTerminal: false,
    });
    return c.json(issued, 201);
  });

  api.post("/instance/users/:userId/reset-link", async (c) => {
    if (!sql) return unavailable(c);
    const userId = c.req.param("userId");
    if (!validId(userId)) return c.notFound();
    const rows = await read(
      c,
      (tx, actor) =>
        tx<
          { email: string }[]
        >`SELECT email FROM mnemosyne.mnemo_instance_list_users(${actor}) WHERE id = ${userId}`
    );
    if (rows instanceof Response) return rows;
    if (!rows[0]) return c.notFound();
    const issued = await issueLink(c, "password_reset", rows[0].email, null);
    if (issued instanceof Response) return issued;
    await audit(c, "link_created", userId, { purpose: "password_reset" });
    return c.json({ id: issued.id, link: issued.link, expiresAt: issued.expiresAt }, 201);
  });

  api.get("/instance/workspaces", async (c) => {
    if (!sql) return unavailable(c);
    const rows = await read(
      c,
      (tx, actor) =>
        tx<WorkspaceRow[]>`SELECT * FROM mnemosyne.mnemo_instance_list_workspaces(${actor})`
    );
    if (rows instanceof Response) return rows;
    // Best-effort: figures that cannot be read are null, the list still answers.
    const tiers = tiersAtOrBelow(resolveCeiling(c));
    const figures = await read(
      c,
      (tx, actor) => tx<
        Array<{ workspace_id: string; facts_live: number; last_write_at: Date | null }>
      >`
        SELECT * FROM mnemosyne.mnemo_instance_workspace_figures(${actor}, ${tiers}::text[])`
    ).catch(() => null);
    const byWorkspace = Array.isArray(figures)
      ? new Map(figures.map((f) => [f.workspace_id, f]))
      : null;
    const workspaces: InstanceWorkspace[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      isPersonal: row.is_personal,
      visibility: row.visibility,
      memberCount: Number(row.member_count),
      owners: parseJson(row.owners).map((o) => ({
        id: o.id,
        email: o.email,
        displayName: o.display_name,
      })),
      // A workspace with no fact at all has no row: zero live, never written.
      factsLive: byWorkspace ? Number(byWorkspace.get(row.id)?.facts_live ?? 0) : null,
      lastWriteAt: byWorkspace ? iso(byWorkspace.get(row.id)?.last_write_at ?? null) : null,
    }));
    return c.json({ workspaces });
  });

  const readMembers = (c: Context<Env>, workspaceId: string) =>
    read(
      c,
      (tx, actor) =>
        tx<
          MemberRow[]
        >`SELECT * FROM mnemosyne.mnemo_instance_workspace_members(${actor}, ${workspaceId})`
    );

  api.get("/instance/workspaces/:id/members", async (c) => {
    if (!sql) return unavailable(c);
    const workspaceId = c.req.param("id");
    if (!validId(workspaceId)) return c.notFound();
    const rows = await readMembers(c, workspaceId);
    if (rows instanceof Response) return rows;
    const members: InstanceMember[] = rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      joinedAt: iso(row.joined_at)!,
    }));
    return c.json({ members });
  });

  api.patch("/instance/workspaces/:id/members/:userId", async (c) => {
    if (!sql) return unavailable(c);
    const workspaceId = c.req.param("id");
    const userId = c.req.param("userId");
    if (!validId(workspaceId) || !validId(userId)) return c.notFound();
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const role = (body as { role?: unknown } | null)?.role;
    if (!isRole(role)) return c.json({ error: "invalid_request" }, 400);
    return mutate(
      c,
      userId,
      "member_role_changed",
      (tx, actor) =>
        tx`SELECT mnemosyne.mnemo_instance_set_member_role(${actor}, ${workspaceId}, ${userId}, ${role})`,
      { workspaceId, role }
    );
  });

  // Add an existing user to a team workspace, with any role: how a superadmin
  // gives an ownerless workspace an owner. The user is found by email.
  api.post("/instance/workspaces/:id/members", async (c) => {
    if (!sql) return unavailable(c);
    const workspaceId = c.req.param("id");
    if (!validId(workspaceId)) return c.notFound();
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const { email, role } = (body ?? {}) as { email?: unknown; role?: unknown };
    if (typeof email !== "string" || !email.trim() || email.length > 320 || !isRole(role))
      return c.json({ error: "invalid_request" }, 400);
    const actor = c.get("userId")!;
    let userId: string;
    try {
      const rows = await asActor(
        actor,
        (tx) =>
          tx<{ user_id: string }[]>`
            SELECT mnemosyne.mnemo_instance_add_member(${actor}, ${workspaceId}, ${email}, ${role}) AS user_id`
      );
      userId = rows[0]!.user_id;
    } catch (err) {
      const refused = refusal(err);
      if (!refused) throw err;
      return refuse(c, refused);
    }
    deps.userStatus?.invalidate(userId);
    forgetUserAuth(userId);
    await audit(c, "member_added", userId, { workspaceId, role });
    return c.json({ ok: true, userId }, 201);
  });

  api.delete("/instance/workspaces/:id/members/:userId", async (c) => {
    if (!sql) return unavailable(c);
    const workspaceId = c.req.param("id");
    const userId = c.req.param("userId");
    if (!validId(workspaceId) || !validId(userId)) return c.notFound();
    return mutate(
      c,
      userId,
      "member_removed",
      (tx, actor) =>
        tx`SELECT mnemosyne.mnemo_instance_remove_member(${actor}, ${workspaceId}, ${userId})`,
      { workspaceId }
    );
  });

  api.post("/instance/workspaces/:id/open", async (c) => {
    if (!sql || !secret) return unavailable(c);
    const workspaceId = c.req.param("id");
    if (!validId(workspaceId)) return c.notFound();
    // Also the existence check: an unknown workspace is the unknown-route 404.
    const rows = await readMembers(c, workspaceId);
    if (rows instanceof Response) return rows;
    const userId = c.get("userId")!;
    const own = rows.find((row) => row.user_id === userId)?.role;
    await issuePasswordSession(
      c,
      deps,
      secret,
      {
        userId,
        workspaceId,
        role: isRole(own) ? own : "read",
        viaInstance: true,
        continueSession: true,
      },
      cookieOptions
    );
    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId,
      actorType: provenance.actorType,
      actorId: provenance.actorId,
      action: "workspace_opened",
      resourceKind: "workspace",
      resourceId: workspaceId,
      isTerminal: false,
    });
    return c.json({ ok: true });
  });

  api.get("/instance/settings", async (c) => c.json(await readInstanceSettings(deps)));

  api.put("/instance/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = parseSettingsPatch(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    // The settings store is not a definer function, so re-check here what
    // every other instance write checks in the database: the guard read a
    // status that may be up to the status cache's age old.
    if (!sql) return unavailable(c);
    const actor = c.get("userId")!;
    const [check] = await asActor(
      actor,
      (tx) => tx<[{ ok: boolean | null }]>`SELECT mnemosyne.mnemo_instance_is_admin(${actor}) AS ok`
    );
    if (check?.ok !== true) {
      deps.userStatus?.invalidate(actor);
      return c.notFound();
    }
    const provenance = resolveProvenance(c);
    try {
      await writeInstanceSettings(deps, parsed.ok, provenance.actorId);
    } catch (err) {
      if (!(err instanceof InstanceSettingsUnavailable)) throw err;
      return c.json(
        { error: "encryption_required", message: "MNEMO_MASTER_KEY is not configured." },
        501
      );
    }
    // The patch names no secret: a URL and a switch.
    await emitAudit(deps, {
      workspaceId: GLOBAL_SENTINEL_ID,
      actorType: provenance.actorType,
      actorId: provenance.actorId,
      action: "settings_changed",
      resourceKind: "settings",
      resourceId: "instance",
      detail: { ...parsed.ok },
      isTerminal: false,
    });
    return c.json(await readInstanceSettings(deps));
  });

  api.get("/instance/audit/stats", async (c) => {
    if (!sql) return unavailable(c);
    const raw = c.req.query("days");
    const days = raw === undefined ? 30 : Number(raw);
    if (!Number.isInteger(days) || days < 7 || days > 90)
      return c.json({ error: "invalid_request" }, 400);
    const keys = utcDayKeys(days);
    const since = `${keys[0]}T00:00:00.000Z`;
    const rows = await read(
      c,
      (tx, actor) => tx<Array<{ day: string; action: string; n: number }>>`
        SELECT * FROM mnemosyne.mnemo_instance_audit_stats(${actor}, ${since}::timestamptz)`
    );
    if (rows instanceof Response) return rows;
    const perDay = new Map(keys.map((day) => [day, 0]));
    const byAction = new Map<string, number>();
    const lastWeek = new Set(keys.slice(-7));
    let failedSignIns7d = 0;
    for (const r of rows) {
      const n = Number(r.n);
      perDay.set(r.day, (perDay.get(r.day) ?? 0) + n);
      byAction.set(r.action, (byAction.get(r.action) ?? 0) + n);
      if (r.action === "login_failure" && lastWeek.has(r.day)) failedSignIns7d += n;
    }
    return c.json({
      days: [...perDay].map(([day, count]) => ({ day, count })),
      byAction: [...byAction]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([action, count]) => ({ action, count })),
      failedSignIns7d,
    });
  });

  api.get("/instance/audit", async (c) => {
    if (!sql) return unavailable(c);
    const query = c.req.query();
    const bad = () => c.json({ error: "invalid_request" }, 400);
    let action: AuditAction | null = null;
    if (query.action !== undefined) {
      if (!SECURITY_AUDIT_ACTIONS.includes(query.action as AuditAction)) return bad();
      action = query.action as AuditAction;
    }
    let actorFilter: string | null = null;
    if (query.actor !== undefined) {
      const actor = query.actor.trim();
      if (!actor || actor.length > MAX_ID_LENGTH) return bad();
      // A bare id names a user.
      actorFilter = actor.includes(":") ? actor : `user:${actor}`;
    }
    const bound = (name: "from" | "to"): string | null | undefined => {
      const raw = query[name];
      if (raw === undefined) return null;
      return parseInstant(raw) ?? undefined;
    };
    const from = bound("from");
    const to = bound("to");
    if (from === undefined || to === undefined) return bad();
    let cursor: { at: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      cursor = decodeCursor(query.cursor);
      if (!cursor) return bad();
    }
    const rows = await read(
      c,
      (tx, actor) => tx<AuditRow[]>`
        SELECT a.*,
               to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM mnemosyne.mnemo_instance_audit(
          ${actor}, ${action}, ${actorFilter}, ${from}::timestamptz, ${to}::timestamptz,
          ${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::bigint,
          ${AUDIT_PAGE_SIZE + 1}) a`
    );
    if (rows instanceof Response) return rows;
    const page = rows.slice(0, AUDIT_PAGE_SIZE);
    const last = page[page.length - 1];
    const entries: InstanceAuditEntry[] = page.map((row) => ({
      id: String(row.id),
      workspaceId: row.workspace_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      actorEmail: row.actor_email,
      action: row.action,
      resourceKind: row.resource,
      resourceId: row.resource_id,
      // An encrypted detail (the actor's DEK) is a string: not shown here.
      detail:
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : null,
      createdAt: iso(row.created_at)!,
    }));
    return c.json({
      entries,
      nextCursor:
        rows.length > AUDIT_PAGE_SIZE && last
          ? encodeCursor(last.cursor_at, String(last.id))
          : null,
    });
  });
}
