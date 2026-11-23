import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AuthVariables } from "../auth.js";
import { NotFoundError, ForbiddenError, ConflictError } from "../errors.js";
import type { ApprovalStore } from "@mnemo-ai/types";

export function mountApprovals(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: { approvals: ApprovalStore }
): void {
  app.get("/approvals/:id", async (c) => {
    const ws = c.get("workspaceId");
    const ar = await deps.approvals.get(ws, c.req.param("id"));
    if (!ar) throw new NotFoundError("approval not found");
    return c.json(
      { id: ar.id, status: ar.status, trigger: ar.trigger, resource: ar.resource },
      200
    );
  });

  app.post("/approvals/:id/resolve", async (c) => {
    const ws = c.get("workspaceId");
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { status?: "approved" | "denied" };
    if (body.status !== "approved" && body.status !== "denied") {
      return c.json(
        { error: { code: "bad_request", message: "status must be approved|denied" } },
        400
      );
    }

    // SEC-2 fix: the resolver's identity MUST come from the authenticated
    // caller, never from the request body — a client-supplied `resolvedBy`
    // string let anyone stamp any name on an approval with zero identity
    // verification, and self-approval (the requester resolving their own
    // gated request) was never rejected. `/approvals/` is intentionally
    // exempt from the standard RBAC scope check (rbac-policy.ts — it's a
    // control-plane, not data-plane, route), so this route is the ONLY
    // enforcement point; it must not skip identity checks just because RBAC
    // does.
    //
    // Dual control must key on the HUMAN (userId), never the credential
    // (actorId) — a key-level identity lets one person holding two admin keys
    // request with one and resolve with the other, satisfying requester !=
    // resolver against themselves. Fail closed when there's no bound user.
    const resolverId = c.get("userId" as never) as string | null | undefined;
    if (!resolverId) {
      throw new ForbiddenError("approval resolution requires a user-bound key");
    }
    const ar = await deps.approvals.get(ws, id);
    if (!ar) throw new NotFoundError("approval not found");
    if (ar.status !== "pending") {
      throw new ConflictError(`approval already ${ar.status}`);
    }
    // APP-007: an expired request cannot be approved after the fact.
    if (ar.expiresAt.getTime() <= Date.now()) {
      throw new ConflictError("approval expired");
    }
    if (ar.requestedBy === resolverId) {
      throw new ForbiddenError(
        "self-approval is not permitted: the requester of an approval cannot resolve their own request"
      );
    }

    // A concurrent resolver, or expiry in between, wins: report it instead of a false 200.
    if ((await deps.approvals.resolve(ws, id, body.status, resolverId)) === false) {
      throw new ConflictError("approval is no longer pending");
    }
    return c.json({ id, status: body.status }, 200);
  });
}
