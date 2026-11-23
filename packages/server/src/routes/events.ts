import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { HttpError, NotFoundError } from "../errors.js";
import { eventToWire } from "./_mappers.js";
import type { CreateEventInput, EventFilter, MnemoEvent } from "@mnemo-ai/types";
import { sensitivityAtLeast, isoDateTimeInput } from "@mnemo-ai/types";
import {
  assertCanReadFact,
  dropHiddenPointers,
  assertCanWriteSensitivity,
  filterBySensitivity,
  resolveCeiling,
} from "../rbac.js";
import { emitEvent } from "../events.js";
import { dispatchWebhookEvent } from "../webhookDispatch.js";
import { resolveProvenance } from "../provenance.js";
import { resolveTargetWorkspace } from "../workspace-target.js";

/**
 * Event endpoints — immutable system and external event log (append-only).
 *
 * Routes:
 *   GET    /events              — list events (filter by type/source/date range)
 *   POST   /events              — record a new event
 *   GET    /events/:id          — get single event by ID
 *   PATCH  /events/:id/sensitivity — raise-only sensitivity update (append-only principle)
 *   DELETE /events/:id          — NO-OP archive stub (EVENT-1): mnemo_event has no status
 *                                  column, so this route returns 204 without touching the row.
 *                                  Kept only for API symmetry with the other primitives' DELETE.
 *
 * Events are immutable: no updatedAt field, no real delete/archive operation.
 * Annotations can be appended via PATCH, but existing event data never changes.
 *
 * BONUS: POST /events auto-creates a fact from event.description (T14 automation),
 * enabling event→memory fusion for observability.
 *
 * POST /events — REQUIRED fields:
 *   ✅ type (enum) — system, external, user, agent, scheduled
 *   ✅ name (string, 1-500 chars) — Event name/title
 *   ✅ description (string, 1-20k chars) — What happened
 *   ✅ occurredAt (ISO 8601 datetime) — When event occurred (in UTC)
 *   ✅ source (string, 1-200 chars) — Where event came from (github, slack, monitoring, etc.)
 *
 * POST /events — OPTIONAL fields:
 *   ⚠️  durationS (non-negative integer) — How long event lasted (seconds)
 *   ⚠️  relatedEntities (string array) — Entity IDs involved in event
 *   ⚠️  annotations (array) — [{author, content, at}] — Comments on event (append-only)
 *   ⚠️  sensitivity (enum: public, internal, confidential, restricted) — default: internal
 *   ⚠️  metadata (object)
 *
 * AUTO-FACT CREATION: Event description is automatically stored as a fact with
 * tags: ["auto:event"], attribution: {source: "event", eventId, eventName}.
 * This enables the system to learn from operational events without manual effort.
 */

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const EventTypeEnum = z
  .enum(["system", "external", "user", "agent", "scheduled"])
  .openapi("EventTypeEnum");

const EventAnnotationSchema = z.object({
  author: z.string().max(200),
  content: z.string().max(20_000),
  at: isoDateTimeInput(),
});

const SensitivityEnum = z.enum(["public", "internal", "confidential", "restricted"]);

const EventSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    type: EventTypeEnum,
    name: z.string(),
    description: z.string(),
    occurredAt: z.iso.datetime(),
    durationS: z.number().int().nonnegative().optional(),
    source: z.string(),
    relatedEntities: z.array(z.string()),
    annotations: z.array(EventAnnotationSchema),
    sensitivity: SensitivityEnum,
    createdAt: z.iso.datetime(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .openapi("EventSchema");

const ListEventsQuery = z
  .object({
    type: EventTypeEnum.optional(),
    source: z.string().optional(),
    after: isoDateTimeInput().optional(),
    before: isoDateTimeInput().optional(),
    offset: z.coerce.number().int().min(0).optional().default(0),
    limit: z.coerce.number().int().min(1).max(200).optional().default(25),
  })
  .openapi("ListEventsQuery");

const ListEventsResponse = z
  .object({
    items: z.array(EventSchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
    hasMore: z.boolean(),
  })
  .openapi("ListEventsResponse");

const CreateEventBody = z
  .object({
    type: EventTypeEnum,
    name: z.string().min(1).max(500),
    description: z.string().min(1).max(20_000),
    occurredAt: isoDateTimeInput(),
    durationS: z.number().int().nonnegative().optional(),
    source: z.string().min(1).max(200),
    relatedEntities: z.array(z.string()).optional(),
    annotations: z.array(EventAnnotationSchema).optional(),
    sensitivity: SensitivityEnum.default("internal").optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    targetWorkspaceId: z.guid().optional().openapi({
      description:
        "Write to a different workspace than the one in the API key. The key's user must be a member of the target workspace. Requires userId binding on the key (mk_user_* or mk_live_* with user_id set).",
    }),
  })
  .openapi("CreateEventBody");

const IdParamSchema = z.object({ id: z.string() });

/** The events as the caller may see them: an entity above the caller's
 * ceiling is left out of relatedEntities. */
function eventsForCaller(
  c: Parameters<typeof resolveCeiling>[0],
  deps: ServerDeps,
  workspaceId: string,
  rows: MnemoEvent[]
) {
  return dropHiddenPointers(c, deps.storage!, workspaceId, rows.map(eventToWire), {
    lists: ["relatedEntities"],
  });
}

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountEvents(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // GET /events — list
  app.openapi(
    createRoute({
      method: "get",
      path: "/events",
      tags: ["events"],
      summary: "List events for this workspace.",
      request: {
        query: ListEventsQuery,
      },
      responses: {
        200: {
          description: "Paginated event list.",
          content: { "application/json": { schema: ListEventsResponse } },
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { type, source, after, before, offset, limit } = c.req.valid("query");
      if (!deps.storage) throw new Error("storage adapter not available");

      const filter: EventFilter = {
        workspaceId,
        ...(type !== undefined ? { type } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(after !== undefined ? { after: new Date(after) } : {}),
        ...(before !== undefined ? { before: new Date(before) } : {}),
        offset,
        limit,
      };

      const result = await deps.storage.queryEvents(filter);
      const filtered = filterBySensitivity(result.items, resolveCeiling(c));

      return c.json({
        items: await eventsForCaller(c, deps, workspaceId, filtered),
        total: result.total,
        offset: result.offset,
        limit: result.limit,
        hasMore: result.hasMore,
      });
    }
  );

  // POST /events — create
  app.openapi(
    createRoute({
      method: "post",
      path: "/events",
      tags: ["events"],
      summary: "Create a new event.",
      request: {
        body: {
          content: { "application/json": { schema: CreateEventBody } },
          required: true,
        },
      },
      responses: {
        201: {
          description: "Event created.",
          content: { "application/json": { schema: EventSchema } },
        },
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

      // mnemo_event previously had no actor_id column, so identity was stuffed
      // into agentId as a workaround — migration 0023 gave events a real
      // actorId/userId/actorType. agentId is now left for a genuine
      // caller-supplied agent label (this endpoint accepts none today, so it
      // stays unset rather than auto-filled from auth).
      const input: CreateEventInput = {
        workspaceId,
        actorId: provenance.actorId,
        userId: provenance.userId,
        actorType: provenance.actorType,
        type: body.type,
        name: body.name,
        description: body.description,
        occurredAt: new Date(body.occurredAt),
        source: body.source,
        ...(body.durationS !== undefined ? { durationS: body.durationS } : {}),
        ...(body.relatedEntities !== undefined ? { relatedEntities: body.relatedEntities } : {}),
        ...(body.annotations !== undefined
          ? {
              annotations: body.annotations.map((a) => ({
                author: a.author,
                content: a.content,
                at: new Date(a.at),
              })),
            }
          : {}),
        ...(body.sensitivity !== undefined ? { sensitivity: body.sensitivity } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      };

      const event = await deps.storage.createEvent(input);
      const traceId = (c.get("requestId" as never) as string | undefined) ?? "";
      const wireEvent = eventToWire(event);
      emitEvent(deps.bus, "event.recorded", wireEvent, traceId);
      void dispatchWebhookEvent(
        deps,
        workspaceId,
        "event.recorded",
        wireEvent as Record<string, unknown>
      );
      // T14: event→memory automation — fire-and-forget fact from event description.
      // flatten-legacy-dual-core PR13: ported off the legacy core's
      // createFact to `deps.cognitive.remember` (v3 `MnemoCore`, same
      // canonical write path `capture.ts`/`anticipation.ts` already use —
      // PR12) — content/tags carried verbatim; the free-form attribution bag
      // (source/eventId/eventName) moves into `metadata` (remember's
      // `attribution`/`provenance` concept is a fixed enum, not a free-form
      // bag — same D2 distinction design.md draws between legacy
      // `POST /facts` and `POST /remember`).
      //
      // PRIM-7: the fact carries the event's own description, so it carries the
      // event's tier too — read off the PERSISTED row, which is what
      // GET /events/:id enforces. Without it the storage default (`internal`)
      // won, and a `restricted` event that its caller could not read back
      // came straight out of recall as an `internal` fact.
      const eventSensitivity = event.sensitivity ?? body.sensitivity;
      void deps.cognitive
        .remember(
          {
            workspaceId,
            kind: "fact",
            content: event.description,
            metadata: { source: "event", eventId: event.id, eventName: event.name },
            tags: ["auto:event"],
            ...(eventSensitivity ? { sensitivity: eventSensitivity } : {}),
          },
          {
            workspaceId,
            actorId: provenance.actorId,
            actorType: provenance.actorType,
            userId: provenance.userId,
            scopes: getAuthCtx(c).scopes as import("@mnemo-ai/types").AuthContext["scopes"],
          }
        )
        .catch(() => {});
      return c.json(wireEvent, 201);
    }
  );

  // GET /events/:id — single event
  app.openapi(
    createRoute({
      method: "get",
      path: "/events/{id}",
      tags: ["events"],
      summary: "Get a single event by ID.",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "The event.",
          content: { "application/json": { schema: EventSchema } },
        },
        404: { description: "Event not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      const event = await deps.storage.getEvent(id, workspaceId);
      if (!event) throw new NotFoundError(`Event ${id} not found`);
      assertCanReadFact(c, id, event.sensitivity, "Event");

      const [shown] = await eventsForCaller(c, deps, workspaceId, [event]);
      return c.json(shown!, 200);
    }
  );

  // PATCH /events/:id/sensitivity — raise-only sensitivity update
  app.openapi(
    createRoute({
      method: "patch",
      path: "/events/{id}/sensitivity",
      tags: ["events"],
      summary: "Raise the sensitivity of an event (raise-only — cannot lower).",
      request: {
        params: IdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({ sensitivity: SensitivityEnum })
                .openapi("EventSensitivityPatchBody"),
            },
          },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Event with updated sensitivity.",
          content: { "application/json": { schema: EventSchema } },
        },
        404: {
          description:
            "Event not found (or above the caller's sensitivity ceiling), or code `sensitivity_above_ceiling`: the requested tier is above the caller's own ceiling, so the event would become unreadable to it; nothing is changed.",
        },
        422: { description: "Sensitivity can only be raised, not lowered." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");

      const existing = await deps.storage.getEvent(id, workspaceId);
      if (!existing) throw new NotFoundError(`Event ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Event");

      if (!sensitivityAtLeast(body.sensitivity, existing.sensitivity)) {
        return c.json({ error: "Event sensitivity can only be raised, not lowered" }, 422);
      }
      // PRIM-14, as on create: a tier the caller could not read back is refused.
      assertCanWriteSensitivity(c, body.sensitivity, "update");

      await deps.storage.updateEventSensitivity(id, workspaceId, body.sensitivity);
      const updated = await deps.storage.getEvent(id, workspaceId);
      const [shown] = await eventsForCaller(c, deps, workspaceId, [updated!]);
      return c.json(shown!, 200);
    }
  );

  // DELETE /events/:id — events are immutable (PRIM-10)
  app.openapi(
    createRoute({
      method: "delete",
      path: "/events/{id}",
      tags: ["events"],
      summary: "Refused: events are an immutable log and cannot be deleted or forgotten.",
      request: { params: IdParamSchema },
      responses: {
        404: { description: "Event not found." },
        409: {
          description:
            "The event exists and was NOT modified (code `event_immutable`): mnemo_event has no validity or status column. To retract what it says, forget the facts derived from it.",
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      // 404-first pattern, ceiling included (S6): the refusal below must not
      // confirm an event the caller could not read.
      const existing = await deps.storage.getEvent(id, workspaceId);
      if (!existing) throw new NotFoundError(`Event ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Event");

      // PRIM-10: this answered 204 while changing nothing — the event, and the
      // fact derived from it, stayed recallable. An honest refusal instead.
      throw new HttpError(
        409,
        "event_immutable",
        "Events are immutable and cannot be deleted; forget the facts derived from them instead.",
        { id }
      );
    }
  );

  // POST /events/:id/annotations — append an annotation (atomic JSONB append)
  app.openapi(
    createRoute({
      method: "post",
      path: "/events/{id}/annotations",
      tags: ["events"],
      summary: "Append an annotation to an event.",
      request: {
        params: IdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  author: z.string().min(1).max(200),
                  content: z.string().min(1).max(20_000),
                  at: isoDateTimeInput().optional(),
                })
                .openapi("EventAnnotationRequest"),
            },
          },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Event with annotation appended.",
          content: { "application/json": { schema: EventSchema } },
        },
        404: { description: "Event not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");

      const existing = await deps.storage.getEvent(id, workspaceId);
      if (!existing) throw new NotFoundError(`Event ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Event");

      const updated = await deps.storage.appendEventAnnotation(id, workspaceId, {
        author: body.author,
        content: body.content,
        at: body.at ? new Date(body.at) : new Date(),
      });
      const [shown] = await eventsForCaller(c, deps, workspaceId, [updated]);
      return c.json(shown!, 200);
    }
  );
}
