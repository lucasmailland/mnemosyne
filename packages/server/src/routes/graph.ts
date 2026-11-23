import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { traverseGraph, findGraphPath } from "@mnemo-ai/core/cognitive";

import type { ServerDeps } from "../deps.js";
import type { AuthVariables } from "../auth.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";
import { BadRequestError } from "../errors.js";
import { resolveCeiling } from "../rbac.js";
import { isEntityId, ENTITY_ID_MESSAGE, ENTITY_ID_EXAMPLE } from "../entity-id.js";

/**
 * GET /graph
 *
 * Returns the workspace's Memory Graph: typed nodes (entity, episode,
 * decision) connected by typed relations (related, conflicts_with,
 * derived_from, supersedes, part_of, …). Used by the orchester UI's
 * graph view (apps/web/.../brain/graph) and by any host that wants to
 * render the constellation of memories.
 *
 * `focus` is an optional `mnemo_entity.id` (a UUID, or a legacy
 * ment_<slug> seed id; see entity-id.ts). When supplied, the server returns
 * only that entity and its 1-hop neighbours, plus the edges between
 * them — far cheaper than shipping the whole graph and filtering
 * client-side on every interaction.
 *
 * Without `focus`, the full canonical view is returned:
 *   • entities  — canonicalId IS NULL (merged duplicates are filtered out)
 *   • episodes  — isSynthetic = false
 *   • decisions — status = 'active'
 *   • relations — judgmentStatus ≠ 'dismissed' AND validTo IS NULL
 *
 * Auth: standard bearer token; `workspaceId` is taken from the auth
 * context and never from the request body, so a caller can't read
 * another tenant's graph.
 *
 * Performance note: expected payload is <500 nodes + <2000 edges for a
 * typical workspace, so we don't paginate. The `Cache-Control: private,
 * max-age=30` header lets clients short-circuit the (usually static)
 * graph between user interactions without going stale.
 */

// Shape rules for `mnemo_entity.id` live in ../entity-id.js — shared with
// entities.ts, which validates the same id as a path param.

const GraphQuerySchema = z
  .object({
    focus: z
      .string()
      .refine(isEntityId, { message: `focus ${ENTITY_ID_MESSAGE}` })
      .optional()
      .openapi({
        description:
          "Optional entity id to centre the graph on. Returns the entity plus its 1-hop neighbourhood.",
        example: ENTITY_ID_EXAMPLE,
      }),
    includeSemantic: z.enum(["true", "1", "false", "0"]).optional().openapi({
      description:
        "When 'true' or '1', overlay precomputed semantic-neighbor edges onto the graph.",
      example: "true",
    }),
    includeMentions: z
      .enum(["true", "1", "false", "0"])
      .optional()
      .openapi({
        description:
          "When 'true' or '1', add an episode → entity edge (relation 'mentions', provenance " +
          "'episode_facts') for each entity the episode's linked facts are about. Derived from " +
          "facts the caller can read; never stored.",
        example: "true",
      }),
    asOf: z.string().optional().openapi({
      description:
        "ISO 8601 timestamp. When supplied, returns the graph as it stood at that instant (bitemporal).",
      example: "2026-01-01T00:00:00Z",
    }),
  })
  .openapi("GraphQuery");

const GraphNodeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["entity", "episode", "decision"]),
    entityKind: z
      .enum(["person", "organization", "project", "concept", "place", "other"])
      .optional(),
    label: z.string(),
    description: z.string().nullable().optional(),
    mentionCount: z.number().int(),
    factCount: z.number().int(),
    avgMemoryStrength: z.number(),
    createdAt: z.iso.datetime(),
  })
  .openapi("GraphNode");

const GraphEdgeSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    relation: z.string(),
    confidence: z.number(),
    provenance: z.string().nullable(),
  })
  .openapi("GraphEdge");

