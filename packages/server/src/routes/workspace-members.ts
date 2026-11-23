/**
 * Workspace members and invitations (accounts stage A, spec §4 and §6),
 * for the session workspace. Mounted on the dashboard cookie bridge only
 * (routes/dashboard-api.ts), so no API key reaches it.
 *
 *   GET    /workspace/members                   → { members: [{userId,email,displayName,role,joinedAt,
 *                                                    lastActiveAt}],
 *                                                    (lastActiveAt: the member's latest audit entry in this
 *                                                    workspace, null when none or when it could not be read)
 *                                                    invitations: [{id,email,role,expiresAt}] }
 *   PATCH  /workspace/members/:userId           { role } → { ok: true }
 *   DELETE /workspace/members/:userId           → { ok: true }            (409 last_owner)
 *   POST   /workspace/invitations               { email, role } → 201 { id, link, expiresAt }
 *   POST   /workspace/invitations/:id/regenerate → { link, expiresAt }   (the old link dies)
 *   DELETE /workspace/invitations/:id           → { ok: true }
 *
 * Access. A password session only (the person acts, never a key). The list
 * is for any member (invitations only for owners and admins, or a
 * superadmin); everything else for an owner or admin. On the bridge
 * `workspaceRole` is the live role resolveLiveSession read on this request,
 * never a JWT claim: a superadmin who opened a workspace they do not belong
 * to holds `read` there and is refused (they have /instance/* for that). The
 * database functions re-check the actor's role under the workspace row lock.
 *
 * An admin neither invites nor touches an owner (403 role_not_allowed);
 * personal workspaces take no invitations (403 personal_workspace). With the
 * installation's invitations turned off (instance-settings.ts) no invitation
 * is created or regenerated (403 invitations_disabled). A link is
 * returned once, when created or regenerated, and never logged or audited.
 */
import type { Context } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type postgres from "postgres";
import type { AuditAction } from "@mnemo-ai/types";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { Membership } from "../dashboard-password.js";
import { normalizeEmail } from "../dashboard-password.js";
import { asAppUser } from "../dashboard-live-session.js";
import { forgetUserAuth } from "../auth-cache-registry.js";
import { emitAudit } from "../audit-emit.js";
import { resolveProvenance } from "../provenance.js";
import { readInstanceSettings } from "../instance-settings.js";
import {
  LINK_TTL_SECONDS,
  linkIssueRefused,
  linkBaseUrl,
  linkTtl,
  linkUrl,
  newLinkToken,
} from "../single-use-link.js";

type Env = { Variables: AuthVariables };

const ROLES: ReadonlyArray<string> = ["owner", "admin", "write", "read"];
export const isRole = (value: unknown): value is Membership["role"] =>
  typeof value === "string" && ROLES.includes(value);

const MAX_ID_LENGTH = 200;
export const validId = (value: string | undefined): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;

/** A normalized email, or null when the input cannot be one. */
export function parseEmail(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254) return null;
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

// Drizzle shares the postgres-js client and installs string timestamp codecs.
export const iso = (value: Date | string): string => new Date(value).toISOString();

/** Database refusals of the member and link functions, as HTTP answers. */
export function memberRefusal(
  err: unknown
): { status: 400 | 403 | 404 | 409; error: string } | null {
  const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown };
  if (typeof message !== "string") return null;
  if (
    code === "42501" &&
    ["not_workspace_admin", "role_not_allowed", "personal_workspace"].includes(message)
  )
    return { status: 403, error: message };
  if (
    code === "P0002" &&
    ["workspace_not_found", "member_not_found", "invitation_not_found"].includes(message)
  )
    return { status: 404, error: message };
  if (code === "23514" && ["last_owner", "already_member"].includes(message))
    return { status: 409, error: message };
  if (code === "22023" && message === "invalid_role") return { status: 400, error: message };
  return null;
}

interface ProfileRow {
  user_id: string;
  email: string;
  display_name: string | null;
  role: Membership["role"];
  joined_at: Date | string;
}

interface InvitationRow {
  id: string;
  email: string;
  role: Membership["role"];
  expires_at: Date | string;
}

/** The person behind a password session, or null (an API key session). */
const sessionUser = (c: Context<Env>): string | null =>
  c.get("actorRefKind") === "user" ? (c.get("userId") ?? null) : null;

