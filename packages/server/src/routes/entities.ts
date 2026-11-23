import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  PRIMITIVE_SUBTYPES,
  sensitivityAtLeast,
  type MnemoEntity,
  type RelationVerb,
} from "@mnemo-ai/types";

import type { ServerDeps } from "../deps.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import {
  assertCanReadFact,
  assertCanWriteSensitivity,
  canReadSensitivity,
  dropHiddenPointers,
  filterBySensitivity,
  resolveCeiling,
} from "../rbac.js";
import { resolveProvenance } from "../provenance.js";
import { resolveTargetWorkspace } from "../workspace-target.js";
import { isEntityId, ENTITY_ID_MESSAGE, ENTITY_ID_EXAMPLE } from "../entity-id.js";
import { entityToWire } from "./_mappers.js";
import { withStorageErrors } from "./_storage-errors.js";
import { FACT_POINTERS, toMemoryFact } from "../mappers.js";

/**
 * Entity endpoints — 3rd cognitive primitive.
 *
 *   POST   /entities                — create entity (person/org/project/concept)
 *   GET    /entities                — list entities (kind/query/limit filter)
 *   GET    /entities/:id            — get entity + linked-fact count
 *   GET    /entities/:id/facts      — get facts linked to this entity
 *   DELETE /entities/:id            — soft-delete: set validTo = now (bitemporal close)
 *
 * Entities are canonical real-world objects (persons, organizations, projects,
 * concepts, places) that facts and episodes can reference. The system
 * auto-deduplicates mentions (aliases) and maintains a canonical ID per entity.
 * Entities have no decay (validTo is set only by explicit deletion).
 *
 * All routes require authentication + memory:write (for mutations) or
 * memory:read (for reads). Multi-tenant isolation via RLS on mnemo_entity
 * ensures workspace_id scoping (migration 0039).
 */

// Shape rules for `mnemo_entity.id` live in ../entity-id.js — shared with
// graph.ts, which validates the same id under a different param name.

const EntityKindEnum = z.enum(["person", "organization", "project", "concept", "place", "other"]);

const SensitivityEnum = z.enum(["public", "internal", "confidential", "restricted"]);

const EntitySchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    kind: EntityKindEnum,
    aliases: z.array(z.string()),
    canonicalId: z.string().nullable(),
    description: z.string().nullable(),
    sensitivity: SensitivityEnum,
    metadata: z.record(z.string(), z.unknown()),
    linkedUserId: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description:
          "The platform account (mnemo_user.id) this person-entity is about, when linked. " +
          "Set only via POST /entities/:id/link-user — never accepted on create/update.",
      }),
    firstSeenAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
    mentionCount: z
      .number()
      .int()
      .openapi({
        description:
          "Active facts linked to the entity plus the episodes related to it, counting only " +
          "those the caller may read (the same number GET /graph shows for the current graph).",
      }),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Entity");

