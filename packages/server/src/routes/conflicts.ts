import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { NotFoundError } from "../errors.js";
import { IdParamSchema } from "../schemas.js";
import { resolveProvenance } from "../provenance.js";
import { canReadSensitivity, resolveCeiling } from "../rbac.js";

/**
 * Conflict resolution endpoints (P4-D memory_judge).
 *
 * These two routes expose the interactive conflict-resolution surface for
 * the `memory_judge` MCP tool. The consolidation pass detects contradicting
 * facts and stores a `conflicts_with` relation between them; these routes
 * surface those conflicts and let an LLM judge resolve them.
 *
 * GET  /conflicts           — list unresolved conflict pairs
 * POST /conflicts/:id/resolve — apply a resolution action to one pair
 */

// ─── Shared fact summary shape ────────────────────────────────────────────────

const ConflictFactSchema = z
  .object({
    id: z.string(),
    subject: z.string(),
    statement: z.string(),
    worth: z.number(),
    validFrom: z.string(),
    validTo: z.string().nullable(),
  })
  .openapi("ConflictFact");

// ─── GET /conflicts ────────────────────────────────────────────────────────────

const ListConflictsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(20).optional().default(5).openapi({
      description: "Max conflict pairs to return. Default 5, max 20.",
    }),
  })
  .openapi("ListConflictsQuery");

const ConflictPairSchema = z
  .object({
    relationId: z.string(),
    confidence: z.number().nullable(),
    factA: ConflictFactSchema,
    factB: ConflictFactSchema,
  })
  .openapi("ConflictPair");

const ListConflictsResponseSchema = z
  .object({
    pairs: z.array(ConflictPairSchema),
    total: z.number().int().nonnegative().openapi({
      description:
        "How many unresolved pairs the caller can see in all, `limit` aside: the same pairs the list draws from (both facts current and within the caller's read ceiling).",
    }),
  })
  .openapi("ListConflictsResponse");

const listConflictsRoute = createRoute({
  method: "get",
  path: "/conflicts",
  tags: ["conflicts"],
  summary: "List unresolved fact conflict pairs (conflicts_with relations).",
  request: { query: ListConflictsQuerySchema },
  responses: {
    200: {
      description:
        "Unresolved conflict pairs, newest first. A pair with either fact above the caller's read ceiling is left out.",
      content: { "application/json": { schema: ListConflictsResponseSchema } },
    },
    401: { description: "Missing or invalid bearer token." },
  },
});

// ─── POST /conflicts/:id/resolve ──────────────────────────────────────────────

const ResolveActionEnum = z.enum(["supersede_a", "supersede_b", "keep_both", "merge"]);

const ResolveConflictBodySchema = z
  .object({
    action: ResolveActionEnum.openapi({
      description:
        "How to resolve the conflict. " +
        "supersede_a: forget factA and replace the relation with `supersedes`. " +
        "supersede_b: forget factB and replace the relation with `supersedes`. " +
        "keep_both: mark as not_conflict (resolved disagreement). " +
        "merge: forget both facts, create a new merged fact, and close the relation.",
    }),
    mergedStatement: z.string().optional().openapi({
      description: "Required when action='merge'. The statement for the new merged fact.",
    }),
  })
  .openapi("ResolveConflictRequest");

const ResolveConflictResponseSchema = z
  .object({
    resolved: z.boolean(),
    action: ResolveActionEnum,
    relationId: z.string(),
    mergedFactId: z.string().nullable(),
  })
  .openapi("ResolveConflictResponse");

