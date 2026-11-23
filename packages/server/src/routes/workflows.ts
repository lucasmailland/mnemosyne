import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { MnemoWorkflow, CreateWorkflowInput } from "@mnemo-ai/types";
import { OffsetPaginationSchema } from "../schemas.js";
import { emitMeter } from "../metering/MeterEmitter.js";
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

/**
 * §4 Knowledge-unit creation — POST /workflows (deep re-audit P1-5).
 *
 * Workflows are one of the 6 knowledge-unit types; before this they had no
 * creation endpoint (only strategy + the v3 remember dispatch had paths). This
 * mirrors mountStrategies: a thin OpenAPI layer over the storage adapter's
 * createWorkflow / getWorkflow / queryWorkflows methods.
 */

// ─── Wire mapper ──────────────────────────────────────────────────────────────

function workflowToWire(w: MnemoWorkflow) {
  return {
    id: w.id,
    workspaceId: w.workspaceId,
    name: w.name,
    description: w.description,
    steps: w.steps,
    scopeRef: w.scopeRef,
    avgDurationMs: w.avgDurationMs,
    successRate: w.successRate,
    executionCount: w.executionCount,
    lastExecutedAt: w.lastExecutedAt?.toISOString(),
    version: w.version,
    previousVersionId: w.previousVersionId,
    status: w.status,
    sensitivity: w.sensitivity,
    // P120: the bitemporal pair travels to the caller. Without it an archived
    // row reads exactly like a live one — `forget` closes the interval and the
    // API said nothing about it.
    validFrom: w.validFrom.toISOString(),
    validTo: w.validTo ? w.validTo.toISOString() : null,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
    metadata: w.metadata,
  };
}

/** The workflows as the caller may see them: a previous version above the
 * caller's ceiling reads like no previous version. */
