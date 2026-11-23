import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";

/**
 * POST /admin/embedding-migrations — trigger or dry-run an embedding-model
 * migration across workspace primitives.
 *
 * Relocated verbatim from `admin.ts` (docs/archive/openspec/decompose-admin-routes) — pure
 * file-level split, no schema, path, or handler-logic change.
 */

// ─── Zod schemas ────────────────────────────────────────────────────────────

const CreateEmbeddingMigrationBodySchema = z
  .object({
    workspaceId: z.guid().optional(),
    targetModel: z.string().min(1),
    dryRun: z.boolean().optional().default(false),
  })
  .openapi("CreateEmbeddingMigrationBody");

const EmbeddingMigrationResponseSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    targetModel: z.string(),
    status: z.enum(["building", "active", "dormant", "stale", "superseded", "failed"]),
    dryRun: z.boolean(),
    totalPrimitives: z.number().int(),
    migratedCount: z.number().int(),
    errorCount: z.number().int(),
    createdAt: z.iso.datetime(),
  })
  .openapi("EmbeddingMigrationResponse");

// ─── Route definitions ──────────────────────────────────────────────────────

const postEmbeddingMigration = createRoute({
  method: "post",
  path: "/admin/embedding-migrations",
  tags: ["admin"],
  summary: "Trigger or dry-run an embedding model migration across workspace primitives.",
  request: {
    body: {
      content: { "application/json": { schema: CreateEmbeddingMigrationBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Migration initiated or dry-run completed.",
      content: { "application/json": { schema: EmbeddingMigrationResponseSchema } },
    },
    400: { description: "Invalid parameters." },
  },
});

// ─── Mount ───────────────────────────────────────────────────────────────────

export function mountAdminEmbeddingMigrations(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // POST /admin/embedding-migrations — trigger or dry-run embedding migration
  app.openapi(postEmbeddingMigration, async (c) => {
    const body = c.req.valid("json");
    const workspaceId = body.workspaceId ?? c.get("workspaceId");
    const migrationId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // D5: admin_access, mutating-only. Partition on the CALLER's real
    // workspace (c.get("workspaceId")) — never GLOBAL_SENTINEL_ID and never
    // the migration's *target* workspaceId (which body.workspaceId can set
    // to a different real workspace than the caller's own). Every response
    // branch below (degraded/dryRun/real) is a completed invocation of this
    // mutating endpoint, so the emission is unconditional here.
    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId: c.get("workspaceId"),
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "admin_access",
      resourceKind: "admin_config",
      resourceId: migrationId,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        route: "/admin/embedding-migrations",
        method: "POST",
        target: "global",
      },
    });

    if (!deps.storage || !deps.llm) {
      return c.json(
        {
          id: migrationId,
          workspaceId,
          targetModel: body.targetModel,
          status: "building" as const,
          dryRun: body.dryRun,
          totalPrimitives: 0,
          migratedCount: 0,
          errorCount: 0,
          createdAt,
        },
        200
      );
    }

    const { detectStale, migrateWorkspace } = await import("@mnemo-ai/core");
    // SECURITY.md §7: under `none` this run never lists confidential+ rows. It
    // embeds with deps.llm, whose locality is not tracked: treated as external.
    const sensitiveTextToEmbedder = deps.sensitiveTextToProviders !== "none";
    const staleResult = await detectStale(deps.storage as any, workspaceId, body.targetModel, {
      sensitiveTextToEmbedder,
    });

    if (body.dryRun) {
      return c.json(
        {
          id: migrationId,
          workspaceId,
          targetModel: body.targetModel,
          status: "building" as const,
          dryRun: true,
          totalPrimitives: staleResult.total,
          migratedCount: 0,
          errorCount: 0,
          createdAt,
        },
        200
      );
    }

    const embedAdapter = {
      model: body.targetModel,
      async embed(texts: string[]) {
        return Promise.all(
          texts.map(async (t) => {
            const vec = await deps.llm!.embed(t, body.targetModel);
            return new Float32Array(vec);
          })
        );
      },
    };

    const migrationResult = await migrateWorkspace({
      storage: deps.storage as any,
      embed: embedAdapter,
      workspaceId,
      sensitiveTextToEmbedder,
    });

    return c.json(
      {
        id: migrationId,
        workspaceId,
        targetModel: body.targetModel,
        status: migrationResult.errors.length === 0 ? ("active" as const) : ("failed" as const),
        dryRun: false,
        totalPrimitives: staleResult.total,
        migratedCount: migrationResult.migrated,
        errorCount: migrationResult.errors.length,
        createdAt,
      },
      200
    );
  });
}
