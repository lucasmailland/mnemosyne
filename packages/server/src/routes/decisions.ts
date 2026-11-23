import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { ServerDeps } from "../deps.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import { IdParamSchema } from "../schemas.js";
import {
  assertCanReadFact,
  assertCanWriteSensitivity,
  dropHiddenPointers,
  filterBySensitivity,
  resolveCeiling,
} from "../rbac.js";
import { dispatchWebhookEvent } from "../webhookDispatch.js";
import { resolveProvenance } from "../provenance.js";
import { resolveTargetWorkspace } from "../workspace-target.js";
import { withStorageErrors } from "./_storage-errors.js";
import { projectScopeFilter } from "../project-scope-filter.js";

/**
 * Decision endpoints — 2nd cognitive primitive.
 *
 *   POST   /decisions          — create a new decision (architecture/policy/etc)
 *   GET    /decisions          — list decisions (status/kind filter, pagination)
 *   GET    /decisions/:id      — get single decision by id
 *   DELETE /decisions/:id      — soft-delete: set validTo = now (bitemporal close)
 *
 * A decision is a durable, audited statement of "we are going to do X because Y"
 * — distinct from a fact (a transient observation). Decisions document
 * architecture choices, policy decisions, bug fixes, learnings, and discoveries.
 * They support status lifecycle: active → superseded (when replaced by another
 * decision) or withdrawn (abandoned).
 *
 * All routes require authentication + memory:write (for mutations) or
 * memory:read (for reads). Multi-tenant isolation via RLS on mnemo_decision
 * ensures workspace_id scoping (migration 0033).
 */

const DecisionKindEnum = z.enum([
  "decision",
  "architecture",
  "policy",
  "process",
  "bugfix",
  "learning",
  "discovery",
  "config",
]);

const DecisionStatusEnum = z.enum(["active", "superseded", "withdrawn"]);

const SensitivityEnum = z.enum(["public", "internal", "confidential", "restricted"]);

const DecisionSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    agentId: z.string().nullable(),
    conversationId: z.string().nullable(),
    kind: DecisionKindEnum,
    title: z.string(),
    body: z.string(),
    topicKey: z.string().nullable(),
    revisionCount: z.number().int(),
    normalizedHash: z.string(),
    decidedByUserId: z.string().nullable(),
    status: DecisionStatusEnum,
    supersededById: z.string().nullable(),
    sensitivity: SensitivityEnum,
    scopeRef: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Decision");

const ListDecisionsQuerySchema = z
  .object({
    status: DecisionStatusEnum.optional().openapi({
      description: "Filter by lifecycle status.",
    }),
    scopeRef: z.string().optional().openapi({
      description: "Filter by scope reference. Returns exact matches plus unscoped (NULL) records.",
    }),
    includeClosed: z.enum(["true", "false"]).optional().openapi({
      description:
        "Include closed decisions (superseded or withdrawn). Default false: only current ones.",
    }),
    limit: z.coerce.number().int().min(1).max(500).default(50).openapi({
      description: "Max rows. Server caps at 500.",
    }),
  })
  .openapi("ListDecisionsQuery");

const ListDecisionsResponseSchema = z
  .object({ items: z.array(DecisionSchema) })
  .openapi("ListDecisionsResponse");

const listDecisionsRoute = createRoute({
  method: "get",
  path: "/decisions",
  tags: ["decisions"],
  summary: "List decisions in the workspace.",
  request: { query: ListDecisionsQuerySchema },
  responses: {
    200: {
      description: "Matching decisions, newest first.",
      content: { "application/json": { schema: ListDecisionsResponseSchema } },
    },
    400: { description: "Invalid query." },
    401: { description: "Missing or invalid bearer token." },
  },
});

const getDecisionRoute = createRoute({
  method: "get",
  path: "/decisions/{id}",
  tags: ["decisions"],
  summary: "Fetch a single decision by id.",
  request: { params: IdParamSchema },
  responses: {
    200: {
      description: "The decision row.",
      content: { "application/json": { schema: DecisionSchema } },
    },
    404: { description: "Decision not found in this workspace." },
  },
});