const GraphResponseSchema = z
  .object({
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
    meta: z.object({
      entityCount: z.number().int(),
      episodeCount: z.number().int(),
      decisionCount: z.number().int(),
      relationCount: z.number().int(),
    }),
  })
  .openapi("GraphResponse");

const graphRoute = createRoute({
  method: "get",
  path: "/graph",
  tags: ["graph"],
  summary: "Memory Graph snapshot (typed nodes + typed relations).",
  description:
    "Nodes above the caller's sensitivity ceiling are omitted, with the edges that touch them; " +
    "`factCount` counts only the facts the caller may read, and an entity's `mentionCount` is " +
    "its `factCount` plus the episodes related to it that the caller may read.",
  request: {
    query: GraphQuerySchema,
  },
  responses: {
    200: {
      description: "Workspace's Memory Graph.",
      content: { "application/json": { schema: GraphResponseSchema } },
    },
    400: { description: "Invalid focus id." },
    401: { description: "Missing or invalid bearer token." },
  },
});

const SemanticBackfillBodySchema = z
  .object({
    k: z.number().int().min(1).max(50).optional().openapi({
      description: "Neighbours per fact (default 8).",
      example: 8,
    }),
    threshold: z.number().min(0).max(1).optional().openapi({
      description: "Minimum cosine similarity to materialise an edge (default 0.75).",
      example: 0.75,
    }),
  })
  .openapi("SemanticBackfillBody");

const SemanticBackfillResponseSchema = z
  .object({ edgesWritten: z.number().int() })
  .openapi("SemanticBackfillResponse");

// ── Graph Traverse ──────────────────────────────────────────────────────────
//
// GRAPH-DUP-1 (docs/archive/remediation/2026-07-31-post-audit-followups.md):
// this route and `POST /relations/traverse` (packages/server/src/routes/relations.ts)
// both do BFS from a root node and can look interchangeable at a glance —
// they are NOT. This one is deliberately kept, not a legacy duplicate:
//   - Bidirectional (follows a relation in either direction) and returns a
//     RANKED, decay-scored list (`{id, hop, relevance}`) with no edge
//     detail — shaped for a caller that wants "what's nearby and how
//     strongly", e.g. a recall-flavored consumer, not a graph inspector.
//   - Supports `asOf` bitemporal reconstruction (view the graph as it stood
//     at a past instant) — `POST /relations/traverse` does not.
// `POST /relations/traverse` is the other, deliberately different shape:
// directional only (source→target), returns the full node+edge structure
// (no relevance score) — shaped for graph-inspection/visualization
// callers that need the actual edges, not just a ranked neighbor list.
// Both are intentionally kept; neither is scheduled for deprecation.

const GraphTraverseQuerySchema = z
  .object({
    root: z.string().min(1).openapi({
      description: "Entity/node id to start BFS from.",
      example: "ent_abc123",
    }),
    maxHops: z.coerce.number().int().min(1).max(5).optional().openapi({
      description: "Maximum hops to traverse (default 3, max 5).",
      example: 3,
    }),
    relations: z.string().optional().openapi({
      description: "Comma-separated list of relation verbs to follow. Omit for all.",
      example: "related,derived_from",
    }),
    asOf: z.string().optional().openapi({
      description: "ISO 8601 timestamp to reconstruct the graph as of that instant.",
      example: "2026-01-01T00:00:00Z",
    }),
  })
  .openapi("GraphTraverseQuery");

const GraphTraverseHitSchema = z
  .object({
    id: z.string(),
    hop: z.number().int(),
    relevance: z.number(),
  })
  .openapi("GraphTraverseHit");

const GraphTraverseResponseSchema = z
  .object({ hits: z.array(GraphTraverseHitSchema) })
  .openapi("GraphTraverseResponse");

