import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { ServerDeps } from "../deps.js";
import { BadRequestError, HttpError, NotFoundError } from "../errors.js";
import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import { IdParamSchema } from "../schemas.js";
import {
  assertCanReadFact,
  canReadSensitivity,
  dropHiddenPointers,
  filterBySensitivity,
  resolveCeiling,
} from "../rbac.js";
import { emitEvent } from "../events.js";
import { dispatchWebhookEvent } from "../webhookDispatch.js";
import { resolveProvenance } from "../provenance.js";
import { resolveTargetWorkspace } from "../workspace-target.js";
import { FACT_POINTERS, toApiFact, toMemoryFact } from "../mappers.js";
import { FactRevisionConflictError, PRIMITIVE_SUBTYPES, isoDateTimeInput } from "@mnemo-ai/types";
import { hardDeleteFactAudited } from "./_fact-hard-delete.js";
import { projectScopeFilter } from "../project-scope-filter.js";

/**
 * Fact CRUD-ish endpoints.
 *
 *   GET    /facts              — list facts (pagination, tag filter)
 *   GET    /facts/:id          — get single fact by id
 *   DELETE /facts/:id          — soft-delete: set validTo = now (bitemporal close)
 *   POST   /facts/:id/pin      — pin/unpin a fact (prevent decay)
 *   POST   /facts/:id/restore  — restore a forgotten fact (revert soft-delete)
 *   DELETE /facts/purge        — bulk physical DELETE of all forgotten facts (memory:hard_delete)
 *   DELETE /facts/:id/hard     — physical DELETE of a single fact (memory:hard_delete)
 *
 * `POST /facts` (create) was DELETED in flatten-legacy-dual-core PR8 (D2 step
 * 2) — its behavior (plugin write hooks + `fact.created` event/webhook
 * fan-out) was ported to `POST /remember` in PR7 first, per D2's 3-step
 * order. `POST /remember` is the sole write path for facts now; see
 * `docs/architecture/API.md` and the root `CHANGELOG` for the breaking-change
 * migration note. `content`/`attribution`/`tags` map losslessly onto
 * `/remember`'s `{statement, attribution, tags}` body.
 *
 * Mnemosyne facts are bitemporal: we never DELETE — we set `valid_to = now`.
 * Rows are preserved forever for auditability. Forgotten facts are excluded
 * from recall queries but remain in the database (immutable audit trail).
 * The two /purge and /:id/hard routes are the deliberate exception — a
 * physical row DELETE, gated behind the stricter `memory:hard_delete` scope.
 * Both write a mnemo_deletion_log row in the DELETE's own transaction and
 * close the fact's open relations; /:id/hard also appends a terminal
 * `hard_delete` audit entry (SEC-4). They delete a RESOURCE: neither destroys
 * anyone's encryption keys, so neither is GDPR Article 17 person-wide
 * erasure. That contract (`core/src/cognitive/forget.ts` hard mode) is not
 * exposed over HTTP. `DELETE /forget/fact/:id?mode=hard` is the same resource
 * hard delete as /:id/hard (`_fact-hard-delete.ts`, V-8); other kinds refuse
 * `mode=hard` with 400.
 *
 * All routes require authentication + memory:write (for mutations) or
 * memory:read (for reads). Multi-tenant isolation via RLS on mnemo_fact
 * ensures workspace_id scoping.
 */

export const FactSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    content: z.string(),
    attribution: z.record(z.string(), z.unknown()),
    tags: z.array(z.string()),
    pinned: z.boolean(),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    sensitivity: z.string().optional(),
    // CLIENTS-20 (additive)
    kind: z.enum(PRIMITIVE_SUBTYPES.fact).optional(),
    subject: z.string().optional(),
    scopeRef: z.string().nullable().optional(),
    confidence: z.number().optional(),
    topicKey: z.string().nullable().optional(),
    episodeId: z.string().nullable().optional(),
    status: z.enum(["active", "merged", "forgotten"]).optional(),
    revisionCount: z.number().int().optional().openapi({
      description: "The revision PATCH /facts/:id `expectedRevision` compares with.",
    }),
    hitCount: z.number().int().nonnegative().optional().openapi({
      description: "How many times recall has served this fact.",
    }),
    redacted: z.enum(["erased", "unreadable"]).optional().openapi({
      description:
        "Present only when the fact's encrypted text could not be opened: `erased` after crypto-erasure of its writer's key, `unreadable` when the server has no key ring (MNEMO_MASTER_KEY) or the key does not open it. The text fields then hold `[erased]` or `[unreadable]`.",
    }),
    // Provenance (only with `provenance=true`; omitted otherwise).
    sessionId: z.string().nullable().optional(),
    supersededById: z.string().nullable().optional(),
    supersededAt: z.iso.datetime().nullable().optional(),
    supersedesIds: z.array(z.string()).optional(),
  })
  .openapi("Fact");

// Lenient on purpose: only the exact string "true" enables a flag; anything
// else behaves as before these params existed (never a 400).
const BoolQuery = z
  .string()
  .optional()
  .transform((v) => v === "true");