const ListEntitiesQuerySchema = z
  .object({
    kind: EntityKindEnum.optional().openapi({
      description: "Filter by entity kind.",
    }),
    q: z.string().min(1).max(200).optional().openapi({
      description: "Case-insensitive substring search across name + aliases.",
    }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .openapi({ description: "Max rows. Server caps at 200." }),
    includeClosed: z
      .enum(["true", "false"])
      .optional()
      .openapi({
        description:
          "Include closed entities (forgotten, or superseded by an unlink/reassignment). " +
          "Default false: only currently valid entities are listed.",
      }),
  })
  .openapi("ListEntitiesQuery");

const ListEntitiesResponseSchema = z
  .object({ items: z.array(EntitySchema) })
  .openapi("ListEntitiesResponse");

const EntityIdParamSchema = z.object({
  id: z
    .string()
    .refine(isEntityId, { message: `id ${ENTITY_ID_MESSAGE}` })
    .openapi({ param: { name: "id", in: "path" }, example: ENTITY_ID_EXAMPLE }),
});

const EntityWithCountSchema = z
  .object({
    entity: EntitySchema,
    linkedFactCount: z.number().int(),
  })
  .openapi("EntityWithCount");

// Rich fact projection — distinct from the simplified FactSchema that
// /facts uses. Entity detail views need the full cognitive shape
// (subject/statement/kind/confidence/...) not just content+attribution.
const MemoryFactSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    agentId: z.string().nullable(),
    scope: z.enum(["global", "conversation"]),
    scopeRef: z.string().nullable(),
    kind: z.enum(PRIMITIVE_SUBTYPES.fact),
    subject: z.string(),
    statement: z.string(),
    confidence: z.number(),
    pinned: z.boolean(),
    relevance: z.number(),
    hitCount: z.number().int(),
    lastRecalledAt: z.iso.datetime().nullable(),
    sourceMessageIds: z.array(z.string()),
    attributedTo: z.enum(["user", "assistant", "system"]).nullable(),
    linkedMemoryIds: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()),
    status: z.enum(["active", "merged", "forgotten"]),
    mergedIntoId: z.string().nullable(),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    memoryType: z.enum(["semantic", "episodic", "procedural", "working"]).optional(),
    actorId: z.string().nullable().optional(),
  })
  .openapi("MemoryFact");

const EntityFactsResponseSchema = z
  .object({
    entity: EntitySchema,
    facts: z.array(MemoryFactSchema),
  })
  .openapi("EntityFactsResponse");

const ListFactsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100).openapi({
      description: "Max facts. Server caps at 500.",
    }),
  })
  .openapi("ListEntityFactsQuery");

// Write surfaces ─────────────────────────────────────────────────────
//
// Symmetric with the legacy /api/mnemo/entities route the inspector
// has shipped with. Same bounds (name 1-200, aliases ≤50 ×≤200), same
// canonicalId merge knob, same "empty patch → 400" defence.

const CreateEntitySchema = z
  .object({
    name: z.string().trim().min(1).max(200).openapi({
      description: "Canonical display name. 1-200 chars after trim.",
    }),
    kind: EntityKindEnum,
    aliases: z
      .array(z.string().trim().min(1).max(200))
      .max(50)
      .optional()
      .openapi({ description: "Aliases. Capped at 50 × 200 chars to keep the GIN index sane." }),
    description: z.string().max(2000).nullable().optional(),
    sensitivity: SensitivityEnum.default("internal").optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    targetWorkspaceId: z.guid().optional().openapi({
      description:
        "Write to a different workspace than the one in the API key. The key's user must be a member of the target workspace. Requires userId binding on the key (mk_user_* or mk_live_* with user_id set).",
    }),
  })
  .openapi("CreateEntityRequest");

const PatchEntitySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    kind: EntityKindEnum.optional(),
    aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    /**
     * canonicalId is the merge knob: set to another entity's id to mark
     * this row as a redirect; set to null to mark it canonical itself.
     */
    canonicalId: z.string().trim().min(1).max(100).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  // Unknown fields are a 400: linkedUserId in particular is set only through
  // /entities/:id/link-user and was silently ignored here (APP-022 follow-up).
  .strict()
  .openapi("PatchEntityRequest");

const listEntitiesRoute = createRoute({
  method: "get",
  path: "/entities",
  tags: ["entities"],
  summary: "List entities in the workspace.",
  request: { query: ListEntitiesQuerySchema },
  responses: {
    200: {
      description: "Matching entities, newest-mentioned first.",
      content: { "application/json": { schema: ListEntitiesResponseSchema } },
    },
    400: { description: "Invalid query parameter." },
    401: { description: "Missing or invalid bearer token." },
  },
});

