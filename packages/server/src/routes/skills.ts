import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { MnemoSkill, CreateSkillInput } from "@mnemo-ai/types";
import { OffsetPaginationSchema } from "../schemas.js";
import { emitMeter } from "../metering/MeterEmitter.js";
import {
  assertCanWriteSensitivity,
  assertCanReadFact,
  filterBySensitivity,
  resolveCeiling,
} from "../rbac.js";
import { resolveProvenance } from "../provenance.js";
import { resolveTargetWorkspace } from "../workspace-target.js";

/**
 * §4 Knowledge-unit creation — POST /skills (deep re-audit P1-5).
 *
 * Skills are stored prompt templates — one of the 6 knowledge-unit types that
 * previously had no creation endpoint. Mirrors mountStrategies / mountWorkflows:
 * a thin OpenAPI layer over the storage adapter's createSkill / getSkill /
 * querySkills methods.
 */

// ─── Wire mapper ──────────────────────────────────────────────────────────────

function skillToWire(s: MnemoSkill) {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    name: s.name,
    promptTemplate: s.promptTemplate,
    variables: s.variables,
    requiredContext: s.requiredContext,
    qualityScore: s.qualityScore,
    usageCount: s.usageCount,
    lastUsedAt: s.lastUsedAt?.toISOString(),
    embeddingModel: s.embeddingModel,
    embeddingStale: s.embeddingStale,
    sensitivity: s.sensitivity,
    // P120: the bitemporal pair travels to the caller. Without it an archived
    // row reads exactly like a live one — `forget` closes the interval and the
    // API said nothing about it.
    validFrom: s.validFrom.toISOString(),
    validTo: s.validTo ? s.validTo.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    metadata: s.metadata,
  };
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const SensitivityEnum = z.enum(["public", "internal", "confidential", "restricted"]);

const SkillSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    promptTemplate: z.string(),
    variables: z.array(z.string()),
    requiredContext: z.array(z.string()),
    qualityScore: z.number(),
    usageCount: z.number().int(),
    lastUsedAt: z.iso.datetime().optional(),
    embeddingModel: z.string().optional(),
    embeddingStale: z.boolean(),
    sensitivity: SensitivityEnum,
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .openapi("SkillSchema");

const SkillListQuerySchema = z.object({
  ...OffsetPaginationSchema.shape,
});

