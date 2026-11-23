import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { ServerDeps } from "../deps.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { AuthVariables } from "../auth.js";
import { IdParamSchema } from "../schemas.js";
import { resolveProvenance } from "../provenance.js";
import { relationToWire } from "./_mappers.js";
import { withStorageErrors } from "./_storage-errors.js";
import { assertCanReadFact, resolveCeiling } from "../rbac.js";
import type { RelationNodeKind, Sensitivity } from "@mnemo-ai/types";

/**
 * Relation endpoints — binary edges in the memory graph (9 locked verbs).
 *
 * Routes:
 *   GET    /relations           — list relations (filter by judgmentStatus)
 *   POST   /relations           — create a new relation
 *   PATCH  /relations/:id       — apply judgment (verb change + mark judged)
 *
 * A relation connects two memory primitives (fact/decision/entity/episode)
 * via one of the 9 LOCKED verbs: related, compatible, scoped, conflicts_with,
 * supersedes, not_conflict, derived_from, part_of, member_of.
 *
 * POST /relations — REQUIRED fields:
 *   ✅ sourceId (string, min 1 char) — ID of source primitive
 *   ✅ sourceKind (enum) — Type of source: fact, decision, entity, episode
 *   ✅ targetId (string, min 1 char) — ID of target primitive
 *   ✅ targetKind (enum) — Type of target: fact, decision, entity, episode
 *   ✅ relation (enum) — One of the 9 locked verbs
 *   ✅ markedByKind (enum) — Who created this: user, agent, system, llm_judge
 *
 * POST /relations — OPTIONAL fields:
 *   ⚠️  confidence (number 0-1)
 *   ⚠️  reason (string)
 *   ⚠️  evidence (object)
 *   ⚠️  markedByUserId, markedByModel, markedByPromptVersion (strings)
 *   ⚠️  conversationId (string)
 *   ⚠️  judgmentStatus (enum: pending, judged, dismissed) — default: pending
 *
 * Multi-actor disagreement is captured by creating multiple relation rows
 * with same source/target/verb but different markedByKind/markedByUserId.
 * The server intentionally has no UNIQUE constraint on this (migration 0020).
 *
 * flatten-legacy-dual-core PR9d port: all 4 handlers below now read/write
 * `deps.storage` (v3 `StorageAdapter.{getRelations,createRelation,
 * applyRelationJudgment}`, design.md D6.4/D6.6) instead of the legacy
 * `CoreLike.{listRelations,createRelation,patchRelation}` client.
 * PR9c widened `MnemoRelation`/`CreateRelationInput` to the full physical
 * `mnemo_relation` column set (the SAME judgment-workflow fields PR8 had
 * found genuinely missing from the port surface) and added
 * `applyRelationJudgment` as the PATCH equivalent. Wire<->domain field-name
 * mapping (`sourceKind`<->`sourceType`, `targetKind`<->`targetType`,
 * `relation`<->`verb`) is handled by `relationToWire()` (`./_mappers.js`).
 * The legacy `factory.ts createRelation`'s ENTITY-1 side effect (a
 * fact->entity `part_of`/`member_of` relation backfills
 * `mnemo_fact.entity_id`) has no v3 `StorageAdapter` equivalent and was
 * ported into `GraphRepository.createRelation` itself (same transaction as
 * the relation insert, matching legacy's atomicity) — see that file's
 * ENTITY-1 comment.
 */

/**
 * §34.6 LOCKED_VERBS — the 9 verbs are sealed in the DB spec.
 * Any attempt to create/patch with an unknown verb returns HTTP 400
 * with a human-readable error listing the allowed set.
 */
export const LOCKED_VERBS = [
  "related",
  "compatible",
  "scoped",
  "conflicts_with",
  "supersedes",
  "not_conflict",
  "derived_from",
  "part_of",
  "member_of",
] as const;

export type RelationVerb = (typeof LOCKED_VERBS)[number];

const RelationVerbEnum = z.enum([
  "related",
  "compatible",
  "scoped",
  "conflicts_with",
  "supersedes",
  "not_conflict",
  "derived_from",
  "part_of",
  "member_of",
]);