const getEntityRoute = createRoute({
  method: "get",
  path: "/entities/{id}",
  tags: ["entities"],
  summary: "Fetch one entity + linked-fact count.",
  request: { params: EntityIdParamSchema },
  responses: {
    200: {
      description: "The entity plus a count of active linked facts.",
      content: { "application/json": { schema: EntityWithCountSchema } },
    },
    400: { description: "Malformed entity id." },
    404: { description: "Entity not found in this workspace." },
  },
});

const getEntityFactsRoute = createRoute({
  method: "get",
  path: "/entities/{id}/facts",
  tags: ["entities"],
  summary: "Facts linked to this entity (active only).",
  request: { params: EntityIdParamSchema, query: ListFactsQuerySchema },
  responses: {
    200: {
      description: "Linked facts, newest first.",
      content: { "application/json": { schema: EntityFactsResponseSchema } },
    },
    400: { description: "Malformed entity id." },
    404: { description: "Entity not found in this workspace." },
  },
});

const createEntityRoute = createRoute({
  method: "post",
  path: "/entities",
  tags: ["entities"],
  summary: "Manually create an entity (editor+).",
  request: {
    body: { content: { "application/json": { schema: CreateEntitySchema } }, required: true },
  },
  responses: {
    201: {
      description: "Entity created.",
      content: { "application/json": { schema: EntitySchema } },
    },
    400: { description: "Invalid request body." },
    409: { description: "Entity with this (name, kind) already exists." },
  },
});

const LinkUserBodySchema = z
  .object({
    userId: z.string().min(1).openapi({
      description: "The platform account (mnemo_user.id) to link this person-entity to.",
    }),
  })
  .openapi("EntityLinkUserRequest");

const linkUserRoute = createRoute({
  method: "post",
  path: "/entities/{id}/link-user",
  tags: ["entities"],
  summary: "Link a person-entity to a real platform account.",
  description:
    "Binds a kind='person' entity to a mnemo_user.id — the subject of the entity row, " +
    "distinct from provenance (who wrote it). Self-link (auth.userId === body.userId) is always " +
    "allowed; linking a DIFFERENT user requires memory:admin scope AND owner/admin role in this " +
    "workspace. The target user must be a member of this workspace. Never accepted on " +
    "POST/PATCH /entities — this is the only route that may set it.",
  request: {
    params: EntityIdParamSchema,
    body: { content: { "application/json": { schema: LinkUserBodySchema } }, required: true },
  },
  responses: {
    200: {
      description: "Entity linked.",
      content: { "application/json": { schema: EntitySchema } },
    },
    400: { description: "Invalid body, or entity kind is not 'person'." },
    403: {
      description:
        "Caller may not link this user (not self, not admin, or not workspace owner/admin).",
    },
    404: {
      description:
        "Entity not found, above the caller's sensitivity ceiling, or target user is not a workspace member.",
    },
  },
});

const unlinkUserRoute = createRoute({
  method: "delete",
  path: "/entities/{id}/link-user",
  tags: ["entities"],
  summary: "Unlink a person-entity from its platform account (bitemporal).",
  description:
    "Closes the current entity row (validTo=now) and inserts an unlinked successor row " +
    "(linkedUserId=null), connected by a 'supersedes' relation — the row is never deleted or " +
    "blanked in place, matching this project's forget() convention. Same authorization as link.",
  request: { params: EntityIdParamSchema },
  responses: {
    200: {
      description: "Unlinked — returns the new (unlinked) successor entity.",
      content: { "application/json": { schema: EntitySchema } },
    },
    403: {
      description:
        "Caller may not unlink this entity (not self, not admin, or not workspace owner/admin).",
    },
    404: {
      description:
        "Entity not found, above the caller's sensitivity ceiling, or not currently linked.",
    },
  },
});

const patchEntityRoute = createRoute({
  method: "patch",
  path: "/entities/{id}",
  tags: ["entities"],
  summary: "Patch an entity (rename / alias edits / kind change / canonical merge).",
  request: {
    params: EntityIdParamSchema,
    body: { content: { "application/json": { schema: PatchEntitySchema } }, required: true },
  },
  responses: {
    200: {
      description: "The updated entity.",
      content: { "application/json": { schema: EntitySchema } },
    },
    400: { description: "Invalid body, empty patch, or invalid canonicalId target." },
    404: { description: "Entity not found." },
  },
});

