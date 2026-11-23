import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { isoDateTimeInput } from "@mnemo-ai/types";

import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { NotFoundError, ConflictError, ForbiddenError } from "../errors.js";
import { taskToWire } from "./_mappers.js";
import {
  assertValidTransition,
  IllegalTaskTransitionError,
  autoExtractOnCompletion,
} from "@mnemo-ai/core/cognitive";
import {
  assertCanWriteSensitivity,
  assertCanReadFact,
  canDelegateTo,
  dropHiddenPointers,
  filterBySensitivity,
  resolveCeiling,
} from "../rbac.js";
import type { CreateTaskInput, MnemoTask, UpdateTaskInput } from "@mnemo-ai/types";
import { emitEvent } from "../events.js";
import { dispatchWebhookEvent } from "../webhookDispatch.js";
import { taskDelegationTotal } from "../metrics/index.js";
import { resolveProvenance } from "../provenance.js";
import { resolveTargetWorkspace } from "../workspace-target.js";

/**
 * Task endpoints — tracked action items with state machine lifecycle.
 *
 * Routes:
 *   GET    /tasks              — list tasks (filter by status/assignedTo/parent)
 *   POST   /tasks              — create a new task
 *   GET    /tasks/:id          — get single task by ID
 *   PATCH  /tasks/:id          — update task (status, priority, outcome, etc.)
 *   DELETE /tasks/:id          — soft-delete task (set validTo = now)
 *
 * POST /tasks — REQUIRED fields:
 *   ✅ title (string, 1-500 chars) — Task name/summary
 *   ✅ assignedTo (string, min 1 char) — Who the task is assigned to (user ID or email)
 *
 * POST /tasks — OPTIONAL fields:
 *   ⚠️  description (string, max 20k chars)
 *   ⚠️  priority (enum: critical, high, medium, low) — default: medium
 *   ⚠️  sessionId (string) — Session this task belongs to
 *   ⚠️  parentTaskId (string) — Parent task for hierarchical decomposition
 *   ⚠️  dueAt (ISO datetime string)
 *   ⚠️  sensitivity (enum: public, internal, confidential, restricted) — default: internal
 *   ⚠️  metadata (object)
 *
 * Task lifecycle states: pending → in_progress → blocked | delegated | completed | cancelled
 * State transitions validated via assertValidTransition (state machine enforced).
 * Auto-extract on completion: when task moves to completed, relevant facts are extracted.
 */

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const TaskStatusEnum = z
  .enum(["pending", "in_progress", "blocked", "delegated", "completed", "cancelled"])
  .openapi("TaskStatus");

const TaskPriorityEnum = z.enum(["critical", "high", "medium", "low"]).openapi("TaskPriority");

const SensitivityEnum = z.enum(["public", "internal", "confidential", "restricted"]);

const TaskSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    title: z.string(),
    description: z.string().optional(),
    status: TaskStatusEnum,
    priority: TaskPriorityEnum,
    assignedTo: z.string(),
    delegatedBy: z.string().optional(),
    parentTaskId: z.string().optional(),
    blockedBy: z.array(z.string()),
    subtaskIds: z.array(z.string()),
    relatedFacts: z.array(z.string()),
    relatedEntities: z.array(z.string()),
    sessionId: z.string().optional(),
    outcome: z.string().optional(),
    lessonsLearned: z.string().optional(),
    delegatedAt: z.iso.datetime().optional(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    dueAt: z.iso.datetime().optional(),
    sensitivity: SensitivityEnum,
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .openapi("TaskSchema");

const TaskListQuerySchema = z.object({
  status: TaskStatusEnum.optional(),
  assignedTo: z.string().optional(),
  parentTaskId: z.string().optional(),
  includeClosed: z.enum(["true", "false"]).optional().openapi({
    description: "Include closed rows (forgotten / archived tasks). Default false.",
  }),
  offset: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const TaskListResponseSchema = z
  .object({
    items: z.array(TaskSchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
    hasMore: z.boolean(),
  })
  .openapi("TaskListResponse");

const TaskCreateBodySchema = z
  .object({
    title: z.string().min(1).max(500),
    description: z.string().max(20_000).optional(),
    priority: TaskPriorityEnum.optional(),
    assignedTo: z.string().min(1),
    sessionId: z.string().optional(),
    parentTaskId: z.string().optional(),
    dueAt: isoDateTimeInput().optional(),
    sensitivity: SensitivityEnum.default("internal").optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    targetWorkspaceId: z.guid().optional().openapi({
      description:
        "Write to a different workspace than the one in the API key. The key's user must be a member of the target workspace. Requires userId binding on the key (mk_user_* or mk_live_* with user_id set).",
    }),
  })
  .openapi("TaskCreateRequest");

const TaskPatchBodySchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(20_000).optional(),
    status: TaskStatusEnum.optional(),
    priority: TaskPriorityEnum.optional(),
    assignedTo: z.string().min(1).optional(),
    blockedBy: z.array(z.string()).optional(),
    subtaskIds: z.array(z.string()).optional(),
    outcome: z.string().max(20_000).optional(),
    lessonsLearned: z.string().max(20_000).optional(),
    startedAt: isoDateTimeInput().optional(),
    completedAt: isoDateTimeInput().optional(),
    dueAt: isoDateTimeInput().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  // Unknown fields are a 400, not silently dropped (APP-022 follow-up).
  .strict()
  .openapi("TaskPatchRequest");

const IdParamSchema = z.object({ id: z.string() });

/**
 * The tasks as the caller may see them: a parent, subtask, blocker, fact or
 * entity above the caller's ceiling is not named (a list leaves it out, a
 * hidden parent reads like no parent).
 */
function tasksForCaller(
  c: Parameters<typeof resolveCeiling>[0],
  deps: ServerDeps,
  workspaceId: string,
  rows: MnemoTask[]
) {
  return dropHiddenPointers(c, deps.storage!, workspaceId, rows.map(taskToWire), {
    lists: ["blockedBy", "subtaskIds", "relatedFacts", "relatedEntities"],
    optionalIds: ["parentTaskId"],
  });
}

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountTasks(app: OpenAPIHono<{ Variables: AuthVariables }>, deps: ServerDeps): void {
  // GET /tasks — list
  app.openapi(
    createRoute({
      method: "get",
      path: "/tasks",
      tags: ["tasks"],
      summary: "List tasks for this workspace.",
      request: {
        query: TaskListQuerySchema,
      },
      responses: {
        200: {
          description: "Paginated task list.",
          content: { "application/json": { schema: TaskListResponseSchema } },
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { status, assignedTo, parentTaskId, includeClosed, offset, limit } =
        c.req.valid("query");
      if (!deps.storage) throw new Error("storage adapter not available");

      const result = await deps.storage.queryTasks({
        workspaceId,
        ...(status !== undefined ? { status } : {}),
        ...(assignedTo !== undefined ? { assignedTo } : {}),
        ...(parentTaskId !== undefined ? { parentTaskId } : {}),
        // PRIM-16: current tasks by default; includeClosed=true (or an explicit
        // status) is how a caller asks for forgotten ones. A completed task is
        // finished work with an open interval, so it stays current.
        ...(includeClosed === "true" || status !== undefined ? {} : { openOnly: true }),
        offset,
        limit,
      });

      const filtered = filterBySensitivity(result.items, resolveCeiling(c));
      return c.json({
        items: await tasksForCaller(c, deps, workspaceId, filtered),
        total: result.total,
        offset: result.offset,
        limit: result.limit,
        hasMore: result.hasMore,
      });
    }
  );

  // POST /tasks — create
  app.openapi(
    createRoute({
      method: "post",
      path: "/tasks",
      tags: ["tasks"],
      summary: "Create a new task.",
      request: {
        body: {
          content: { "application/json": { schema: TaskCreateBodySchema } },
          required: true,
        },
      },
      responses: {
        201: {
          description: "Task created.",
          content: { "application/json": { schema: TaskSchema } },
        },
      },
    }),
    async (c) => {
      const { workspaceId: keyWorkspaceId, actorId, userId } = getAuthCtx(c);
      const provenance = resolveProvenance(c);
      const body = c.req.valid("json");
      assertCanWriteSensitivity(c, body.sensitivity); // PRIM-14
      if (!deps.storage) throw new Error("storage adapter not available");

      const target = await resolveTargetWorkspace({
        keyWorkspaceId,
        userId,
        sql: deps.metricsPgClient,
        targetWorkspaceId: body.targetWorkspaceId,
      });
      if (!target.ok) return c.json(target.body as never, target.status as never);
      const workspaceId = target.workspaceId;

      // Policy lookup is keyed by the raw credential id, not the namespaced
      // ActorRef — per-agent policies are stored/looked-up by the key's own
      // id (matches ratelimit.ts/rbac-policy.ts's use of actorId).
      const taskPolicy = await deps.accessPolicies?.getPolicy(workspaceId, actorId ?? "");
      if (taskPolicy && taskPolicy.taskScopes.canCreate === false) {
        throw new ForbiddenError("Agent policy forbids task creation (taskScopes.canCreate=false)");
      }

      const input: CreateTaskInput = {
        workspaceId,
        actorId: provenance.actorId,
        userId: provenance.userId,
        actorType: provenance.actorType,
        title: body.title,
        assignedTo: body.assignedTo,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
        ...(body.parentTaskId !== undefined ? { parentTaskId: body.parentTaskId } : {}),
        ...(body.dueAt !== undefined ? { dueAt: new Date(body.dueAt) } : {}),
        ...(body.sensitivity !== undefined ? { sensitivity: body.sensitivity } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      };

      const task = await deps.storage.createTask(input);
      const traceId = (c.get("requestId" as never) as string | undefined) ?? "";
      const taskWire = taskToWire(task);
      emitEvent(deps.bus, "task.created", taskWire, traceId);
      // §35(n) webhook fan-out — best-effort, detached.
      void dispatchWebhookEvent(
        deps,
        workspaceId,
        "task.created",
        taskWire as unknown as Record<string, unknown>
      );
      const [shown] = await tasksForCaller(c, deps, workspaceId, [task]);
      return c.json(shown!, 201);
    }
  );

  // GET /tasks/:id — single task
  app.openapi(
    createRoute({
      method: "get",
      path: "/tasks/{id}",
      tags: ["tasks"],
      summary: "Get a single task by ID.",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "The task.",
          content: { "application/json": { schema: TaskSchema } },
        },
        404: { description: "Task not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      const task = await deps.storage.getTask(id, workspaceId);
      if (!task) throw new NotFoundError(`Task ${id} not found`);
      assertCanReadFact(c, id, task.sensitivity, "Task");

      const [shown] = await tasksForCaller(c, deps, workspaceId, [task]);
      return c.json(shown!, 200);
    }
  );

  // PATCH /tasks/:id — update
  app.openapi(
    createRoute({
      method: "patch",
      path: "/tasks/{id}",
      tags: ["tasks"],
      summary: "Update fields on an existing task.",
      request: {
        params: IdParamSchema,
        body: {
          content: { "application/json": { schema: TaskPatchBodySchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Updated task.",
          content: { "application/json": { schema: TaskSchema } },
        },
        404: { description: "Task not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");

      // 404-first: confirm the task belongs to this workspace, and is one the
      // caller may read, before mutating (the response carries the task).
      const existing = await deps.storage.getTask(id, workspaceId);
      if (!existing) throw new NotFoundError(`Task ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Task");

      // State-machine guard — reject illegal transitions with 409
      if (body.status !== undefined && body.status !== existing.status) {
        try {
          assertValidTransition(existing.status, body.status);
        } catch (err) {
          if (err instanceof IllegalTaskTransitionError) {
            throw new ConflictError(err.message);
          }
          throw err;
        }
      }

      // Build patch field-by-field — date strings must be converted to Date
      const patch: UpdateTaskInput = { workspaceId };
      if (body.title !== undefined) patch.title = body.title;
      if (body.description !== undefined) patch.description = body.description;
      if (body.status !== undefined) patch.status = body.status;
      if (body.priority !== undefined) patch.priority = body.priority;
      if (body.assignedTo !== undefined) patch.assignedTo = body.assignedTo;
      if (body.blockedBy !== undefined) patch.blockedBy = body.blockedBy;
      if (body.subtaskIds !== undefined) patch.subtaskIds = body.subtaskIds;
      if (body.outcome !== undefined) patch.outcome = body.outcome;
      if (body.lessonsLearned !== undefined) patch.lessonsLearned = body.lessonsLearned;
      if (body.startedAt !== undefined) patch.startedAt = new Date(body.startedAt);
      if (body.completedAt !== undefined) patch.completedAt = new Date(body.completedAt);
      if (body.dueAt !== undefined) patch.dueAt = new Date(body.dueAt);
      if (body.metadata !== undefined) patch.metadata = body.metadata;

      const updated = await deps.storage.updateTask(id, patch);

      // Best-effort auto-extraction on fresh completion
      if (body.status === "completed" && existing.status !== "completed") {
        try {
          await autoExtractOnCompletion(deps.storage, updated);
        } catch {
          // best-effort: the status is already committed, auto-extract failure is non-fatal
        }
      }

      const traceId = (c.get("requestId" as never) as string | undefined) ?? "";
      const taskEventType =
        updated.status === "completed"
          ? ("task.completed" as const)
          : ("task.transitioned" as const);
      const updatedWire = taskToWire(updated);
      emitEvent(deps.bus, taskEventType, updatedWire, traceId);
      // §35(n) webhook fan-out for the spec's task.completed event only.
      if (taskEventType === "task.completed") {
        void dispatchWebhookEvent(
          deps,
          workspaceId,
          "task.completed",
          updatedWire as unknown as Record<string, unknown>
        );
      }
      const [shown] = await tasksForCaller(c, deps, workspaceId, [updated]);
      return c.json(shown!, 200);
    }
  );

  // DELETE /tasks/:id — archive
  app.openapi(
    createRoute({
      method: "delete",
      path: "/tasks/{id}",
      tags: ["tasks"],
      summary: "Archive a task (soft-delete).",
      request: { params: IdParamSchema },
      responses: {
        204: { description: "Task archived." },
        404: { description: "Task not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      // 404-first pattern; a hidden task answers like a missing one.
      const existing = await deps.storage.getTask(id, workspaceId);
      if (!existing) throw new NotFoundError(`Task ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Task");

      await deps.storage.archiveTask(id, workspaceId);
      return c.body(null, 204);
    }
  );

  // POST /tasks/:id/delegate — delegate to another agent
  app.openapi(
    createRoute({
      method: "post",
      path: "/tasks/{id}/delegate",
      tags: ["tasks"],
      summary: "Delegate a task to another agent.",
      request: {
        params: IdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z.object({ assignedTo: z.string().min(1) }).openapi("TaskDelegateRequest"),
            },
          },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Task delegated.",
          content: { "application/json": { schema: TaskSchema } },
        },
        404: { description: "Task not found." },
        409: { description: "Task cannot be delegated from its current state." },
      },
    }),
    async (c) => {
      const { workspaceId, actorId } = getAuthCtx(c);
      // Policy lookup/delegation attribution keyed by the raw credential id — see
      // the same reasoning in POST /tasks above. Was apiKeyPrefix (a shared
      // constant like "mns_live_"), which made every legacy-key holder in the
      // workspace share one delegation policy and collapsed delegatedBy/metrics
      // for all of them into the same fake agent.
      const agentId = actorId ?? "system";
      const { id } = c.req.valid("param");
      const { assignedTo } = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");

      const existing = await deps.storage.getTask(id, workspaceId);
      if (!existing) throw new NotFoundError(`Task ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Task");

      const delegatePolicy = await deps.accessPolicies?.getPolicy(workspaceId, agentId);
      if (delegatePolicy && delegatePolicy.taskScopes.canDelegate === false) {
        throw new ForbiddenError("Agent policy forbids delegation (taskScopes.canDelegate=false)");
      }
      if (!canDelegateTo(agentId, assignedTo, delegatePolicy?.taskScopes.canDelegateTo)) {
        throw new ForbiddenError(
          "Delegation target not permitted by policy (taskScopes.canDelegateTo)"
        );
      }

      try {
        assertValidTransition(existing.status, "delegated");
      } catch (err) {
        if (err instanceof IllegalTaskTransitionError) {
          throw new ConflictError(`Task in state '${existing.status}' cannot be delegated`);
        }
        throw err;
      }

      const delegated = await deps.storage.delegateTask(id, workspaceId, {
        assignedTo,
        delegatedBy: agentId,
      });
      taskDelegationTotal.inc({ from_agent: agentId, to_agent: assignedTo });
      const delegatedWire = taskToWire(delegated);
      const traceId = (c.get("requestId" as never) as string | undefined) ?? "";
      // Bus union has no dedicated "delegated" type — delegation IS a transition,
      // so emit task.transitioned to the internal bus but fire the spec's
      // task.delegated webhook event (webhook event strings are independent of
      // the internal MnemoEventType union).
      emitEvent(deps.bus, "task.transitioned", delegatedWire, traceId);
      // §35(n) webhook fan-out — best-effort, detached.
      void dispatchWebhookEvent(
        deps,
        workspaceId,
        "task.delegated",
        delegatedWire as unknown as Record<string, unknown>
      );
      const [shown] = await tasksForCaller(c, deps, workspaceId, [delegated]);
      return c.json(shown!, 200);
    }
  );
}
