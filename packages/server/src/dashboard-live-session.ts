/**
 * Live dashboard session state (accounts stage A).
 *
 * A dashboard JWT names a user and a workspace; it does not decide what that
 * user may do now. For password sessions every request re-reads:
 *   - the user status (disabled, sessions_valid_after, superadmin), through
 *     UserStatusService's short cache, busted on change;
 *   - the user's role in the session workspace, from mnemo_workspace_member.
 *   - whether the session was signed out (mnemo_dashboard_session_revocation, 0059;
 *     never cached, so a sign-out applies on the next request on every replica).
 * The scopes in the token are ignored for password sessions. API key sessions
 * keep their JWT scopes; when one carries a userId (a user-bound key) it ends
 * as soon as that user is disabled (keyUserAllowed, shared with every key
 * transport). sessions_valid_after does not apply to API key sessions.
 *
 * Fails closed: a missing status service or database, or a lookup error,
 * throws LiveSessionUnavailableError / the lookup error. Callers answer 503,
 * never "allowed".
 */
import type postgres from "postgres";
import { TenantRepository } from "@mnemo-ai/adapter-postgres";
import type { ServerDeps } from "./deps.js";
import {
  DASHBOARD_SESSION_TTL_SECONDS,
  type DashboardSessionPayload,
} from "./dashboard-session.js";
import { membershipScopes, type Membership } from "./dashboard-password.js";
import type { UserStatus } from "./user-status.js";
import { keyUserAllowed } from "./auth-evaluate.js";

export interface LiveSession {
  workspaceId: string;
  userId: string | null;
  /** Live membership role; null only for API key sessions (no live role). */
  role: Membership["role"] | null;
  scopes: string[];
  isSuperadmin: boolean;
  viaInstance: boolean;
}

export class LiveSessionUnavailableError extends Error {
  constructor(message = "live session checks are not available") {
    super(message);
    this.name = "LiveSessionUnavailableError";
  }
}

const ROLES: ReadonlySet<string> = new Set(["owner", "admin", "write", "read"]);
const isRole = (value: unknown): value is Membership["role"] =>
  typeof value === "string" && ROLES.has(value);

/**
 * A transaction as app_user with the actor GUCs set to `actorUserId` (empty
 * for none) and no tenant: the tenant-table exception in CLAUDE.md, and the
 * caller of the SECURITY DEFINER functions that take the actor explicitly.
 */
