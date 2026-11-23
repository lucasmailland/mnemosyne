/**
 * Issue a dashboard password session: the cookie options and the minting that
 * sign-in (routes/dashboard-auth.ts) and the instance plane's "open a
 * workspace" (routes/instance.ts) share.
 */
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";

import type { ServerDeps } from "./deps.js";
import { membershipScopes, type Membership } from "./dashboard-password.js";
import { waitForSessionEpoch } from "./dashboard-live-session.js";
import {
  DASHBOARD_COOKIE,
  DASHBOARD_COOKIE_PATH,
  DASHBOARD_SESSION_TTL_SECONDS,
  mintDashboardToken,
  verifyDashboardToken,
} from "./dashboard-session.js";

/** Remembers the workspace of the last sign-in so the next choice can start on it. */
export const LAST_WORKSPACE_COOKIE = "mnemo_last_workspace";
const LAST_WORKSPACE_MAX_AGE = 365 * 24 * 60 * 60;

/** Options of every dashboard cookie; Secure unless MNEMO_DASHBOARD_INSECURE_COOKIE=true. */
export function dashboardCookieOptions(env: Record<string, string | undefined> = process.env) {
  return {
    httpOnly: true,
    secure: env["MNEMO_DASHBOARD_INSECURE_COOKIE"] !== "true",
    sameSite: "Lax" as const,
    path: DASHBOARD_COOKIE_PATH,
  };
}

export interface PasswordSessionInput {
  userId: string;
  workspaceId: string;
  /** Role the scopes are minted from. The bridge re-reads the live role on each request. */
  role: Membership["role"];
  /** A superadmin's session opened from the instance plane. */
  viaInstance?: true;
  /**
   * The request was authenticated by this browser's session cookie, for this same user
   * (a workspace switch, an "open", a create, a link redeemed while signed in): the new
   * token keeps that session's jti, so signing out ends the tokens before and after.
   * Otherwise (a sign-in) the token starts a new session.
   */
  continueSession?: boolean;
}

/** The jti of the request's session cookie when it verifies and belongs to `userId`. */
async function currentSessionJti(
  c: Context,
  secret: string,
  userId: string
): Promise<string | undefined> {
  const token = getCookie(c, DASHBOARD_COOKIE);
  const payload = token ? await verifyDashboardToken(secret, token) : null;
  return payload?.authMethod === "password" && payload.userId === userId ? payload.jti : undefined;
}

/**
 * Mint a password session and set it as the dashboard cookie. A session minted
 * in the second sessions_valid_after moved (a password change, a reset or a
 * revocation just now) would be dead on arrival, so minting waits for the
 * next second first.
 */
export async function issuePasswordSession(
  c: Context,
  deps: Pick<ServerDeps, "userStatus">,
  secret: string,
  input: PasswordSessionInput,
  cookieOptions: ReturnType<typeof dashboardCookieOptions> = dashboardCookieOptions()
) {
  if (deps.userStatus) await waitForSessionEpoch(await deps.userStatus.get(input.userId));
  const session = {
    workspaceId: input.workspaceId,
    keyPrefix: "password",
    scopes: membershipScopes(input.role),
    plan: "free",
    actorId: input.userId,
    userId: input.userId,
    authMethod: "password" as const,
    ...(input.viaInstance === true ? { viaInstance: true as const } : {}),
  };
  const jti = input.continueSession ? await currentSessionJti(c, secret, input.userId) : undefined;
  const { token, expiresAt } = await mintDashboardToken(secret, { ...session, jti });
  setCookie(c, DASHBOARD_COOKIE, token, {
    ...cookieOptions,
    maxAge: DASHBOARD_SESSION_TTL_SECONDS,
  });
  setCookie(c, LAST_WORKSPACE_COOKIE, input.workspaceId, {
    ...cookieOptions,
    maxAge: LAST_WORKSPACE_MAX_AGE,
  });
  return { session, expiresAt };
}
