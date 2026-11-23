/**
 * Minimal test harness for NEW route files that are not yet wired into app.ts.
 *
 * The coordinator owns app.ts wiring (see each route's `wiringNeeded` note), so
 * a new mount fn cannot be exercised through `createApp` until that wiring lands.
 * This harness builds the same /v1 sub-router skeleton createApp uses (CORS-free,
 * auth middleware + single error handler + the OpenAPI sub-app mounted at /v1)
 * and mounts ONLY the route(s) under test. It is intentionally a strict subset:
 * no rate-limit / idempotency / RBAC middleware, which the routes under test do
 * not depend on.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";

import { createAuthMiddleware, type AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { toErrorBody } from "../errors.js";

type MountFn = (app: OpenAPIHono<{ Variables: AuthVariables }>, deps: ServerDeps) => void;

export function buildMountHarness(deps: ServerDeps, mounts: MountFn[]): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err, undefined);
    return c.json(body, status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 501 | 503);
  });

  const v1 = new OpenAPIHono<{ Variables: AuthVariables }>();
  v1.use("*", createAuthMiddleware(deps.apiKeys));
  for (const mount of mounts) mount(v1, deps);

  app.route("/", v1);
  return app;
}
