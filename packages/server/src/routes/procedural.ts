/**
 * §14 Procedural memory routes (Wave U, U2.4)
 *
 * POST /procedural/optimize          — trigger one optimization pass for an agent
 * GET  /procedural/prompt/:agent     — return the active/candidate prompt version
 * GET  /procedural/versions/:agent   — list all prompt versions for an agent
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { runProceduralOptimization, decideProceduralTransition } from "@mnemo-ai/core";
import type { LLMAdapter } from "@mnemo-ai/types";
import type { ServerDeps } from "../deps.js";
import type { AuthVariables } from "../auth.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";

// ─── Shared error response ────────────────────────────────────────────────────

const ErrorResponseSchema = z.object({ message: z.string() }).openapi("ProceduralErrorResponse");

// ─── POST /procedural/optimize ───────────────────────────────────────────────

const OptimizeRequestSchema = z
  .object({
    agentId: z
      .string()
      .min(1)
      .max(256)
      .openapi({ description: "Agent id to optimize the prompt for." }),
    topK: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .optional()
      .openapi({ description: "Number of trajectories to use. Default 20." }),
    highThreshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.8)
      .optional()
      .openapi({ description: "Min score for 'high' group. Default 0.8." }),
    lowThreshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.4)
      .optional()
      .openapi({ description: "Max score for 'low' group. Default 0.4." }),
    skipIfBudgetBelow: z
      .number()
      .min(0)
      .default(0.01)
      .optional()
      .openapi({ description: "USD budget gate. Default $0.01/month." }),
  })
  .openapi("ProceduralOptimizeRequest");

const OptimizeResponseSchema = z
  .object({
    outcome: z.enum(["skipped", "created"]).openapi({
      description: "'created' if a new candidate version was written; 'skipped' otherwise.",
    }),
    reason: z.string().optional(),
    promptVersionId: z.string().optional(),
    transitionResult: z
      .object({
        action: z.enum(["activated", "rolled_back", "noop"]),
        reason: z.string(),
        promptVersionId: z.string().optional(),
      })
      .optional()
      .openapi({
        description: "A/B test decision that ran immediately after the optimization pass.",
      }),
  })
  .openapi("ProceduralOptimizeResponse");

const optimizeRoute = createRoute({
  method: "post",
  path: "/procedural/optimize",
  tags: ["procedural"],
  summary: "Trigger one metaprompt optimization pass for an agent.",
  request: {
    body: { content: { "application/json": { schema: OptimizeRequestSchema } }, required: true },
  },
  responses: {
    200: {
      description: "Optimization result.",
      content: { "application/json": { schema: OptimizeResponseSchema } },
    },
    400: {
      description: "Invalid request.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    503: {
      description: "LLM adapter not configured.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── GET /procedural/prompt/:agent ───────────────────────────────────────────

const PromptVersionSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    status: z.string(),
    promptText: z.string().nullable(),
    diffFromPrevious: z.string().nullable(),
    algorithm: z.string(),
    trajectoriesUsed: z.number().nullable(),
    avgScoreBefore: z.number().nullable(),
    avgScoreAfter: z.number().nullable(),
    activatedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("ProceduralPromptVersion");

const activePromptRoute = createRoute({
  method: "get",
  path: "/procedural/prompt/:agent",
  tags: ["procedural"],
  summary: "Return the active or candidate prompt version for an agent.",
  request: {
    params: z.object({ agent: z.string().min(1).max(256) }),
  },
  responses: {
    200: {
      description: "The active/candidate version, or null.",
      content: {
        "application/json": {
          schema: z
            .object({ version: PromptVersionSchema.nullable() })
            .openapi("ProceduralActivePromptResponse"),
        },
      },
    },
    400: {
      description: "Invalid request.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── GET /procedural/versions/:agent ─────────────────────────────────────────

const listVersionsRoute = createRoute({
  method: "get",
  path: "/procedural/versions/:agent",
  tags: ["procedural"],
  summary: "List all prompt versions for an agent, newest first.",
  request: {
    params: z.object({ agent: z.string().min(1).max(256) }),
  },
  responses: {
    200: {
      description: "Prompt version history.",
      content: {
        "application/json": {
          schema: z
            .object({ versions: z.array(PromptVersionSchema) })
            .openapi("ProceduralVersionListResponse"),
        },
      },
    },
    400: {
      description: "Invalid request.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountProcedural(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // POST /procedural/optimize
  app.openapi(optimizeRoute, async (c) => {
    if (!deps.storage) {
      return c.json({ message: "Storage adapter not available." }, 503 as never);
    }
    if (!deps.llm) {
      return c.json(
        { message: "LLM adapter not configured — cannot run procedural optimization." },
        503 as never
      );
    }

    const body = c.req.valid("json");
    const workspaceId = c.get("workspaceId");
    const provenance = resolveProvenance(c);
    const storage = deps.storage;
    // deps.llm is LLMProviderLike (embed-only); cast to LLMAdapter for procedural
    // (generate/generateStructured are duck-typed at runtime via the real adapter)
    const llm = deps.llm as unknown as LLMAdapter;

    const result = await runProceduralOptimization(storage, llm, workspaceId, body.agentId, {
      topK: body.topK,
      highThreshold: body.highThreshold,
      lowThreshold: body.lowThreshold,
      skipIfBudgetBelow: body.skipIfBudgetBelow,
    });

    // If a candidate was created, immediately check whether we should transition
    let transitionResult:
      | { action: "activated" | "rolled_back" | "noop"; reason: string; promptVersionId?: string }
      | undefined;
    if (result.outcome === "created") {
      const tr = await decideProceduralTransition(storage, workspaceId, body.agentId);
      transitionResult = {
        action: tr.action,
        reason: tr.reason,
        promptVersionId: tr.promptVersionId,
      };
    }

    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "admin_access",
      resourceKind: "procedural",
      resourceId: body.agentId,
      isTerminal: false,
      detail: { outcome: result.outcome },
    });

    return c.json(
      {
        outcome: result.outcome,
        reason: result.reason,
        promptVersionId: result.promptVersionId,
        transitionResult,
      },
      200
    );
  });

  // GET /procedural/prompt/:agent
  app.openapi(activePromptRoute, async (c) => {
    if (!deps.storage) {
      return c.json({ version: null }, 200);
    }
    const { agent } = c.req.valid("param");
    const workspaceId = c.get("workspaceId");
    const storage = deps.storage;

    const row = (await storage.getActivePromptVersion?.(workspaceId, agent)) ?? null;
    if (!row) {
      return c.json({ version: null }, 200);
    }

    // Fetch full text — getActivePromptVersion returns a minimal shape
    const versions = (await storage.listPromptVersions?.(workspaceId, agent)) ?? [];
    const full = versions.find((v) => v.id === row.id);

    return c.json(
      {
        version: full
          ? {
              id: full.id,
              agentId: agent,
              status: row.status,
              promptText: full.promptText,
              diffFromPrevious: full.diffFromPrevious,
              algorithm: full.algorithm,
              trajectoriesUsed: full.trajectoriesUsed,
              avgScoreBefore: full.avgScoreBefore,
              avgScoreAfter: full.avgScoreAfter,
              activatedAt: full.activatedAt ? full.activatedAt.toISOString() : null,
              createdAt: full.createdAt.toISOString(),
            }
          : null,
      },
      200
    );
  });

  // GET /procedural/versions/:agent
  app.openapi(listVersionsRoute, async (c) => {
    if (!deps.storage) {
      return c.json({ versions: [] }, 200);
    }
    const { agent } = c.req.valid("param");
    const workspaceId = c.get("workspaceId");
    const storage = deps.storage;

    const rows = (await storage.listPromptVersions?.(workspaceId, agent)) ?? [];

    return c.json(
      {
        versions: rows.map((v) => ({
          id: v.id,
          agentId: agent,
          status: v.status,
          promptText: v.promptText,
          diffFromPrevious: v.diffFromPrevious,
          algorithm: v.algorithm,
          trajectoriesUsed: v.trajectoriesUsed,
          avgScoreBefore: v.avgScoreBefore,
          avgScoreAfter: v.avgScoreAfter,
          activatedAt: v.activatedAt ? v.activatedAt.toISOString() : null,
          createdAt: v.createdAt.toISOString(),
        })),
      },
      200
    );
  });
}