const isManager = (c: Context<Env>) => {
  const role = c.get("workspaceRole");
  return role === "owner" || role === "admin";
};

export function mountWorkspaceMembers(api: OpenAPIHono<Env>, deps: ServerDeps): void {
  const sql = deps.metricsPgClient;

  const unavailable = (c: Context<Env>) =>
    c.json({ error: "members_unavailable", message: "Member management is unavailable" }, 503);
  const forbidden = (c: Context<Env>) =>
    c.json({ error: "forbidden", message: "Only workspace owners and admins can do this." }, 403);

  const audit = (
    c: Context<Env>,
    action: AuditAction,
    resourceKind: string,
    resourceId: string,
    detail?: Record<string, unknown>
  ) => {
    const provenance = resolveProvenance(c);
    return emitAudit(deps, {
      workspaceId: c.get("workspaceId"),
      actorType: provenance.actorType,
      actorId: provenance.actorId,
      action,
      resourceKind,
      resourceId,
      ...(detail ? { detail } : {}),
      isTerminal: false,
    });
  };

  /**
   * Run a definer call as the session user. A refusal becomes its answer;
   * anything else propagates. Null when the caller may not manage members.
   */
  const run = async <T>(
    c: Context<Env>,
    fn: (tx: postgres.TransactionSql, actor: string, workspaceId: string) => Promise<T>
  ): Promise<{ ok: T } | Response> => {
    const actor = sessionUser(c);
    if (!actor || !isManager(c)) return forbidden(c);
    try {
      return { ok: await asAppUser(sql!, actor, (tx) => fn(tx, actor, c.get("workspaceId"))) };
    } catch (err) {
      const refused = memberRefusal(err);
      if (!refused) throw err;
      return c.json({ error: refused.error }, refused.status);
    }
  };

  const readJson = async (c: Context<Env>): Promise<Record<string, unknown> | null> => {
    try {
      const body = (await c.req.json()) as unknown;
      return body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  /** Issuing a link counts toward the acting user's 30 per 15 minutes. */
  const issueLimited = (c: Context<Env>) => linkIssueRefused(c, deps, sessionUser(c)!);

  /** The 403 to answer while the installation has invitations turned off. */
  const invitationsOff = async (c: Context<Env>): Promise<Response | null> => {
    const { invitationsEnabled } = await readInstanceSettings(deps);
    if (invitationsEnabled) return null;
    return c.json(
      {
        error: "invitations_disabled",
        message: "Invitations are turned off for this installation.",
      },
      403
    );
  };

  api.get("/workspace/members", async (c) => {
    if (!sql) return unavailable(c);
    const actor = sessionUser(c);
    if (!actor) return forbidden(c);
    const workspaceId = c.get("workspaceId");
    const { members, invitations } = await asAppUser(sql, actor, async (tx) => ({
      members: await tx<
        ProfileRow[]
      >`SELECT * FROM mnemosyne.mnemo_workspace_member_profiles(${actor}, ${workspaceId})`,
      invitations: await tx<
        InvitationRow[]
      >`SELECT id, email, role, expires_at FROM mnemosyne.mnemo_workspace_invitations(${actor}, ${workspaceId})`,
    }));
    // Best-effort: activity that cannot be read is null for everyone, the list still answers.
    const lastAt =
      (await deps.storage
        ?.getAuditActivity({
          workspaceId,
          days: 7,
          actorIds: members.map((row) => `user:${row.user_id}`),
        })
        .then((a) => a.lastAt)
        .catch(() => null)) ?? null;
    return c.json({
      members: members.map((row) => ({
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        joinedAt: iso(row.joined_at),
        lastActiveAt: lastAt ? (lastAt[`user:${row.user_id}`] ?? null) : null,
      })),
      invitations: invitations.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        expiresAt: iso(row.expires_at),
      })),
    });
  });

  api.patch("/workspace/members/:userId", async (c) => {
    if (!sql) return unavailable(c);
    const userId = c.req.param("userId");
    if (!validId(userId)) return c.json({ error: "member_not_found" }, 404);
    const body = await readJson(c);
    if (!body || !isRole(body.role)) return c.json({ error: "invalid_request" }, 400);
    const role = body.role;
    const res = await run(
      c,
      (tx, actor, workspaceId) =>
        tx`SELECT mnemosyne.mnemo_workspace_set_member_role(${actor}, ${workspaceId}, ${userId}, ${role})`
    );
    if (res instanceof Response) return res;
    deps.userStatus?.invalidate(userId);
    forgetUserAuth(userId);
    await audit(c, "member_role_changed", "user", userId, { role });
    return c.json({ ok: true });
  });

  api.delete("/workspace/members/:userId", async (c) => {
    if (!sql) return unavailable(c);
    const userId = c.req.param("userId");
    if (!validId(userId)) return c.json({ error: "member_not_found" }, 404);
    const res = await run(
      c,
      (tx, actor, workspaceId) =>
        tx`SELECT mnemosyne.mnemo_workspace_remove_member(${actor}, ${workspaceId}, ${userId})`
    );
    if (res instanceof Response) return res;
    // The removal revoked the member's keys homed here (0054); drop them, and
    // the cached role, from this process's auth caches now.
    deps.userStatus?.invalidate(userId);
    forgetUserAuth(userId);
    await audit(c, "member_removed", "user", userId);
    return c.json({ ok: true });
  });

  api.post("/workspace/invitations", async (c) => {
    if (!sql) return unavailable(c);
    if (!sessionUser(c) || !isManager(c)) return forbidden(c);
    const off = await invitationsOff(c);
    if (off) return off;
    const body = await readJson(c);
    const email = parseEmail(body?.email);
    if (!body || !email || !isRole(body.role)) return c.json({ error: "invalid_request" }, 400);
    const role = body.role;
    const limited = await issueLimited(c);
    if (limited) return limited;
    // Read before issuing: a failure here must not leave a link nobody saw.
    const base = await linkBaseUrl(c, deps);
    const { token, hash } = newLinkToken();
    const res = await run(c, async (tx, actor, workspaceId) => {
      const [row] = await tx<[{ id: string }]>`
        SELECT mnemosyne.mnemo_link_issue(${actor}, 'invite', ${email}, ${workspaceId}, ${role},
                                          ${hash}, ${linkTtl("invite")}::interval) AS id`;
      return row!.id;
    });
    if (res instanceof Response) return res;
    const expiresAt = new Date(Date.now() + LINK_TTL_SECONDS.invite * 1000).toISOString();
    await audit(c, "invitation_created", "invitation", res.ok, { role });
    return c.json({ id: res.ok, link: linkUrl(base, token), expiresAt }, 201);
  });

  api.post("/workspace/invitations/:id/regenerate", async (c) => {
    if (!sql) return unavailable(c);
    const id = c.req.param("id");
    if (!validId(id)) return c.json({ error: "invitation_not_found" }, 404);
    if (!sessionUser(c) || !isManager(c)) return forbidden(c);
    const off = await invitationsOff(c);
    if (off) return off;
    const limited = await issueLimited(c);
    if (limited) return limited;
    const base = await linkBaseUrl(c, deps);
    const { token, hash } = newLinkToken();
    const res = await run(c, async (tx, actor, workspaceId) => {
      const [row] = await tx<[{ expires_at: Date | string }]>`
        SELECT mnemosyne.mnemo_invitation_regenerate(${actor}, ${workspaceId}, ${id},
                                                     ${hash}, ${linkTtl("invite")}::interval) AS expires_at`;
      return iso(row!.expires_at);
    });
    if (res instanceof Response) return res;
    await audit(c, "link_created", "invitation", id, { purpose: "invite" });
    return c.json({ link: linkUrl(base, token), expiresAt: res.ok });
  });

  api.delete("/workspace/invitations/:id", async (c) => {
    if (!sql) return unavailable(c);
    const id = c.req.param("id");
    if (!validId(id)) return c.json({ error: "invitation_not_found" }, 404);
    const res = await run(
      c,
      (tx, actor, workspaceId) =>
        tx`SELECT mnemosyne.mnemo_invitation_revoke(${actor}, ${workspaceId}, ${id})`
    );
    if (res instanceof Response) return res;
    await audit(c, "invitation_revoked", "invitation", id);
    return c.json({ ok: true });
  });
}
