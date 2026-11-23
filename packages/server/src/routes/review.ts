import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { ServerDeps } from "../deps.js";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors.js";
import type { AuthVariables } from "../auth.js";
import { resolveProvenance } from "../provenance.js";
import { assertCanReadFact, findHiddenFor } from "../rbac.js";

/**
 * Active-learning review queue (Mnemosyne v1.3+).
 *
 *   GET  /review                 — list queue rows
 *   GET  /review/count           — unresolved-rows badge
 *   POST /review/{id}/resolve    — close a row (cascade on 'forgotten')
 *
 * The queue is filled by the extraction pipeline (low-confidence
 * extractions, contradictions against existing facts) and by manual
 * flag-for-review actions. Editor+ surface — it's an operational
 * concern, not a viewer one.
 *
 * Identity scoping: every read/write goes through
 * `withMnemoTx(workspaceId, …)` so `app.workspace_id` is set and the
 * FORCE policies on `mnemo_review_queue` (migration 0032) prevent
 * cross-tenant leakage.
 *
 * `POST /resolve` cascades atomically when the reviewer picks
 * 'forgotten' — the linked fact's status flips to 'forgotten' in the
 * same tx so the fact leaves the recall pool without a follow-up
 * round-trip. Other resolutions ('kept', 'edited', 'dismissed') leave
 * the fact alone.
 *
 * flatten-legacy-dual-core Slice 3c pt.1 (PR10): ported off the legacy
 * `CoreLike` field onto `deps.storage`'s new
 * `{list,countUnresolved,resolve,enqueue}ActiveLearningReview` methods
 * (`@mnemo-ai/types` StorageAdapter). Identity scoping is
 * unchanged — the adapter implementation still runs every read/write inside
 * `mnemo_set_workspace(...)`-scoped transactions against the SAME physical
 * `mnemosyne.mnemo_review_queue` table (already reconciled to this exact
 * column shape by PR3's schema-drift work).
 */

// Hyphens are allowed because every adapter has minted `mrev_<randomUUID()>`
// since the PR10 port (the legacy core used cuid2); without them no row the
// server enqueued could be resolved — POST /resolve answered 400.
const REVIEW_ID_PATTERN = /^mrev_[a-z0-9_-]{1,64}$/;

const ReviewReasonEnum = z.enum(["low_confidence", "contradiction", "manual"]);
const ReviewResolutionEnum = z.enum(["kept", "edited", "forgotten", "dismissed"]);

const ReviewQueueRowSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    factId: z.string().nullable(),
    decisionId: z.string().nullable(),
    reason: ReviewReasonEnum,
    createdAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
    resolvedBy: z.string().nullable(),
    resolution: ReviewResolutionEnum.nullable(),
  })
  .openapi("ReviewQueueRow");

const ListReviewQuerySchema = z
  .object({
    reason: ReviewReasonEnum.optional().openapi({
      description: "Filter by reason. Omit for all reasons.",
    }),
    all: z.coerce.boolean().optional().openapi({
      description: "When true, include resolved rows. Defaults to unresolved only.",
    }),
    limit: z.coerce.number().int().min(1).max(200).default(50).openapi({
      description: "Max rows. Server caps at 200.",
    }),
  })
  .openapi("ListReviewQuery");

const ListReviewResponseSchema = z
  .object({ items: z.array(ReviewQueueRowSchema) })
  .openapi("ListReviewResponse");

const ReviewCountResponseSchema = z
  .object({ count: z.number().int() })
  .openapi("ReviewCountResponse");

const ResolveReviewRequestSchema = z
  .object({
    resolution: ReviewResolutionEnum.openapi({
      description:
        "How the reviewer closed the row. 'forgotten' atomically cascades to the fact's status.",
    }),
  })
  .openapi("ResolveReviewRequest");

const ResolveReviewResponseSchema = z
  .object({
    id: z.string(),
    resolution: ReviewResolutionEnum,
    /** The fact id the row pointed at, when applicable. */
    factId: z.string().nullable(),
    /** True when a 'forgotten' resolution cascaded the fact to status='forgotten'. */
    cascaded: z.boolean(),
  })
  .openapi("ResolveReviewResponse");

const ReviewIdParamSchema = z.object({
  id: z
    .string()
    .regex(REVIEW_ID_PATTERN, {
      message: "id must match mrev_<slug> (uuid, cuid2 or seed id)",
    })
    .openapi({ param: { name: "id", in: "path" }, example: "mrev_a23bcdef0123456789ghijkl" }),
});

const listReviewRoute = createRoute({
  method: "get",
  path: "/review",
  tags: ["review"],
  summary: "List active-learning queue rows.",
  request: { query: ListReviewQuerySchema },
  responses: {
    200: {
      description: "Matching rows, newest first.",
      content: { "application/json": { schema: ListReviewResponseSchema } },
    },
    400: { description: "Invalid query parameter." },
    401: { description: "Missing or invalid bearer token." },
  },
});

const reviewCountRoute = createRoute({
  method: "get",
  path: "/review/count",
  tags: ["review"],
  summary: "Cheap COUNT(*) of unresolved queue rows.",
  responses: {
    200: {
      description: "The unresolved-rows count.",
      content: { "application/json": { schema: ReviewCountResponseSchema } },
    },
    401: { description: "Missing or invalid bearer token." },
  },
});

