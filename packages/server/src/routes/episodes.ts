import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import {
  PRIMITIVE_SUBTYPES,
  type MnemoEpisode,
  type MnemoFact,
  type Sensitivity,
  isoDateTimeInput,
} from "@mnemo-ai/types";

import type { ServerDeps } from "../deps.js";
import { NotFoundError, ServiceUnavailableError } from "../errors.js";
import type { AuthVariables } from "../auth.js";
import {
  assertCanReadFact,
  assertCanWriteSensitivity,
  canReadSensitivity,
  dropHiddenPointers,
  filterBySensitivity,
  resolveCeiling,
} from "../rbac.js";
import { resolveProvenance } from "../provenance.js";
import { FACT_POINTERS, toMemoryFact } from "../mappers.js";

/**
 * Episode timeline endpoints (Mnemosyne v1.4 — "The Cognitive Leap").
 *
 *   GET  /episodes                — list episodes in a date window
 *   GET  /episodes/:id            — single episode + linked facts
 *   POST /episodes                — create an episode directly
 *   GET  /episodes/:id/timeline   — episode + its linked facts, timeline-ordered
 *
 * An episode is a narrative wrapper around a cluster of facts that
 * occurred together (a meeting, a milestone, a "Monday morning sync").
 * The extraction pipeline auto-creates "synthetic" episodes — one per
 * message turn / document / day — which the Inspector UI hides by
 * default (`includeSynthetic=false`). Operator-style tools opt in.
 *
 * Identity scoping: every read flows through `withMnemoTx(workspaceId,
 * …)` so `app.workspace_id` is set. FORCE policies on `mnemo_episode`
 * (migration 0034) and `mnemo_fact` prevent cross-tenant leakage.
 *
 * POST is a direct, operator-facing create — not routed through the
 * extraction pipeline. Its id must match EPISODE_ID_PATTERN below, same
 * as the pipeline's own mepi_-prefixed convention
 * (packages/core/src/episode/store.ts), so a created episode round-trips
 * through GET /episodes/:id (fixed by adapter-postgres's
 * EpisodeRepository.createEpisode — see its own comment for the B4.1
 * discovery this corrected). There is no PATCH yet.
 */

const EPISODE_ID_PATTERN = /^mepi_[a-z0-9_]{1,64}$/;

const SensitivityEnum = z.enum(["public", "internal", "confidential", "restricted"]);

const EpisodeSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    title: z.string(),
    narrative: z.string(),
    occurredAt: z.iso.datetime(),
    durationMinutes: z.number().int().nullable(),
    participants: z.array(z.string()),
    topics: z.array(z.string()),
    linkedFactIds: z.array(z.string()),
    sourceConversationId: z.string().nullable(),
    sensitivity: SensitivityEnum,
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    isSynthetic: z.boolean(),
  })
  .openapi("Episode");

const ListEpisodesQuerySchema = z
  .object({
    // ISO 8601 — server defaults `from` to now-30d and `to` to now when
    // either is omitted, so the timeline UI doesn't need to round-trip
    // to discover the default window.
    from: isoDateTimeInput().optional().openapi({
      description: "ISO 8601 lower bound on occurredAt. Defaults to now-30d.",
    }),
    to: isoDateTimeInput().optional().openapi({
      description: "ISO 8601 upper bound on occurredAt. Defaults to now.",
    }),
    topic: z.string().min(1).max(200).optional().openapi({
      description: "Filter by a single topic in `topics` (GIN-indexed).",
    }),
    limit: z.coerce.number().int().min(1).max(200).default(50).openapi({
      description: "Max episodes. Server caps at 200.",
    }),
    includeSynthetic: z.coerce.boolean().optional().openapi({
      description:
        "Include episodes auto-created by the extraction pipeline. Defaults to false (Inspector view).",
    }),
  })
  .openapi("ListEpisodesQuery");