const graphTraverseRoute = createRoute({
  method: "get",
  path: "/graph/traverse",
  tags: ["graph"],
  summary: "Multi-hop BFS traversal from a root entity.",
  description:
    "Stops at nodes above the caller's sensitivity ceiling: they are neither returned nor " +
    "walked through, and a root above it returns no hits.",
  request: { query: GraphTraverseQuerySchema },
  responses: {
    200: {
      description: "Reachable nodes with hop distances and relevance scores.",
      content: { "application/json": { schema: GraphTraverseResponseSchema } },
    },
    400: { description: "Missing required `root` parameter." },
    401: { description: "Missing or invalid bearer token." },
  },
});

// ── Graph Path ───────────────────────────────────────────────────────────────

const GraphPathQuerySchema = z
  .object({
    from: z.string().min(1).openapi({
      description: "Source node id.",
      example: "ent_abc123",
    }),
    to: z.string().min(1).openapi({
      description: "Target node id.",
      example: "ent_xyz789",
    }),
    maxHops: z.coerce.number().int().min(1).max(6).optional().openapi({
      description: "Maximum hops (default 4, max 6).",
      example: 4,
    }),
    asOf: z.string().optional().openapi({
      description: "ISO 8601 timestamp for bitemporal reconstruction.",
      example: "2026-01-01T00:00:00Z",
    }),
  })
  .openapi("GraphPathQuery");

const GraphPathEdgeSchema = z
  .object({
    source: z.string(),
    target: z.string(),
    relation: z.string(),
  })
  .openapi("GraphPathEdge");

const GraphPathResponseSchema = z
  .object({
    path: z.array(z.string()),
    edges: z.array(GraphPathEdgeSchema),
  })
  .openapi("GraphPathResponse");

const graphPathRoute = createRoute({
  method: "get",
  path: "/graph/path",
  tags: ["graph"],
  summary: "Shortest path between two graph nodes.",
  description:
    "Never runs through a node above the caller's sensitivity ceiling; when the only path " +
    "does, the path is empty.",
  request: { query: GraphPathQuerySchema },
  responses: {
    200: {
      description:
        "Node id chain from `from` to `to` plus the traversed relation verbs. Empty path if unreachable.",
      content: { "application/json": { schema: GraphPathResponseSchema } },
    },
    400: { description: "Missing required `from` or `to` parameter." },
    401: { description: "Missing or invalid bearer token." },
  },
});

