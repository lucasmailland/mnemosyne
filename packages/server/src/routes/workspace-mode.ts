/**
 * Workspace mode — learning/production graduation state (RDD-5).
 *
 *   GET /workspace-mode  → current mode record (learning defaults if unset)
 *   PUT /workspace-mode  → change mode and/or promote-at threshold
 *
 * Backed by StorageAdapter.getWorkspaceMode/setWorkspaceMode
 * (mnemosyne.mnemo_workspace_mode, migration 0009). The dashboard Config
 * page (spec §4.6) is the primary consumer; graduation itself keeps
 * running in core (graduation tick) regardless of this surface.
 *
 * Scope: GET falls under memory:read; PUT is gated to memory:admin via
 * getScopeForRequest — flipping mode changes extraction gates for the
 * whole workspace, so it is an admin-tier operation.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { ServerDeps } from "../deps.js";
import type { AuthVariables } from "../auth.js";
import { HttpError } from "../errors.js";
import { logger } from "../logging.js";

interface WorkspaceModeStorage {
  getWorkspaceMode?(workspaceId: string): Promise<{
    mode: "learning" | "production";
    sessionCount: number;
    promoteAt: number | null;
    startedAt?: Date;
    factCount?: number;
    entityCount?: number;
  } | null>;
  setWorkspaceMode?(
    workspaceId: string,
    patch: { mode?: "learning" | "production"; promoteAt?: number | null }
  ): Promise<void>;
}

const WorkspaceModeSchema = z
  .object({
    mode: z.enum(["learning", "production"]),
    sessionCount: z.number().int(),
    promoteAt: z.number().int().nullable(),
    startedAt: z.iso.datetime().nullable(),
    factCount: z.number().int(),
    entityCount: z.number().int(),
  })
  .openapi("WorkspaceMode");

const getModeRoute = createRoute({
  method: "get",
  path: "/workspace-mode",
  tags: ["workspace"],
  summary: "Current learning/production mode and graduation counters.",
  responses: {
    200: {
      description: "Mode record. Workspaces with no row yet report learning defaults.",
      content: { "application/json": { schema: WorkspaceModeSchema } },
    },
    401: { description: "Missing or invalid bearer token." },
    501: { description: "Storage adapter does not support workspace mode." },
  },
});

const putModeRoute = createRoute({
  method: "put",
  path: "/workspace-mode",
  tags: ["workspace"],
  summary: "Change workspace mode and/or the promote-at threshold.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              mode: z.enum(["learning", "production"]).optional(),
              promoteAt: z.number().int().min(1).max(100_000).nullable().optional(),
            })
            .refine((b) => b.mode !== undefined || b.promoteAt !== undefined, {
              message: "Provide mode and/or promoteAt",
            })
            .openapi("WorkspaceModePatch"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated mode record.",
      content: { "application/json": { schema: WorkspaceModeSchema } },
    },
    400: { description: "Empty patch." },
    401: { description: "Missing or invalid bearer token." },
    403: { description: "memory:admin scope required." },
    501: { description: "Storage adapter does not support workspace mode." },
  },
});

function toWire(
  record: Awaited<ReturnType<NonNullable<WorkspaceModeStorage["getWorkspaceMode"]>>>
) {
  if (!record) {
    // No row yet — the workspace behaves as learning-mode with defaults
    // (incrementWorkspaceModeCounters creates the row lazily on first write).
    return {
      mode: "learning" as const,
      sessionCount: 0,
      promoteAt: null,
      startedAt: null,
      factCount: 0,
      entityCount: 0,
    };
  }
  return {
    mode: record.mode,
    sessionCount: record.sessionCount,
    promoteAt: record.promoteAt,
    startedAt: record.startedAt ? record.startedAt.toISOString() : null,
    factCount: record.factCount ?? 0,
    entityCount: record.entityCount ?? 0,
  };
}

export function mountWorkspaceMode(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  const storage = deps.storage as WorkspaceModeStorage | undefined;

  app.openapi(getModeRoute, async (c) => {
    if (!storage?.getWorkspaceMode) {
      throw new HttpError(
        501,
        "not_implemented",
        "Storage adapter does not support workspace mode"
      );
    }
    const workspaceId = c.get("workspaceId");
    let record: Awaited<ReturnType<NonNullable<WorkspaceModeStorage["getWorkspaceMode"]>>> = null;
    try {
      record = await storage.getWorkspaceMode(workspaceId);
    } catch (err) {
      // 42P01 (undefined_table): the DB predates migration 0009. A read must
      // not 500 the Config page — report learning defaults and let the operator
      // run migrations. Writes (PUT) still surface the error loudly.
      if (String(err).includes("mnemo_workspace_mode") && String(err).includes("does not exist")) {
        logger.warn(
          { workspace_id: workspaceId },
          "workspace-mode: mnemo_workspace_mode table missing (run adapter-postgres migrations) — reporting learning defaults"
        );
      } else {
        throw err;
      }
    }
    return c.json(toWire(record), 200);
  });

  app.openapi(putModeRoute, async (c) => {
    if (!storage?.getWorkspaceMode || !storage.setWorkspaceMode) {
      throw new HttpError(
        501,
        "not_implemented",
        "Storage adapter does not support workspace mode"
      );
    }
    const body = c.req.valid("json");
    const workspaceId = c.get("workspaceId");
    await storage.setWorkspaceMode(workspaceId, {
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
      ...(body.promoteAt !== undefined ? { promoteAt: body.promoteAt } : {}),
    });
    const record = await storage.getWorkspaceMode(workspaceId);
    return c.json(toWire(record), 200);
  });
}