const ListEpisodesResponseSchema = z
  .object({ items: z.array(EpisodeSchema) })
  .openapi("ListEpisodesResponse");

const EpisodeIdParamSchema = z.object({
  id: z
    .string()
    .regex(EPISODE_ID_PATTERN, {
      message: "id must match mepi_<slug> (cuid2 or seed id)",
    })
    .openapi({ param: { name: "id", in: "path" }, example: "mepi_a23bcdef0123456789ghijkl" }),
});

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

const EpisodeWithLinkedFactsSchema = z
  .object({
    episode: EpisodeSchema,
    linkedFacts: z.array(MemoryFactSchema),
  })
  .openapi("EpisodeWithLinkedFacts");

const listEpisodesRoute = createRoute({
  method: "get",
  path: "/episodes",
  tags: ["episodes"],
  summary: "List episodes in a date window.",
  request: { query: ListEpisodesQuerySchema },
  responses: {
    200: {
      description: "Matching episodes, newest first.",
      content: { "application/json": { schema: ListEpisodesResponseSchema } },
    },
    400: { description: "Invalid query parameter." },
    401: { description: "Missing or invalid bearer token." },
  },
});

const getEpisodeRoute = createRoute({
  method: "get",
  path: "/episodes/{id}",
  tags: ["episodes"],
  summary: "Fetch one episode + linked facts.",
  request: { params: EpisodeIdParamSchema },
  responses: {
    200: {
      description: "The episode plus the facts it links to (active only).",
      content: { "application/json": { schema: EpisodeWithLinkedFactsSchema } },
    },
    400: { description: "Malformed episode id." },
    404: { description: "Episode not found in this workspace." },
  },
});

// ── POST /episodes ─────────────────────────────────────────────────────────────

