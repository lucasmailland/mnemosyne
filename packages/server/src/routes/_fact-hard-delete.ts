import type { Context } from "hono";

import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  NotImplementedError,
} from "../errors.js";
import { assertCanReadFact } from "../rbac.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";

/**
 * The resource hard delete of one fact (SEC-4). `DELETE /facts/:id/hard` and
 * `DELETE /forget/fact/:id?mode=hard` (V-8) both run this, so the two doors
 * cannot drift: memory:hard_delete, fail closed without the adapter capability,
 * 404 above the caller's ceiling (S6), the deletion-log row and the index
 * cleanup in the DELETE's own transaction, 409 for a row mid-consolidation, and
 * a terminal `hard_delete` audit entry.
 *
 * It deletes a RESOURCE: nobody's encryption keys are destroyed, so it is not
 * person-wide GDPR Article 17 erasure, which is POST /admin/erasure
 * (routes/admin-erasure.ts).
 *
 * @param reason recorded on the deletion-log row.
 */
export async function hardDeleteFactAudited(
  c: Context<{ Variables: AuthVariables }>,
  deps: ServerDeps,
  id: string,
  reason: string
): Promise<void> {
  const { workspaceId, scopes } = getAuthCtx(c);
  if (!scopes.includes("memory:hard_delete")) {
    throw new ForbiddenError("memory:hard_delete scope required for hard delete");
  }
  if (!deps.storage) throw new BadRequestError("storage adapter not available");
  // SEC-4: fail closed. An adapter without the capability used to answer
  // `deleted: true` for a row it never touched.
  if (!deps.storage.hardDeleteFact) {
    throw new NotImplementedError("hard delete is not supported by this storage adapter");
  }
  // flatten-legacy-dual-core PR8 port: existence is checked first via
  // getFact — same 200/404 status matrix. A fact above the caller's
  // ceiling is a 404 too (S6), exactly what GET answers for it.
  const existing = await deps.storage.getFact(id, workspaceId);
  if (!existing) throw new NotFoundError(`Fact ${id} not found`);
  assertCanReadFact(c, id, existing.sensitivity);
  // SEC-4: the actor makes the adapter write the deletion-log row and the
  // index cleanup in the DELETE's own transaction — this path used to
  // leave no trace at all.
  const provenance = resolveProvenance(c);
  const deleted = await deps.storage.hardDeleteFact(id, workspaceId, {
    actorId: provenance.actorId,
    reason,
  });
  if (deleted === false) {
    throw new ConflictError(`Fact ${id} is being consolidated; retry the delete later`);
  }
  await emitAudit(deps, {
    workspaceId,
    actorId: provenance.actorId,
    actorType: provenance.actorType,
    action: "hard_delete",
    resourceKind: "fact",
    resourceId: id,
    isTerminal: true,
    detail: {
      ...(provenance.userId ? { userId: provenance.userId } : {}),
      gdprErasure: false,
    },
  });
}
