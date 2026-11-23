import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, isoDateTimeInput, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

const StatusEnum = z.enum([
  "pending",
  "in_progress",
  "blocked",
  "delegated",
  "completed",
  "cancelled",
]);
const PriorityEnum = z.enum(["critical", "high", "medium", "low"]);

/** `memory_task` — gestiona tareas accionables del workspace. */
export function registerTask(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_task",
    {
      title: "Manage actionable tasks",
      inputSchema: {
        action: z
          .enum(["create", "get", "list", "patch", "archive", "delegate", "complete"])
          .describe(d("fields.memory_task.action")),
        id: z.string().optional().describe(d("fields.memory_task.id")),
        title: z.string().min(1).max(500).optional().describe(d("fields.memory_task.title")),
        description: z
          .string()
          .max(20_000)
          .optional()
          .describe(d("fields.memory_task.description")),
        status: StatusEnum.optional().describe(d("fields.memory_task.status")),
        priority: PriorityEnum.optional().describe(d("fields.memory_task.priority")),
        assignedTo: z.string().optional().describe(d("fields.memory_task.assignedTo")),
        sessionId: z.string().optional().describe(d("fields.memory_task.sessionId")),
        parentTaskId: z.string().optional().describe(d("fields.memory_task.parentTaskId")),
        dueAt: isoDateTimeInput().optional().describe(d("fields.memory_task.dueAt")),
        sensitivity: z
          .enum(["public", "internal", "confidential", "restricted"])
          .optional()
          .describe(d("fields.memory_task.sensitivity")),
        outcome: z.string().max(20_000).optional().describe(d("fields.memory_task.outcome")),
        lessonsLearned: z
          .string()
          .max(20_000)
          .optional()
          .describe(d("fields.memory_task.lessonsLearned")),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(d("fields.memory_task.metadata")),
        parentTaskIdFilter: z
          .string()
          .optional()
          .describe(d("fields.memory_task.parentTaskIdFilter")),
        limit: z.number().int().min(1).max(200).optional().describe(d("fields.memory_task.limit")),
        idempotencyKey: z.string().optional().describe(d("fields.memory_task.idempotencyKey")),
        targetWorkspaceId: z.uuid().optional().describe(d("fields.memory_task.targetWorkspaceId")),
      },
    },
    async (args) => {
      let result: unknown;
      try {
        if (args.action !== "create" && args.targetWorkspaceId !== undefined) {
          return errorOut(t(locale, "out.targetWorkspaceOnlyCreate", { when: "action='create'" }));
        }
        // APP-022: the server drops sensitivity on patch; a silent success lied.
        if (args.action !== "create" && args.sensitivity !== undefined) {
          return errorOut(
            t(locale, "out.onlyOnCreate", {
              field: "sensitivity",
              when: "action='create'",
              action: `action='${args.action}'`,
            })
          );
        }
        switch (args.action) {
          case "create": {
            if (!args.title || !args.assignedTo)
              return errorOut(t(locale, "out.memory_task.createNeeds"));
            const body: Record<string, unknown> = {
              title: args.title,
              assignedTo: args.assignedTo,
            };
            if (args.description !== undefined) body["description"] = args.description;
            if (args.priority !== undefined) body["priority"] = args.priority;
            if (args.sessionId !== undefined) body["sessionId"] = args.sessionId;
            if (args.parentTaskId !== undefined) body["parentTaskId"] = args.parentTaskId;
            if (args.dueAt !== undefined) body["dueAt"] = args.dueAt;
            if (args.sensitivity !== undefined) body["sensitivity"] = args.sensitivity;
            if (args.metadata !== undefined) body["metadata"] = args.metadata;
            if (args.targetWorkspaceId !== undefined)
              body["targetWorkspaceId"] = args.targetWorkspaceId;
            result = await client.createTask(
              body as unknown as Parameters<typeof client.createTask>[0],
              undefined,
              args.idempotencyKey
            );
            break;
          }
          case "get": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "get", field: "id" }));
            result = await client.getTask(args.id);
            break;
          }
          case "list": {
            const params: Record<string, unknown> = {};
            if (args.status !== undefined) params["status"] = args.status;
            if (args.assignedTo !== undefined) params["assignedTo"] = args.assignedTo;
            if (args.parentTaskIdFilter !== undefined)
              params["parentTaskId"] = args.parentTaskIdFilter;
            if (args.limit !== undefined) params["limit"] = args.limit;
            result = await client.listTasks(params as Parameters<typeof client.listTasks>[0]);
            break;
          }
          case "patch": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "patch", field: "id" }));
            const patch: Record<string, unknown> = {};
            if (args.title !== undefined) patch["title"] = args.title;
            if (args.description !== undefined) patch["description"] = args.description;
            if (args.status !== undefined) patch["status"] = args.status;
            if (args.priority !== undefined) patch["priority"] = args.priority;
            if (args.assignedTo !== undefined) patch["assignedTo"] = args.assignedTo;
            if (args.outcome !== undefined) patch["outcome"] = args.outcome;
            if (args.lessonsLearned !== undefined) patch["lessonsLearned"] = args.lessonsLearned;
            if (args.dueAt !== undefined) patch["dueAt"] = args.dueAt;
            if (args.metadata !== undefined) patch["metadata"] = args.metadata;
            result = await client.patchTask(
              args.id,
              patch as Parameters<typeof client.patchTask>[1]
            );
            break;
          }
          case "archive": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "archive", field: "id" }));
            await client.archiveTask(args.id);
            result = { id: args.id, archived: true };
            break;
          }
          case "delegate": {
            // §24 domain verb — calls dedicated, provenance-aware route
            // (POST /tasks/:id/delegate), which stamps delegatedBy + delegatedAt
            // and enforces the canDelegateTo allow-list.
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "delegate", field: "id" }));
            if (!args.assignedTo) return errorOut(t(locale, "out.memory_task.delegateNeeds"));
            result = await client.delegateTask(args.id, { assignedTo: args.assignedTo });
            break;
          }
          case "complete": {
            // §24 domain verb — sugar over PATCH status→"completed". The server's
            // PATCH handler fires the `task.completed` event and runs
            // auto-extraction on a fresh completion, so this is the real
            // completion path, not a shortcut.
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "complete", field: "id" }));
            const patch: Parameters<typeof client.patchTask>[1] = { status: "completed" };
            if (args.outcome !== undefined) patch.outcome = args.outcome;
            if (args.lessonsLearned !== undefined) patch.lessonsLearned = args.lessonsLearned;
            result = await client.patchTask(args.id, patch);
            break;
          }
        }
      } catch (err) {
        return formatMcpError("memory_task", err, locale);
      }
      return {
        content: [{ type: "text" as const, text: jsonText(result) }],
        structuredContent: result as { [key: string]: unknown },
      };
    }
  );
}

function errorOut(msg: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
}