const RelationKindEnum = z.enum([
  "fact",
  "decision",
  "entity",
  "episode",
  "strategy",
  "workflow",
  "skill",
  "task",
  "event",
  "reasoning",
]);
const JudgmentStatusEnum = z.enum(["pending", "judged", "dismissed"]);
const MarkerKindEnum = z.enum(["user", "agent", "system", "llm_judge"]);

const RelationSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    sourceKind: RelationKindEnum,
    sourceId: z.string(),
    targetKind: RelationKindEnum,
    targetId: z.string(),
    relation: RelationVerbEnum,
    judgmentStatus: JudgmentStatusEnum,
    reason: z.string().nullable(),
    evidence: z.record(z.string(), z.unknown()).nullable(),
    confidence: z.number().nullable(),
    markedByUserId: z.string().nullable(),
    markedByKind: MarkerKindEnum,
    markedByModel: z.string().nullable(),
    markedByPromptVersion: z.string().nullable(),
    provenance: z.string().nullable(),
    conversationId: z.string().nullable(),
    supersededByRelationId: z.string().nullable(),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Relation");

const ListRelationsQuerySchema = z
  .object({
    judgmentStatus: JudgmentStatusEnum.optional().openapi({
      description: "Filter by judgment lifecycle status.",
    }),
    sourceId: z.string().min(1).optional().openapi({
      description: "Only relations whose source is this id (outgoing edges of a node).",
    }),
    targetId: z.string().min(1).optional().openapi({
      description: "Only relations whose target is this id (incoming edges of a node).",
    }),
    includeClosed: z.enum(["true", "false"]).optional().openapi({
      description:
        "Include retracted (closed) relations. Default false: only open relations are listed.",
    }),
    limit: z.coerce.number().int().min(1).max(500).default(50).openapi({
      description: "Max rows. Server caps at 500.",
    }),
  })
  .openapi("ListRelationsQuery");

const ListRelationsResponseSchema = z
  .object({ items: z.array(RelationSchema) })
  .openapi("ListRelationsResponse");