const resolveConflictRoute = createRoute({
  method: "post",
  path: "/conflicts/{id}/resolve",
  tags: ["conflicts"],
  summary: "Resolve a conflict pair identified by its relation id.",
  request: {
    params: IdParamSchema,
    body: {
      content: { "application/json": { schema: ResolveConflictBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Conflict resolved.",
      content: { "application/json": { schema: ResolveConflictResponseSchema } },
    },
    400: { description: "Invalid body (e.g. merge without mergedStatement)." },
    404: {
      description:
        "Relation not found, not a conflicts_with relation, or either fact above the caller's read ceiling.",
    },
    401: { description: "Missing or invalid bearer token." },
  },
});

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountConflicts(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // GET /conflicts — list unresolved conflict pairs
  app.openapi(listConflictsRoute, async (c) => {
    const { limit } = c.req.valid("query");
    const workspaceId = c.get("workspaceId");
    if (!deps.storage) throw new Error("storage adapter not available");
    const ceiling = resolveCeiling(c);

    // v3 `getRelations` filters `verb` server-side (a strict subset of the
    // legacy `limit: 500` + JS filter — same result set, fewer rows fetched),
    // then `validTo` is still checked in application code, matching legacy.
    const allRelations = await deps.storage.getRelations({
      workspaceId,
      verb: "conflicts_with",
      openOnly: false,
    });
    const conflictRelations = allRelations.filter((r) => r.validTo === null);

    // Resolve the fact pairs. We fetch each fact individually; pairs with a
    // missing fact (deleted outside normal paths) or a closed one are skipped.
    //
    // PRIM-19: `limit` is applied to the pairs that survive that filter, not
    // to the relations before it. Slicing first made every skipped pair cost
    // a slot — `limit=N` returned N-1 pairs in the eval workspace — and a page
    // of stale relations hid every live conflict behind it.
    const pairs: Array<{
      relationId: string;
      confidence: number | null;
      factA: {
        id: string;
        subject: string;
        statement: string;
        worth: number;
        validFrom: string;
        validTo: string | null;
      };
      factB: {
        id: string;
        subject: string;
        statement: string;
        worth: number;
        validFrom: string;
        validTo: string | null;
      };
    }> = [];

    for (const rel of conflictRelations) {
      if (pairs.length >= limit) break;
      const [factA, factB] = await Promise.all([
        deps.storage.getFact(rel.sourceId, workspaceId),
        deps.storage.getFact(rel.targetId, workspaceId),
      ]);
      if (!factA || !factB) continue;
      if (factA.validTo !== undefined || factB.validTo !== undefined) continue;
      // A pair with either fact above the caller's read ceiling is not listed.
      if (!canReadSensitivity(ceiling, factA.sensitivity)) continue;
      if (!canReadSensitivity(ceiling, factB.sensitivity)) continue;
      pairs.push({
        relationId: rel.id,
        confidence: rel.confidence ?? null,
        factA: {
          id: factA.id,
          subject: factA.subject,
          statement: factA.statement,
          worth: factA.worth,
          validFrom: factA.validFrom.toISOString(),
          // Both narrowed to `undefined` by the `continue` guard above.
          validTo: null,
        },
        factB: {
          id: factB.id,
          subject: factB.subject,
          statement: factB.statement,
          worth: factB.worth,
          validFrom: factB.validFrom.toISOString(),
          validTo: null,
        },
      });
    }

    // One COUNT of the same pairs, so the total never reads them all.
    const total = await deps.storage.countOpenConflicts({ workspaceId, maxSensitivity: ceiling });
    return c.json({ pairs, total }, 200);
  });

  // POST /conflicts/:id/resolve — apply a resolution action
  //
  // B5 (flatten-legacy-dual-core, Slice 3c): the legacy core previously
  // chained up to 6 separate calls (closeFact ×2, createFact, patchRelation,
  // createRelation ×2), each independently transactional — a mid-sequence
  // failure left partial state. Now delegates the whole resolution to
  // `deps.storage.resolveConflict`, ONE atomic v3 transaction (see its doc
  // comment in `ports.ts` / `FactRepository.resolveConflict`).
  app.openapi(resolveConflictRoute, async (c) => {
    const { id: relationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const workspaceId = c.get("workspaceId");
    const provenance = resolveProvenance(c);
    if (!deps.storage) throw new Error("storage adapter not available");

    // Validate action-specific preconditions before touching state.
    if (body.action === "merge" && !body.mergedStatement?.trim()) {
      return c.json(
        { error: "mergedStatement is required when action='merge'" } as never,
        400 as never
      );
    }

    // Find the target relation.
    const allRelations = await deps.storage.getRelations({
      workspaceId,
      verb: "conflicts_with",
      openOnly: false,
    });
    const rel = allRelations.find((r) => r.id === relationId);

    if (!rel) throw new NotFoundError(`Relation ${relationId} not found`);
    if (rel.verb !== "conflicts_with") {
      throw new NotFoundError(
        `Relation ${relationId} is not a conflicts_with relation (got: ${rel.verb})`
      );
    }

    // S6: a pair with either fact above the caller's read ceiling answers 404,
    // like the list that never showed it — resolving is no way past the ceiling.
    const ceiling = resolveCeiling(c);
    const facts = await Promise.all([
      deps.storage.getFact(rel.sourceId, workspaceId),
      deps.storage.getFact(rel.targetId, workspaceId),
    ]);
    if (facts.some((f) => f && !canReadSensitivity(ceiling, f.sensitivity))) {
      throw new NotFoundError(`Relation ${relationId} not found`);
    }

    const { mergedFactId } = await deps.storage.resolveConflict({
      workspaceId,
      relationId,
      sourceId: rel.sourceId,
      sourceKind: rel.sourceType,
      targetId: rel.targetId,
      targetKind: rel.targetType,
      action: body.action,
      mergedStatement: body.mergedStatement,
      actorId: provenance.actorId,
      userId: provenance.userId,
      actorType: provenance.actorType,
    });

    return c.json({ resolved: true, action: body.action, relationId, mergedFactId }, 200);
  });
}
