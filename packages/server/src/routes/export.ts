import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createGzip } from "node:zlib";

import type { ServerDeps } from "../deps.js";
import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import { HttpError, ServiceUnavailableError } from "../errors.js";
import { resolveProvenance } from "../provenance.js";
import { resolveCeiling } from "../rbac.js";
import { emitAudit } from "../audit-emit.js";
import { approvalTarget } from "../middleware/rbac-policy.js";
import {
  exportWorkspace as exportWorkspaceV3,
  exportRelations,
  exportCitations,
} from "@mnemo-ai/core/cognitive";

// ─── JSONL Export constants ────────────────────────────────────────────────────
export const JSONL_FORMAT_VERSION = "mnemo-export-v1";

export interface ExportHeaderInput {
  workspaceId: string;
  exportedAt: string;
  region: string;
  factCount: number;
  entityCount: number;
  totalLines: number;
}

/** Build the versioned first line of a JSONL export. Pure. */
export function buildExportHeader(i: ExportHeaderInput): Record<string, unknown> {
  return {
    _type: "header",
    version: JSONL_FORMAT_VERSION,
    schemaVersion: JSONL_FORMAT_VERSION,
    workspaceId: i.workspaceId,
    exportedAt: i.exportedAt,
    region: i.region,
    factCount: i.factCount,
    entityCount: i.entityCount,
    totalLines: i.totalLines,
    embeddingsExcluded: true,
  };
}

/**
 * GET /export — full JSON dump of a workspace's Mnemosyne memory.
 *
 * Wave X2.4: Requires `memory:export` scope + approval gate.
 *
 * Approval flow:
 *   1. No `approvalRequestId` query param → create a pending approval request
 *      with trigger "bulk_export" and return 202. The client must wait for the
 *      request to be approved (via POST /approvals/:id/resolve) then retry
 *      with ?approvalRequestId=<id>.
 *   2. `approvalRequestId` present → look it up, verify:
 *        - status === "approved"
 *        - workspaceId matches the caller's workspace
 *        - expiresAt is in the future
 *        - trigger is "bulk_export" and the caller is the user who asked
 *      then spend it (ApprovalStore.consume): one approval is one export, of
 *      the same method and path it was raised on. On fail: return 403.
 *
 * When no `ApprovalStore` is wired (deps.approvals === undefined) the gate
 * is skipped and the export proceeds immediately (backward-compatible for
 * deployments without the approval infrastructure).
 *
 * Returns the four mnemo_* tables (facts, decisions, relations, citations)
 * in a single buffered response. Embedding vectors are EXCLUDED.
 *
 * flatten-legacy-dual-core PR9h (design.md D6.5 "Export — no new port
 * method at all"): the legacy core client's `exportWorkspace` (four raw SQL
 * `SELECT`s, factory.ts) is replaced by the pure-core `exportWorkspace`
 * projection (`@mnemo-ai/core/cognitive`), composed from
 * `deps.storage.{queryFactsPage,queryDecisions,getRelations,listCitations}`
 * — see `packages/core/src/cognitive/export/workspace-export.ts` for the
 * `toLegacyExportRow()`-style snake_case projections that reproduce the
 * legacy wire row shape field-for-field. Identity scoping: each resource is
 * RLS-scoped via its own adapter-level transaction (`mnemo_set_workspace`),
 * same as every other `deps.storage` read.
 */

const ExportMetaSchema = z
  .object({
    workspaceId: z.string(),
    exportedAt: z.iso.datetime(),
    rowCapPerResource: z.number().int(),
    embeddingsExcluded: z.literal(true),
  })
  .openapi("ExportMeta");

const ExportResponseSchema = z
  .object({
    meta: ExportMetaSchema,
    facts: z.array(z.record(z.string(), z.unknown())),
    decisions: z.array(z.record(z.string(), z.unknown())),
    relations: z.array(z.record(z.string(), z.unknown())),
    citations: z.array(z.record(z.string(), z.unknown())),
  })
  .openapi("ExportResponse");

