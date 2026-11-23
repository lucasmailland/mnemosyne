import { sanitizeDashboardNext } from "./utils";

/**
 * The request header `proxy.ts` sets to the address being rendered (base path, path and
 * query), so a server render that finds the session gone can send the reader back to it.
 */
export const PATH_HEADER = "x-mnemo-path";

/**
 * The login address for a reader whose session ended on `path` (as the browser shows it,
 * `/dashboard/...`). Relative to the base path, for `redirect()` and `router.replace()`.
 * No `next` when it would be the home, the login itself, or not ours.
 */
export function loginPath(path: string | null | undefined): string {
  const next = sanitizeDashboardNext(path);
  if (/^\/dashboard\/?$|^\/dashboard\/login(?:[/?#]|$)/.test(next)) return "/login";
  return `/login?next=${encodeURIComponent(next)}`;
}