const CreateRelationSchema = z
  .object({
    sourceKind: RelationKindEnum,
    sourceId: z.string().min(1),
    targetKind: RelationKindEnum,
    targetId: z.string().min(1),
    relation: RelationVerbEnum,
    judgmentStatus: JudgmentStatusEnum.optional(),
    reason: z.string().optional(),
    evidence: z.record(z.string(), z.unknown()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    markedByKind: MarkerKindEnum,
    markedByUserId: z.string().nullable().optional(),
    markedByModel: z.string().optional(),
    markedByPromptVersion: z.string().optional(),
    conversationId: z.string().nullable().optional(),
  })
  .openapi("CreateRelationRequest");

const PatchRelationSchema = z
  .object({
    relation: RelationVerbEnum,
    reason: z.string().optional(),
    evidence: z.record(z.string(), z.unknown()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    markedByKind: MarkerKindEnum,
    markedByUserId: z.string().nullable().optional(),
    markedByModel: z.string().optional(),
    markedByPromptVersion: z.string().optional(),
  })
  .openapi("PatchRelationRequest");

const listRelationsRoute = createRoute({
  method: "get",
  path: "/relations",
  tags: ["relations"],
  summary: "List relations in the workspace.",
  description:
    "A relation that touches a node above the caller's sensitivity ceiling is not listed.",
  request: { query: ListRelationsQuerySchema },
  responses: {
    200: {
      description: "Matching relations, newest first.",
      content: { "application/json": { schema: ListRelationsResponseSchema } },
    },
    400: { description: "Invalid query." },
  },
});

const createRelationRoute = createRoute({
  method: "post",
  path: "/relations",
  tags: ["relations"],
  summary: "Create a relation.",
  request: {
    body: { content: { "application/json": { schema: CreateRelationSchema } }, required: true },
  },
  responses: {
    201: {
      description: "Created.",
      content: { "application/json": { schema: RelationSchema } },
    },
    400: { description: "Invalid body (e.g. unknown verb)." },
  },
});

const closeRelationRoute = createRoute({
  method: "delete",
  path: "/relations/{id}",
  tags: ["relations"],
  summary: "Retract a relation (bitemporal close — the row and its judgment survive).",
  request: { params: IdParamSchema },
  responses: {
    204: { description: "Relation closed." },
    404: {
      description:
        "Relation not found, already closed, or it touches a node above the caller's ceiling.",
    },
  },
});

const patchRelationRoute = createRoute({
  method: "patch",
  path: "/relations/{id}",
  tags: ["relations"],
  summary: "Apply a judgment (verb change + status='judged').",
  request: {
    params: IdParamSchema,
    body: { content: { "application/json": { schema: PatchRelationSchema } }, required: true },
  },
  responses: {
    200: {
      description: "Updated relation.",
      content: { "application/json": { schema: RelationSchema } },
    },
    404: {
      description: "Relation not found, or it touches a node above the caller's ceiling.",
    },
  },
});

/**
 * Look the endpoint up through the kind's own getter (workspace-scoped) and
 * apply the caller's sensitivity ceiling. Throws the same 404 for "no such
 * row", "row of another workspace", "wrong kind for this id" and "above the
 * caller's ceiling".
 */
async function assertEndpointVisible(
  c: Parameters<typeof assertCanReadFact>[0],
  deps: ServerDeps,
  kind: RelationNodeKind,
  id: string,
  workspaceId: string
): Promise<void> {
  const s = deps.storage!;
  const row: { sensitivity?: Sensitivity } | null | undefined = await (async () => {
    switch (kind) {
      case "fact":
        return s.getFact(id, workspaceId);
      case "decision":
        return s.getDecision(id, workspaceId);
      case "entity":
        return s.getEntity(id, workspaceId);
      case "episode":
        return s.getEpisode(id, workspaceId);
      case "strategy":
        return s.getStrategy(id, workspaceId);
      case "workflow":
        return s.getWorkflow(id, workspaceId);
      case "skill":
        return s.getSkill(id, workspaceId);
      case "task":
        return s.getTask(id, workspaceId);
      case "event":
        return s.getEvent(id, workspaceId);
      case "reasoning":
        return s.getReasoning(id, workspaceId);
    }
  })();
  if (!row) throw new NotFoundError(`${kind} ${id} not found`);
  assertCanReadFact(c, id, row.sensitivity, kind);
}

export function mountRelations(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(listRelationsRoute, async (c) => {
    const { judgmentStatus, sourceId, targetId, includeClosed, limit } = c.req.valid("query");
    const workspaceId = c.get("workspaceId");
    if (!deps.storage) throw new BadRequestError("storage adapter not available");
    const items = await deps.storage.getRelations({
      workspaceId,
      ...(judgmentStatus ? { judgmentStatus } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(targetId ? { targetId } : {}),
      // PRIM-12: a retracted relation is history, not part of the graph.
      openOnly: includeClosed !== "true",
      // A relation that touches a node above the caller's ceiling is not listed.
      maxSensitivity: resolveCeiling(c),
      limit,
    });
    return c.json({ items: items.map(relationToWire) }, 200);
  });

  app.openapi(createRelationRoute, async (c) => {
    const body = c.req.valid("json");
    const workspaceId = c.get("workspaceId");
    const provenance = resolveProvenance(c);

    // §34.6 explicit locked-verb guard: Zod enum catches syntactic typos, but
    // we surface a descriptive 400 here to distinguish "verb not in locked set"
    // from a generic 422 validation error.
    if (!(LOCKED_VERBS as readonly string[]).includes(body.relation)) {
      return c.json(
        {
          error: "invalid_verb",
          message: `Verb "${body.relation}" is not in the locked vocabulary. Allowed verbs: ${LOCKED_VERBS.join(", ")}.`,
        },
        400
      );
    }

    if (!deps.storage) throw new BadRequestError("storage adapter not available");

    // PRIM-13: no self-loops, and both endpoints must be real, visible nodes of
    // the declared kind in THIS workspace. A missing id, an id of another
    // workspace, a kind mismatch and an above-ceiling target all answer the same
    // 404, so the response never confirms that an id exists somewhere else.
    if (body.sourceKind === body.targetKind && body.sourceId === body.targetId) {
      throw new BadRequestError("A relation cannot link a node to itself");
    }
    await assertEndpointVisible(c, deps, body.sourceKind, body.sourceId, workspaceId);
    await assertEndpointVisible(c, deps, body.targetKind, body.targetId, workspaceId);

    const created = await withStorageErrors(() =>
      deps.storage!.createRelation({
        workspaceId,
        sourceType: body.sourceKind,
        sourceId: body.sourceId,
        targetType: body.targetKind,
        targetId: body.targetId,
        verb: body.relation,
        markedByKind: body.markedByKind,
        actorId: provenance.actorId,
        userId: provenance.userId,
        actorType: provenance.actorType,
        ...(body.judgmentStatus !== undefined ? { judgmentStatus: body.judgmentStatus } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.evidence !== undefined ? { evidence: body.evidence } : {}),
        ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
        ...(body.markedByUserId !== undefined ? { markedByUserId: body.markedByUserId } : {}),
        ...(body.markedByModel !== undefined ? { markedByModel: body.markedByModel } : {}),
        ...(body.markedByPromptVersion !== undefined
          ? { markedByPromptVersion: body.markedByPromptVersion }
          : {}),
        ...(body.conversationId !== undefined ? { conversationId: body.conversationId } : {}),
      })
    );
    return c.json(relationToWire(created), 201);
  });

  app.openapi(patchRelationRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const workspaceId = c.get("workspaceId");

    // §34.6 locked-verb guard on PATCH (judgment can change the verb).
    if (!(LOCKED_VERBS as readonly string[]).includes(body.relation)) {
      return c.json(
        {
          error: "invalid_verb",
          message: `Verb "${body.relation}" is not in the locked vocabulary. Allowed verbs: ${LOCKED_VERBS.join(", ")}.`,
        },
        400
      );
    }

    if (!deps.storage) throw new BadRequestError("storage adapter not available");
    const updated = await deps.storage.applyRelationJudgment({
      workspaceId,
      id,
      relation: body.relation,
      markedByKind: body.markedByKind,
      // One that touches a node above the caller's ceiling answers 404, untouched.
      maxSensitivity: resolveCeiling(c),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.evidence !== undefined ? { evidence: body.evidence } : {}),
      ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
      ...(body.markedByUserId !== undefined ? { markedByUserId: body.markedByUserId } : {}),
      ...(body.markedByModel !== undefined ? { markedByModel: body.markedByModel } : {}),
      ...(body.markedByPromptVersion !== undefined
        ? { markedByPromptVersion: body.markedByPromptVersion }
        : {}),
    });
    if (!updated) throw new NotFoundError(`Relation ${id} not found`);
    return c.json(relationToWire(updated), 200);
  });

  // DELETE /relations/:id — retract a relation
  //
  // P111 — relations could be created and never removed through any surface.
  // That matters more than it sounds: P74's dangling-write path created
  // relations against ids that matched no row, and there was no way to take one
  // back.
  //
  // This CLOSES the interval (`valid_to = now()`), it does not delete. Every
  // other primitive in the system works that way — forget() "closes validity —
  // does NOT delete rows" — and a relation carries an explicit human judgment
  // (markedByKind, reason, evidence, confidence) that is precisely the sort of
  // thing an audit needs to keep. The port's `deleteRelation` does a physical
  // DELETE with no audit and no deletion-log row; it is deliberately NOT wired
  // here, and stays registered in the port-method guard as a decision rather
  // than an oversight.
  app.openapi(closeRelationRoute, async (c) => {
    const { id } = c.req.valid("param");
    const workspaceId = c.get("workspaceId");
    if (!deps.storage) throw new BadRequestError("storage adapter not available");

    // `false` covers both "no such relation" and "already closed" — neither is
    // a state the caller changed, so neither may report success.
    // ...and so does one that touches a node above the caller's ceiling.
    const closed = await deps.storage.closeRelation(id, workspaceId, {
      maxSensitivity: resolveCeiling(c),
    });
    if (!closed) throw new NotFoundError(`Relation ${id} not found`);

    return c.body(null, 204);
  });

  // POST /relations/traverse — BFS graph traversal from a root node
  //
  // GRAPH-DUP-1 (docs/archive/remediation/2026-07-31-post-audit-followups.md): this
  // route and `GET /graph/traverse` (packages/server/src/routes/graph.ts)
  // both do BFS from a root and can look interchangeable — they are NOT,
  // and both are intentionally kept. This one: directional only
  // (source→target, no reverse-edge following), returns the full node+edge
  // structure (real `Relation` objects, no relevance score) — for graph
  // inspection/visualization callers that need the actual edges. `GET
  // /graph/traverse`: bidirectional, returns a ranked decay-scored neighbor
  // list with no edge detail, plus `asOf` bitemporal support — for a
  // recall-flavored caller that wants "what's nearby and how strongly",
  // not the raw graph structure. Neither is scheduled for deprecation.
  app.openapi(
    createRoute({
      method: "post",
      path: "/relations/traverse",
      tags: ["relations"],
      summary: "BFS traversal of the relation graph from a root node.",
      description:
        "Stops at nodes above the caller's sensitivity ceiling: they are neither returned nor " +
        "walked through, and no edge that touches one is listed.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  rootId: z.string().min(1),
                  rootKind: RelationKindEnum,
                  maxDepth: z.number().int().min(1).max(5).default(2),
                  verbs: z.array(RelationVerbEnum).optional(),
                })
                .openapi("TraverseRequest"),
            },
          },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Traversal result — nodes and edges reachable from root.",
          content: {
            "application/json": {
              schema: z
                .object({
                  nodes: z.array(z.object({ id: z.string(), kind: RelationKindEnum })),
                  edges: z.array(RelationSchema),
                  // TRAVERSE-1: signals a real (very generous) per-layer cap
                  // was hit, instead of silently dropping edges as before.
                  truncated: z.boolean().optional(),
                })
                .openapi("TraverseResponse"),
            },
          },
        },
        400: { description: "Invalid request." },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      const maxDepth = body.maxDepth ?? 2;
      if (!deps.storage) throw new BadRequestError("storage adapter not available");

      // TRAVERSE-1: BFS batched ONE QUERY PER LAYER (bounded by maxDepth <=
      // 5), not one query PER VISITED NODE re-fetching the same
      // artificially-capped 500-row page every time. `TRAVERSE_LAYER_LIMIT`
      // is a real safety ceiling scoped to this one layer's actual fan-out
      // (not "how many relations has this workspace ever accumulated"); if
      // it's ever hit, `truncated` is surfaced in the response instead of
      // silently dropping edges the way the old per-node cap did.
      const TRAVERSE_LAYER_LIMIT = 2000;
      const visited = new Set<string>([`${body.rootKind}:${body.rootId}`]);
      const nodes: Array<{ id: string; kind: string }> = [{ id: body.rootId, kind: body.rootKind }];
      const edges: unknown[] = [];
      let truncated = false;

      let frontier: Array<{ id: string; kind: string }> = [
        { id: body.rootId, kind: body.rootKind },
      ];
      let depth = 0;

      while (frontier.length > 0 && depth < maxDepth) {
        const frontierIds = frontier.map((n) => n.id);
        const layerRels = await deps.storage.getRelations({
          workspaceId,
          sourceIds: frontierIds,
          openOnly: true,
          limit: TRAVERSE_LAYER_LIMIT + 1,
          // Nodes above the caller's ceiling are neither returned nor walked through.
          maxSensitivity: resolveCeiling(c),
        });
        if (layerRels.length > TRAVERSE_LAYER_LIMIT) {
          truncated = true;
          layerRels.length = TRAVERSE_LAYER_LIMIT;
        }

        const nextFrontier: Array<{ id: string; kind: string }> = [];
        for (const rel of layerRels) {
          if (body.verbs && !body.verbs.includes(rel.verb as RelationVerb)) continue;
          edges.push(relationToWire(rel));
          const targetKey = `${rel.targetType}:${rel.targetId}`;
          if (!visited.has(targetKey)) {
            visited.add(targetKey);
            const node = { id: rel.targetId, kind: rel.targetType };
            nodes.push(node);
            nextFrontier.push(node);
          }
        }
        frontier = nextFrontier;
        depth++;
      }

      return c.json({ nodes, edges, ...(truncated ? { truncated } : {}) }, 200);
    }
  );
}
