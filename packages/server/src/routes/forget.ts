import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { HttpError, NotFoundError } from "../errors.js";
import { assertCanReadFact, findHiddenFor } from "../rbac.js";
import { resolveProvenance } from "../provenance.js";
import { hardDeleteFactAudited } from "./_fact-hard-delete.js";

// ─── DELETE /forget/:kind/:id ──────────────────────────────────────────────

// P18 — Generic soft-delete route for all 10 primitive kinds. Allows MCP memory_forget
// to archive any primitive type (episode, entity, workflow, skill, task, etc.)
// beyond facts. Delegates to core.forget() which dispatches per-kind.
//
// V-8 (SEC-4) — `?mode=hard` used to be dropped by the query schema and the
// handler hardcoded "soft": a caller asking for a hard delete was told it had
// succeeded while the row stayed. A silent downgrade is the bug, so `mode=hard`
// is either honoured or refused, never ignored:
//   - fact: the resource hard delete of DELETE /facts/:id/hard, the same code
//     (`_fact-hard-delete.ts`) — memory:hard_delete (403 without it), S6 404,
//     deletion-log row, index cleanup and a terminal audit entry.
//   - every other kind: 400 `hard_delete_unsupported`. No adapter hard-deletes
//     them, and core forget's hard mode is person-wide GDPR erasure (it destroys
//     the CALLER's encryption keys, for every row they wrote), which a
//     per-resource route must never trigger. Erasing a person is
//     POST /admin/erasure (routes/admin-erasure.ts), which names its subject.
const VALID_PRIMITIVE_KINDS = [
  "fact",
  "decision",
  "episode",
  "entity",
  "strategy",
  "workflow",
  "skill",
  "task",
  "event",
  "reasoning",
  "hyperedge",
] as const;