const CreateEpisodeRequestSchema = z
  .object({
    title: z.string().min(1).max(1000),
    narrative: z.string().min(1).max(100_000),
    occurredAt: isoDateTimeInput().optional(),
    durationMinutes: z.number().int().min(0).optional(),
    participants: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
    linkedFactIds: z.array(z.string()).optional(),
    isSynthetic: z.boolean().optional(),
    sensitivity: SensitivityEnum.default("internal").optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("CreateEpisodeRequest");

// ── GET /episodes/:id/timeline ─────────────────────────────────────────────────

const TimelineEventSchema = z
  .object({
    kind: z.enum(["episode_created", "fact_linked", "episode_closed"]),
    occurredAt: z.string(),
    detail: z.record(z.string(), z.unknown()),
  })
  .openapi("TimelineEvent");

// flatten-legacy-dual-core PR15 port (task 6c.2): wire projection of a
// `MnemoEpisode` domain object — mirrors legacy factory.ts's `episodeToWire`
// mapping so `GET /episodes/:id`/`GET /episodes/:id/timeline`'s response
// shape is byte-for-byte unchanged. `POST /episodes` above already builds
// this same shape inline (pre-existing, untouched by this PR); this shares
// the same field mapping for the 2 newly-ported read routes.
function episodeToWireShape(ep: MnemoEpisode) {
  return {
    id: ep.id,
    workspaceId: ep.workspaceId,
    title: ep.title,
    narrative: ep.narrative,
    occurredAt: ep.occurredAt.toISOString(),
    durationMinutes: ep.durationMinutes ?? null,
    participants: ep.participants,
    topics: ep.topics,
    linkedFactIds: ep.linkedFactIds,
    sourceConversationId: ep.sourceConversationId ?? null,
    sensitivity: ep.sensitivity,
    metadata: ep.metadata,
    createdAt: ep.createdAt.toISOString(),
    updatedAt: ep.updatedAt.toISOString(),
    isSynthetic: ep.isSynthetic,
  };
}

// flatten-legacy-dual-core PR15 port (task 6c.2): legacy getEpisode()
// (factory.ts) resolves `linkedFactIds` via a single `inArray` SELECT with
// NO active-only predicate — an archived/forgotten fact still referenced by
// an episode is silently included, only a physically-missing id is dropped
// (see factory.ts's own comment: "some linkedFactIds may point at facts
// that have since been archived ... we filter those silently"). v3
// `StorageAdapter` has no batched by-id fact fetch, so this reproduces the
// exact same "keep archived, drop missing" semantics via per-id
// `deps.storage.getFact` (also filter-free by design — see facts.ts's
// `DELETE /:id` doc comment: "getFact intentionally returns an
// already-archived row too").
async function loadEpisodeWithLinkedFacts(
  deps: ServerDeps,
  workspaceId: string,
  id: string,
  ceiling: Sensitivity
): Promise<{ episode: MnemoEpisode; linkedFacts: MnemoFact[] } | null> {
  if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");
  const storage = deps.storage;
  const episode = await storage.getEpisode(id, workspaceId);
  if (!episode) return null;
  // A linked fact above the caller's ceiling is neither returned nor named,
  // in the detail's linkedFacts or the timeline's fact_linked events.
  const linkedFacts = (
    await Promise.all(episode.linkedFactIds.map((fid) => storage.getFact(fid, workspaceId)))
  ).filter((f): f is MnemoFact => f != null && canReadSensitivity(ceiling, f.sensitivity));
  return { episode, linkedFacts };
}

export function mountEpisodes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(listEpisodesRoute, async (c) => {
    const query = c.req.valid("query");
    const workspaceId = c.get("workspaceId");
    if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");
    // flatten-legacy-dual-core Slice 3c pt.1 (PR10): legacy's `includeSynthetic:
    // true` means "no is_synthetic filter at all" (shows both), not "synthetic
    // only" — mirrored here as `isSynthetic: undefined` (no filter) vs `false`.
    const page = await deps.storage.queryEpisodes({
      workspaceId,
      ...(query.from ? { after: new Date(query.from) } : {}),
      ...(query.to ? { before: new Date(query.to) } : {}),
      ...(query.topic ? { topics: [query.topic] } : {}),
      limit: query.limit,
      ...(query.includeSynthetic === true ? {} : { isSynthetic: false }),
    });
    const filtered = await dropHiddenPointers(
      c,
      deps.storage,
      workspaceId,
      filterBySensitivity(page.items, resolveCeiling(c)),
      { lists: ["linkedFactIds"], optionalIds: ["parentEpisodeId"] }
    );
    return c.json({ items: filtered }, 200);
  });

  // flatten-legacy-dual-core PR15 port (task 6c.2): ported off the legacy
  // core client — the `linkedMemoryIds` gap PR8/PR10 documented here was fixed by PR9a
  // (D6.2), which added the field to `MnemoFact`. `toMemoryFact()` (the same
  // mapper `GET /facts` (list)/`getEntityFactsRoute` already use) supplies it.
  app.openapi(getEpisodeRoute, async (c) => {
    const { id } = c.req.valid("param");
    const workspaceId = c.get("workspaceId");
    const result = await loadEpisodeWithLinkedFacts(deps, workspaceId, id, resolveCeiling(c));
    if (!result) throw new NotFoundError(`Episode ${id} not found`);
    assertCanReadFact(c, id, result.episode.sensitivity, "Episode");
    // A linked fact above the ceiling is neither listed nor named by id.
    const [episode] = await dropHiddenPointers(
      c,
      deps.storage!,
      workspaceId,
      [episodeToWireShape(result.episode)],
      { lists: ["linkedFactIds"] }
    );
    const linkedFacts = await dropHiddenPointers(
      c,
      deps.storage!,
      workspaceId,
      result.linkedFacts.map(toMemoryFact),
      FACT_POINTERS
    );
    return c.json({ episode: episode!, linkedFacts }, 200);
  });

  // POST /episodes — create an episode directly
  app.openapi(
    createRoute({
      method: "post",
      path: "/episodes",
      tags: ["episodes"],
      summary: "Create an episode.",
      request: {
        body: {
          content: { "application/json": { schema: CreateEpisodeRequestSchema } },
          required: true,
        },
      },
      responses: {
        201: {
          description: "Episode created.",
          content: { "application/json": { schema: EpisodeSchema } },
        },
        400: { description: "Invalid request." },
        401: { description: "Missing or invalid bearer token." },
        503: { description: "Storage adapter not wired." },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      assertCanWriteSensitivity(c, body.sensitivity); // PRIM-14
      const workspaceId = c.get("workspaceId");
      const provenance = resolveProvenance(c);
      if (!deps.storage) {
        throw new ServiceUnavailableError("Storage adapter not available");
      }
      const episode = await deps.storage.createEpisode({
        workspaceId,
        actorId: provenance.actorId,
        userId: provenance.userId,
        actorType: provenance.actorType,
        title: body.title,
        narrative: body.narrative,
        occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
        ...(body.durationMinutes !== undefined ? { durationMinutes: body.durationMinutes } : {}),
        ...(body.participants ? { participants: body.participants } : {}),
        ...(body.topics ? { topics: body.topics } : {}),
        ...(body.linkedFactIds ? { linkedFactIds: body.linkedFactIds } : {}),
        isSynthetic: body.isSynthetic ?? false,
        ...(body.sensitivity !== undefined ? { sensitivity: body.sensitivity } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      });
      return c.json(
        {
          id: episode.id,
          workspaceId: episode.workspaceId,
          title: episode.title,
          narrative: episode.narrative,
          occurredAt:
            episode.occurredAt instanceof Date
              ? episode.occurredAt.toISOString()
              : episode.occurredAt,
          durationMinutes: episode.durationMinutes ?? null,
          participants: episode.participants ?? [],
          topics: episode.topics ?? [],
          linkedFactIds: episode.linkedFactIds ?? [],
          sourceConversationId: episode.sourceConversationId ?? null,
          sensitivity: episode.sensitivity,
          metadata: episode.metadata ?? {},
          createdAt:
            episode.createdAt instanceof Date ? episode.createdAt.toISOString() : episode.createdAt,
          updatedAt:
            episode.updatedAt instanceof Date ? episode.updatedAt.toISOString() : episode.updatedAt,
          isSynthetic: episode.isSynthetic ?? false,
        },
        201
      );
    }
  );

  // GET /episodes/:id/timeline — chronological fact events for an episode
  app.openapi(
    createRoute({
      method: "get",
      path: "/episodes/{id}/timeline",
      tags: ["episodes"],
      summary: "Chronological timeline events for an episode.",
      request: { params: EpisodeIdParamSchema },
      responses: {
        200: {
          description: "Timeline events in chronological order.",
          content: {
            "application/json": {
              schema: z.object({ events: z.array(TimelineEventSchema) }).openapi("EpisodeTimeline"),
            },
          },
        },
        401: { description: "Missing or invalid bearer token." },
        404: { description: "Episode not found." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      const result = await loadEpisodeWithLinkedFacts(deps, workspaceId, id, resolveCeiling(c));
      if (!result) throw new NotFoundError(`Episode ${id} not found`);

      assertCanReadFact(c, id, result.episode.sensitivity, "Episode");

      const { episode: ep, linkedFacts } = result;

      const events: Array<{ kind: string; occurredAt: string; detail: Record<string, unknown> }> = [
        {
          kind: "episode_created",
          occurredAt: ep.createdAt.toISOString(),
          detail: { episodeId: id },
        },
        ...linkedFacts.map((f) => ({
          kind: "fact_linked",
          occurredAt: f.createdAt.toISOString(),
          detail: { factId: f.id },
        })),
      ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

      return c.json({ events }, 200);
    }
  );
}