/**
 * The wire form of `rows`, each `mentionCount` counted from what the caller may
 * see (the same count GET /graph shows). One query per response.
 */
async function entitiesToWire(
  c: Parameters<typeof resolveCeiling>[0],
  deps: ServerDeps,
  workspaceId: string,
  rows: MnemoEntity[]
) {
  const counts = await deps.storage!.countEntityMentions({
    workspaceId,
    entityIds: rows.map((r) => r.id),
    maxSensitivity: resolveCeiling(c),
  });
  // A merge into a hidden canonical reads as no merge target, as a missing one would.
  return dropHiddenPointers(
    c,
    deps.storage!,
    workspaceId,
    rows.map((r) => entityToWire(r, counts[r.id] ?? 0)),
    { ids: ["canonicalId"] }
  );
}

async function entityWire(
  c: Parameters<typeof resolveCeiling>[0],
  deps: ServerDeps,
  workspaceId: string,
  row: MnemoEntity
) {
  return (await entitiesToWire(c, deps, workspaceId, [row]))[0]!;
}

export function mountEntities(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(listEntitiesRoute, async (c) => {
    const query = c.req.valid("query");
    const workspaceId = c.get("workspaceId");
    if (!deps.storage) throw new BadRequestError("storage adapter not available");
    // flatten-legacy-dual-core PR9a port (D6.2): legacy `q` is a
    // case-insensitive substring search across name+aliases — now available
    // on `EntityFilter.q`, distinct from `EntityFilter.name` (exact match).
    // `queryEntities`'s ORDER BY (lastSeenAt DESC, createdAt DESC, id DESC)
    // matches legacy listEntities' "newest-mentioned first" ordering.
    const { items: rows } = await deps.storage.queryEntities({
      workspaceId,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.q ? { q: query.q } : {}),
      // PRIM-16: closed entities (forgotten, superseded) are history, not the
      // current list — opt in with includeClosed=true.
      ...(query.includeClosed === "true" ? {} : { openOnly: true }),
      limit: query.limit,
    });
    const visible = filterBySensitivity(rows, resolveCeiling(c));
    return c.json({ items: await entitiesToWire(c, deps, workspaceId, visible) }, 200);
  });

  app.openapi(getEntityRoute, async (c) => {
    const { id } = c.req.valid("param");
    const workspaceId = c.get("workspaceId");
    if (!deps.storage) throw new BadRequestError("storage adapter not available");
    const entity = await deps.storage.getEntity(id, workspaceId);
    if (!entity) throw new NotFoundError(`Entity ${id} not found`);
    assertCanReadFact(c, id, entity.sensitivity, "Entity");
    // flatten-legacy-dual-core PR8 port: legacy getEntity() returned
    // {entity, linkedFactCount} in one round-trip; v3 has no 1:1 equivalent
    // aggregate, so the count is a second `queryFacts` call scoped to this
    // entity's active facts — `.total` is the real COUNT(*) independent of
    // `limit` (see FactRepository.queryFacts), so `limit: 1` is safe here.
    const { total: linkedFactCount } = await deps.storage.queryFacts({
      workspaceId,
      entityId: id,
      status: "active",
      // Facts above the caller's ceiling are not counted.
      maxSensitivity: resolveCeiling(c),
      limit: 1,
    });
    return c.json({ entity: await entityWire(c, deps, workspaceId, entity), linkedFactCount }, 200);
  });

  app.openapi(getEntityFactsRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const workspaceId = c.get("workspaceId");
    if (!deps.storage) throw new BadRequestError("storage adapter not available");

    // flatten-legacy-dual-core PR9a port (D6.2): legacy listFactsForEntity()
    // returned {entity, facts} in one round-trip; v3 has no 1:1 aggregate, so
    // this is getEntity + a queryFacts call scoped to entityId+status:active,
    // mirroring getEntityRoute's existing linkedFactCount pattern. `facts`
    // now maps through toMemoryFact(), which requires MnemoFact.linkedMemoryIds
    // (D6.2) — previously the port-surface gap blocking this route.
    const entity = await deps.storage.getEntity(id, workspaceId);
    if (!entity) throw new NotFoundError(`Entity ${id} not found`);
    assertCanReadFact(c, id, entity.sensitivity, "Entity");
    const { items } = await deps.storage.queryFacts({
      workspaceId,
      entityId: id,
      status: "active",
      // In the query, so hidden facts don't take slots of the page.
      maxSensitivity: resolveCeiling(c),
      limit,
    });
    // Legacy `listFactsForEntity` ORDER BY updated_at DESC, id DESC — v3
    // queryFacts has no ORDER BY (shared by many callers), so sort here to
    // preserve wire-level ordering without touching the shared method.
    const sorted = [...items].sort((a, b) => {
      const byUpdated = b.updatedAt.getTime() - a.updatedAt.getTime();
      return byUpdated !== 0 ? byUpdated : b.id.localeCompare(a.id);
    });
    const facts = sorted.map(toMemoryFact);
    const filteredFacts = await dropHiddenPointers(
      c,
      deps.storage,
      workspaceId,
      filterBySensitivity(facts, resolveCeiling(c)),
      FACT_POINTERS
    );
    return c.json(
      { entity: await entityWire(c, deps, workspaceId, entity), facts: filteredFacts },
      200
    );
  });

  app.openapi(createEntityRoute, async (c) => {
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
    // linkedUserId is deliberately not in CreateEntitySchema — it can never be
    // set here, only via POST /entities/:id/link-user (see that route).
    const created = await withStorageErrors(() =>
      deps.storage!.createEntity({
        workspaceId,
        actorId: provenance.actorId ?? undefined,
        userId: provenance.userId,
        actorType: provenance.actorType,
        name: body.name,
        kind: body.kind,
        aliases: body.aliases ?? [],
        // exactOptionalPropertyTypes: only forward defined keys, never
        // an explicit undefined (would clobber a server-side default).
        ...(body.description !== undefined ? { description: body.description ?? undefined } : {}),
        ...(body.sensitivity !== undefined ? { sensitivity: body.sensitivity } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      })
    );
    return c.json(await entityWire(c, deps, workspaceId, created), 201);
  });

  app.openapi(patchEntityRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const workspaceId = c.get("workspaceId");

    // Empty patch → 400. Cheaper to bail early than to issue a no-op
    // UPDATE that needlessly bumps `updated_at` (which would mislead
    // downstream observers watching for "real" edits).
    const isEmpty =
      body.name === undefined &&
      body.kind === undefined &&
      body.aliases === undefined &&
      body.canonicalId === undefined &&
      body.description === undefined &&
      body.metadata === undefined;
    if (isEmpty) throw new BadRequestError("No fields to update");

    if (!deps.storage) throw new BadRequestError("storage adapter not available");

    // flatten-legacy-dual-core PR9a port (D6.2): legacy entityExists() was a
    // dedicated yes/no query; v3 has no 1:1 equivalent method, so this is a
    // getEntity() existence check instead (same substitution pattern already
    // used for the canonicalId-target check elsewhere in this codebase).
    // Sanity-check the canonicalId target when present: it must
    // (a) exist in this workspace and (b) not equal the row being
    // patched (an entity cannot be its own canonical — pass null
    // instead). Both checks before the UPDATE so the response is a
    // clean 400 rather than a generic FK / business-rule failure.
    if (body.canonicalId !== undefined && body.canonicalId !== null) {
      if (body.canonicalId === id) {
        throw new BadRequestError("canonicalId cannot equal the entity id");
      }
      const target = await deps.storage.getEntity(body.canonicalId, workspaceId);
      // A target above the caller's ceiling answers exactly like a missing one.
      if (!target || !canReadSensitivity(resolveCeiling(c), target.sensitivity)) {
        throw new BadRequestError("canonicalId target does not exist");
      }
    }

    // flatten-legacy-dual-core PR9a port (D6.2): `kind` is now on
    // UpdateEntityInput/EntityRepository.updateEntity — previously the
    // port-surface gap blocking this route. v3 updateEntity() THROWS (not
    // null) on a missing row (EntityRepository.updateEntity:81), unlike
    // legacy's found/not-found boolean-style return — a pre-check via
    // getEntity() preserves the same 404 status matrix without relying on
    // exception-as-control-flow (same pattern as linkUserRoute/
    // unlinkUserRoute/getEntityFactsRoute above).
    const existing = await deps.storage.getEntity(id, workspaceId);
    if (!existing) throw new NotFoundError(`Entity ${id} not found`);
    assertCanReadFact(c, id, existing.sensitivity, "Entity");

    const updated = await withStorageErrors(() =>
      deps.storage!.updateEntity(id, {
        workspaceId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.aliases !== undefined ? { aliases: body.aliases } : {}),
        ...(body.canonicalId !== undefined ? { canonicalId: body.canonicalId } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      })
    );
    return c.json(await entityWire(c, deps, workspaceId, updated), 200);
  });

  /**
   * Self-link (caller's own userId) is always allowed. Linking/unlinking on
   * behalf of a DIFFERENT user requires memory:admin scope AND the caller's
   * own owner/admin role in this workspace — resolved via
   * deps.apiKeys.getWorkspaceMemberRole, the same membership-role lookup the
   * auth middleware uses for scope narrowing. Fails closed (false) whenever
   * the caller has no bound userId of their own, since role membership is
   * keyed by userId and there is nothing to look up.
   */
  async function mayActOnUser(
    c: Parameters<typeof getAuthCtx>[0],
    targetUserId: string
  ): Promise<boolean> {
    const { workspaceId, scopes } = getAuthCtx(c);
    const provenance = resolveProvenance(c);
    if (provenance.userId != null && provenance.userId === targetUserId) return true;
    if (!scopes.includes("memory:admin")) return false;
    if (provenance.userId == null) return false;
    const role = await deps.apiKeys.getWorkspaceMemberRole?.(provenance.userId, workspaceId);
    return role === "owner" || role === "admin";
  }

  app.openapi(linkUserRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const { workspaceId } = getAuthCtx(c);
    if (!deps.storage) throw new BadRequestError("storage adapter not available");

    const entity = await deps.storage.getEntity(id, workspaceId);
    if (!entity) throw new NotFoundError(`Entity ${id} not found`);
    // Anti-probing (S6): a caller above the ceiling gets the same 404 as a
    // caller pointing at a nonexistent id — never confirm this entity exists.
    assertCanReadFact(c, id, entity.sensitivity, "Entity");

    // A closed entity is history (forgotten, or already superseded by an
    // earlier link/unlink): it cannot be linked, and revising it would fork
    // the entity into two live versions.
    if (entity.validTo != null) throw new ConflictError(`Entity ${id} is closed`);

    if (entity.kind !== "person") {
      throw new BadRequestError("Only kind='person' entities can be linked to a user account");
    }

    if (!(await mayActOnUser(c, body.userId))) {
      throw new ForbiddenError(
        "Linking a different user requires memory:admin scope and an owner/admin role in this workspace"
      );
    }

    // SEC: self-link is always allowed for the TARGET user, but that alone
    // must not let a caller silently overwrite someone ELSE's existing link
    // just by naming themselves as the new target — reassigning an entity
    // already linked to a different user is at least as sensitive as linking
    // a stranger, so it requires the same admin+role permission over the
    // CURRENT link-holder too, regardless of who the new target is.
    const isReassignment = entity.linkedUserId != null && entity.linkedUserId !== body.userId;
    if (isReassignment && !(await mayActOnUser(c, entity.linkedUserId as string))) {
      throw new ForbiddenError(
        "Reassigning an entity already linked to a different user requires memory:admin " +
          "scope and an owner/admin role in this workspace"
      );
    }

    // The target account must itself be a member of this workspace — a link
    // must never point at an account with no legitimate reason to be
    // associated with this workspace's data.
    const targetRole = await deps.apiKeys.getWorkspaceMemberRole?.(body.userId, workspaceId);
    if (targetRole == null) {
      throw new NotFoundError(`User ${body.userId} is not a member of this workspace`);
    }

    // PII by construction (S5/MED-23: numeric comparison, never string).
    const sensitivity = sensitivityAtLeast(entity.sensitivity, "internal")
      ? entity.sensitivity
      : "internal";

    const provenance = resolveProvenance(c);

    let updated;
    if (isReassignment) {
      // Bitemporal reassignment — mirrors the unlink route's convention
      // (close, never blank-in-place). Close + successor (carrying the new
      // link) + `supersedes` lineage are ONE storage transaction: done as
      // separate calls, a failure after the close lost the entity (PRIM-2).
      updated = await withStorageErrors(() =>
        deps.storage!.supersedeEntity({
          workspaceId,
          id,
          successor: {
            linkedUserId: body.userId,
            sensitivity,
            actorId: provenance.actorId,
            userId: provenance.userId,
            actorType: provenance.actorType,
          },
        })
      );
    } else {
      updated = await withStorageErrors(() =>
        deps.storage!.updateEntity(id, {
          workspaceId,
          linkedUserId: body.userId,
          sensitivity,
        })
      );
    }

    await deps.storage.appendAuditEntry({
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "update",
      resourceKind: "entity",
      resourceId: updated.id,
      isTerminal: false,
      detail: { linkedUserId: body.userId, reassigned: isReassignment },
    });

    return c.json(await entityWire(c, deps, workspaceId, updated), 200);
  });

  app.openapi(unlinkUserRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { workspaceId } = getAuthCtx(c);
    if (!deps.storage) throw new BadRequestError("storage adapter not available");

    const entity = await deps.storage.getEntity(id, workspaceId);
    if (!entity) throw new NotFoundError(`Entity ${id} not found`);
    assertCanReadFact(c, id, entity.sensitivity, "Entity");

    if (entity.validTo != null) throw new ConflictError(`Entity ${id} is closed`);

    if (!entity.linkedUserId) {
      throw new NotFoundError(`Entity ${id} is not currently linked to a user`);
    }

    if (!(await mayActOnUser(c, entity.linkedUserId))) {
      throw new ForbiddenError(
        "Unlinking a different user requires memory:admin scope and an owner/admin role in this workspace"
      );
    }

    // Bitemporal unlink — mirrors this project's forget() convention (close,
    // never delete/blank in place): close the linked row, insert an unlinked
    // successor and record the lineage with a 'supersedes' relation so the
    // historical fact that the link existed is preserved for audit. One
    // storage transaction (PRIM-2): the old close-then-create pair left the
    // entity closed with no successor whenever the second call failed.
    const provenance = resolveProvenance(c);
    const successor = await withStorageErrors(() =>
      deps.storage!.supersedeEntity({
        workspaceId,
        id,
        successor: {
          linkedUserId: null,
          actorId: provenance.actorId,
          userId: provenance.userId,
          actorType: provenance.actorType,
        },
      })
    );

    await deps.storage.appendAuditEntry({
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "update",
      resourceKind: "entity",
      resourceId: id,
      isTerminal: false,
      detail: { unlinkedFrom: entity.linkedUserId, successorId: successor.id },
    });

    return c.json(await entityWire(c, deps, workspaceId, successor), 200);
  });
}
