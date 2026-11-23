/**
 * The signed-in user's own workspaces (dashboard cookie bridge only).
 *
 *   GET  /my-workspaces              → { workspaces: [{ id, name, role, isPersonal, current,
 *                                        factsLive, lastWriteAt, memberCount }],
 *                                        ownedTeamCount, limit }   (limit null: no limit)
 *                                      factsLive counts under the session's ceiling; the three
 *                                      figures are null when they could not be read.
 *   POST /my-workspaces              { name } → 201 { id, name }   and the session moves to it
 *                                      (400 invalid_name; 409 workspace_limit { limit })
 *   POST /my-workspaces/:id/switch   → { ok: true }                 and the session moves to it
 *                                      (404 workspace_not_found: not a member)
 *
 * Access. A password session only: the person acts, never a key. Any enabled
 * user may create a team workspace they own (migration 0056 gives it its own
 * organization tenant). A user who is not a superadmin may own at most
 * `workspaceLimitPerUser` team workspaces (installation setting, default 5);
 * the database counts and refuses under a per-user lock. Creating is audited
 * as workspace_created in the new workspace.
 *
 * Switching re-issues the session for a workspace the user belongs to, with
 * the role read from the database now, as login does.
 */
import type { Context } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { asAppUser, readWorkspaceRole } from "../dashboard-live-session.js";
import { readDashboardSecret } from "../dashboard-session.js";
import { dashboardCookieOptions, issuePasswordSession } from "../dashboard-session-issue.js";
import { emitAudit } from "../audit-emit.js";
import { readInstanceSettings } from "../instance-settings.js";
import { resolveProvenance } from "../provenance.js";
import { resolveCeiling } from "../rbac.js";
import { validId } from "./workspace-members.js";

type Env = { Variables: AuthVariables };

const MAX_NAME_LENGTH = 100;

interface WorkspaceRow {
  id: string;
  name: string;
  role: "owner" | "admin" | "write" | "read";
  is_personal: boolean;
  owned_team_count: number;
}

/** The person behind a password session, or null (an API key session). */
const sessionUser = (c: Context<Env>): string | null =>
  c.get("actorRefKind") === "user" ? (c.get("userId") ?? null) : null;

export function mountMyWorkspaces(api: OpenAPIHono<Env>, deps: ServerDeps): void {
  const sql = deps.metricsPgClient;
  const secret = readDashboardSecret();
  const cookieOptions = dashboardCookieOptions();

  const unavailable = (c: Context<Env>) =>
    c.json({ error: "workspaces_unavailable", message: "Workspaces are unavailable" }, 503);
  const passwordOnly = (c: Context<Env>) =>
    c.json(
      { error: "password_session_required", message: "Sign in with your email and password." },
      403
    );

  /** The limit for this caller: null for a superadmin (no limit). */
  const limitFor = async (c: Context<Env>): Promise<number | null> =>
    c.get("instanceSuperadmin") === true
      ? null
      : (await readInstanceSettings(deps)).workspaceLimitPerUser;

  api.get("/my-workspaces", async (c) => {
    if (!sql) return unavailable(c);
    const actor = sessionUser(c);
    if (!actor) return passwordOnly(c);
    const rows = await asAppUser(
      sql,
      actor,
      (tx) => tx<WorkspaceRow[]>`SELECT * FROM mnemosyne.mnemo_user_workspaces(${actor})`
    );
    const current = c.get("workspaceId");
    const maxSensitivity = resolveCeiling(c);
    // Each workspace's figures, best-effort: one that cannot be read is null, never zero.
    // ponytail: two reads per workspace, bounded by the per-user workspace limit; one grouped
    // query if a superadmin's list ever grows long.
    // Live memories and the last write share one read and one predicate (live, under the
    // ceiling), so a closed or hidden fact never shows through its timestamp.
    const figures = (id: string) =>
      Promise.all([
        deps.storage?.getFactStats({ workspaceId: id, maxSensitivity }).catch(() => null) ?? null,
        asAppUser(
          sql,
          actor,
          (tx) =>
            tx<
              Array<{ n: number }>
            >`SELECT count(*)::int AS n FROM mnemosyne.mnemo_workspace_member_profiles(${actor}, ${id})`
        )
          .then((r) => r[0]?.n ?? null)
          .catch(() => null),
      ]);
    const enriched = await Promise.all(rows.map((row) => figures(row.id)));
    return c.json({
      workspaces: rows.map((row, i) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        isPersonal: row.is_personal,
        current: row.id === current,
        factsLive: enriched[i]![0]?.live ?? null,
        lastWriteAt: enriched[i]![0]?.lastWriteAt ?? null,
        memberCount: enriched[i]![1],
      })),
      ownedTeamCount: rows[0]?.owned_team_count ?? 0,
      limit: await limitFor(c),
    });
  });

  api.post("/my-workspaces", async (c) => {
    if (!sql || !secret) return unavailable(c);
    const actor = sessionUser(c);
    if (!actor) return passwordOnly(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const raw = (body as { name?: unknown } | null)?.name;
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) return c.json({ error: "invalid_name" }, 400);

    const limit = await limitFor(c);
    let created: { workspace_id: string };
    try {
      const rows = await asAppUser(
        sql,
        actor,
        (tx) =>
          tx<{ workspace_id: string }[]>`
            SELECT workspace_id FROM mnemosyne.mnemo_user_create_workspace(${actor}, ${name}, ${limit ?? 0})`
      );
      created = rows[0]!;
    } catch (err) {
      const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown };
      if (code === "54000" && message === "workspace_limit")
        return c.json({ error: "workspace_limit", limit }, 409);
      if (code === "22023" && message === "invalid_name")
        return c.json({ error: "invalid_name" }, 400);
      if (code === "42501" && message === "user_not_allowed")
        return c.json({ error: "user_not_allowed" }, 403);
      throw err;
    }

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId: created.workspace_id,
      actorType: provenance.actorType,
      actorId: provenance.actorId,
      action: "workspace_created",
      resourceKind: "workspace",
      resourceId: created.workspace_id,
      detail: { name },
      isTerminal: false,
    });
    await issuePasswordSession(
      c,
      deps,
      secret,
      { userId: actor, workspaceId: created.workspace_id, role: "owner", continueSession: true },
      cookieOptions
    );
    return c.json({ id: created.workspace_id, name }, 201);
  });

  api.post("/my-workspaces/:id/switch", async (c) => {
    if (!sql || !secret) return unavailable(c);
    const actor = sessionUser(c);
    if (!actor) return passwordOnly(c);
    const workspaceId = c.req.param("id");
    if (!validId(workspaceId)) return c.json({ error: "workspace_not_found" }, 404);
    const role = await readWorkspaceRole(sql, actor, workspaceId);
    if (!role) return c.json({ error: "workspace_not_found" }, 404);
    await issuePasswordSession(
      c,
      deps,
      secret,
      { userId: actor, workspaceId, role, continueSession: true },
      cookieOptions
    );
    return c.json({ ok: true });
  });
}
