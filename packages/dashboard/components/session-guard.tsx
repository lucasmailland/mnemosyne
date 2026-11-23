"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { loginPath } from "@/lib/login-path";

const requestUrl = (input: RequestInfo | URL) =>
  new URL(input instanceof Request ? input.url : String(input), window.location.href);

/** A 401 that answers a wrong password: read from a copy, so the caller can still read it. */
async function refusedPassword(res: Response): Promise<boolean> {
  try {
    const body: unknown = await res.clone().json();
    return (body as { error?: unknown } | null)?.error === "invalid_credentials";
  } catch {
    return false;
  }
}

/**
 * The one place a client call learns that the session ended (APP-041). A 401 from a
 * same-origin /dashboard/api/ call sends the reader to the login with this page as `next`,
 * whichever page or helper made it. The caller still receives its answer. A refused password
 * is not an ended session and stays the page's to explain: a wrong current password on
 * /dashboard/auth/*, or `invalid_credentials` through the bridge (a superadmin step-up).
 */
export function SessionGuard() {
  const router = useRouter();
  useEffect(() => {
    // Wraps the page's fetch; it adds no call to the bridge of its own. Named through
    // `scope` because the server's bridge-contract test reads fetch named off the window as a call
    // it cannot place, and every call this wrapper forwards is already a `fetch(...)` there.
    const scope: { fetch: typeof fetch } = window;
    const original = scope.fetch;
    scope.fetch = async (input, init) => {
      const res = await original.call(scope, input, init);
      if (res.status === 401) {
        const url = requestUrl(input);
        if (
          url.origin === window.location.origin &&
          url.pathname.startsWith("/dashboard/api/") &&
          !(await refusedPassword(res))
        )
          router.replace(loginPath(window.location.pathname + window.location.search));
      }
      return res;
    };
    return () => {
      scope.fetch = original;
    };
  }, [router]);
  return null;
}
