import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { BreakGlassStore, SpecScope } from "@mnemo-ai/types";
import { ForbiddenError, BadRequestError } from "../errors.js";

/**
 * Grant validity window once filed. Admin A must use the approved grant within
 * 15 minutes of approval; after that the gate forces a fresh request. This is
 * the spec's break-glass "narrow window" — strict by design so a stale grant
 * cannot survive an extended pause between approval and use.
 */
const BREAK_GLASS_TTL_MS = 15 * 60_000;

/**
 * WP8 (F10) — `/break-glass` request + approve routes.
 *
 * Two-person dual control: admin A POSTs to file a request, admin B POSTs to
 * approve it. The store enforces requester ≠ approver structurally — the route
 * just translates the throw to a 403. Every request and approve action is
 * audit-logged through Hono's context logger (a no-op when no logger is wired,
 * via optional chaining).
 */
export function mountBreakGlass(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: { breakGlass: BreakGlassStore }
): void {
  // Admin A files a pending break-glass request.
  app.post("/break-glass", async (c) => {
    const { workspaceId: ws, userId, apiKeyPrefix } = getAuthCtx(c);
    if (apiKeyPrefix !== "mk_admin_") {
      throw new ForbiddenError("break-glass requests require an mk_admin_ key");
    }
    // Dual control must key on the HUMAN (userId), never the credential
    // (actorId/apiKeyPrefix) — a key-level identity lets one person holding two
    // mk_admin_ keys satisfy requester != approver against themselves. Fail
    // closed: an mk_admin_ key with no bound user cannot open a break-glass
    // request at all.
    if (!userId) {
      throw new ForbiddenError("break-glass requires a user-bound mk_admin_ key");
    }
    const actorId = userId;
    const body = (await c.req.json().catch(() => ({}))) as {
      reason?: string;
      requestedScopes?: string[];
    };
    if (!body.reason || typeof body.reason !== "string") {
      throw new BadRequestError("reason is required");
    }
    if (!Array.isArray(body.requestedScopes) || body.requestedScopes.length === 0) {
      throw new BadRequestError("requestedScopes must be a non-empty array");
    }
    const r = await deps.breakGlass.request({
      workspaceId: ws,
      requestedBy: actorId,
      reason: body.reason,
      requestedScopes: body.requestedScopes as SpecScope[],
      expiresAt: new Date(Date.now() + BREAK_GLASS_TTL_MS),
    });
    // Audit: who requested, why, which scopes (no secrets).
    const logger = c.get("logger" as never) as
      { info?: (entry: Record<string, unknown>) => void } | undefined;
    logger?.info?.({
      event: "break_glass.requested",
      workspaceId: ws,
      requestedBy: actorId,
      requestId: r.id,
      requestedScopes: r.requestedScopes,
      reason: r.reason,
    });
    return c.json(
      {
        id: r.id,
        status: r.status,
        requestedScopes: r.requestedScopes,
        expiresAt: r.expiresAt.toISOString(),
      },
      201
    );
  });

  // Status poll (admin A polls until a second admin approves).
  app.get("/break-glass/:id", async (c) => {
    const ws = c.get("workspaceId");
    const r = await deps.breakGlass.get(ws, c.req.param("id"));
    if (!r) throw new ForbiddenError("break-glass request not found");
    return c.json(
      {
        id: r.id,
        status: r.status,
        requestedBy: r.requestedBy,
        approvedBy: r.approvedBy ?? null,
      },
      200
    );
  });

  // Admin B approves. The store enforces requester≠approver and throws on
  // self-approval; the catch maps both that violation and a non-pending state
  // to a 403 so the response shape is uniform.
  app.post("/break-glass/:id/approve", async (c) => {
    const { workspaceId: ws, userId, apiKeyPrefix } = getAuthCtx(c);
    if (apiKeyPrefix !== "mk_admin_") {
      throw new ForbiddenError("break-glass approvals require an mk_admin_ key");
    }
    // Same userId-keyed dual control as the request side — see comment above.
    if (!userId) {
      throw new ForbiddenError("break-glass requires a user-bound mk_admin_ key");
    }
    const approverId = userId;
    const id = c.req.param("id");
    try {
      await deps.breakGlass.approve(ws, id, approverId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "approval failed";
      throw new ForbiddenError(msg);
    }
    const logger = c.get("logger" as never) as
      { info?: (entry: Record<string, unknown>) => void } | undefined;
    logger?.info?.({
      event: "break_glass.approved",
      workspaceId: ws,
      approvedBy: approverId,
      requestId: id,
    });
    return c.json({ id, status: "approved", approvedBy: approverId }, 200);
  });
}
