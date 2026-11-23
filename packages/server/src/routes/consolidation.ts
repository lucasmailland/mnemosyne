import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { HttpError } from "../errors.js";
import { logger } from "../logging.js";
import { consolidationTotal } from "../metrics/index.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";

/**
 * POST /consolidation/trigger
 *
 * Manually fires a single consolidation tick for the caller's workspace.
 * The background scheduler already runs on its own 60-second interval
 * (wired in server/src/index.ts). This endpoint exists so the MCP
 * `memory_consolidate` tool and operators can force a pass on demand.
 *
 * Fast mode delegates to `runConsolidationTick` from
 * `@mnemo-ai/consolidation` — the same function the scheduler calls each
 * tick, constrained to the caller's workspace ID and its bounded low-worth
 * candidate set. It does not reweight or reindex the entire graph. Manual deep
 * mode and dry-run are reserved inputs that return 422 until dedicated
 * implementations exist.
 *
 * When `@mnemo-ai/consolidation` or `@mnemo-ai/adapter-postgres` are not
 * installed the route returns 503 with a clear error body rather than
 * crashing the server — lightweight deploys can omit these peer deps.
 */

const TriggerConsolidationRequest = z
  .object({
    mode: z
      .enum(["fast", "deep"])
      .optional()
      .default("fast")
      .openapi({
        description:
          "`fast` (default): processes a bounded low-worth candidate set; it does not " +
          "reweight or reindex the entire graph. " +
          "`deep`: currently unsupported and returns HTTP 422.",
      }),
    dryRun: z.boolean().optional().default(false).openapi({
      description:
        "Reserved for compatibility. `true` is currently unsupported and returns HTTP 422.",
    }),
  })
  .openapi("TriggerConsolidationRequest");

const TriggerConsolidationResponse = z
  .object({
    accepted: z.boolean(),
    workspaceId: z.string(),
    mode: z.literal("fast"),
    dryRun: z.literal(false),
    /** Gate-passed pairs merged this tick. */
    mergedPairs: z.number().int(),
    /** Gate-failed or ineligible pairs skipped. */
    skippedPairs: z.number().int(),
    /** Total candidate facts fetched and inspected. */
    candidatesProcessed: z.number().int(),
    /** Number of errors encountered (non-fatal per-fact errors). */
    errors: z.number().int(),
    tookMs: z.number(),
  })
  .openapi("TriggerConsolidationResponse");

export function assertSupportedConsolidationRequest(input: unknown): void {
  const parsed = TriggerConsolidationRequest.safeParse(input);
  if (!parsed.success) return;

  const request = parsed.data;
  if (request.dryRun === true) {
    throw new HttpError(
      422,
      "dry_run_not_supported",
      "Consolidation dry-run is not supported yet; no changes were made."
    );
  }
  if (request.mode === "deep") {
    throw new HttpError(
      422,
      "deep_mode_not_supported",
      "Manual deep consolidation is not supported yet; no changes were made."
    );
  }
}

