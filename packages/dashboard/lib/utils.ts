import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui-style class combiner — Tailwind-aware merge over clsx. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Open-redirect guard for the login `?next=` param (Engram's
 * sanitizeDashboardNext, spec §5.1 non-negotiable #6): only same-app
 * destinations under /dashboard are allowed; anything else falls back
 * to the dashboard home.
 */
export function sanitizeDashboardNext(next: string | null | undefined): string {
  // Backslashes and control characters: browsers normalize or drop them, which can
  // turn "/dashboard/\t/evil.test" into a protocol-relative address.
  if (!next || /[\\\u0000-\u001f\u007f]/.test(next)) return "/dashboard";
  const path = next.split(/[?#]/, 1)[0];
  // The base path itself or a segment under it ("/dashboardX" is another app), and no
  // empty segment ("//host") anywhere in the path; the query may hold anything.
  if (!/^\/dashboard(?:\/|$)/.test(path) || path.includes("//")) return "/dashboard";
  return next;
}