const ApprovalPendingSchema = z
  .object({
    status: z.literal("pending"),
    approvalRequestId: z.string(),
    message: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .openapi("ExportApprovalPending");

const exportQuerySchema = z.object({
  approvalRequestId: z.string().optional(),
});

/**
 * POST /export body schema — all fields optional.
 * `types` (a per-type filter) is not implemented: the export always carries
 * every type, so a body that sends it is rejected with 400 instead of being
 * silently ignored (R-19).
 * TODO(V9): implement the types filter + async 202 jobId, then accept it here.
 */
const exportBodySchema = z
  .object({
    format: z.string().optional(),
    includeEmbeddings: z.boolean().optional(),
  })
  .passthrough()
  .refine((body) => !("types" in body), {
    message: "types is not supported yet: POST /export always returns every type",
    path: ["types"],
  })
  .optional()
  .openapi("ExportBody");

const exportRoute = createRoute({
  method: "get",
  path: "/export",
  tags: ["export"],
  summary: "Full workspace memory dump (facts/decisions/relations/citations).",
  request: {
    query: exportQuerySchema,
  },
  responses: {
    200: {
      description: "Buffered JSON dump. v1.4 switches to streaming.",
      content: { "application/json": { schema: ExportResponseSchema } },
    },
    202: {
      description: "Approval request created — retry with ?approvalRequestId=<id> once approved.",
      content: { "application/json": { schema: ApprovalPendingSchema } },
    },
    401: { description: "Missing or invalid bearer token." },
    403: { description: "Insufficient scope (requires memory:export) or approval denied/expired." },
  },
});

/**
 * POST /export — same scope gate + approval flow as GET /export.
 * Accepts an optional body (format, includeEmbeddings) for future use; a body
 * with `types` gets 400 until the filter exists. Returns synchronous 200 for now.
 * TODO(V9): apply types filter + async 202 jobId
 */
const exportPostRoute = createRoute({
  method: "post",
  path: "/export",
  tags: ["export"],
  summary: "Full workspace memory dump (POST variant — body reserved for V9 async/filter options).",
  request: {
    query: exportQuerySchema,
    body: {
      content: { "application/json": { schema: exportBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Buffered JSON dump. v1.4 switches to streaming.",
      content: { "application/json": { schema: ExportResponseSchema } },
    },
    202: {
      description: "Approval request created — retry with ?approvalRequestId=<id> once approved.",
      content: { "application/json": { schema: ApprovalPendingSchema } },
    },
    401: { description: "Missing or invalid bearer token." },
    403: { description: "Insufficient scope (requires memory:export) or approval denied/expired." },
  },
});

const ROW_CAP_PER_RESOURCE = 100_000;

// Approval window: 24 hours from now
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Validate the approval gate for export handlers.
 *
 * Returns null when the gate is not wired (deps.approvals absent) or when the
 * approval is valid and the handler should proceed to the export.
 *
 * Returns a pending-approval object when no approvalRequestId was supplied and
 * a new pending request was created — the caller should emit a 202 response.
 *
 * Throws HttpError(403) on any validation failure (not found, workspace
 * mismatch, not approved, expired).
 */
/**
 * What an export approval covers (re-audit 2, item 5): the route, its query
 * (minus the approval id itself) and, for POST, the options that widen the
 * export. An approval for a narrow export cannot be spent on a broader one.
 */
function exportTarget(
  url: string,
  body?: { format?: string; includeEmbeddings?: boolean }
): string {
  const u = new URL(url);
  u.searchParams.delete("approvalRequestId");
  const target = approvalTarget(u.toString());
  if (!body) return target;
  return `${target}#${JSON.stringify({
    format: body.format ?? null,
    includeEmbeddings: body.includeEmbeddings === true,
  })}`;
}

async function checkApprovalGate(
  deps: ServerDeps,
  workspaceId: string,
  // Must be userId, not actorId: /approvals/:id/resolve compares requestedBy
  // against the resolver's userId (see routes/approvals.ts) — an actorId here
  // would make the self-approval guard permanently blind.
  userId: string | null | undefined,
  approvalRequestId: string | undefined,
  // The request the approval is raised on and spent by (S1, re-audit 2026-11-22).
  target: { method: string; path: string }
): Promise<{ approvalRequestId: string; message: string; expiresAt: string } | null> {
  if (!deps.approvals) {
    // No ApprovalStore wired — gate is disabled; proceed immediately.
    return null;
  }

  if (!userId) {
    throw new HttpError(
      403,
      "user_binding_required",
      "This action requires approval, which requires a user-bound key"
    );
  }

  if (!approvalRequestId) {
    // No approval ID → create a pending request and signal a 202 response.
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
    const request = await deps.approvals.create({
      workspaceId,
      requestedBy: userId,
      trigger: "bulk_export",
      resource: "workspace",
      resourceId: workspaceId,
      payload: { requestedAt: new Date().toISOString(), ...target },
      expiresAt,
    });
    return {
      approvalRequestId: request.id,
      message:
        "Bulk export requires approval. Retry with ?approvalRequestId=" +
        request.id +
        " once the request is approved.",
      expiresAt: expiresAt.toISOString(),
    };
  }

  // Approval ID provided → look it up and validate.
  const approvalRequest = await deps.approvals.get(workspaceId, approvalRequestId);
  if (!approvalRequest) {
    throw new HttpError(403, "approval_not_found", "Approval request not found", {
      approvalRequestId,
    });
  }
  if (approvalRequest.workspaceId !== workspaceId) {
    throw new HttpError(
      403,
      "approval_workspace_mismatch",
      "Approval request belongs to a different workspace"
    );
  }
  if (approvalRequest.status !== "approved") {
    throw new HttpError(403, "approval_not_approved", "Approval request has not been approved", {
      status: approvalRequest.status,
    });
  }
  if (approvalRequest.expiresAt < new Date()) {
    throw new HttpError(403, "approval_expired", "Approval request has expired");
  }
  // S1 (re-audit 2026-11-22): any approved approval of the workspace used to
  // pass, for any trigger, by anyone, any number of times.
  if (approvalRequest.trigger !== "bulk_export") {
    throw new HttpError(
      403,
      "approval_wrong_trigger",
      "This approval was not granted for a bulk export"
    );
  }
  if (approvalRequest.requestedBy !== userId) {
    throw new HttpError(
      403,
      "approval_wrong_requester",
      "This approval was requested by another user; only they can use it"
    );
  }
  const spent = await deps.approvals.consume(workspaceId, approvalRequestId, {
    requestedBy: userId,
    ...target,
  });
  if (!spent) {
    throw new HttpError(
      403,
      "approval_not_covering",
      "this approval does not cover this request: it was already used, has expired, or was granted for another request or user"
    );
  }
  return null;
}

export function mountExport(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(exportRoute, async (c) => {
    const { workspaceId, scopes, userId } = getAuthCtx(c);

    // Scope gate: require memory:export
    if (!scopes?.includes("memory:export")) {
      throw new HttpError(403, "INSUFFICIENT_SCOPE", "Insufficient scope", {
        required: "memory:export",
      });
    }

    // Approval gate (only when ApprovalStore is wired)
    const { approvalRequestId } = c.req.valid("query");
    const pending = await checkApprovalGate(deps, workspaceId, userId, approvalRequestId, {
      method: c.req.method,
      path: exportTarget(c.req.url),
    });
    if (pending) {
      return c.json({ status: "pending" as const, ...pending }, 202);
    }

    if (!deps.storage) {
      throw new ServiceUnavailableError("Storage adapter not available");
    }
    const payload = await exportWorkspaceV3(
      { storage: deps.storage },
      workspaceId,
      resolveCeiling(c)
    );

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "export",
      resourceKind: "workspace",
      resourceId: workspaceId,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        format: "json",
        ...(approvalRequestId ? { approvalRequestId } : {}),
        rowCapPerResource: ROW_CAP_PER_RESOURCE,
      },
    });

    return c.json(
      {
        meta: {
          workspaceId,
          exportedAt: new Date().toISOString(),
          rowCapPerResource: ROW_CAP_PER_RESOURCE,
          embeddingsExcluded: true as const,
        },
        ...payload,
      },
      200
    );
  });

  // POST /export — same scope gate + approval flow as GET /export.
  // Body (format, includeEmbeddings) is accepted but reserved for future use;
  // `types` is rejected with 400 by exportBodySchema until the filter exists.
  // TODO(V9): apply types filter + async 202 jobId
  app.openapi(exportPostRoute, async (c) => {
    const { workspaceId, scopes, userId } = getAuthCtx(c);

    // Scope gate: require memory:export
    if (!scopes?.includes("memory:export")) {
      throw new HttpError(403, "INSUFFICIENT_SCOPE", "Insufficient scope", {
        required: "memory:export",
      });
    }

    // Approval gate (only when ApprovalStore is wired)
    const { approvalRequestId } = c.req.valid("query");
    const pending = await checkApprovalGate(deps, workspaceId, userId, approvalRequestId, {
      method: c.req.method,
      path: exportTarget(
        c.req.url,
        (c.req.valid("json") ?? {}) as { format?: string; includeEmbeddings?: boolean }
      ),
    });
    if (pending) {
      return c.json({ status: "pending" as const, ...pending }, 202);
    }

    if (!deps.storage) {
      throw new ServiceUnavailableError("Storage adapter not available");
    }
    const payload = await exportWorkspaceV3(
      { storage: deps.storage },
      workspaceId,
      resolveCeiling(c)
    );

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "export",
      resourceKind: "workspace",
      resourceId: workspaceId,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        format: "json",
        ...(approvalRequestId ? { approvalRequestId } : {}),
        rowCapPerResource: ROW_CAP_PER_RESOURCE,
      },
    });

    return c.json(
      {
        meta: {
          workspaceId,
          exportedAt: new Date().toISOString(),
          rowCapPerResource: ROW_CAP_PER_RESOURCE,
          embeddingsExcluded: true as const,
        },
        ...payload,
      },
      200
    );
  });

  // ── GET /export/jsonl — Wave V §29 gzip JSONL export (all 11 entity types)
  app.openapi(
    createRoute({
      method: "get",
      path: "/export/jsonl",
      tags: ["export"],
      summary:
        "Full workspace export as gzip JSONL. First line is a versioned header, each subsequent line is a JSON entity record with a `_type` discriminator field.",
      request: { query: exportQuerySchema },
      responses: {
        200: {
          description:
            "Gzip-compressed JSONL file. Content-Type: application/x-ndjson. Content-Encoding: gzip.",
          content: { "application/x-ndjson": { schema: z.string() } },
        },
        202: {
          description: "Approval required.",
          content: { "application/json": { schema: ApprovalPendingSchema } },
        },
        401: { description: "Unauthorized." },
        403: { description: "Insufficient scope or approval denied." },
      },
    }),
    async (c) => {
      const { workspaceId, scopes, userId } = getAuthCtx(c);

      if (!scopes?.includes("memory:export")) {
        throw new HttpError(403, "INSUFFICIENT_SCOPE", "Insufficient scope", {
          required: "memory:export",
        });
      }

      // Approval gate (reuse same flow as GET/POST /export)
      const { approvalRequestId } = c.req.valid("query");
      const pending = await checkApprovalGate(deps, workspaceId, userId, approvalRequestId, {
        method: c.req.method,
        path: exportTarget(c.req.url),
      });
      if (pending) {
        return c.json({ status: "pending" as const, ...pending }, 202);
      }

      if (!deps.storage) {
        throw new ServiceUnavailableError("Storage adapter not available");
      }

      // Collect all 11 entity types into a single JSONL buffer
      const lines: string[] = [];
      const exportedAt = new Date().toISOString();

      async function dumpEntities(type: string, items: unknown[]): Promise<void> {
        for (const item of items) {
          lines.push(JSON.stringify({ _type: type, ...(item as Record<string, unknown>) }));
        }
      }

      // 1. facts
      // Facts above the caller's ceiling stay out: reads hand back the decrypted
      // text of confidential+ facts, and an export is a read like any other.
      const factsPage = await deps.storage.queryFacts({
        workspaceId,
        limit: ROW_CAP_PER_RESOURCE,
        maxSensitivity: resolveCeiling(c),
      });
      await dumpEntities("fact", factsPage.items);

      // 2. decisions (spec core type)
      const decisionsPage = await deps.storage.queryDecisions({
        workspaceId,
        limit: ROW_CAP_PER_RESOURCE,
      });
      await dumpEntities("decision", decisionsPage.items);

      // 3. episodes
      const episodesPage = await deps.storage.queryEpisodes({
        workspaceId,
        limit: ROW_CAP_PER_RESOURCE,
      });
      await dumpEntities("episode", episodesPage.items);

      // 4. entities (spec core type)
      const entitiesPage = await deps.storage.queryEntities({
        workspaceId,
        limit: ROW_CAP_PER_RESOURCE,
      });
      await dumpEntities("entity", entitiesPage.items);

      // 5. strategies (spec core type)
      const strategiesPage = await deps.storage.queryStrategies({
        workspaceId,
        limit: ROW_CAP_PER_RESOURCE,
      });
      await dumpEntities("strategy", strategiesPage.items);

      // 6. workflows (spec core type)
      const workflowsPage = await deps.storage.queryWorkflows({
        workspaceId,
        limit: ROW_CAP_PER_RESOURCE,
      });
      await dumpEntities("workflow", workflowsPage.items);

      // 7. skills
      const skillsPage = await deps.storage.querySkills({
        workspaceId,
        limit: ROW_CAP_PER_RESOURCE,
      });
      await dumpEntities("skill", skillsPage.items);

      // 8. tasks
      const tasksPage = await deps.storage.queryTasks({ workspaceId, limit: ROW_CAP_PER_RESOURCE });
      await dumpEntities("task", tasksPage.items);

      // 9. events
      const eventsPage = await deps.storage.queryEvents({
        workspaceId,
        limit: ROW_CAP_PER_RESOURCE,
      });
      await dumpEntities("event", eventsPage.items);

      // 10. reasoning chains
      const reasoningPage = await deps.storage.queryReasoning({
        workspaceId,
        limit: ROW_CAP_PER_RESOURCE,
      });
      await dumpEntities("reasoning", reasoningPage.items);

      // 11. hyperedges
      const hyperedgesPage = await deps.storage.queryHyperedges({
        workspaceId,
        limit: ROW_CAP_PER_RESOURCE,
      });
      await dumpEntities("hyperedge", hyperedgesPage.items);

      // 12. webhook endpoints (operational — leave as-is)
      const webhooks = await deps.storage.listWebhookEndpoints(workspaceId);
      await dumpEntities(
        "webhook_endpoint",
        webhooks.map((w) => ({ ...w, secretHash: "[REDACTED]" }))
      );

      // 13. reminders (operational — leave as-is)
      const reminders = await deps.storage.listReminders(workspaceId, "all", ROW_CAP_PER_RESOURCE);
      await dumpEntities("reminder", reminders);

      // 16-17. managed sessions and the transcripts that still survive retention.
      // Split on purpose: metadata outlives the words, so an export of a session
      // whose transcript was already erased carries the session and no content.
      if (deps.storage.exportManagedSessions) {
        await dumpEntities(
          "managed_session",
          await deps.storage.exportManagedSessions({ workspaceId, limit: ROW_CAP_PER_RESOURCE })
        );
      }
      if (deps.storage.exportManagedTranscripts) {
        await dumpEntities(
          "managed_transcript",
          await deps.storage.exportManagedTranscripts({ workspaceId, limit: ROW_CAP_PER_RESOURCE })
        );
      }

      // 14-15. relations + citations — flatten-legacy-dual-core PR9h port:
      // previously fetched together via the legacy core client's
      // `exportWorkspace` (a single consistent-tx snapshot); now composed from the pure-core
      // `exportRelations`/`exportCitations` projections (same
      // `@mnemo-ai/core/cognitive` module GET/POST /export use above), each
      // its own `deps.storage` read — no shared transaction across the two,
      // matching every other per-type read in this handler.
      const [relations, citations] = await Promise.all([
        exportRelations({ storage: deps.storage }, workspaceId),
        exportCitations({ storage: deps.storage }, workspaceId),
      ]);
      await dumpEntities("relation", relations);
      await dumpEntities("citation", citations);

      // Prepend versioned header now that entity counts are known
      // The workspace's home region (region lock, app.ts); the instance's for a
      // workspace created without one.
      const region = c.get("workspaceRegion") || process.env["MNEMO_REGION"] || "unknown";
      const factCount = factsPage.items.length;
      const entityCount = lines.length;
      const totalLines = entityCount + 1; // +1 for the header itself
      lines.unshift(
        JSON.stringify(
          buildExportHeader({ workspaceId, exportedAt, region, factCount, entityCount, totalLines })
        )
      );

      // Gzip the JSONL and stream it back
      const plainBuffer = Buffer.from(lines.join("\n") + "\n", "utf8");
      const gzip = createGzip({ level: 6 });
      const chunks: Buffer[] = [];
      gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
      await new Promise<void>((resolve, reject) => {
        gzip.on("end", resolve);
        gzip.on("error", reject);
        gzip.end(plainBuffer);
      });
      const compressed = Buffer.concat(chunks);

      const provenance = resolveProvenance(c);
      await emitAudit(deps, {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        action: "export",
        resourceKind: "workspace",
        resourceId: workspaceId,
        isTerminal: false,
        detail: {
          ...(provenance.userId ? { userId: provenance.userId } : {}),
          format: "jsonl",
          ...(approvalRequestId ? { approvalRequestId } : {}),
          rowCapPerResource: ROW_CAP_PER_RESOURCE,
        },
      });

      return c.body(compressed as unknown as string, 200, {
        "Content-Type": "application/x-ndjson",
        "Content-Encoding": "gzip",
        "Content-Disposition": `attachment; filename="mnemosyne-export-${workspaceId}-${Date.now()}.jsonl.gz"`,
      });
    }
  );
}
