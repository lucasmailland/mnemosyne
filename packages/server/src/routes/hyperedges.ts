import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { NotFoundError } from "../errors.js";
import { hyperedgeToWire } from "./_mappers.js";
import { OffsetPaginationSchema } from "../schemas.js";
import type { CreateHyperedgeInput, UpdateHyperedgeInput } from "@mnemo-ai/types";
import { resolveProvenance } from "../provenance.js";
import { resolveCeiling } from "../rbac.js";
import { withStorageErrors } from "./_storage-errors.js";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const HyperedgeSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    memberIds: z.array(z.string()),
    label: z.string().optional(),
    description: z.string().optional(),
    contextQuery: z.string().optional(),
    activationCount: z.number().int(),
    worth: z.number(),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("HyperedgeSchema");

const HyperedgeListQuerySchema = z.object({
  memberId: z.string().optional(),
  label: z.string().optional(),
  includeClosed: z.enum(["true", "false"]).optional().openapi({
    description: "Include deleted (closed) hyperedges. Default false.",
  }),
  ...OffsetPaginationSchema.shape,
});

const HyperedgeListResponseSchema = z
  .object({
    items: z.array(HyperedgeSchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
    hasMore: z.boolean(),
  })
  .openapi("HyperedgeListResponse");

const HyperedgeCreateBodySchema = z
  .object({
    memberIds: z.array(z.string()).min(3).max(50),
    label: z.string().min(1).max(200).optional(),
    description: z.string().max(20_000).optional(),
    contextQuery: z.string().max(20_000).optional(),
  })
  .openapi("HyperedgeCreateRequest");

const HyperedgePatchBodySchema = z
  .object({
    label: z.string().min(1).max(200).optional(),
    description: z.string().max(20_000).optional(),
    contextQuery: z.string().max(20_000).optional(),
  })
  .openapi("HyperedgePatchRequest");

const IdParamSchema = z.object({ id: z.string() });

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountHyperedges(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // GET /hyperedges — list
  app.openapi(
    createRoute({
      method: "get",
      path: "/hyperedges",
      tags: ["hyperedges"],
      summary: "List hyperedges for this workspace.",
      description:
        "A hyperedge with a member above the caller's sensitivity ceiling is left out of " +
        "`items` and `total`; GET, PATCH and DELETE /hyperedges/{id} answer 404 for it.",
      request: {
        query: HyperedgeListQuerySchema,
      },
      responses: {
        200: {
          description: "Paginated hyperedge list.",
          content: { "application/json": { schema: HyperedgeListResponseSchema } },
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { memberId, label, includeClosed, offset, limit } = c.req.valid("query");
      if (!deps.storage) throw new Error("storage adapter not available");

      const result = await deps.storage.queryHyperedges({
        workspaceId,
        ...(memberId !== undefined ? { memberId } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(includeClosed === "true" ? { includeClosed: true } : {}),
        // A hyperedge with a member above the caller's ceiling is not listed or counted.
        maxSensitivity: resolveCeiling(c),
        offset,
        limit,
      });

      return c.json({
        items: result.items.map(hyperedgeToWire),
        total: result.total,
        offset: result.offset,
        limit: result.limit,
        hasMore: result.hasMore,
      });
    }
  );

  // POST /hyperedges — create
  app.openapi(
    createRoute({
      method: "post",
      path: "/hyperedges",
      tags: ["hyperedges"],
      summary: "Create a new hyperedge (n-ary relation with ≥3 members).",
      request: {
        body: {
          content: { "application/json": { schema: HyperedgeCreateBodySchema } },
          required: true,
        },
      },
      responses: {
        201: {
          description: "Hyperedge created.",
          content: { "application/json": { schema: HyperedgeSchema } },
        },
        400: { description: "Repeated members." },
        404: { description: "A member does not exist in this workspace." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const body = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");
      const provenance = resolveProvenance(c);

      const input: CreateHyperedgeInput = {
        workspaceId,
        memberIds: body.memberIds,
        actorId: provenance.actorId,
        userId: provenance.userId,
        actorType: provenance.actorType,
        // PRIM-13: members must be distinct and exist in this workspace.
        verifyMembers: true,
        maxSensitivity: resolveCeiling(c),
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.contextQuery !== undefined ? { contextQuery: body.contextQuery } : {}),
      };

      const hyperedge = await withStorageErrors(() => deps.storage!.createHyperedge(input));

      return c.json(hyperedgeToWire(hyperedge), 201);
    }
  );

  // GET /hyperedges/:id — single hyperedge
  app.openapi(
    createRoute({
      method: "get",
      path: "/hyperedges/{id}",
      tags: ["hyperedges"],
      summary: "Get a single hyperedge by ID.",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "The hyperedge.",
          content: { "application/json": { schema: HyperedgeSchema } },
        },
        404: { description: "Hyperedge not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      const hyperedge = await deps.storage.getHyperedge(id, workspaceId, {
        maxSensitivity: resolveCeiling(c),
      });
      if (!hyperedge) throw new NotFoundError(`Hyperedge ${id} not found`);

      return c.json(hyperedgeToWire(hyperedge), 200);
    }
  );

  // PATCH /hyperedges/:id — update
  app.openapi(
    createRoute({
      method: "patch",
      path: "/hyperedges/{id}",
      tags: ["hyperedges"],
      summary: "Update fields on an existing hyperedge.",
      request: {
        params: IdParamSchema,
        body: {
          content: { "application/json": { schema: HyperedgePatchBodySchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Updated hyperedge.",
          content: { "application/json": { schema: HyperedgeSchema } },
        },
        404: { description: "Hyperedge not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");

      // 404-first: confirm it belongs to this workspace before mutating
      const existing = await deps.storage.getHyperedge(id, workspaceId, {
        maxSensitivity: resolveCeiling(c),
      });
      if (!existing) throw new NotFoundError(`Hyperedge ${id} not found`);

      // PRIM-12: the workspace travels with the update so the adapter can set the
      // RLS context before it reads the row.
      const patch: UpdateHyperedgeInput = { workspaceId };
      if (body.label !== undefined) patch.label = body.label;
      if (body.description !== undefined) patch.description = body.description;
      if (body.contextQuery !== undefined) patch.contextQuery = body.contextQuery;

      const updated = await withStorageErrors(() => deps.storage!.updateHyperedge(id, patch));
      return c.json(hyperedgeToWire(updated), 200);
    }
  );

  // DELETE /hyperedges/:id — archive
  app.openapi(
    createRoute({
      method: "delete",
      path: "/hyperedges/{id}",
      tags: ["hyperedges"],
      summary: "Archive a hyperedge (soft-delete).",
      request: { params: IdParamSchema },
      responses: {
        204: { description: "Hyperedge archived." },
        404: { description: "Hyperedge not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      // 404-first pattern
      const existing = await deps.storage.getHyperedge(id, workspaceId, {
        maxSensitivity: resolveCeiling(c),
      });
      if (!existing) throw new NotFoundError(`Hyperedge ${id} not found`);

      await deps.storage.archiveHyperedge(id, workspaceId);
      return c.body(null, 204);
    }
  );
}
