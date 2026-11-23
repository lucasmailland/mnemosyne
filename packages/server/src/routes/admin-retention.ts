import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { GLOBAL_SENTINEL_ID } from "../config/WorkspaceConfigStore.js";
import { handlePutRetentionConfig, RetentionConfigBodySchema } from "./workspace-config.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";

/**
 * PUT/GET/DELETE /admin/config/retention — global retention window
 * configuration.
 *
 * Relocated verbatim from `admin.ts` (docs/archive/openspec/decompose-admin-routes) — pure
 * file-level split, no schema, path, or handler-logic change. Operates on
 * `GLOBAL_SENTINEL_ID` via the same shared `handlePutRetentionConfig` handler
 * `workspace-config.ts`'s per-workspace self-service variant also uses.
 */

// ─── Zod schemas ────────────────────────────────────────────────────────────

const AdminRetentionConfigReadSchema = z
  .object({
    internalDays: z.number().int(),
    confidentialDays: z.number().int(),
    restrictedDays: z.number().int(),
    transcriptDays: z.number().int(),
    source: z.enum(["workspace", "global", "env"]),
  })
  .openapi("AdminRetentionConfigRead");

// ─── Route definitions ──────────────────────────────────────────────────────

const putAdminRetentionConfig = createRoute({
  method: "put",
  path: "/admin/config/retention",
  tags: ["admin"],
  summary:
    "Set global retention window config (applies to all workspaces without workspace-level override).",
  request: {
    body: {
      content: { "application/json": { schema: RetentionConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Global retention config stored.",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
    400: { description: "Validation error — day value out of range." },
    501: { description: "Encryption not configured." },
  },
});

const getAdminRetentionConfig = createRoute({
  method: "get",
  path: "/admin/config/retention",
  tags: ["admin"],
  summary: "Read global retention window config (falls back to env defaults when no sentinel row).",
  responses: {
    200: {
      description: "Global retention config.",
      content: { "application/json": { schema: AdminRetentionConfigReadSchema } },
    },
  },
});

const deleteAdminRetentionConfig = createRoute({
  method: "delete",
  path: "/admin/config/retention",
  tags: ["admin"],
  summary: "Remove global retention window override (all workspaces fall back to env defaults).",
  responses: {
    204: { description: "Global retention config removed." },
    404: { description: "No global retention config row exists." },
    501: { description: "Encryption not configured." },
  },
});

// ─── Mount ───────────────────────────────────────────────────────────────────

export function mountAdminRetention(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // PUT /admin/config/retention — set global retention config (scope: admin:workspace)
  app.openapi(putAdminRetentionConfig, async (c) => {
    const body = c.req.valid("json");
    const result = await handlePutRetentionConfig(GLOBAL_SENTINEL_ID, body, deps);

    if (result.status === 200) {
      const provenance = resolveProvenance(c);
      await emitAudit(deps, {
        workspaceId: c.get("workspaceId"),
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        action: "admin_access",
        resourceKind: "admin_config",
        resourceId: "retention",
        isTerminal: false,
        detail: {
          ...(provenance.userId ? { userId: provenance.userId } : {}),
          route: "/admin/config/retention",
          method: "PUT",
          target: "global",
        },
      });
    }

    return c.json(result.body, result.status as 200 | 400 | 501);
  });

  // GET /admin/config/retention — read global retention config
  app.openapi(getAdminRetentionConfig, async (c) => {
    if (!deps.retentionConfigResolver) {
      // No resolver — fall back to env vars
      const { parseRetentionConfig } = await import("../cron/retention-purge.js");
      const env = parseRetentionConfig(process.env);
      return c.json(
        {
          internalDays: env.internalDays,
          confidentialDays: env.confidentialDays,
          restrictedDays: env.restrictedDays,
          transcriptDays: env.transcriptDays,
          source: "env" as const,
        },
        200
      );
    }

    const resolved = await deps.retentionConfigResolver.resolve(GLOBAL_SENTINEL_ID);
    // When resolve() is called with GLOBAL_SENTINEL_ID it returns source="workspace"
    // if data exists at that ID (it treats it as tier-1 workspace data). Remap to
    // "global" for the admin view so callers can distinguish global-sentinel from
    // per-workspace overrides.
    const source = resolved.source === "workspace" ? "global" : resolved.source;
    return c.json(
      {
        internalDays: resolved.internalDays,
        confidentialDays: resolved.confidentialDays,
        restrictedDays: resolved.restrictedDays,
        transcriptDays: resolved.transcriptDays,
        source,
      },
      200
    );
  });

  // DELETE /admin/config/retention — remove global retention config
  app.openapi(deleteAdminRetentionConfig, async (c) => {
    if (!deps.workspaceConfigStore || !deps.retentionConfigResolver) {
      return c.json(
        { code: "ENCRYPTION_REQUIRED", message: "MNEMO_MASTER_KEY is not configured." },
        501 as never
      );
    }

    // Check if any global retention row exists
    const existing = await deps.workspaceConfigStore.get(
      GLOBAL_SENTINEL_ID,
      "retention_internal_days"
    );
    if (!existing) {
      return c.json({ code: "NOT_FOUND" }, 404 as never);
    }

    // Delete all 3 retention keys under the global sentinel
    await Promise.all([
      deps.workspaceConfigStore.delete(GLOBAL_SENTINEL_ID, "retention_internal_days"),
      deps.workspaceConfigStore.delete(GLOBAL_SENTINEL_ID, "retention_confidential_days"),
      deps.workspaceConfigStore.delete(GLOBAL_SENTINEL_ID, "retention_restricted_days"),
      deps.workspaceConfigStore.delete(GLOBAL_SENTINEL_ID, "retention_transcript_days"),
    ]);

    // Invalidate cache for the sentinel
    deps.retentionConfigResolver.invalidate(GLOBAL_SENTINEL_ID);

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId: c.get("workspaceId"),
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "admin_access",
      resourceKind: "admin_config",
      resourceId: "retention",
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        route: "/admin/config/retention",
        method: "DELETE",
        target: "global",
      },
    });

    return new Response(null, { status: 204 });
  });
}