export function mountConsolidation(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/consolidation/trigger",
      tags: ["consolidation"],
      summary: "Trigger an on-demand consolidation pass for the workspace.",
      description:
        "Fast mode processes the scheduler's bounded low-worth candidate set for the " +
        "workspace. It does not reweight or reindex the entire graph. Deep mode and " +
        "dry-run are currently unsupported and return HTTP 422.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: TriggerConsolidationRequest,
            },
          },
          required: false,
        },
      },
      responses: {
        200: {
          description: "Consolidation tick completed.",
          content: {
            "application/json": { schema: TriggerConsolidationResponse },
          },
        },
        401: { description: "Missing or invalid bearer token." },
        422: {
          description: "The requested consolidation mode or dry-run behavior is not supported.",
          content: {
            "application/json": {
              schema: z.object({
                error: z.object({
                  type: z.string(),
                  code: z.string(),
                  message: z.string(),
                  param: z.string().optional(),
                  details: z.record(z.string(), z.unknown()).optional(),
                  request_id: z.string().optional(),
                }),
              }),
            },
          },
        },
        503: {
          description:
            "@mnemo-ai/consolidation peer dep is not installed or storage is unavailable.",
          content: {
            "application/json": {
              schema: z
                .object({
                  error: z.object({ code: z.string(), message: z.string() }),
                })
                .openapi("ConsolidationUnavailable"),
            },
          },
        },
      },
    }),
    async (c) => {
      const started = performance.now();
      const body = c.req.valid("json") ?? {};
      const workspaceId = c.get("workspaceId");
      const mode = (body.mode ?? "fast") as "fast" | "deep";
      const dryRun = body.dryRun ?? false;
      // p47-consolidation-actor-seal introduced this resolve to seal
      // SchedulerContext.actor; p45 Slice C reuses the SAME call/variable for
      // this route's audit-log attribution rather than resolving twice.
      const provenance = resolveProvenance(c);

      assertSupportedConsolidationRequest(body);

      // ── Guard: storage must be wired ─────────────────────────────────────────
      // deps.storage is set in bootFromEnv when adapter-postgres is present.
      // Without it we cannot build the SchedulerContext the tick function needs.
      if (!deps.storage) {
        logger.warn(
          { workspaceId },
          "consolidation.trigger — storage adapter not wired; install @mnemo-ai/adapter-postgres"
        );
        return c.json(
          {
            error: {
              code: "storage_unavailable",
              message:
                "Storage adapter is not wired into ServerDeps. " +
                "Install @mnemo-ai/adapter-postgres and restart the server.",
            },
          },
          503
        );
      }

      // ── Dynamically import the consolidation package ──────────────────────────
      // The dynamic import is intentional — it keeps this file compilable even
      // when the peer dep is absent, and gives callers a clean 503 rather than a
      // startup crash in lightweight deploys.
      let runConsolidationTick: typeof import("@mnemo-ai/consolidation").runConsolidationTick;
      try {
        const mod = await import("@mnemo-ai/consolidation");
        runConsolidationTick = mod.runConsolidationTick;
      } catch (err) {
        logger.warn(
          { err, workspaceId },
          "consolidation.trigger — @mnemo-ai/consolidation not installed"
        );
        return c.json(
          {
            error: {
              code: "consolidation_unavailable",
              message:
                "@mnemo-ai/consolidation is not installed. " +
                "Add it as a dependency and restart the server to enable this endpoint.",
            },
          },
          503
        );
      }

      // ── Build the SchedulerContext and run one tick ───────────────────────────
      // The SchedulerContext.storage interface (queryFacts / updateFact /
      // updateWorth) is a structural subset of StorageAdapter from
      // @mnemo-ai/types — deps.storage satisfies it structurally.
      const schedulerCtx: import("@mnemo-ai/consolidation").SchedulerContext = {
        // Cast is safe: SchedulerStorage is a structural subset of StorageAdapter.
        storage: deps.storage as import("@mnemo-ai/consolidation").SchedulerStorage,
        // listWorkspaceIds is not called when workspaceId is passed to
        // runConsolidationTick, but we provide it as a no-op for type safety.
        listWorkspaceIds: async () => [workspaceId],
        actor: provenance,
        ...(deps.replayValidator
          ? {
              replayValidator:
                deps.replayValidator as import("@mnemo-ai/consolidation").ReplayValidatorContext,
            }
          : {}),
        ...(deps.getReplayValidator
          ? {
              getReplayValidator: deps.getReplayValidator as (
                ws: string
              ) => Promise<import("@mnemo-ai/consolidation").ReplayValidatorContext | undefined>,
            }
          : {}),
      };

      const tickResult = await runConsolidationTick(schedulerCtx, workspaceId);

      // B1.3: label key renamed from "outcome" → "decision" per spec
      consolidationTotal.inc({ decision: "merged" }, tickResult.mergedPairs);
      consolidationTotal.inc({ decision: "skipped" }, tickResult.skippedPairs);
      if (tickResult.errors > 0) {
        consolidationTotal.inc({ decision: "failed" }, tickResult.errors);
      }

      logger.info(
        {
          workspaceId,
          mode,
          dryRun,
          mergedPairs: tickResult.mergedPairs,
          skippedPairs: tickResult.skippedPairs,
          candidateCount: tickResult.candidateCount,
          errors: tickResult.errors,
          tookMs: Math.round(performance.now() - started),
        },
        "consolidation.trigger_complete"
      );

      await emitAudit(deps, {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        action: "admin_access",
        resourceKind: "consolidation",
        resourceId: mode,
        isTerminal: false,
        detail: { mergedPairs: tickResult.mergedPairs, skippedPairs: tickResult.skippedPairs },
      });

      return c.json(
        {
          accepted: true,
          workspaceId,
          mode,
          dryRun,
          mergedPairs: tickResult.mergedPairs,
          skippedPairs: tickResult.skippedPairs,
          candidatesProcessed: tickResult.candidateCount,
          errors: tickResult.errors,
          tookMs: Math.round(performance.now() - started),
        },
        200
      );
    }
  );
}