const resolveReviewRoute = createRoute({
  method: "post",
  path: "/review/{id}/resolve",
  tags: ["review"],
  summary: "Close a queue row (cascades on 'forgotten').",
  request: {
    params: ReviewIdParamSchema,
    body: {
      content: { "application/json": { schema: ResolveReviewRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Row resolved. `cascaded: true` when 'forgotten' flipped the fact's status.",
      content: { "application/json": { schema: ResolveReviewResponseSchema } },
    },
    400: { description: "Invalid resolution / malformed id." },
    404: { description: "Queue row not found in this workspace." },
    409: { description: "Queue row already resolved." },
  },
});

export function mountReview(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(listReviewRoute, async (c) => {
    const query = c.req.valid("query");
    const workspaceId = c.get("workspaceId");
    if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");
    const items = await deps.storage.listActiveLearningReview({
      workspaceId,
      ...(query.reason ? { reason: query.reason } : {}),
      ...(query.all !== undefined ? { includeResolved: query.all } : {}),
      limit: query.limit,
    });
    // A row about a fact or decision above the caller's ceiling is not listed:
    // it would name that row, and resolving it would act on it.
    const hidden = await findHiddenFor(
      c,
      deps.storage,
      workspaceId,
      items.flatMap((r) => [r.factId, r.decisionId].filter((id): id is string => !!id))
    );
    return c.json(
      {
        items: items.filter(
          (r) => !(r.factId && hidden.has(r.factId)) && !(r.decisionId && hidden.has(r.decisionId))
        ),
      },
      200
    );
  });

  app.openapi(reviewCountRoute, async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");
    const count = await deps.storage.countUnresolvedActiveLearningReview(workspaceId);
    return c.json({ count }, 200);
  });

  app.openapi(resolveReviewRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { resolution } = c.req.valid("json");
    const workspaceId = c.get("workspaceId");
    const provenance = resolveProvenance(c);
    if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");

    const result = await deps.storage.resolveActiveLearningReview({
      workspaceId,
      reviewId: id,
      resolvedBy: provenance.actorId,
      resolution,
    });

    if (!result.resolved) {
      // Disambiguate: factId+decisionId both null → never existed
      // (404). Otherwise → already resolved (409). Mirrors the legacy
      // orchester route's contract exactly.
      if (result.factId === null && result.decisionId === null) {
        throw new NotFoundError(`Review row ${id} not found`);
      }
      throw new ConflictError(`Review row ${id} is already resolved`);
    }

    return c.json(
      {
        id,
        resolution,
        factId: result.factId,
        cascaded: result.cascaded,
      },
      200
    );
  });

  // POST /review/enqueue — manually queue a fact (or decision) for
  // human review. The lib helper is idempotent via the partial index:
  // re-enqueuing an open row returns the existing id rather than
  // creating a duplicate. Wire response carries `inserted` so the
  // caller can distinguish first-add from re-add.
  //
  // Exactly one of factId/decisionId must be supplied — the helper
  // throws otherwise; we map that to a 400.
  const EnqueueReviewSchema = z
    .object({
      factId: z.string().optional(),
      decisionId: z.string().optional(),
      reason: ReviewReasonEnum,
    })
    .refine((v) => (v.factId !== undefined) !== (v.decisionId !== undefined), {
      message: "Exactly one of factId or decisionId must be supplied",
    })
    .openapi("EnqueueReviewRequest");

  const EnqueueReviewResponseSchema = z
    .object({
      id: z.string(),
      inserted: z.boolean(),
    })
    .openapi("EnqueueReviewResponse");

  app.openapi(
    createRoute({
      method: "post",
      path: "/review/enqueue",
      tags: ["review"],
      summary: "Manually queue a fact or decision for review (idempotent).",
      request: {
        body: { content: { "application/json": { schema: EnqueueReviewSchema } }, required: true },
      },
      responses: {
        200: {
          description:
            "Row queued (inserted:true) or already-open (inserted:false). Same id either way.",
          content: { "application/json": { schema: EnqueueReviewResponseSchema } },
        },
        400: { description: "Invalid body / both-or-neither id." },
        404: {
          description: "The fact or decision does not exist, or is above the caller's ceiling.",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");
      // The target must exist and be readable: a review of a hidden row would
      // name it, and resolving it as 'forgotten' would forget it. Hidden reads
      // exactly like missing.
      const target =
        body.factId !== undefined
          ? await deps.storage.getFact(body.factId, workspaceId)
          : await deps.storage.getDecision(body.decisionId!, workspaceId);
      const [label, targetId] =
        body.factId !== undefined ? ["Fact", body.factId] : ["Decision", body.decisionId!];
      if (!target) throw new NotFoundError(`${label} ${targetId} not found`);
      assertCanReadFact(c, targetId, target.sensitivity, label);
      try {
        const result = await deps.storage.enqueueActiveLearningReview({
          workspaceId,
          ...(body.factId !== undefined ? { factId: body.factId } : {}),
          ...(body.decisionId !== undefined ? { decisionId: body.decisionId } : {}),
          reason: body.reason,
        });
        return c.json(result, 200);
      } catch (e) {
        // The lib helper throws "exactly one of factId or decisionId
        // must be supplied" — the refine() above usually catches this
        // first, but if it slips through (e.g. both supplied as null
        // via a tricky JSON parse), surface as 400.
        if (e instanceof Error && e.message.includes("exactly one")) {
          throw new BadRequestError(e.message);
        }
        throw e;
      }
    }
  );
}