export function mountDecisions(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(listDecisionsRoute, async (c) => {
    const query = c.req.valid("query");
    const workspaceId = c.get("workspaceId");
    if (!deps.storage) throw new BadRequestError("storage adapter not available");
    // the legacy core's listDecisions took { status?, scopeRef?, limit } and
    // returned a bare array; v3 queryDecisions(DecisionFilter) returns a
    // PaginatedResult — same filter fields, .items is the equivalent array
    // (flatten-legacy-dual-core PR8 port off the legacy core).
    const { items } = await deps.storage.queryDecisions({
      workspaceId,
      // PRIM-16: current decisions by default. An explicit `status` is an explicit
      // ask for that lifecycle state; includeClosed=true lifts the filter.
      ...(query.status
        ? { status: query.status }
        : query.includeClosed === "true"
          ? {}
          : { status: "active" as const, openOnly: true }),
      ...(await projectScopeFilter(deps.storage, workspaceId, query.scopeRef)),
      limit: query.limit,
    });
    const filtered = await dropHiddenPointers(
      c,
      deps.storage,
      workspaceId,
      filterBySensitivity(items, resolveCeiling(c)),
      { ids: ["supersededById"] }
    );
    return c.json({ items: filtered }, 200);
  });

  app.openapi(getDecisionRoute, async (c) => {
    const { id } = c.req.valid("param");
    const workspaceId = c.get("workspaceId");
    if (!deps.storage) throw new BadRequestError("storage adapter not available");
    const decision = await deps.storage.getDecision(id, workspaceId);
    if (!decision) throw new NotFoundError(`Decision ${id} not found`);
    assertCanReadFact(c, id, decision.sensitivity, "Decision");
    const [shown] = await dropHiddenPointers(c, deps.storage, workspaceId, [decision], {
      ids: ["supersededById"],
    });
    return c.json(shown!, 200);
  });

  // POST /decisions — create a decision.
  //
  // Topic-key upsert + normalized-hash dedup happen inside the core
  // helper — a duplicate by (workspace_id, topic_key) returns the
  // existing row rather than 409-ing, so callers can be idempotent.
  const CreateDecisionSchema = z
    .object({
      kind: DecisionKindEnum,
      title: z.string().min(1).max(500),
      body: z.string().min(1).max(50_000),
      topicKey: z.string().min(1).max(200).nullable().optional(),
      conversationId: z.string().nullable().optional(),
      agentId: z.string().nullable().optional(),
      decidedByUserId: z.string().nullable().optional(),
      scopeRef: z.string().min(1).max(500).nullable().optional(),
      sensitivity: SensitivityEnum.default("internal").optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      targetWorkspaceId: z.guid().optional().openapi({
        description:
          "Write to a different workspace than the one in the API key. The key's user must be a member of the target workspace. Requires userId binding on the key (mk_user_* or mk_live_* with user_id set).",
      }),
    })
    .openapi("CreateDecisionRequest");

  app.openapi(
    createRoute({
      method: "post",
      path: "/decisions",
      tags: ["decisions"],
      summary: "Create a decision (topic-key upsert + hash dedup).",
      request: {
        body: { content: { "application/json": { schema: CreateDecisionSchema } }, required: true },
      },
      responses: {
        201: {
          description: "Created (or existing duplicate by topic_key).",
          content: { "application/json": { schema: DecisionSchema } },
        },
        400: { description: "Invalid body." },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      assertCanWriteSensitivity(c, body.sensitivity); // PRIM-14
      const { workspaceId: keyWorkspaceId, userId } = getAuthCtx(c);
      const target = await resolveTargetWorkspace({
        keyWorkspaceId,
        userId,
        sql: deps.metricsPgClient,
        targetWorkspaceId: body.targetWorkspaceId,
      });
      if (!target.ok) return c.json(target.body as never, target.status as never);
      const workspaceId = target.workspaceId;
      const provenance = resolveProvenance(c);
      if (!deps.storage) throw new BadRequestError("storage adapter not available");
      // p45 (S11) — actorId/userId/actorType forwarded through to
      // mnemo_decision (see CreateDecisionInput / DecisionRepository).
      //
      // flatten-legacy-dual-core PR8 port: the legacy core's single
      // createDecision() call did topic-key upsert + hash dedup INSIDE
      // one helper ("a duplicate by (workspace_id, topic_key) returns the
      // existing row rather than 409-ing"). v3 splits that into two
      // separate StorageAdapter methods — mergeDecisionByTopicKey (UPDATE
      // the existing active row in place, revisionCount bumped) and
      // createDecision (plain INSERT). Composed here to preserve the exact
      // same idempotent-by-topic_key behavior: try the merge first when a
      // topicKey is supplied; fall back to a plain create when there is no
      // existing active row for that key (mergeDecisionByTopicKey returns
      // null) or when no topicKey was supplied at all.
      let created;
      if (body.topicKey) {
        created = await deps.storage.mergeDecisionByTopicKey({
          workspaceId,
          topicKey: body.topicKey,
          title: body.title,
          body: body.body,
          kind: body.kind,
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        });
      }
      const createInput = {
        workspaceId,
        actorId: provenance.actorId,
        userId: provenance.userId,
        actorType: provenance.actorType,
        kind: body.kind,
        title: body.title,
        body: body.body,
        ...(body.topicKey !== undefined ? { topicKey: body.topicKey ?? undefined } : {}),
        ...(body.conversationId !== undefined
          ? { conversationId: body.conversationId ?? undefined }
          : {}),
        ...(body.agentId !== undefined ? { agentId: body.agentId ?? undefined } : {}),
        ...(body.decidedByUserId !== undefined
          ? { decidedByUserId: body.decidedByUserId ?? undefined }
          : {}),
        ...(body.scopeRef !== undefined ? { scopeRef: body.scopeRef ?? undefined } : {}),
        ...(body.sensitivity !== undefined ? { sensitivity: body.sensitivity } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      };
      // PRIM-18 (V-4): without a topicKey an exact repeat is the same decision.
      // The adapter looks the twin up and inserts under one advisory lock, so
      // identical concurrent POSTs make one row. A write that names a topicKey
      // has named its slot (merge above, else a row of its own).
      let reused = false;
      if (!created) {
        if (!body.topicKey && deps.storage.createDecisionUnlessDuplicate) {
          const r = await deps.storage.createDecisionUnlessDuplicate(createInput);
          created = r.decision;
          reused = r.reused;
        } else {
          created = await deps.storage.createDecision(createInput);
        }
      }
      // §35(n): decision.created webhook (one of the 12 canonical event types).
      if (!reused) {
        void dispatchWebhookEvent(
          deps,
          workspaceId,
          "decision.created",
          created as unknown as Record<string, unknown>
        );
      }
      // DecisionSchema declares topicKey as nullable (always present), but
      // DecisionRepository's mapper (adapter-postgres/src/repositories/
      // mappers.ts:mapRowToDecision) maps a NULL DB column to `undefined`,
      // not `null` — JSON.stringify then drops the key entirely instead of
      // emitting `"topicKey": null`. Normalize here so the wire contract
      // matches the declared schema (found while fixing this route's own
      // integration test fixture; pre-existing since the PR8 v3 port, not
      // introduced by this change).
      return c.json({ ...created, topicKey: created.topicKey ?? null }, 201);
    }
  );

  // PATCH /decisions/:id — supersede a decision.
  //
  // Marks the old decision as status='superseded', closes its validity and
  // points its supersededById at the new one. The matching `supersedes` relation
  // (new -> old) is recorded by the same storage transaction (PRIM-18); a client
  // that also POSTs one adds a second, harmless, edge.
  // We chose PATCH (not POST) because this mutates an existing
  // resource — the semantic stays REST-ful even though the body
  // points at a different row.
  const SupersedeDecisionSchema = z
    .object({
      supersededById: z.string().min(1).openapi({
        description:
          "Id of the new decision that supersedes this one. Must exist in the same workspace.",
      }),
    })
    .openapi("SupersedeDecisionRequest");

  app.openapi(
    createRoute({
      method: "patch",
      path: "/decisions/{id}",
      tags: ["decisions"],
      summary: "Supersede a decision (status='superseded', supersededById=newId).",
      request: {
        params: IdParamSchema,
        body: {
          content: { "application/json": { schema: SupersedeDecisionSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Supersede applied; returns the updated decision.",
          content: { "application/json": { schema: DecisionSchema } },
        },
        400: { description: "A decision cannot supersede itself." },
        404: { description: "Decision or successor not found." },
        409: {
          description: "Successor is closed, or the decision was already replaced by another.",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { supersededById } = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      if (!deps.storage) throw new BadRequestError("storage adapter not available");
      // flatten-legacy-dual-core PR8 port: legacy supersedeDecision(oldId,
      // newId) is a single call that sets old.status='superseded' +
      // old.supersededById=newId and returns a found/not-found boolean.
      // v3 has no 1:1 equivalent — updateDecision(id, input) achieves the
      // identical mutation (same 2 columns, same target row) but throws
      // rather than returning false on a missing row, so existence is
      // checked first via getDecision (matching this route's own
      // subsequent re-fetch, which already needs to run either way).
      const existing = await deps.storage.getDecision(id, workspaceId);
      if (!existing) throw new NotFoundError(`Decision ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Decision");
      // PRIM-18: the successor must be a decision of this workspace the caller can
      // read (one 404 for missing, foreign and above-ceiling).
      const successor = await deps.storage.getDecision(supersededById, workspaceId);
      if (!successor) throw new NotFoundError(`Decision ${supersededById} not found`);
      assertCanReadFact(c, supersededById, successor.sensitivity, "Decision");

      // One atomic storage operation: validates both rows (self-supersede,
      // closed successor, replaced-by-another), closes the predecessor's validity,
      // records the `supersedes` lineage and drops it from the vector index.
      // Repeating the same transition is a no-op that returns the same decision.
      const provenance = resolveProvenance(c);
      const updated = await withStorageErrors(() =>
        deps.storage!.supersedeDecision({
          workspaceId,
          id,
          supersededById,
          actorId: provenance.actorId,
          userId: provenance.userId,
          actorType: provenance.actorType,
        })
      );
      // §35(n): decision.superseded webhook (not re-fired by an idempotent repeat).
      if (existing.status !== "superseded") {
        void dispatchWebhookEvent(
          deps,
          workspaceId,
          "decision.superseded",
          updated as unknown as Record<string, unknown>
        );
      }
      return c.json(updated, 200);
    }
  );
}