export function asAppUser<T>(
  sql: postgres.Sql,
  actorUserId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE app_user`;
    // mnemosyne.region: a workspace created here gets this instance's region
    // (the mnemo_workspace.region default, migration 0062).
    await tx`SELECT set_config('mnemosyne.actor_user_id', ${actorUserId}, true), set_config('mnemosyne.actor_tenant_id', '', true), set_config('mnemosyne.region', ${process.env.MNEMO_REGION ?? ""}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * The user's role in a workspace, read as the user, through
 * TenantRepository's query. Errors propagate.
 */
export async function readWorkspaceRole(
  sql: postgres.Sql,
  userId: string,
  workspaceId: string
): Promise<Membership["role"] | null> {
  const role = (await asAppUser(sql, userId, (tx) =>
    new TenantRepository(tx).getWorkspaceMemberRole(workspaceId, userId)
  )) as unknown;
  return isRole(role) ? role : null;
}

/** The session was signed out: its id (sid, from the signed jti) is in the revocation table. Errors propagate. */
async function sessionRevoked(tx: postgres.TransactionSql, sid: string): Promise<boolean> {
  const [row] =
    (await tx`SELECT mnemosyne.mnemo_dashboard_session_revoked(${sid}) AS revoked`) as unknown as Array<{
      revoked?: boolean;
    }>;
  return row?.revoked === true;
}

/**
 * Margin on a revocation row past the session TTL: a re-issue (switch, open, create) that
 * passed its live check just before the sign-out mints just after it, and replicas and the
 * database clocks drift. Within the 9-hour cap of mnemo_dashboard_session_revoke (0059).
 */
const REVOCATION_MARGIN_SECONDS = 60 * 60;

/**
 * Record a sign-out by session id (the hash of the signed jti). The row lives as long as
 * any token of the session can, plus the margin: one minted up to now expires within the
 * session TTL, and a revoked session mints no more (re-issue needs a live one).
 */
export function revokeDashboardSession(
  sql: postgres.Sql,
  payload: Pick<DashboardSessionPayload, "sid">,
  now: number = Date.now()
): Promise<void> {
  if (!payload.sid) return Promise.resolve();
  const sid = payload.sid;
  const until = Math.floor(now / 1000) + DASHBOARD_SESSION_TTL_SECONDS + REVOCATION_MARGIN_SECONDS;
  return asAppUser(sql, "", async (tx) => {
    await tx`SELECT mnemosyne.mnemo_dashboard_session_revoke(${sid}, to_timestamp(${until}))`;
  });
}

export async function resolveLiveSession(
  deps: Pick<ServerDeps, "userStatus" | "metricsPgClient">,
  payload: DashboardSessionPayload
): Promise<LiveSession | null> {
  if (payload.authMethod !== "password") {
    if (!(await keyUserAllowed(deps.userStatus, payload.userId))) return null;
    // Without a database there is no revocation table, as there is no user status.
    const sql = deps.metricsPgClient;
    if (sql && payload.sid) {
      const sid = payload.sid;
      if (await asAppUser(sql, "", (tx) => sessionRevoked(tx, sid))) return null;
    }
    return {
      workspaceId: payload.workspaceId,
      userId: payload.userId,
      role: null,
      scopes: [...payload.scopes],
      isSuperadmin: false,
      viaInstance: false,
    };
  }
  const userId = payload.userId;
  if (!userId || typeof payload.iat !== "number") return null;
  if (!deps.userStatus || !deps.metricsPgClient) throw new LiveSessionUnavailableError();
  const status = await deps.userStatus.get(userId);
  if (!status || !deps.userStatus.sessionAllowed(status, payload.iat)) return null;
  const viaInstance = payload.viaInstance === true;
  const sid = payload.sid;
  // One transaction: the sign-out check rides along with the role read.
  const [revoked, liveRole] = await asAppUser(deps.metricsPgClient, userId, async (tx) => [
    sid ? await sessionRevoked(tx, sid) : false,
    (await new TenantRepository(tx).getWorkspaceMemberRole(payload.workspaceId, userId)) as unknown,
  ]);
  if (revoked) return null;
  let role = isRole(liveRole) ? liveRole : null;
  if (!role) {
    if (!viaInstance || !status.isSuperadmin) return null;
    role = "read";
  }
  const scopes = membershipScopes(role);
  if (status.isSuperadmin && !scopes.includes("admin:workspace")) scopes.push("admin:workspace");
  return {
    workspaceId: payload.workspaceId,
    userId,
    role,
    scopes,
    isSuperadmin: status.isSuperadmin,
    viaInstance,
  };
}

/** Longest wait for a fresh session to outlive a revocation (clock skew guard). */
const MAX_EPOCH_WAIT_MS = 2_000;

/**
 * Wait until a session minted now survives `sessionAllowed`: its whole-second
 * `iat` must reach the first whole second at or after sessions_valid_after.
 * A session minted right after a password change (or a revocation) therefore
 * lives, while every session minted in the revocation's own second dies.
 */
export async function waitForSessionEpoch(
  status: UserStatus | null,
  now: () => number = Date.now
): Promise<void> {
  if (!status) return;
  const target = Math.ceil(status.sessionsValidAfter.getTime() / 1000) * 1000;
  const until = Math.min(target, now() + MAX_EPOCH_WAIT_MS);
  // Re-read the clock after each sleep: a timer runs on libuv's cached loop time and can
  // wake a millisecond before the wall clock reaches `target`, minting a dead session.
  for (let t = now(); t < until; t = now())
    await new Promise((resolve) => setTimeout(resolve, until - t));
}