const SkillListResponseSchema = z
  .object({
    items: z.array(SkillSchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
    hasMore: z.boolean(),
  })
  .openapi("SkillListResponse");

const SkillCreateBodySchema = z
  .object({
    name: z.string().min(1).max(500),
    promptTemplate: z.string().min(1).max(50_000),
    variables: z.array(z.string()).max(200).optional(),
    requiredContext: z.array(z.string()).max(200).optional(),
    sensitivity: SensitivityEnum.default("internal").optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    targetWorkspaceId: z.guid().optional().openapi({
      description:
        "Write to a different workspace than the one in the API key. The key's user must be a member of the target workspace. Requires userId binding on the key (mk_user_* or mk_live_* with user_id set).",
    }),
  })
  .openapi("SkillCreateRequest");

/**
 * P111/P112 — every field is optional and `targetWorkspaceId` is absent by
 * design: a PATCH addresses a row that already lives in a workspace, so the
 * workspace comes from the row, never from the body. `sensitivity` is likewise
 * excluded — reclassifying an existing item is a different operation with a
 * different authorization question, not a field edit.
 */
const SkillUpdateBodySchema = z
  .object({
    name: z.string().min(1).max(500).optional(),
    promptTemplate: z.string().min(1).max(50_000).optional(),
    variables: z.array(z.string()).max(200).optional(),
    requiredContext: z.array(z.string()).max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  // The "at least one field" rule lives in the handler, not in a `.refine()`:
  // refine wraps the schema in a ZodEffects, which @hono/zod-openapi does not
  // serialise, and the route then silently vanishes from the OpenAPI document.
  // contract-reality.test.ts catches exactly that — it diffs the live route
  // inventory against the generated document — which is how this was found.
  .openapi("SkillUpdateRequest");

const IdParamSchema = z.object({ id: z.string() });

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountSkills(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // GET /skills — list
  app.openapi(
    createRoute({
      method: "get",
      path: "/skills",
      tags: ["skills"],
      summary: "List skills for this workspace.",
      request: { query: SkillListQuerySchema },
      responses: {
        200: {
          description: "Paginated skill list.",
          content: { "application/json": { schema: SkillListResponseSchema } },
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { offset, limit } = c.req.valid("query");
      if (!deps.storage) throw new Error("storage adapter not available");

      const result = await deps.storage.querySkills({
        workspaceId,
        offset,
        limit,
        openOnly: true,
      });

      const filtered = filterBySensitivity(result.items, resolveCeiling(c));
      return c.json({
        items: filtered.map(skillToWire),
        total: result.total,
        offset: result.offset,
        limit: result.limit,
        hasMore: result.hasMore,
      });
    }
  );

  // POST /skills — create
  app.openapi(
    createRoute({
      method: "post",
      path: "/skills",
      tags: ["skills"],
      summary: "Create a new skill (stored prompt template).",
      request: {
        body: {
          content: { "application/json": { schema: SkillCreateBodySchema } },
          required: true,
        },
      },
      responses: {
        201: {
          description: "Skill created.",
          content: { "application/json": { schema: SkillSchema } },
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

      const input: CreateSkillInput = {
        workspaceId,
        actorId: provenance.actorId,
        userId: provenance.userId,
        actorType: provenance.actorType,
        name: body.name,
        promptTemplate: body.promptTemplate,
        ...(body.variables !== undefined ? { variables: body.variables } : {}),
        ...(body.requiredContext !== undefined ? { requiredContext: body.requiredContext } : {}),
        ...(body.sensitivity !== undefined ? { sensitivity: body.sensitivity } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      };

      const skill = await deps.storage.createSkill(input);
      // mnemo_requests_total emitted globally by app.ts middleware — no ad-hoc inc.
      emitMeter(workspaceId, "write");

      return c.json(skillToWire(skill), 201);
    }
  );

  // GET /skills/:id — single
  app.openapi(
    createRoute({
      method: "get",
      path: "/skills/{id}",
      tags: ["skills"],
      summary: "Get a single skill by ID.",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "The skill.",
          content: { "application/json": { schema: SkillSchema } },
        },
        404: { description: "Skill not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      const skill = await deps.storage.getSkill(id, workspaceId);
      if (!skill) throw new NotFoundError(`Skill ${id} not found`);
      assertCanReadFact(c, id, skill.sensitivity, "Skill");

      return c.json(skillToWire(skill), 200);
    }
  );

  // PATCH /skills/:id — edit
  //
  // P111 — `updateSkill` has been implemented on every adapter since the port was
  // written and had no caller anywhere: no route, no MCP tool, no CLI command.
  // Skills could be created and then never corrected, which for a stored prompt
  // template is the whole point of storing it.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/skills/{id}",
      tags: ["skills"],
      summary: "Update a skill's template, name, variables or metadata.",
      request: {
        params: IdParamSchema,
        body: {
          content: { "application/json": { schema: SkillUpdateBodySchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Skill updated.",
          content: { "application/json": { schema: SkillSchema } },
        },
        400: { description: "Invalid request body." },
        404: { description: "Skill not found." },
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

      // Existence and sensitivity are checked against the CURRENT row before any
      // write: updateSkill resolves the workspace from its input, so without this
      // read a caller could address a row above their ceiling and learn of its
      // existence from the response. Same order as GET above.
      const existing = await deps.storage.getSkill(id, workspaceId);
      if (!existing) throw new NotFoundError(`Skill ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Skill");

      const updated = await deps.storage.updateSkill(id, {
        workspaceId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.promptTemplate !== undefined ? { promptTemplate: body.promptTemplate } : {}),
        ...(body.variables !== undefined ? { variables: body.variables } : {}),
        ...(body.requiredContext !== undefined ? { requiredContext: body.requiredContext } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      });

      emitMeter(workspaceId, "write");

      return c.json(skillToWire(updated), 200);
    }
  );
}
