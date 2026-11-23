import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { isoDateTimeInput } from "@mnemo-ai/types";

import type { ServerDeps } from "../deps.js";
import type { AuthVariables } from "../auth.js";
import { resolveCeiling } from "../rbac.js";

/**
 * GET /audit — Inspector "Undo log" feed.
 *
 * Synthesises a per-fact mutation log from two stable signals:
 *   - `mnemo_fact.status='forgotten'` rows (user-driven Forget,
 *     revertible via POST /facts/:id/restore).
 *   - `mnemo_fact_archive` rows (system-driven janitor merge/prune,
 *     NOT revertible).
 *
 * Newest first, capped by `limit`. The two sources never overlap —
 * archived facts are no longer in mnemo_fact — so the UNION ALL is
 * safe and dedupe-free.
 *
 * Identity scoping: read goes through `withMnemoTx(workspaceId, …)`
 * so `app.workspace_id` is set; the FORCE policies on `mnemo_fact`
 * and `mnemo_fact_archive` prevent cross-tenant leakage.
 *
 * Viewer+ surface — the undo log is read-only inspection. The
 * matching `POST /facts/:id/restore` carries the editor-tier gate.
 *
 * Response shape mirrors orchester's UndoClient `UndoResponse`
 * contract (items[], total, available) so the legacy route can
 * proxy the wire payload through without remapping fields.
 */

const AuditEntrySchema = z
  .object({
    id: z.string(),
    factId: z.string(),
    factStatement: z.string(),
    factSubject: z.string(),
    factKind: z.string(),
    action: z.literal("forgotten"),
    actorKind: z.enum(["user", "system"]),
    actorName: z.string().nullable(),
    timestamp: z.iso.datetime(),
    revertible: z.boolean(),
  })
  .openapi("AuditEntry");

const AuditResponseSchema = z
  .object({
    items: z.array(AuditEntrySchema),
    total: z.number().int(),
    available: z.literal(true),
  })
  .openapi("AuditResponse");

const AuditQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20).openapi({
      description: "Max entries. Server caps at 100.",
    }),
    actorKind: z.enum(["user", "system"]).optional().openapi({
      description: "Filter by actor: user (manual forgets) or system (janitor archives).",
    }),
    from: isoDateTimeInput().optional().openapi({
      description: "Only entries at or after this ISO 8601 instant.",
    }),
    to: isoDateTimeInput().optional().openapi({
      description: "Only entries at or before this ISO 8601 instant.",
    }),
    q: z.string().optional().openapi({
      description: "Substring match (case-insensitive) on fact statement or subject.",
    }),
  })
  .openapi("AuditQuery");

const auditRoute = createRoute({
  method: "get",
  path: "/audit",
  tags: ["audit"],
  summary: "Undo log feed — fact-mutation events (user forgets + system archives).",
  request: { query: AuditQuerySchema },
  responses: {
    200: {
      description: "Newest-first entries.",
      content: { "application/json": { schema: AuditResponseSchema } },
    },
    400: { description: "Invalid limit." },
    401: { description: "Missing or invalid bearer token." },
  },
});

export function mountAudit(app: OpenAPIHono<{ Variables: AuthVariables }>, deps: ServerDeps): void {
  app.openapi(auditRoute, async (c) => {
    const { limit, actorKind, from, to, q } = c.req.valid("query");
    const workspaceId = c.get("workspaceId");
    // flatten-legacy-dual-core PR6: ported off the legacy core's audit() onto the v3
    // StorageAdapter port (packages/types/src/ports.ts's getAuditFeed) — same
    // UNION ALL query, now implemented in adapter-postgres's FactRepository.
    // Tier B (audit-feed-tier-b.integration.test.ts) proves byte-identical
    // output against the legacy implementation before this swap.
    if (!deps.storage) {
      throw new Error("[audit] deps.storage is required — no storage adapter wired.");
    }
    const items = await deps.storage.getAuditFeed({
      workspaceId,
      limit,
      // The feed carries each fact's statement: a fact above the caller's
      // ceiling is not in it.
      maxSensitivity: resolveCeiling(c),
      ...(actorKind ? { actorKind } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(q ? { q } : {}),
    });
    return c.json(
      {
        items,
        total: items.length,
        // `available:true` always — when the upstream fails the
        // global error handler turns it into a 5xx, not a degraded
        // payload. The legacy orchester surface used `available:false`
        // for the graceful-degrade case; mode picks that up downstream.
        available: true as const,
      },
      200
    );
  });
}