function workflowsForCaller(
  c: Parameters<typeof resolveCeiling>[0],
  deps: ServerDeps,
  workspaceId: string,
  rows: MnemoWorkflow[]
) {
  return dropHiddenPointers(c, deps.storage!, workspaceId, rows.map(workflowToWire), {
    optionalIds: ["previousVersionId"],
  });
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const WorkflowStatusEnum = z.enum(["active", "deprecated", "draft"]).openapi("WorkflowStatus");

const WorkflowStepSchema = z
  .object({
    order: z.number().int(),
    action: z.string().min(1).max(20_000),
    condition: z.string().max(20_000).optional(),
    expectedDurationMs: z.number().int().min(0),
    tools: z.array(z.string()).optional(),
  })
  .openapi("WorkflowStep");

const SensitivityEnum = z.enum(["public", "internal", "confidential", "restricted"]);

const WorkflowSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    steps: z.array(WorkflowStepSchema),
    scopeRef: z.string().optional(),
    avgDurationMs: z.number(),
    successRate: z.number(),
    executionCount: z.number().int(),
    lastExecutedAt: z.iso.datetime().optional(),
    version: z.number().int(),
    previousVersionId: z.string().optional(),
    status: WorkflowStatusEnum,
    sensitivity: SensitivityEnum,
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .openapi("WorkflowSchema");

const WorkflowListQuerySchema = z.object({
  status: WorkflowStatusEnum.optional(),
  scopeRef: z.string().optional(),
  includeClosed: z.enum(["true", "false"]).optional().openapi({
    description: "Include closed rows (archived, superseded or deleted). Default false.",
  }),
  ...OffsetPaginationSchema.shape,
});

const WorkflowListResponseSchema = z
  .object({
    items: z.array(WorkflowSchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
    hasMore: z.boolean(),
  })
  .openapi("WorkflowListResponse");

const WorkflowCreateBodySchema = z
  .object({
    name: z.string().min(1).max(500),
    description: z.string().max(20_000).optional(),
    steps: z.array(WorkflowStepSchema).min(1).max(200),
    scopeRef: z.string().min(1).max(500).optional(),
    sensitivity: SensitivityEnum.default("internal").optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    targetWorkspaceId: z.guid().optional().openapi({
      description:
        "Write to a different workspace than the one in the API key. The key's user must be a member of the target workspace. Requires userId binding on the key (mk_user_* or mk_live_* with user_id set).",
    }),
  })
  .openapi("WorkflowCreateRequest");

/**
 * P111/P112 — mirrors SkillUpdateBodySchema: every field optional, no
 * `targetWorkspaceId` (a PATCH addresses a row that already has a workspace),
 * no `sensitivity` (reclassification is a separate authorization question).
 *
 * `status` IS included, unlike skills, because UpdateWorkflowInput carries it
 * and a workflow's status is part of its ordinary lifecycle rather than a
 * security label.
 */
const WorkflowUpdateBodySchema = z
  .object({
    name: z.string().min(1).max(500).optional(),
    description: z.string().max(20_000).optional(),
    steps: z.array(WorkflowStepSchema).min(1).max(200).optional(),
    status: z.enum(["active", "deprecated", "draft"]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  // See SkillUpdateBodySchema: the "at least one field" rule is enforced in the
  // handler because a `.refine()` produces a ZodEffects that @hono/zod-openapi
  // drops from the generated document, taking the route with it.
  // Unknown fields are a 400, not silently dropped (APP-022 follow-up).
  .strict()
  .openapi("WorkflowUpdateRequest");

const IdParamSchema = z.object({ id: z.string() });

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountWorkflows(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // GET /workflows — list
  app.openapi(
    createRoute({
      method: "get",
      path: "/workflows",
      tags: ["workflows"],
      summary: "List workflows for this workspace.",
      request: { query: WorkflowListQuerySchema },
      responses: {
        200: {
          description: "Paginated workflow list.",
          content: { "application/json": { schema: WorkflowListResponseSchema } },
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { status, scopeRef, includeClosed, offset, limit } = c.req.valid("query");
      if (!deps.storage) throw new Error("storage adapter not available");

      const result = await deps.storage.queryWorkflows({
        workspaceId,
        ...(status !== undefined ? { status } : {}),
        ...(await projectScopeFilter(deps.storage, workspaceId, scopeRef)),
        // PRIM-16: archived (closed) workflows are history; includeClosed=true opts in.
        // An explicit `status` (e.g. deprecated, which is what archiving sets) is an
        // explicit ask for that state and keeps returning closed rows.
        ...(includeClosed === "true" || status !== undefined ? {} : { openOnly: true }),
        offset,
        limit,
      });

      const filtered = filterBySensitivity(result.items, resolveCeiling(c));
      return c.json({
        items: await workflowsForCaller(c, deps, workspaceId, filtered),
        total: result.total,
        offset: result.offset,
        limit: result.limit,
        hasMore: result.hasMore,
      });
    }
  );

  // POST /workflows — create
  app.openapi(
    createRoute({
      method: "post",
      path: "/workflows",
      tags: ["workflows"],
      summary: "Create a new workflow.",
      request: {
        body: {
          content: { "application/json": { schema: WorkflowCreateBodySchema } },
          required: true,
        },
      },
      responses: {
        201: {
          description: "Workflow created.",
          content: { "application/json": { schema: WorkflowSchema } },
        },
        400: { description: "Invalid request body." },
      },
    }),
    async (c) => {
      const { workspaceId: keyWorkspaceId, userId } = getAuthCtx(c);
      const provenance = resolveProvenance(c);
      const body = c.req.valid("json");
      assertCanWriteSensitivity(c, body.sensitivity); // PRIM-14
      if (!deps.storage) throw new Error("storage adapter not available");

      const target = await resolveTargetWorkspace({
        keyWorkspaceId,
        userId,
        sql: deps.metricsPgClient,
        targetWorkspaceId: body.targetWorkspaceId,
      });
      if (!target.ok) return c.json(target.body as never, target.status as never);
      const workspaceId = target.workspaceId;

      const input: CreateWorkflowInput = {
        workspaceId,
        actorId: provenance.actorId,
        userId: provenance.userId,
        actorType: provenance.actorType,
        name: body.name,
        steps: body.steps,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.scopeRef !== undefined ? { scopeRef: body.scopeRef } : {}),
        ...(body.sensitivity !== undefined ? { sensitivity: body.sensitivity } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      };

      const workflow = await deps.storage.createWorkflow(input);
      // mnemo_requests_total emitted globally by app.ts middleware — no ad-hoc inc.
      emitMeter(workspaceId, "write");

      const [shown] = await workflowsForCaller(c, deps, workspaceId, [workflow]);
      return c.json(shown!, 201);
    }
  );

  // GET /workflows/:id — single
  app.openapi(
    createRoute({
      method: "get",
      path: "/workflows/{id}",
      tags: ["workflows"],
      summary: "Get a single workflow by ID.",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "The workflow.",
          content: { "application/json": { schema: WorkflowSchema } },
        },
        404: { description: "Workflow not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      const workflow = await deps.storage.getWorkflow(id, workspaceId);
      if (!workflow) throw new NotFoundError(`Workflow ${id} not found`);
      assertCanReadFact(c, id, workflow.sensitivity, "Workflow");

      const [shown] = await workflowsForCaller(c, deps, workspaceId, [workflow]);
      return c.json(shown!, 200);
    }
  );

  // PATCH /workflows/:id — edit
  //
  // P111 — same gap as skills: `updateWorkflow` was implemented on every adapter
  // and called from nowhere. A multi-step process template that cannot be
  // corrected after the first save is not a template.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/workflows/{id}",
      tags: ["workflows"],
      summary: "Update a workflow's name, description, steps, status or metadata.",
      request: {
        params: IdParamSchema,
        body: {
          content: { "application/json": { schema: WorkflowUpdateBodySchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Workflow updated.",
          content: { "application/json": { schema: WorkflowSchema } },
        },
        400: { description: "Invalid request body." },
        404: { description: "Workflow not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");
      if (!Object.values(body).some((v) => v !== undefined)) {
        throw new BadRequestError("at least one field must be supplied");
      }

      // Existence + sensitivity resolved against the current row before writing,
      // for the same reason as the skills PATCH.
      const existing = await deps.storage.getWorkflow(id, workspaceId);
      if (!existing) throw new NotFoundError(`Workflow ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Workflow");

      const updated = await deps.storage.updateWorkflow(id, {
        workspaceId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.steps !== undefined ? { steps: body.steps } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      });

      emitMeter(workspaceId, "write");

      const [shown] = await workflowsForCaller(c, deps, workspaceId, [updated]);
      return c.json(shown!, 200);
    }
  );
}
