import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { isoDateTimeInput } from "@mnemo-ai/types";
import { randomUUID } from "node:crypto";

import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { NotFoundError } from "../errors.js";
import { resolveProvenance } from "../provenance.js";
import { resolveTargetWorkspace } from "../workspace-target.js";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const ReminderSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    content: z.string(),
    // REMIND-1: null on a time-only reminder.
    condition: z.string().nullable(),
    triggerAt: z.iso.datetime().nullable(),
    status: z.enum(["pending", "triggered", "dismissed"]),
    createdAt: z.iso.datetime(),
  })
  .openapi("Reminder");

const CreateReminderBodySchema = z
  .object({
    content: z.string().min(1),
    condition: z.string().min(1).optional(),
    triggerAt: isoDateTimeInput().optional(),
    targetWorkspaceId: z.guid().optional().openapi({
      description:
        "Write to a different workspace than the one in the API key. The key's user must be a member of the target workspace. Requires userId binding on the key (mk_user_* or mk_live_* with user_id set).",
    }),
  })
  .refine((b) => b.condition !== undefined || b.triggerAt !== undefined, {
    message:
      "a reminder needs at least one trigger: `condition` (semantic, evaluated on every recall), " +
      "`triggerAt` (temporal, swept every 30s), or both (AND — fires only when the clock has " +
      "passed AND a real recall query satisfies the condition).",
  })
  .openapi("CreateReminderRequest");

const ListRemindersQuerySchema = z.object({
  status: z.enum(["pending", "triggered", "dismissed", "all"]).optional().default("pending"),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const IdParamSchema = z.object({ id: z.string() });

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountReminders(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // POST /reminders — create
  app.openapi(
    createRoute({
      method: "post",
      path: "/reminders",
      tags: ["reminders"],
      summary: "Create a prospective memory reminder.",
      request: {
        body: {
          content: { "application/json": { schema: CreateReminderBodySchema } },
          required: true,
        },
      },
      responses: {
        201: {
          description: "Reminder created.",
          content: { "application/json": { schema: ReminderSchema } },
        },
      },
    }),
    async (c) => {
      const { workspaceId: keyWorkspaceId, userId } = getAuthCtx(c);
      const provenance = resolveProvenance(c);
      const body = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");

      const target = await resolveTargetWorkspace({
        keyWorkspaceId,
        userId,
        sql: deps.metricsPgClient,
        targetWorkspaceId: body.targetWorkspaceId,
      });
      if (!target.ok) return c.json(target.body as never, target.status as never);
      const workspaceId = target.workspaceId;

      // Compute conditionEmbedding at creation so the evaluator's vector
      // cosine path (evaluator.ts Path 1) can actually fire later — without
      // this, every reminder's conditionEmbedding stayed permanently null
      // and the semantic trigger silently fell back to the (still useful,
      // but coarser) LLM-judgment or FTS-keyword paths only. Same
      // degrade-gracefully pattern used by reasoning.ts's vector path:
      // no embedder configured → skip, evaluator still works via Path 2/3.
      let conditionEmbedding: number[] | undefined;
      if (deps.llm && body.condition) {
        const model = deps.embedModel ?? "text-embedding-3-small";
        try {
          conditionEmbedding = await deps.llm.embed(body.condition, model);
        } catch {
          // Non-fatal: reminder creation must not fail because embedding
          // did. The evaluator falls back to LLM-judgment/FTS matching.
          conditionEmbedding = undefined;
        }
      }

      const id = randomUUID();
      const reminder = await deps.storage.createReminder({
        id,
        workspaceId,
        content: body.content,
        condition: body.condition,
        triggerAt: body.triggerAt ? new Date(body.triggerAt) : undefined,
        conditionEmbedding,
        actorId: provenance.actorId,
        userId: provenance.userId,
        actorType: provenance.actorType,
      });

      return c.json(
        {
          id: reminder.id,
          workspaceId,
          content: reminder.content,
          condition: reminder.condition,
          triggerAt: reminder.triggerAt ? reminder.triggerAt.toISOString() : null,
          status: reminder.status,
          createdAt: reminder.createdAt.toISOString(),
        },
        201
      );
    }
  );

  // GET /reminders — list
  app.openapi(
    createRoute({
      method: "get",
      path: "/reminders",
      tags: ["reminders"],
      summary: "List reminders for this workspace.",
      request: {
        query: ListRemindersQuerySchema,
      },
      responses: {
        200: {
          description: "Reminders list.",
          content: {
            "application/json": {
              schema: z.object({ reminders: z.array(ReminderSchema) }),
            },
          },
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { status, limit } = c.req.valid("query");
      if (!deps.storage) throw new Error("storage adapter not available");

      const reminders = await deps.storage.listReminders(workspaceId, status, limit);

      return c.json({
        reminders: reminders.map((r) => ({
          id: r.id,
          workspaceId: r.workspaceId,
          content: r.content,
          condition: r.condition,
          triggerAt: r.triggerAt ? r.triggerAt.toISOString() : null,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    }
  );

  // DELETE /reminders/:id — dismiss
  app.openapi(
    createRoute({
      method: "delete",
      path: "/reminders/{id}",
      tags: ["reminders"],
      summary: "Dismiss a reminder (sets status to 'dismissed'). No row is deleted.",
      request: {
        params: IdParamSchema,
      },
      responses: {
        204: { description: "Reminder dismissed." },
        404: { description: "Reminder not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      const existing = await deps.storage.getReminder(id, workspaceId);
      if (!existing) throw new NotFoundError(`Reminder ${id} not found`);

      await deps.storage.dismissReminder(id, workspaceId, "dismissed");
      return new Response(null, { status: 204 });
    }
  );
}