const semanticBackfillRoute = createRoute({
  method: "post",
  path: "/admin/graph/semantic-backfill",
  tags: ["admin", "graph"],
  summary: "Recompute kNN semantic-neighbor edges for the workspace.",
  description:
    "Deletes existing semantic-neighbor rows for the workspace and inserts fresh " +
    "top-k pairs derived from fact embeddings (HNSW cosine). Safe to call " +
    "repeatedly — idempotent. Returns the number of edges written.",
  request: {
    body: {
      content: { "application/json": { schema: SemanticBackfillBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Backfill complete.",
      content: { "application/json": { schema: SemanticBackfillResponseSchema } },
    },
    401: { description: "Missing or invalid bearer token." },
  },
});

export function mountGraph(app: OpenAPIHono<{ Variables: AuthVariables }>, deps: ServerDeps): void {
  app.openapi(graphRoute, async (c) => {
    const query = c.req.valid("query");
    const workspaceId = c.get("workspaceId");
    const includeSemantic = query.includeSemantic === "true" || query.includeSemantic === "1";
    const includeMentions = query.includeMentions === "true" || query.includeMentions === "1";
    const asOf = query.asOf ? new Date(query.asOf) : undefined;

    // flatten-legacy-dual-core PR9f port (design.md D6.5): the legacy
    // `CoreLike.graph` method is replaced by `deps.storage.getGraphSnapshot`
    // (v3 StorageAdapter) — adapter-side assembly, same call-arg shape (the
    // legacy `GraphQueryOptions` and `GraphSnapshotFilter` are field-for-
    // field identical), pinned by __tests__/parity/graph.parity.test.ts.
    if (!deps.storage) throw new BadRequestError("storage adapter not available");
    const result = await deps.storage.getGraphSnapshot({
      workspaceId,
      // Nodes above the caller's ceiling are omitted, with their edges and facts.
      maxSensitivity: resolveCeiling(c),
      ...(query.focus ? { focusEntityId: query.focus } : {}),
      ...(includeSemantic ? { includeSemantic: true } : {}),
      ...(includeMentions ? { includeMentions: true } : {}),
      ...(asOf ? { asOf } : {}),
    });

    c.header("Cache-Control", "private, max-age=30");
    return c.json(result, 200);
  });

  app.openapi(graphTraverseRoute, async (c) => {
    const query = c.req.valid("query");
    const workspaceId = c.get("workspaceId");

    // flatten-legacy-dual-core PR9f port (design.md D6.5): the legacy
    // `CoreLike.graphTraverse` method is replaced by the pure-core
    // `traverseGraph` (@mnemo-ai/core/cognitive), looping
    // `deps.storage.getRelations` one hop per call — no new port method
    // beyond RelationFilter.sourceIds/targetIds (D6.4/D6.5). Ports take
    // Date, not ISO strings — the parse stays here, at the route boundary.
    if (!deps.storage) throw new BadRequestError("storage adapter not available");
    const hits = await traverseGraph({ storage: deps.storage }, workspaceId, query.root, {
      ...(query.maxHops !== undefined ? { maxHops: query.maxHops } : {}),
      ...(query.relations ? { relations: query.relations.split(",").map((v) => v.trim()) } : {}),
      ...(query.asOf ? { asOf: new Date(query.asOf) } : {}),
      maxSensitivity: resolveCeiling(c),
    });

    return c.json({ hits }, 200);
  });

  app.openapi(graphPathRoute, async (c) => {
    const query = c.req.valid("query");
    const workspaceId = c.get("workspaceId");

    // flatten-legacy-dual-core PR9f port (design.md D6.5): the legacy
    // `CoreLike.graphPath` method is replaced by the pure-core
    // `findGraphPath` (@mnemo-ai/core/cognitive) — same undirected,
    // hop-capped BFS semantics as traverseGraph above.
    if (!deps.storage) throw new BadRequestError("storage adapter not available");
    const result = await findGraphPath(
      { storage: deps.storage },
      workspaceId,
      query.from,
      query.to,
      {
        ...(query.maxHops !== undefined ? { maxHops: query.maxHops } : {}),
        ...(query.asOf ? { asOf: new Date(query.asOf) } : {}),
        maxSensitivity: resolveCeiling(c),
      }
    );

    return c.json(result, 200);
  });

  app.openapi(semanticBackfillRoute, async (c) => {
    const workspaceId = c.get("workspaceId");
    const provenance = resolveProvenance(c);
    const body = (await c.req.json().catch(() => ({}))) as { k?: number; threshold?: number };

    // flatten-legacy-dual-core PR9g port (design.md D6.5): the legacy
    // `CoreLike.backfillSemanticNeighbors` method is replaced by
    // `deps.storage.backfillSemanticNeighbors` (v3 StorageAdapter) —
    // adapter-side set-based kNN over public.mnemo_semantic_neighbor, same
    // call-arg shape. This is graph.ts's last remaining legacy client call
    // site — the file is now fully off the legacy core client.
    if (!deps.storage) throw new BadRequestError("storage adapter not available");
    const edgesWritten = await deps.storage.backfillSemanticNeighbors({
      workspaceId,
      ...(body.k !== undefined ? { k: body.k } : {}),
      ...(body.threshold !== undefined ? { threshold: body.threshold } : {}),
    });

    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "admin_access",
      resourceKind: "graph_backfill",
      resourceId: workspaceId,
      isTerminal: false,
      detail: { edgesWritten },
    });

    return c.json({ edgesWritten }, 200);
  });
}