const FactDetailQuerySchema = z.object({
  includeClosed: BoolQuery.openapi({
    description:
      "When true a closed fact (forgotten, merged or with an ended validity interval) is returned instead of 404.",
  }),
  provenance: BoolQuery.openapi({
    description:
      "When true adds sessionId, supersededById, supersededAt and supersedesIds. A successor or source episode above the caller's sensitivity ceiling reads as null (supersededById, sessionId; supersededAt then absent), exactly like none; superseded facts above it are left out of supersedesIds.",
  }),
});

const PinFactSchema = z
  .object({
    pinned: z.boolean().openapi({
      description: "true to pin (never evict), false to unpin.",
    }),
  })
  .openapi("PinFactRequest");

/**
 * PRIM-14 — the fact a mutation route is about to touch, or a 404 when it does
 * not exist or sits above the caller's read ceiling (S6: 404, not 403). Pin,
 * PATCH and restore respond with the fact (or bring it back into recall), so a
 * write was a way to read past the ceiling.
 */
async function assertWritableFact(
  c: Parameters<typeof resolveCeiling>[0],
  storage: NonNullable<ServerDeps["storage"]>,
  id: string,
  workspaceId: string
) {
  const fact = await storage.getFact(id, workspaceId);
  if (!fact) throw new NotFoundError(`Fact ${id} not found`);
  assertCanReadFact(c, id, fact.sensitivity);
  return fact;
}

