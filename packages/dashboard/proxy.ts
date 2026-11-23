import { NextResponse, type NextRequest } from "next/server";

import { PATH_HEADER } from "@/lib/login-path";

/**
 * Tells the server render which address it is rendering. A Server Component cannot read
 * the request URL, so without this a session that expired mid-visit sends the reader to
 * a bare /login and the page they were on is lost (APP-041). Always overwritten, never
 * taken from the client; `loginPath` sanitizes it again before it becomes a `next`.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  const { basePath, pathname, search } = request.nextUrl;
  headers.set(PATH_HEADER, `${basePath}${pathname}${search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Pages only: not the bridges to the API server, not Next's assets nor files.
  matcher: ["/((?!api/|auth/|bootstrap|_next/static|_next/image|.*\\.[a-z0-9]+$).*)"],
};
