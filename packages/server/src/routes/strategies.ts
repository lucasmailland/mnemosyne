import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { isoDateTimeInput } from "@mnemo-ai/types";

import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { withStorageErrors } from "./_storage-errors.js";
import type { MnemoStrategy } from "@mnemo-ai/types";
import { OffsetPaginationSchema } from "../schemas.js";
import type { CreateStrategyInput, UpdateStrategyInput } from "@mnemo-ai/types";
import {
  assertCanWriteSensitivity,
  assertCanReadFact,
  dropHiddenPointers,
  filterBySensitivity,
  resolveCeiling,
} from "../rbac.js";
import { resolveProvenance } from "../provenance.js";
import { resolveTargetWorkspace } from "../workspace-target.js";
import { projectScopeFilter } from "../project-scope-filter.js";

// ─── Wire mapper ──────────────────────────────────────────────────────────────

function strategyToWire(s: MnemoStrategy) {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    agentId: s.agentId,
    trigger: s.trigger,
    action: s.action,
    context: s.context,
    scopeRef: s.scopeRef,
    successCount: s.successCount,
    failureCount: s.failureCount,
    worth: s.worth,
    supersedesId: s.supersedesId,
    status: s.status,
    embeddingStale: s.embeddingStale,
    sensitivity: s.sensitivity,
    validFrom: s.validFrom.toISOString(),
    validTo: s.validTo?.toISOString(),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    metadata: s.metadata,
  };
}

/** The strategies as the caller may see them: a predecessor above the
 * caller's ceiling reads like no predecessor. */
