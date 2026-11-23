import "server-only";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { isTimeout } from "./load";
import { loginPath, PATH_HEADER } from "./login-path";
import type { WorkspaceRole } from "./roles";

/**
 * Server-side data access: React Server Components talk to the Hono server
 * directly (no rewrite hop), forwarding the mnemo_dash_token cookie so the
 * /dashboard/api bridge authenticates the session.
 */
const MNEMO_SERVER_URL = process.env.MNEMO_SERVER_URL ?? "http://localhost:3939";

/**
 * How long a server render waits for the bridge (APP-043). A stalled API server would
 * otherwise hold the page open forever; past this the source reads as a load failure.
 */
export const FETCH_TIMEOUT_MS = 10_000;

/** What a server-side read got: `timedOut` says the server took too long to answer. */
export interface ApiResult<T> {
  data: T | null;
  status: number | null;
  timedOut?: true;
}

export interface DashboardSession {
  userId?: string | null;
  /** The signed-in account's email (password sessions). */
  email?: string | null;
  isSuperadmin?: boolean;
  /** The workspace was opened from the Installation section (read-only unless a member). */
  viaInstance?: boolean;
  authMethod?: "password" | "apiKey";
  workspaceId: string;
  workspaceName?: string | null;
  keyPrefix: string;
  scopes: string[];
  plan: string;
  role: "admin" | "contributor" | "viewer";
  /** Membership role in this workspace (password sessions); null for an API key session. */
  workspaceRole?: WorkspaceRole | null;
  /** The workspace is the signed-in user's own personal workspace. */
  workspaceIsPersonal?: boolean;
  expiresAt: string;
}

async function cookieHeader(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get("mnemo_dash_token")?.value;
  return token ? `mnemo_dash_token=${token}` : null;
}

/**
 * Validate the session cookie against the server. Null = not signed in. Memoized per request
 * (React `cache`): the layout, the page, its metadata and its loaders share one round trip.
 */
export const getSession = cache(async function getSession(): Promise<DashboardSession | null> {
  const cookie = await cookieHeader();
  if (!cookie) return null;
  try {
    const res = await fetch(`${MNEMO_SERVER_URL}/dashboard/auth/session`, {
      headers: { cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as DashboardSession;
  } catch {
    return null;
  }
});

/**
 * Fetch a /dashboard/api resource server-side with the session cookie, keeping the
 * HTTP status: `data` is null on any failure, `status` is null when no answer came
 * (network error, timeout: then `timedOut`). For pages that tell failures apart (a 400
 * is not a 404, a 403 is not "try again"). A session that ended does not return: it
 * redirects to the login, whether the bridge said so (401) or the cookie is gone (its
 * 8-hour Max-Age ran out, APP-041).
 */
export async function apiRead<T>(path: string): Promise<ApiResult<T>> {
  const cookie = await cookieHeader();
  if (!cookie) return redirectToLogin();
  let res: Response;
  try {
    res = await fetch(`${MNEMO_SERVER_URL}/dashboard/api${path}`, {
      headers: { cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return isTimeout(e)
      ? { data: null, status: null, timedOut: true }
      : { data: null, status: null };
  }
  // The bridge answers 401 only for a session that is gone: an empty page would hide it.
  if (res.status === 401) return redirectToLogin();
  if (!res.ok) return { data: null, status: res.status };
  // An answer came: a body that is not JSON is no data, not "no answer". The timeout
  // also covers the body, so one that stalls half-way is a timeout too.
  try {
    return { data: (await res.json()) as T, status: res.status };
  } catch (e) {
    return isTimeout(e)
      ? { data: null, status: null, timedOut: true }
      : { data: null, status: res.status };
  }
}

/**
 * Leave a server render for the login, carrying the address being rendered as `next`.
 * The address comes from `proxy.ts` (a Server Component cannot read the URL); without
 * it the login gets no `next`.
 */
export async function redirectToLogin(): Promise<never> {
  redirect(loginPath((await headers()).get(PATH_HEADER)));
}

/**
 * Fetch a /dashboard/api resource server-side with the session cookie.
 * Returns the parsed JSON, or null on any failure (page renders a
 * degraded state instead of crashing); an ended session redirects to the login.
 */
export async function apiGet<T>(path: string): Promise<T | null> {
  return (await apiRead<T>(path)).data;
}

/**
 * The Installation pages are for superadmins only. Anyone else gets the same
 * 404 as an address that does not exist; the server answers the instance API
 * the same way, so the section does not announce itself.
 */
export async function requireSuperadmin(): Promise<DashboardSession> {
  const session = await getSession();
  if (!session?.isSuperadmin) notFound();
  return session;
}