export function mountForget(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(
    createRoute({
      method: "delete",
      path: "/forget/{kind}/{id}",
      tags: ["memory"],
      summary:
        "Soft-delete (archive) any cognitive primitive by kind and id; `mode=hard` physically deletes a fact (memory:hard_delete).",
      request: {
        params: z.object({
          kind: z.enum(VALID_PRIMITIVE_KINDS).openapi({ param: { name: "kind", in: "path" } }),
          id: z
            .string()
            .min(1)
            .openapi({ param: { name: "id", in: "path" } }),
        }),
        query: z.object({
          reason: z
            .string()
            .optional()
            .openapi({ param: { name: "reason", in: "query" } }),
          mode: z
            .enum(["soft", "hard"])
            .optional()
            .openapi({
              param: { name: "mode", in: "query" },
              description:
                "`soft` (default) closes the primitive's validity. `hard` physically deletes a fact — the same audited delete as DELETE /facts/{id}/hard, requiring memory:hard_delete; any other kind answers 400 `hard_delete_unsupported`. Neither is person-wide GDPR erasure.",
            }),
        }),
      },
      responses: {
        200: {
          description: "Primitive archived (or, with `mode=hard`, the fact deleted).",
          content: {
            "application/json": {
              schema: z
                .object({
                  forgotten: z.boolean(),
                  mode: z.literal("hard").optional(),
                  deleted: z.literal(true).optional(),
                  alreadyForgotten: z.literal(true).optional().openapi({
                    description:
                      "The primitive was already forgotten (or otherwise closed): nothing changed. A repeated forget succeeds.",
                  }),
                })
                .openapi("PrimitiveForgetResponse"),
            },
          },
        },
        400: {
          description:
            "Invalid kind or mode; `mode=hard` on a kind other than fact (code `hard_delete_unsupported`). Nothing was changed.",
        },
        401: { description: "Missing or invalid bearer token." },
        403: { description: "`mode=hard` without the memory:hard_delete scope." },
        404: { description: "Primitive not found." },
        409: {
          description:
            "kind 'event': events are an immutable log and cannot be forgotten (code `event_immutable`); `mode=hard`: the fact is mid-consolidation. Nothing was changed.",
        },
        501: { description: "`mode=hard`: the storage adapter cannot hard-delete." },
      },
    }),
    async (c) => {
      const { kind, id } = c.req.valid("param");
      const { reason, mode } = c.req.valid("query");

      if (mode === "hard") {
        if (kind !== "fact") {
          throw new HttpError(
            400,
            "hard_delete_unsupported",
            `mode=hard is supported only for facts (DELETE /forget/fact/{id}?mode=hard or DELETE /facts/{id}/hard); a ${kind} can only be forgotten (soft, without mode). Person-wide GDPR erasure is POST /admin/erasure.`,
            { kind, mode, supportedKinds: ["fact"] }
          );
        }
        // The caller's reason lands on the deletion-log row, capped like the
        // soft forget's audit reason (FORGET-2).
        await hardDeleteFactAudited(
          c,
          deps,
          id,
          `DELETE /forget/fact/:id?mode=hard${reason ? `: ${reason.slice(0, 200)}` : ""}`
        );
        return c.json({ forgotten: true, mode: "hard" as const, deleted: true as const }, 200);
      }
      const { workspaceId, scopes, maxSensitivity } = getAuthCtx(c);
      const provenance = resolveProvenance(c);

      const auth: import("@mnemo-ai/types").AuthContext = {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        userId: provenance.userId,
        // P112 — was `["memory:delete"]`, a fabricated scope list rather than the
        // caller's own.
        //
        // Not an authorization bypass: the scope-guard middleware gates this
        // route before the handler runs, and core forget is only ever called
        // in "soft" mode below (`mode=hard` takes the resource hard delete
        // above, never the core's person-wide erasure), so the one scope check
        // inside cognitive.forget() — `auth.scopes.includes("memory:hard_delete")`
        // for hard mode — is unreachable from here.
        //
        // Fabricating an auth context is the same class of defect as treating
        // apiKeyPrefix as an identity (S11): the value names no one, and any
        // decision taken from it is decided on a fiction.
        scopes: scopes as import("@mnemo-ai/types").AuthContext["scopes"],
        ...(maxSensitivity ? { maxSensitivity } : {}),
      };

      // Review round (PRIM-10): events are refused with 409, and that refusal
      // must not confirm an event this caller could not read — a missing id
      // is a 404, so a restricted one has to be too. Same check as
      // DELETE /events/:id, before the core is asked anything.
      if (kind === "event") {
        const event = deps.storage ? await deps.storage.getEvent(id, workspaceId) : null;
        if (!event) throw new NotFoundError(`${kind} ${id} not found`);
        assertCanReadFact(c, id, event.sensitivity, kind);
      }

      // APP-008: the same rule for every other kind. A row above the caller's
      // ceiling is a row the caller cannot see, so it cannot be forgotten either
      // and the answer is the 404 a missing id gets. Measured before this check:
      // a key with a `public` ceiling closed a `restricted` fact through this
      // route while DELETE /facts/:id correctly answered 404.
      if (kind !== "event" && deps.storage) {
        const hidden = await findHiddenFor(c, deps.storage, workspaceId, [id]);
        if (hidden.has(id)) throw new NotFoundError(`${kind} ${id} not found`);
      }

      // APP-062: forgetting is idempotent. A row of this workspace that is
      // already closed (forgotten, or superseded) is reported as such, without
      // a second forget: no second audit entry, no second vector_delete. A row
      // that does not exist still reaches core and gets its 404.
      if (kind !== "event" && kind !== "hyperedge" && deps.storage?.getRecallPrimitives) {
        const [row] = await deps.storage.getRecallPrimitives(workspaceId, [{ id, kind }]);
        if (row && (row.value as { validTo?: string | null }).validTo != null) {
          return c.json({ forgotten: true, alreadyForgotten: true as const }, 200);
        }
      }

      try {
        await (deps.circuitBreakers
          ? deps.circuitBreakers.storageWrite(() =>
              deps.cognitive.forget(
                id,
                kind as import("@mnemo-ai/types").PrimitiveKind,
                "soft",
                auth,
                reason
              )
            )
          : deps.cognitive.forget(
              id,
              kind as import("@mnemo-ai/types").PrimitiveKind,
              "soft",
              auth,
              reason
            ));

        // Forgetting an episode must not leave the conversation that produced it
        // replayable: the summary would be gone while the raw transcript stayed.
        // Best-effort and after the fact — the primitive is already forgotten, and
        // a transcript erasure that fails must not un-forget it. It retries on the
        // retention window, which erases the same rows anyway.
        if (kind === "episode" && deps.storage?.forgetManagedTranscriptForEpisode) {
          try {
            await deps.storage.forgetManagedTranscriptForEpisode({
              workspaceId,
              episodeId: id,
              actorId: auth.actorId,
            });
          } catch {
            /* retention still owns this transcript; nothing here is left claimed as erased */
          }
        }
      } catch (err) {
        // P74: core signals a missing primitive with a plain Error carrying
        // code "NOT_FOUND" — it cannot import the server's HttpError types
        // without breaking hexagonal purity. Translate it here into the 404
        // this route has always declared but never produced.
        if ((err as { code?: string } | null)?.code === "NOT_FOUND") {
          throw new NotFoundError(`${kind} ${id} not found`);
        }
        // PRIM-10: forgetting an event used to report success and change
        // nothing. It is refused instead (events are an immutable log).
        if ((err as { code?: string } | null)?.code === "EVENT_IMMUTABLE") {
          throw new HttpError(409, "event_immutable", (err as Error).message, { kind, id });
        }
        throw err;
      }

      return c.json({ forgotten: true }, 200);
    }
  );
}