function strategiesForCaller(
  c: Parameters<typeof resolveCeiling>[0],
  deps: ServerDeps,
  workspaceId: string,
  rows: MnemoStrategy[]
) {
  return dropHiddenPointers(c, deps.storage!, workspaceId, rows.map(strategyToWire), {
    optionalIds: ["supersedesId"],
  });
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const StrategyStatusEnum = z.enum(["active", "superseded", "archived"]).openapi("StrategyStatus");

const SensitivityEnum = z.enum(["public", "internal", "confidential", "restricted"]);

const StrategySchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    agentId: z.string().optional(),
    trigger: z.string(),
    action: z.string(),
    context: z.string().optional(),
    scopeRef: z.string().optional(),
    successCount: z.number().int(),
    failureCount: z.number().int(),
    worth: z.number(),
    supersedesId: z.string().optional(),
    status: StrategyStatusEnum,
    embeddingStale: z.boolean(),
    sensitivity: SensitivityEnum,
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .openapi("StrategySchema");

const StrategyListQuerySchema = z.object({
  status: StrategyStatusEnum.optional(),
  scopeRef: z.string().optional(),
  validAt: isoDateTimeInput().optional(),
  includeClosed: z.enum(["true", "false"]).optional().openapi({
    description: "Include closed rows (archived, superseded or deleted). Default false.",
  }),
  ...OffsetPaginationSchema.shape,
});

const StrategyListResponseSchema = z
  .object({
    items: z.array(StrategySchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
    hasMore: z.boolean(),
  })
  .openapi("StrategyListResponse");

const StrategyCreateBodySchema = z
  .object({
    agentId: z.string().optional(),
    trigger: z.string().min(1).max(20_000),
    action: z.string().min(1).max(20_000),
    context: z.string().max(20_000).optional(),
    scopeRef: z.string().min(1).max(500).optional(),
    supersedesId: z.string().optional(),
    validFrom: isoDateTimeInput().optional().openapi({
      description:
        "When the strategy starts to apply. Omitted → now. A future instant returns 400.",
    }),
    sensitivity: SensitivityEnum.default("internal").optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    targetWorkspaceId: z.guid().optional().openapi({
      description:
        "Write to a different workspace than the one in the API key. The key's user must be a member of the target workspace. Requires userId binding on the key (mk_user_* or mk_live_* with user_id set).",
    }),
  })
  .openapi("StrategyCreateRequest");

const StrategyPatchBodySchema = z
  .object({
    trigger: z.string().min(1).max(20_000).optional(),
    action: z.string().min(1).max(20_000).optional(),
    context: z.string().max(20_000).optional(),
    status: StrategyStatusEnum.optional(),
    validTo: isoDateTimeInput().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  // Unknown fields are a 400, not silently dropped (APP-022 follow-up).
  .strict()
  .openapi("StrategyPatchRequest");

const IdParamSchema = z.object({ id: z.string() });

const StrategyRateBodySchema = z
  .object({
    outcome: z.enum(["success", "failure"]),
  })
  .openapi("StrategyRateRequest");

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountStrategies(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // GET /strategies — list
  app.openapi(
    createRoute({
      method: "get",
      path: "/strategies",
      tags: ["strategies"],
      summary: "List strategies for this workspace.",
      request: {
        query: StrategyListQuerySchema,
      },
      responses: {
        200: {
          description: "Paginated strategy list.",
          content: { "application/json": { schema: StrategyListResponseSchema } },
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { status, scopeRef, validAt, includeClosed, offset, limit } = c.req.valid("query");
      if (!deps.storage) throw new Error("storage adapter not available");

      const result = await deps.storage.queryStrategies({
        workspaceId,
        // PRIM-16: current strategies by default; includeClosed=true (or an explicit
        // status / validAt) is how a caller asks for superseded or archived ones.
        ...(status !== undefined
          ? { status }
          : includeClosed === "true" || validAt !== undefined
            ? {}
            : { status: "active" as const }),
        ...(await projectScopeFilter(deps.storage, workspaceId, scopeRef)),
        ...(validAt !== undefined
          ? { validAt: new Date(validAt) }
          : includeClosed === "true" || status !== undefined
            ? {}
            : { openOnly: true }),
        offset,
        limit,
      });

      const filtered = filterBySensitivity(result.items, resolveCeiling(c));
      return c.json({
        items: await strategiesForCaller(c, deps, workspaceId, filtered),
        total: result.total,
        offset: result.offset,
        limit: result.limit,
        hasMore: result.hasMore,
      });
    }
  );

  // POST /strategies — create
  app.openapi(
    createRoute({
      method: "post",
      path: "/strategies",
      tags: ["strategies"],
      summary: "Create a new strategy.",
      request: {
        body: {
          content: { "application/json": { schema: StrategyCreateBodySchema } },
          required: true,
        },
      },
      responses: {
        201: {
          description: "Strategy created.",
          content: { "application/json": { schema: StrategySchema } },
        },
        400: { description: "Invalid body, or a `validFrom` in the future." },
        404: {
          description:
            "`supersedesId` names no strategy the caller may read, or (code `sensitivity_above_ceiling`) `sensitivity` is above the caller's ceiling.",
        },
        409: { description: "`supersedesId` names a strategy that is already closed." },
      },
    }),
    async (c) => {
      const { workspaceId: keyWorkspaceId, userId } = getAuthCtx(c);
      const provenance = resolveProvenance(c);
      const body = c.req.valid("json");
      assertCanWriteSensitivity(c, body.sensitivity); // PRIM-14
      if (!deps.storage) throw new Error("storage adapter not available");
      // As in POST /remember: valid time cannot start after the write. The
      // default list reads "current" as an open interval, so a future-dated
      // strategy would be listed as current before it starts.
      if (body.validFrom && new Date(body.validFrom).getTime() > Date.now()) {
        throw new BadRequestError("validFrom cannot be in the future.", undefined, "validFrom");
      }

      const target = await resolveTargetWorkspace({
        keyWorkspaceId,
        userId,
        sql: deps.metricsPgClient,
        targetWorkspaceId: body.targetWorkspaceId,
      });
      if (!target.ok) return c.json(target.body as never, target.status as never);
      const workspaceId = target.workspaceId;

      const input: CreateStrategyInput = {
        workspaceId,
        actorId: provenance.actorId,
        userId: provenance.userId,
        actorType: provenance.actorType,
        trigger: body.trigger,
        action: body.action,
        ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
        ...(body.context !== undefined ? { context: body.context } : {}),
        ...(body.scopeRef !== undefined ? { scopeRef: body.scopeRef } : {}),
        ...(body.supersedesId !== undefined ? { supersedesId: body.supersedesId } : {}),
        ...(body.validFrom !== undefined ? { validFrom: new Date(body.validFrom) } : {}),
        ...(body.sensitivity !== undefined ? { sensitivity: body.sensitivity } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      };

      // PRIM-11: supersedesId closes the predecessor atomically. It must be a
      // strategy of this workspace the caller may read (one 404 for missing,
      // foreign and above-ceiling); a predecessor that is already closed is a 409.
      if (body.supersedesId !== undefined) {
        const predecessor = await deps.storage.getStrategy(body.supersedesId, workspaceId);
        if (!predecessor) throw new NotFoundError(`Strategy ${body.supersedesId} not found`);
        assertCanReadFact(c, body.supersedesId, predecessor.sensitivity, "Strategy");
      }
      const strategy = await withStorageErrors(() => deps.storage!.createStrategy(input));

      const [shown] = await strategiesForCaller(c, deps, workspaceId, [strategy]);
      return c.json(shown!, 201);
    }
  );

  // GET /strategies/:id — single strategy
  app.openapi(
    createRoute({
      method: "get",
      path: "/strategies/{id}",
      tags: ["strategies"],
      summary: "Get a single strategy by ID.",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "The strategy.",
          content: { "application/json": { schema: StrategySchema } },
        },
        404: { description: "Strategy not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      const strategy = await deps.storage.getStrategy(id, workspaceId);
      if (!strategy) throw new NotFoundError(`Strategy ${id} not found`);
      assertCanReadFact(c, id, strategy.sensitivity, "Strategy");

      const [shown] = await strategiesForCaller(c, deps, workspaceId, [strategy]);
      return c.json(shown!, 200);
    }
  );

  // PATCH /strategies/:id — update
  app.openapi(
    createRoute({
      method: "patch",
      path: "/strategies/{id}",
      tags: ["strategies"],
      summary: "Update fields on an existing strategy.",
      request: {
        params: IdParamSchema,
        body: {
          content: { "application/json": { schema: StrategyPatchBodySchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Updated strategy.",
          content: { "application/json": { schema: StrategySchema } },
        },
        404: { description: "Strategy not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");

      // 404-first: confirm the strategy belongs to this workspace, and is one
      // the caller may read, before mutating (the response carries it).
      const existing = await deps.storage.getStrategy(id, workspaceId);
      if (!existing) throw new NotFoundError(`Strategy ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Strategy");

      // Build patch field-by-field — date strings must be converted to Date
      const patch: UpdateStrategyInput = { workspaceId };
      if (body.trigger !== undefined) patch.trigger = body.trigger;
      if (body.action !== undefined) patch.action = body.action;
      if (body.context !== undefined) patch.context = body.context;
      if (body.status !== undefined) patch.status = body.status;
      if (body.validTo !== undefined) patch.validTo = new Date(body.validTo);
      if (body.metadata !== undefined) patch.metadata = body.metadata;

      const updated = await deps.storage.updateStrategy(id, patch);
      const [shown] = await strategiesForCaller(c, deps, workspaceId, [updated]);
      return c.json(shown!, 200);
    }
  );

  // POST /strategies/:id/rate — Beta-Bernoulli outcome recording
  app.openapi(
    createRoute({
      method: "post",
      path: "/strategies/{id}/rate",
      tags: ["strategies"],
      summary: "Record a success or failure outcome for a strategy and recompute its worth.",
      request: {
        params: IdParamSchema,
        body: {
          content: { "application/json": { schema: StrategyRateBodySchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Updated strategy with recomputed worth.",
          content: { "application/json": { schema: StrategySchema } },
        },
        404: { description: "Strategy not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      const { outcome } = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");

      // 404-first: confirm the strategy belongs to this workspace and is readable
      const existing = await deps.storage.getStrategy(id, workspaceId);
      if (!existing) throw new NotFoundError(`Strategy ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Strategy");

      // Beta-Bernoulli recompute: alpha = 2 + successCount, beta = 2 + failureCount
      const newSuccessCount = existing.successCount + (outcome === "success" ? 1 : 0);
      const newFailureCount = existing.failureCount + (outcome === "failure" ? 1 : 0);
      const alpha = 2 + newSuccessCount;
      const beta = 2 + newFailureCount;
      const newWorth = alpha / (alpha + beta);

      const updated = await deps.storage.updateStrategy(id, {
        workspaceId,
        successCount: newSuccessCount,
        failureCount: newFailureCount,
        worth: newWorth,
      });

      const [shown] = await strategiesForCaller(c, deps, workspaceId, [updated]);
      return c.json(shown!, 200);
    }
  );

  // DELETE /strategies/:id — archive
  app.openapi(
    createRoute({
      method: "delete",
      path: "/strategies/{id}",
      tags: ["strategies"],
      summary: "Archive a strategy (soft-delete).",
      request: { params: IdParamSchema },
      responses: {
        204: { description: "Strategy archived." },
        404: { description: "Strategy not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      // 404-first pattern; a hidden strategy answers like a missing one.
      const existing = await deps.storage.getStrategy(id, workspaceId);
      if (!existing) throw new NotFoundError(`Strategy ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Strategy");

      await deps.storage.archiveStrategy(id, workspaceId);
      return c.body(null, 204);
    }
  );
}