export function mountFacts(app: OpenAPIHono<{ Variables: AuthVariables }>, deps: ServerDeps): void {
  // GET /facts/:id — read one
  app.openapi(
    createRoute({
      method: "get",
      path: "/facts/{id}",
      tags: ["facts"],
      summary: "Fetch a fact by id.",
      request: { params: IdParamSchema, query: FactDetailQuerySchema },
      responses: {
        200: { description: "The fact.", content: { "application/json": { schema: FactSchema } } },
        404: { description: "Fact not found in this workspace." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { includeClosed, provenance } = c.req.valid("query");
      const workspaceId = c.get("workspaceId");
      if (!deps.storage) throw new BadRequestError("storage adapter not available");
      // flatten-legacy-dual-core PR9a port (D6.1): legacy `Fact.tags`/
      // `attribution` are phantom fields (see toApiFact's doc comment) —
      // reproducible from a plain MnemoFact read + a wire mapper, no new
      // port surface needed.
      //
      // Legacy `readFact` (factory.ts:628-646) is explicit: "a forgotten
      // fact ... is NOT returned here — a plain getFact reflects what
      // memory knows NOW". Its query filters `valid_to IS NULL AND
      // status = 'active'`. `deps.storage.getFact` does NOT apply this
      // filter (it is a plain by-id read, reused by DELETE/restore which
      // need to see archived rows) — replicate the filter here so a
      // forgotten/superseded fact still reads as 404, not 200. Found via
      // this PR's Tier B check against `conflicts.integration.test.ts`,
      // which asserts a conflict-resolution loser reads back as 404.
      const fact = await deps.storage.getFact(id, workspaceId);
      const isClosed = !!fact && (fact.validTo != null || fact.status !== "active");
      if (!fact || (isClosed && !includeClosed)) {
        throw new NotFoundError(`Fact ${id} not found`);
      }
      assertCanReadFact(c, id, fact.sensitivity);
      const [body] = await dropHiddenPointers(c, deps.storage, workspaceId, [toApiFact(fact)], {
        ids: ["episodeId"],
      });
      if (!provenance) return c.json(body!, 200);

      // Provenance: every related record is workspace-scoped and checked
      // against the caller's ceiling; one above it reads as null (or is left
      // out of supersedesIds), never an error.
      const storage = deps.storage;
      const ceiling = resolveCeiling(c);
      const extra: Record<string, unknown> = {};

      if (isClosed) {
        let successorId: string | null =
          fact.status === "merged" ? (fact.mergedIntoId ?? null) : null;
        if (!successorId) {
          const incoming = await storage.getRelations({
            workspaceId,
            targetId: id,
            verb: "supersedes",
            openOnly: false,
          });
          successorId =
            [...incoming].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
              ?.sourceId ?? null;
        }
        const successor = successorId ? await storage.getFact(successorId, workspaceId) : null;
        // A hidden or missing successor reads exactly like "no successor", so
        // the shape of the body says nothing about what the caller cannot see.
        if (successor && canReadSensitivity(ceiling, successor.sensitivity)) {
          extra.supersededById = successor.id;
          extra.supersededAt = successor.createdAt.toISOString();
        } else {
          extra.supersededById = null;
        }
      }

      const outgoing = await storage.getRelations({
        workspaceId,
        sourceId: id,
        verb: "supersedes",
        openOnly: false,
      });
      const targets = await Promise.all(
        [...outgoing]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map(async (r) => {
            const t = await storage.getFact(r.targetId, workspaceId);
            return t && canReadSensitivity(ceiling, t.sensitivity) ? r.targetId : null;
          })
      );
      extra.supersedesIds = targets.filter((t): t is string => t !== null);

      if (fact.episodeId) {
        const episode = await storage.getEpisode(fact.episodeId, workspaceId);
        if (episode && canReadSensitivity(ceiling, episode.sensitivity)) {
          extra.sessionId = episode.sourceConversationId ?? fact.sessionId ?? null;
        } else {
          // Hidden episode: null rather than absent, so presence is not an oracle.
          extra.sessionId = episode ? null : (fact.sessionId ?? null);
        }
      } else {
        extra.sessionId = fact.sessionId ?? null;
      }
      return c.json({ ...body!, ...extra }, 200);
    }
  );

  // POST /facts/:id/pin — pin/unpin
  app.openapi(
    createRoute({
      method: "post",
      path: "/facts/{id}/pin",
      tags: ["facts"],
      summary: "Pin or unpin a fact.",
      request: {
        params: IdParamSchema,
        body: { content: { "application/json": { schema: PinFactSchema } }, required: true },
      },
      responses: {
        200: {
          description: "Updated fact.",
          content: { "application/json": { schema: FactSchema } },
        },
        404: { description: "Fact not found." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { pinned } = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      if (!deps.storage) throw new BadRequestError("storage adapter not available");
      // PRIM-14: a write is no way around the read ceiling — this route
      // answers with the fact's content, and used to for any sensitivity.
      await assertWritableFact(c, deps.storage, id, workspaceId);
      // flatten-legacy-dual-core PR9a port (D6.1): legacy pinFact() is a raw
      // UPDATE guarded on `NOT (metadata ? '__mnemoConsolidationPending')`
      // (factory.ts:735) then re-reads the row via readFact, which filters
      // `valid_to IS NULL AND status = 'active'` — a forgotten/superseded
      // fact reads as 404 even though the UPDATE itself ran (see GET
      // /facts/:id's doc comment above for the same filter, replicated here
      // since v3 `updateFact`'s `pinned` branch only guards the
      // consolidation-pending marker, not active-ness). A pending row's pin
      // flip is refused the same way (query predicate doesn't match,
      // `updateFact` returns null).
      const fact = await deps.storage.updateFact(id, workspaceId, { pinned });
      if (!fact || fact.validTo != null || fact.status !== "active") {
        throw new NotFoundError(`Fact ${id} not found`);
      }
      const wire = toApiFact(fact);
      const traceId = (c.get("requestId" as never) as string | undefined) ?? "";
      emitEvent(deps.bus, "fact.updated", wire, traceId);
      void dispatchWebhookEvent(
        deps,
        workspaceId,
        "fact.updated",
        wire as unknown as Record<string, unknown>
      );
      const [shown] = await dropHiddenPointers(c, deps.storage, workspaceId, [wire], {
        ids: ["episodeId"],
      });
      return c.json(shown!, 200);
    }
  );

  // POST /facts/:id/relocate — move a fact to another workspace (P72).
  //
  // Registered BEFORE the /facts/{id} wildcard for the same reason
  // /facts/purge is: Hono resolves in registration order and {id} swallows
  // anything, including a literal path segment.
  app.openapi(
    createRoute({
      method: "post",
      path: "/facts/{id}/relocate",
      tags: ["facts"],
      summary: "Move a fact to another workspace (bitemporal: close + successor + supersedes).",
      request: {
        params: IdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  targetWorkspaceId: z.guid(),
                  reason: z.string().max(500).optional(),
                })
                .openapi("RelocateFactRequest"),
            },
          },
        },
      },
      responses: {
        200: {
          description:
            "Relocated. The original is closed (valid_to set) in the source workspace and a successor exists in the target, linked by `supersedes`.",
          content: {
            "application/json": {
              schema: z
                .object({ previousId: z.string(), newId: z.string() })
                .openapi("RelocateFactResponse"),
            },
          },
        },
        403: { description: "Not a write member of the target workspace." },
        404: { description: "No active fact with that id in this workspace." },
        409: {
          description:
            "The fact is confidential or restricted — its ciphertext is bound to the source workspace's DEK and cannot cross the boundary.",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const { workspaceId, userId } = getAuthCtx(c);
      if (!deps.storage?.relocateFact) throw new BadRequestError("storage adapter not available");
      // A fact above the ceiling answers 404 before anything else is asked of
      // it: the 409 for a confidential one would otherwise confirm it exists.
      await assertWritableFact(c, deps.storage, id, workspaceId);

      // Same membership check every cross-workspace write goes through (P57):
      // the caller must be a write member of the destination, or this becomes a
      // way to push rows into workspaces you cannot write to.
      const target = await resolveTargetWorkspace({
        keyWorkspaceId: workspaceId,
        userId,
        sql: deps.metricsPgClient,
        targetWorkspaceId: body.targetWorkspaceId,
      });
      if (!target.ok) return c.json(target.body as never, target.status as never);

      try {
        const moved = await deps.storage.relocateFact({
          id,
          fromWorkspaceId: workspaceId,
          toWorkspaceId: target.workspaceId,
          actorId: resolveProvenance(c).actorId,
          ...(body.reason ? { reason: body.reason } : {}),
        });
        if (!moved) throw new NotFoundError(`No active fact ${id} in this workspace.`);
        return c.json(moved, 200);
      } catch (err) {
        if ((err as { code?: string }).code === "SENSITIVITY_BLOCKED") {
          return c.json({ error: "sensitivity_blocked", message: (err as Error).message }, 409);
        }
        throw err;
      }
    }
  );

  // DELETE /facts/purge — bulk hard-delete all forgotten facts (P5-C).
  //
  // Requires the `memory:hard_delete` scope. Deletes every fact row whose
  // `status = 'forgotten'` in the workspace. Returns { deleted: number }.
  //
  // MUST be registered before DELETE /facts/{id} — Hono resolves route
  // patterns in registration order, and /facts/{id} is a wildcard that
  // matches ANY single path segment, including the literal "purge". A
  // previous comment here claimed registering this route AFTER /facts/{id}
  // was safe because Hono would still prefer the literal match; that's
  // false — the wildcard captured every /facts/purge request first (id=
  // "purge"), 404ing before this handler's own scope check ever ran. See
  // purge-facts-hard-delete.integration.test.ts.
  app.openapi(
    createRoute({
      method: "delete",
      path: "/facts/purge",
      tags: ["facts"],
      summary: "Bulk hard-delete all forgotten facts (requires memory:hard_delete scope).",
      responses: {
        200: {
          description: "Count of rows deleted.",
          content: {
            "application/json": {
              schema: z.object({ deleted: z.number().int() }).openapi("PurgeClosedFactsResponse"),
            },
          },
        },
        403: { description: "Insufficient scope — memory:hard_delete required." },
      },
    }),
    async (c) => {
      const { workspaceId, scopes } = getAuthCtx(c);
      if (!scopes.includes("memory:hard_delete")) {
        throw new (await import("../errors.js")).ForbiddenError(
          "memory:hard_delete scope required for bulk purge"
        );
      }
      // flatten-legacy-dual-core PR9b port (D6.3): legacy purgeClosedFacts()
      // is `DELETE FROM mnemo_fact WHERE status='forgotten' AND NOT
      // (...__mnemoConsolidationPending)` (factory.ts) — ported 1:1 onto
      // `deps.storage.purgeForgottenFacts`, which carries the same guard.
      // NOT optional-chained like the legacy call was: `purgeForgottenFacts`
      // is a REQUIRED StorageAdapter member (it backs a first-class route).
      if (!deps.storage) throw new BadRequestError("storage adapter not available");
      // P114: the purge now writes one mnemo_deletion_log row per deleted fact,
      // in the DELETE's own transaction, so it needs a real actor. Never
      // `apiKeyPrefix` and never a bare id — resolveProvenance returns the
      // namespaced ActorRef the audit trail is supposed to carry (S11).
      const count = await deps.storage.purgeForgottenFacts(
        workspaceId,
        resolveProvenance(c).actorId
      );
      return c.json({ deleted: count }, 200);
    }
  );

  // DELETE /facts/:id — soft delete (close bitemporal interval)
  app.openapi(
    createRoute({
      method: "delete",
      path: "/facts/{id}",
      tags: ["facts"],
      summary: "Soft-delete a fact (sets valid_to = now).",
      request: {
        params: IdParamSchema,
        // FORGET-1: client.forgetFact() has always sent ?reason=… (client.ts)
        // and this route never declared it, so the reason memory_forget
        // promises "queda en audit log" was parsed by nobody and dropped.
        query: z.object({
          reason: z
            .string()
            .optional()
            .openapi({ param: { name: "reason", in: "query" } }),
        }),
      },
      responses: {
        204: { description: "Closed. Body is empty." },
        404: { description: "Fact not found." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { reason } = c.req.valid("query");
      const { workspaceId } = getAuthCtx(c);
      const provenance = resolveProvenance(c);
      if (!deps.storage) throw new BadRequestError("storage adapter not available");

      // flatten-legacy-dual-core PR8 port: legacy closeFact() is a single
      // call returning a found/not-found boolean AND invalidates legacy
      // core's in-process L1 recall/fact-count cache as a side effect (see
      // comment below). v3 archiveFact(id, workspaceId) returns void, so
      // existence is checked first via getFact — an extra round-trip but
      // an identical 404/204 status matrix. The L1 cache invalidation has
      // no v3 equivalent to preserve: it belongs to the legacy core's OWN
      // in-process cache (packages/core/src/factory.ts, deleted whole-sale
      // in Slice 4), not to any v3 read path this route or `POST /remember`
      // exercises — skipping it is inert, not a behavior change.
      //
      // Found while fixing this PR's integration test fixtures (unrelated
      // to the /facts->/remember remap itself): `getFact` intentionally
      // returns an already-archived row too (it has other legitimate
      // callers that need that), so a plain existence check alone let a
      // SECOND DELETE of the same fact reach `archiveFact` again, which
      // crashed with a 500 (`mnemo_fact_archive_pkey` unique-constraint
      // violation) instead of the documented idempotent 404. `validTo` must
      // still be open for this to be a legitimate "still active" 404-guard
      // — same idempotency contract legacy closeFact()'s found/not-found
      // boolean already gave this route pre-port. Falsy check (not a strict
      // `!== undefined`) because the real `MnemoFact` type/DrizzleStorageAdapter
      // mapper uses `undefined` for "open" (mappers.ts: `row.validTo ?? undefined`)
      // while at least one existing unit-test StorageAdapter fake
      // (tests/e2e/memory_lifecycle.test.ts) legitimately uses `null` — a
      // strict `undefined` check broke that fake and is not part of the
      // real port contract either way.
      const existing = await deps.storage.getFact(id, workspaceId);
      if (!existing || existing.validTo) {
        throw new NotFoundError(`Fact ${id} not found`);
      }
      // A 204 where a missing id gets a 404 would confirm a hidden fact.
      assertCanReadFact(c, id, existing.sensitivity);
      // PRIM-3 / CHAOS-8: the pre-check above cannot see a concurrent DELETE
      // that closed the fact after it read. archiveFact locks the row and
      // reports whether THIS call closed it; the losers get the same 404 a
      // sequential repeat gets, and write no audit entry.
      const closed = await deps.storage.archiveFact(id, workspaceId);
      if (closed === false) {
        throw new NotFoundError(`Fact ${id} not found`);
      }

      // FORGET-1: every OTHER primitive kind reaches the audit log through
      // cognitive.forget() (core/src/cognitive/forget.ts). Facts — the
      // DEFAULT and most common memory_forget kind — took this legacy
      // closeFact() path and were never audited at all, contradicting the
      // tool's "queda para auditoría" promise. We append here rather than
      // migrating the route onto cognitive.forget() because that path also
      // copies the row into mnemo_fact_archive (FactRepository.archiveFact),
      // which collides with restoreFact()'s resurrect-in-place semantics, and
      // because closeFact()'s boolean return is what produces the 404 above,
      // and because the cognitive path skips this handler's in-process L1
      // recall/fact-count cache invalidation below.
      //
      // Ordering mirrors the cognitive path exactly: mutate first, then
      // audit. An audit failure therefore surfaces as a 500 with the fact
      // already closed — the same trade-off cognitive.forget() makes: a
      // silently-skipped audit row is strictly worse than a loud failure.
      if (deps.storage) {
        const truncated = reason !== undefined ? reason.slice(0, 200) : undefined;
        await deps.storage.appendAuditEntry({
          workspaceId,
          actorType: provenance.actorType,
          actorId: provenance.actorId,
          action: "delete",
          resourceKind: "fact",
          resourceId: id,
          isTerminal: false,
          ...(truncated ? { detail: { reason: truncated } } : {}),
        });

        // OUTBOX-1: this comment used to explain a manual `vector_delete`
        // enqueue here because the LEGACY closeFact() never enqueued one
        // itself. That's stale: this handler now calls v3's
        // `deps.storage.archiveFact()` above (not legacy closeFact()), and
        // `FactRepository.archiveFact` (adapter-postgres) already enqueues
        // its own `vector_delete` entry inside the SAME transaction that
        // archives the row. Found while fixing this PR's integration test
        // fixtures: the manual enqueue that used to live here duplicated
        // that entry on every single DELETE /facts/:id call (2 outbox rows
        // per delete instead of 1) — removed, not re-added.
      }

      const traceId = (c.get("requestId" as never) as string | undefined) ?? "";
      emitEvent(deps.bus, "fact.archived", { id, workspaceId }, traceId);
      void dispatchWebhookEvent(deps, workspaceId, "fact.archived", { id, workspaceId });
      return c.body(null, 204);
    }
  );

  // DELETE /facts/:id/hard — single fact hard-delete (P5-C).
  //
  // Requires the `memory:hard_delete` scope. Physically removes the row from
  // mnemo_fact, bypassing the bitemporal model. Returns { deleted: true }.
  app.openapi(
    createRoute({
      method: "delete",
      path: "/facts/{id}/hard",
      tags: ["facts"],
      summary: "Hard-delete a single fact (requires memory:hard_delete scope).",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "Row deleted.",
          content: {
            "application/json": {
              schema: z.object({ deleted: z.literal(true) }).openapi("PurgeFactResponse"),
            },
          },
        },
        403: { description: "Insufficient scope — memory:hard_delete required." },
        404: { description: "Fact not found." },
        409: { description: "The fact is mid-consolidation; nothing was deleted." },
        501: { description: "The storage adapter cannot hard-delete." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      // SEC-4: scope, ceiling, deletion log, index cleanup and audit — shared
      // with DELETE /forget/fact/:id?mode=hard (V-8).
      await hardDeleteFactAudited(c, deps, id, "DELETE /facts/:id/hard");
      return c.json({ deleted: true as const }, 200);
    }
  );

  // GET /facts — paginated list of facts in the workspace.
  //
  // Returns the rich `MemoryFact` projection — subject/statement/kind
  // — distinct from the simplified `Fact` shape `GET /facts/:id`
  // returns for ingest-style consumers. Tramo 5 added:
  //   - q (FTS via plainto_tsquery + ILIKE fallback)
  //   - cursor (keyset pagination)
  //   - sortBy / order
  //   - asOf (bitemporal snapshot)
  //   - status: 'merged' / 'all' added to the enum
  //   - response envelope { items, nextCursor, total } so callers can
  //     render header counts + paginate without follow-up reads.
  const MemoryFactSchemaForList = z
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
      sensitivity: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
      // CLIENTS-20 / CHAOS-8 (additive)
      topicKey: z.string().nullable().optional(),
      episodeId: z.string().nullable().optional(),
      revisionCount: z.number().int().optional(),
      redacted: z.enum(["erased", "unreadable"]).optional(),
    })
    .openapi("MemoryFact");

  app.openapi(
    createRoute({
      method: "get",
      path: "/facts",
      tags: ["facts"],
      summary: "Paginated fact list (rich projection, FTS, keyset cursor).",
      request: {
        query: z
          .object({
            kind: z.enum(PRIMITIVE_SUBTYPES.fact).optional(),
            scope: z.enum(["global", "conversation"]).optional(),
            scopeRef: z.string().optional(),
            status: z.enum(["active", "forgotten", "merged", "all"]).optional().openapi({
              description:
                "Defaults to current rows ('active' with an open validity interval), or, with `asOf`, to every row valid at that instant whatever its status now. 'all' yields the full bitemporal view (active+merged+forgotten). An explicit status is applied as given.",
            }),
            includeClosed: z
              .enum(["true", "false"])
              .optional()
              .transform((v) => v === "true")
              .openapi({
                description:
                  "PRIM-16. When true and no `status` is given, closed rows (forgotten, merged, or with an ended validity interval) are listed too — the same as `status=all`. Default false: only current rows.",
              }),
            pinned: z.coerce.boolean().optional(),
            sensitivity: z
              .enum(["public", "internal", "confidential", "restricted"])
              .optional()
              .openapi({
                description:
                  "Filter to a single §5 sensitivity tier. The per-key recall ceiling still applies on top — a key can never see tiers above its ceiling.",
              }),
            q: z.string().optional().openapi({
              description:
                "Optional full-text query. Matches plainto_tsquery on text_lemmatized when populated; ILIKE on statement as fallback.",
            }),
            sortBy: z
              .enum(["created_at", "updated_at", "relevance", "hit_count"])
              .default("updated_at"),
            order: z.enum(["asc", "desc"]).default("desc"),
            cursor: z.string().optional().openapi({
              description:
                "Opaque base64url cursor from a prior page's `nextCursor`. Omit for the first page.",
            }),
            asOf: isoDateTimeInput().optional().openapi({
              description:
                "ISO 8601 bitemporal snapshot. Returns facts whose [validFrom, validTo) interval contained this instant. Future timestamps are rejected.",
            }),
            limit: z.coerce.number().int().min(1).max(500).default(50),
          })
          .superRefine((val, ctx) => {
            // The factory accepts asOf as-is; future timestamps would
            // always return zero rows (no fact's interval extends past
            // its own `now()`-bound validFrom), so reject them here so
            // callers get a clear 400 rather than a silently empty page.
            if (val.asOf) {
              const parsed = Date.parse(val.asOf);
              if (Number.isFinite(parsed) && parsed > Date.now()) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ["asOf"],
                  message: "asOf cannot be in the future",
                });
              }
            }
          })
          .openapi("ListFactsQuery"),
      },
      responses: {
        200: {
          description:
            "Matching facts. `nextCursor` is non-null when more rows follow; `total` is the cheap COUNT(*) for the filter set (without the cursor predicate).",
          content: {
            "application/json": {
              schema: z
                .object({
                  items: z.array(MemoryFactSchemaForList),
                  nextCursor: z.string().nullable(),
                  total: z.number().int(),
                })
                .openapi("ListFactsResponse"),
            },
          },
        },
        400: { description: "Invalid query (e.g. future asOf, bad cursor)." },
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const workspaceId = c.get("workspaceId");
      // flatten-legacy-dual-core PR9b port (D6.3): legacy listFacts() (raw
      // SQL, keyset cursor, FTS, sortBy/order — factory.ts) ported 1:1 onto
      // `deps.storage.queryFactsPage`, which mirrors the same filter set,
      // cursor wire format, and total-before-cursor snapshot semantics (see
      // FactRepository.queryFactsPage's doc comment). The one shape
      // difference: `queryFactsPage` returns domain `MnemoFact[]` (Date
      // fields), so the route wire-maps via `toMemoryFact()` — the SAME
      // mapper PR9a's `getEntityFactsRoute` already uses for this exact wire
      // shape — instead of receiving already-ISO-string items.
      if (!deps.storage) throw new BadRequestError("storage adapter not available");
      // PRIM-16 — one list contract: current rows by default, the closed ones
      // only on request. "Current" is an open interval as well as a status: a
      // row whose validity ended (an import used to write those as `active`)
      // is history. An explicit status, and an asOf snapshot, are honoured as
      // given — the filtering happens in the query, before LIMIT and `total`.
      // A snapshot (`asOf`) is the rows valid at that instant: a fact closed
      // later is `forgotten` or `merged` today, and was the live one then.
      const status = query.status ?? (query.includeClosed || query.asOf ? "all" : "active");
      const currentOnly =
        !query.includeClosed && !query.asOf && (query.status ?? "active") === "active";
      const ceiling = resolveCeiling(c);
      const page = await deps.storage.queryFactsPage({
        workspaceId,
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.scope ? { scope: query.scope } : {}),
        ...(await projectScopeFilter(deps.storage, workspaceId, query.scopeRef)),
        status,
        ...(currentOnly ? { currentOnly: true } : {}),
        // PRIM-8 — the ceiling filters the rows AND `total` in the query; the
        // post-filter below stays as a guard for adapters that ignore it.
        maxSensitivity: ceiling,
        ...(query.pinned !== undefined ? { pinned: query.pinned } : {}),
        ...(query.sensitivity ? { sensitivity: query.sensitivity } : {}),
        ...(query.q ? { q: query.q } : {}),
        sortBy: query.sortBy,
        order: query.order,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.asOf ? { asOf: new Date(query.asOf) } : {}),
        limit: query.limit,
      });
      const items = page.items.map(toMemoryFact);
      const allowedItems = await dropHiddenPointers(
        c,
        deps.storage,
        workspaceId,
        filterBySensitivity(items, ceiling),
        FACT_POINTERS
      );
      return c.json({ ...page, items: allowedItems }, 200);
    }
  );

  // PATCH /facts/:id — patch the editable columns.
  //
  // Subject/statement/kind/pinned/confidence/relevance/metadata. The
  // bitemporal interval is NOT touched — use DELETE for that. An
  // empty patch is rejected with 400 to avoid bumping `updated_at`
  // on a no-op.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/facts/{id}",
      tags: ["facts"],
      summary: "Patch fact (subject/statement/kind/pinned/confidence/relevance/metadata).",
      request: {
        params: IdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  subject: z.string().min(1).max(500).optional(),
                  statement: z.string().min(1).max(50_000).optional(),
                  kind: z.enum(PRIMITIVE_SUBTYPES.fact).optional(),
                  pinned: z.boolean().optional(),
                  confidence: z.number().min(0).max(1).optional(),
                  relevance: z.number().min(0).max(1).optional(),
                  metadata: z.record(z.string(), z.unknown()).optional(),
                  expectedRevision: z.number().int().min(1).optional().openapi({
                    description:
                      "Optional precondition: apply the patch only if the fact is still at this `revisionCount`; otherwise 409 `revision_conflict` and nothing changes. Use it for read-modify-write edits. The replaced revision is always kept in history.",
                  }),
                })
                .openapi("PatchFactRequest"),
            },
          },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Updated fact.",
          content: { "application/json": { schema: MemoryFactSchemaForList } },
        },
        400: { description: "Empty patch or invalid body." },
        404: { description: "Fact not found." },
        409: {
          description:
            "`expectedRevision` no longer matches the fact (code `revision_conflict`); nothing was changed.",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      const isEmpty =
        body.subject === undefined &&
        body.statement === undefined &&
        body.kind === undefined &&
        body.pinned === undefined &&
        body.confidence === undefined &&
        body.relevance === undefined &&
        body.metadata === undefined;
      if (isEmpty) {
        // Hono renders this as a 400 via the global error handler.
        const err = new Error("No fields to update");
        (err as Error & { status?: number }).status = 400;
        throw err;
      }
      if (!deps.storage) throw new BadRequestError("storage adapter not available");
      // flatten-legacy-dual-core PR15 port (task 6c.2): legacy patchFact() is
      // a raw UPDATE (factory.ts) whose active-only WHERE guard only applies
      // when `statement` is part of the patch — a `subject`/`pinned`-only
      // patch on an archived/forgotten fact would still succeed under
      // legacy. This port always requires the row to be active, matching
      // the active-only guard GET /facts/:id and POST /facts/:id/pin already
      // established (PR9a) — a deliberate consistency tightening, not a
      // silently-dropped behavior: an archived/forgotten fact now reads as
      // 404 on PATCH regardless of which fields are touched. `updateFact`'s
      // `subject`/`kind` support (widened this PR, additive — see
      // UpdateFactInput's doc comment) covers the remaining legacy patch
      // fields 1:1.
      // PRIM-14: the response carries the fact, so the read ceiling applies.
      await assertWritableFact(c, deps.storage, id, workspaceId);
      let updated;
      try {
        updated = await deps.storage.updateFact(id, workspaceId, {
          ...(body.subject !== undefined ? { subject: body.subject } : {}),
          ...(body.statement !== undefined ? { statement: body.statement } : {}),
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
          ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
          ...(body.relevance !== undefined ? { relevance: body.relevance } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          ...(body.expectedRevision !== undefined
            ? { expectedRevision: body.expectedRevision }
            : {}),
        });
      } catch (err) {
        // CHAOS-8: a stale precondition is the caller's conflict, not a 500.
        if (err instanceof FactRevisionConflictError) {
          throw new HttpError(409, "revision_conflict", err.message, {
            factId: id,
            expectedRevision: err.expectedRevision,
            currentRevision: err.currentRevision,
          });
        }
        throw err;
      }
      if (!updated || updated.validTo != null || updated.status !== "active") {
        throw new NotFoundError(`Fact ${id} not found`);
      }
      const wire = toMemoryFact(updated);
      const traceId = (c.get("requestId" as never) as string | undefined) ?? "";
      emitEvent(deps.bus, "fact.updated", wire, traceId);
      void dispatchWebhookEvent(
        deps,
        workspaceId,
        "fact.updated",
        wire as unknown as Record<string, unknown>
      );
      const [shown] = await dropHiddenPointers(c, deps.storage, workspaceId, [wire], FACT_POINTERS);
      return c.json(shown!, 200);
    }
  );

  // GET /facts/:id/citations — source-message ids.
  //
  // Returns just `{ factId, sourceMessageIds[] }`. Hosts that want
  // joined message content/role/timestamp do that on their side
  // (the `message` table is host-domain).
  app.openapi(
    createRoute({
      method: "get",
      path: "/facts/{id}/citations",
      tags: ["facts"],
      summary: "Source-message ids for a fact.",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "The fact id plus its source_message_ids list.",
          content: {
            "application/json": {
              schema: z
                .object({ factId: z.string(), sourceMessageIds: z.array(z.string()) })
                .openapi("FactCitationsResponse"),
            },
          },
        },
        404: { description: "Fact not found." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      if (!deps.storage) throw new BadRequestError("storage adapter not available");
      // flatten-legacy-dual-core PR8 port: MnemoFact.sourceMessageIds is a
      // 1:1 equivalent of the legacy projection this route already returns.
      const fact = await deps.storage.getFact(id, workspaceId);
      if (!fact) throw new NotFoundError(`Fact ${id} not found`);
      // Closed facts keep their citations (the catalog opens them), but a fact
      // above the ceiling answers 404 like every other read by id.
      assertCanReadFact(c, id, fact.sensitivity);
      return c.json({ factId: id, sourceMessageIds: fact.sourceMessageIds }, 200);
    }
  );

  // POST /facts/:id/restore — reverse of DELETE/forget.
  //
  // Flips `status` back to 'active' so the fact rejoins the recall
  // pool. The companion endpoint to DELETE /facts/:id; the
  // inspector's undo log uses this when the user un-forgets a fact.
  // Returns the minimal {id, status} pair rather than a full Fact
  // body — the undo-log row only needs enough to update its UI.
  // Hosts that want the full body can chain a getFact() call.
  const RestoreFactResponseSchema = z
    .object({
      id: z.string(),
      status: z.literal("active"),
    })
    .openapi("RestoreFactResponse");

  app.openapi(
    createRoute({
      method: "post",
      path: "/facts/{id}/restore",
      tags: ["facts"],
      summary: "Restore a forgotten fact (status='active').",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "Restored.",
          content: { "application/json": { schema: RestoreFactResponseSchema } },
        },
        404: { description: "Fact not found." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      if (!deps.storage) throw new BadRequestError("storage adapter not available");
      // PRIM-14: restoring brings content back into the caller's recall, so
      // it is held to the same read ceiling as GET.
      const current = await assertWritableFact(c, deps.storage, id, workspaceId);
      // Restoring a fact that is already live is a no-op, not a new revision.
      if (current.status === "active" && current.validTo == null) {
        return c.json({ id: current.id, status: "active" as const }, 200);
      }
      // flatten-legacy-dual-core PR8 port: v3 updateFact(id, workspaceId,
      // {status}) already returns null on a missing row, matching legacy
      // restoreFact's 404 semantics 1:1.
      //
      // PRIM-4: updateFact treats this reopen like new text — it marks the
      // vector stale and enqueues a revision-tagged re-embed in the same
      // transaction. A restored fact used to come back with no vector and
      // drop out of semantic recall for good.
      // P85.2 — `validTo: null` is the half that was missing. Flipping `status`
      // alone left the bitemporal interval closed, and every recall path filters
      // on `validTo IS NULL`, so this route answered 200 with `status: "active"`
      // for a fact that stayed unrecallable. Restore is the system's only
      // reversal operation; it appearing to work while not working is the worst
      // shape that failure can take.
      const updated = await deps.storage.updateFact(id, workspaceId, {
        status: "active",
        validTo: null,
      });
      if (!updated) throw new NotFoundError(`Fact ${id} not found`);
      const restored = { id: updated.id, status: "active" as const };
      const traceId = (c.get("requestId" as never) as string | undefined) ?? "";
      emitEvent(deps.bus, "fact.updated", restored, traceId);
      void dispatchWebhookEvent(
        deps,
        workspaceId,
        "fact.updated",
        restored as unknown as Record<string, unknown>
      );
      return c.json(restored, 200);
    }
  );
}
