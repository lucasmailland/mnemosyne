/**
 * Mnemosyne — Legacy route manifest.
 *
 * Layout:
 *   mountRoutes(v1, deps) — /session/* under v1 OpenAPIHono
 *
 * Note: /memory/* and /entity/* (legacy) have been removed. The canonical
 * cognitive-layer routes are now mounted directly in app.ts:
 *   - POST /remember via mountRemember (routes/remember.ts)
 *   - DELETE /forget/:kind/:id via mountForget (routes/forget.ts)
 *   - POST /recall via mountRecall (routes/recall.ts)
 */

import { OpenAPIHono } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { mountAdminHarness } from "./admin-harness.js";
import { mountHarness } from "./harness.js";
import { mountSession } from "./session.js";

// ─── API routes (mounted under /v1 with auth) ────────────────────────────────

export function mountRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  mountAdminHarness(app, deps);
  mountHarness(app, deps);
  mountSession(app, deps);
}
