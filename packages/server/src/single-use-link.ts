/**
 * Single-use links (accounts stage A, spec §3): invitations, account setup
 * and password reset.
 *
 * A link carries a random token. Only its SHA-256 reaches the database
 * (mnemo_link_token, migration 0054); the raw token appears once, in the link
 * returned to whoever created it. Never log, audit or persist a token or a
 * link: request logs go through redactLinkPath.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";

import type { ServerDeps } from "./deps.js";
import { DashboardLoginLimiter } from "./dashboard-password.js";
import { readInstanceSettings } from "./instance-settings.js";

/** Lifetimes (global constraints): invitation and account setup 7 days, reset 30 minutes. */
export const LINK_TTL_SECONDS = {
  invite: 7 * 24 * 60 * 60,
  account_setup: 7 * 24 * 60 * 60,
  password_reset: 30 * 60,
} as const;
export type LinkPurpose = keyof typeof LINK_TTL_SECONDS;

/** Postgres interval text for a purpose's lifetime. */
export const linkTtl = (purpose: LinkPurpose): string => `${LINK_TTL_SECONDS[purpose]} seconds`;

/** SHA-256 hex of a raw token: the only form the database sees. */
export const hashLinkToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** 32 random bytes, base64url, and its hash. */
export function newLinkToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashLinkToken(token) };
}

/** A token as newLinkToken makes it: 43 base64url characters. */
export const isLinkToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

/** The dashboard page that opens a link. */
export function linkUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/dashboard/link/${token}`;
}

/**
 * Base URL links are built on: the saved installation setting
 * (instance-settings.ts), else MNEMO_PUBLIC_BASE_URL (trimmed, without
 * trailing slashes), else the request's own origin.
 */
export async function linkBaseUrl(
  c: Context,
  deps: Pick<ServerDeps, "workspaceConfigStore">,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  const { publicBaseUrl } = await readInstanceSettings(deps, { env });
  return publicBaseUrl ?? new URL(c.req.url).origin;
}

const LINK_PATH = /^(\/dashboard\/(?:auth\/)?link\/)[^/?#]+/;

/** A request path for logs: a link token in it becomes ":token". */
export function redactLinkPath(path: string): string {
  return path.replace(LINK_PATH, "$1:token");
}

/** Links one acting user may issue per 15 minutes (spec §3 rate limits). */
export const LINK_ISSUE_BURST = 30;

const issueLimiters = new WeakMap<object, DashboardLoginLimiter>();

/**
 * Rate limit for the endpoints that issue links, per acting user, on the
 * shared token-bucket backend. Returns the seconds to wait, 0 when allowed.
 * One limiter per deps object, so the workspace and instance routes share
 * the local fallback buckets.
 */
export function consumeLinkIssue(
  deps: Pick<ServerDeps, "rateLimitBackend">,
  userId: string
): Promise<number> {
  let limiter = issueLimiters.get(deps);
  if (!limiter) {
    limiter = new DashboardLoginLimiter(deps.rateLimitBackend);
    issueLimiters.set(deps, limiter);
  }
  return limiter.consumeKeys([[`dashboard:link-issue:user:${userId}`, LINK_ISSUE_BURST]]);
}

/** consumeLinkIssue as a response: null when allowed, else the 429 to return. */
export async function linkIssueRefused(
  c: Context,
  deps: Pick<ServerDeps, "rateLimitBackend">,
  userId: string
): Promise<Response | null> {
  const retry = await consumeLinkIssue(deps, userId);
  if (!retry) return null;
  c.header("Retry-After", String(retry));
  return c.json({ error: "rate_limited", message: "Too many links. Try again later." }, 429);
}
