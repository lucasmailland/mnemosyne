import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { BadRequestError, NotFoundError, NotImplementedError } from "../errors.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";

/**
 * POST /admin/erasure — GDPR Article 17 crypto-erasure of one data subject in
 * the caller's workspace (SECURITY.md section 8).
 *
 * Destroys the subject's data encryption keys: every DEK of a platform user
 * (`userId`, `destroyUserDeks`) or the one DEK of an actor (`actorId`, the
 * `key:<id>` ref on its facts, `destroyActorDek`). Every confidential or
 * restricted value written under those keys becomes unreadable; no row is
 * deleted. Scope `memory:hard_delete` (app-scope.ts). The body must repeat the
 * subject id in `confirm`.
 *
 * Audit: `erasure_initiated` is written BEFORE any key is touched and is an
 * unguarded await, like core forget's hard mode: if it cannot be recorded the
 * erasure aborts while it is still reversible. `erasure_complete` (terminal)
 * follows the destruction.
 */

const EraseBodySchema = z
  .object({
    userId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .openapi({ description: "Erase every key of this platform user (mnemo_user.id)." }),
    actorId: z.string().min(1).max(256).optional().openapi({
      description:
        "Erase the key of this actor (the `key:<id>` ref its facts carry). For keys provisioned without a user binding.",
    }),
    confirm: z
      .string()
      .openapi({ description: "Must equal the userId or actorId being erased. Irreversible." }),
  })
  .openapi("EraseSubjectBody");

const EraseResultSchema = z
  .object({
    subject: z.object({ kind: z.enum(["user", "actor"]), id: z.string() }),
    keysDestroyed: z.number().int(),
  })
  .openapi("EraseSubjectResult");

const eraseRoute = createRoute({
  method: "post",
  path: "/admin/erasure",
  tags: ["admin"],
  summary:
    "GDPR crypto-erasure: destroy a user's or actor's encryption keys so their encrypted memory can never be read again.",
  request: {
    body: { content: { "application/json": { schema: EraseBodySchema } }, required: true },
  },
  responses: {
    200: {
      description: "Keys destroyed.",
      content: { "application/json": { schema: EraseResultSchema } },
    },
    400: { description: "Not exactly one of userId/actorId, or `confirm` does not repeat it." },
    403: { description: "The key lacks memory:hard_delete." },
    404: { description: "No live key for that subject in this workspace (already erased)." },
    501: { description: "The storage adapter cannot destroy keys." },
  },
});

export function mountAdminErasure(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(eraseRoute, async (c) => {
    const { workspaceId } = getAuthCtx(c);
    const body = c.req.valid("json");
    if ((body.userId === undefined) === (body.actorId === undefined)) {
      throw new BadRequestError("Name exactly one of userId or actorId", {
        code: "erasure_subject_required",
      });
    }
    const kind = body.userId !== undefined ? "user" : "actor";
    const id = (body.userId ?? body.actorId)!;
    if (body.confirm !== id) {
      throw new BadRequestError("confirm must repeat the userId or actorId being erased", {
        code: "erasure_not_confirmed",
      });
    }
    const storage = deps.storage;
    if (!storage || !(kind === "user" ? storage.destroyUserDeks : storage.destroyActorDek)) {
      throw new NotImplementedError("crypto-erasure is not supported by this storage adapter");
    }

    const provenance = resolveProvenance(c);
    const detail = {
      ...(provenance.userId ? { userId: provenance.userId } : {}),
      gdprErasure: true,
      subjectKind: kind,
    };
    await storage.appendAuditEntry({
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "erasure_initiated",
      resourceKind: kind,
      resourceId: id,
      isTerminal: false,
      detail,
    });

    const keysDestroyed =
      kind === "user"
        ? await storage.destroyUserDeks!(workspaceId, id)
        : (await storage.destroyActorDek!(workspaceId, id))
          ? 1
          : 0;
    if (keysDestroyed === 0) {
      throw new NotFoundError(`No live encryption key to erase for ${kind} ${id}`);
    }

    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "erasure_complete",
      resourceKind: kind,
      resourceId: id,
      isTerminal: true,
      detail: { ...detail, keysDestroyed },
    });

    return c.json({ subject: { kind, id }, keysDestroyed }, 200);
  });
}
