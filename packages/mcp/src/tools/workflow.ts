import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

const WorkflowStepSchema = z.object({
  order: z.number().int().min(0),
  action: z.string().min(1).max(20_000),
  condition: z.string().max(20_000).optional(),
  expectedDurationMs: z.number().int().min(0).default(0),
  tools: z.array(z.string()).optional(),
});

/** `memory_workflow` — gestiona workflows (procesos repetibles) del workspace. */
export function registerWorkflow(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_workflow",
    {
      title: "Manage reusable workflows",
      inputSchema: {
        action: z
          .enum(["create", "get", "list", "update"])
          .describe(d("fields.memory_workflow.action")),
        id: z.string().optional().describe(d("fields.memory_workflow.id")),
        name: z.string().min(1).max(500).optional().describe(d("fields.memory_workflow.name")),
        description: z.string().max(20_000).optional(),
        steps: z.array(WorkflowStepSchema).optional().describe(d("fields.memory_workflow.steps")),
        sensitivity: z
          .enum(["public", "internal", "confidential", "restricted"])
          .optional()
          .describe(d("fields.memory_workflow.sensitivity")),
        metadata: z.record(z.string(), z.unknown()).optional(),
        scopeRef: z.string().optional().describe(d("fields.memory_workflow.scopeRef")),
        status: z
          .enum(["active", "deprecated", "draft"])
          .optional()
          .describe(d("fields.memory_workflow.status")),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        targetWorkspaceId: z
          .uuid()
          .optional()
          .describe(d("fields.memory_workflow.targetWorkspaceId")),
      },
    },
    async (args) => {
      let result: unknown;
      try {
        if (args.targetWorkspaceId !== undefined && args.action !== "create") {
          return errorOut(t(locale, "out.targetWorkspaceOnlyCreate", { when: "action='create'" }));
        }
        // APP-022: update drops both server-side; scopeRef is also a list filter.
        const ignored =
          args.action === "create"
            ? undefined
            : args.sensitivity !== undefined
              ? "sensitivity"
              : args.scopeRef !== undefined && args.action !== "list"
                ? "scopeRef"
                : undefined;
        if (ignored) {
          return errorOut(
            t(locale, "out.onlyOnCreate", {
              field: ignored,
              when: ignored === "scopeRef" ? "action='create'/'list'" : "action='create'",
              action: `action='${args.action}'`,
            })
          );
        }
        switch (args.action) {
          case "create": {
            if (!args.name || !args.steps?.length) {
              return errorOut(t(locale, "out.memory_workflow.createNeeds"));
            }
            const body: Record<string, unknown> = { name: args.name, steps: args.steps };
            if (args.description !== undefined) body["description"] = args.description;
            if (args.scopeRef !== undefined) body["scopeRef"] = args.scopeRef;
            if (args.sensitivity !== undefined) body["sensitivity"] = args.sensitivity;
            if (args.metadata !== undefined) body["metadata"] = args.metadata;
            if (args.targetWorkspaceId !== undefined)
              body["targetWorkspaceId"] = args.targetWorkspaceId;
            result = await client.createWorkflow(
              body as unknown as Parameters<typeof client.createWorkflow>[0]
            );
            break;
          }
          case "get": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "get", field: "id" }));
            result = await client.getWorkflow(args.id);
            break;
          }
          // P111 — same gap as memory_skill: a workflow could be created and
          // never corrected. `status` doubles as a list filter above; here it
          // sets the workflow's own lifecycle state.
          case "update": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "update", field: "id" }));
            const patch: Record<string, unknown> = {};
            if (args.name !== undefined) patch["name"] = args.name;
            if (args.description !== undefined) patch["description"] = args.description;
            if (args.steps !== undefined) patch["steps"] = args.steps;
            if (args.status !== undefined) patch["status"] = args.status;
            if (args.metadata !== undefined) patch["metadata"] = args.metadata;
            if (Object.keys(patch).length === 0) {
              return errorOut(t(locale, "out.memory_workflow.updateNeeds"));
            }
            result = await client.updateWorkflow(
              args.id,
              patch as unknown as Parameters<typeof client.updateWorkflow>[1]
            );
            break;
          }
          case "list": {
            const params: Record<string, unknown> = {};
            if (args.status !== undefined) params["status"] = args.status;
            if (args.scopeRef !== undefined) params["scopeRef"] = args.scopeRef;
            if (args.limit !== undefined) params["limit"] = args.limit;
            if (args.offset !== undefined) params["offset"] = args.offset;
            result = await client.listWorkflows(params);
            break;
          }
        }
      } catch (err) {
        return formatMcpError("memory_workflow", err, locale);
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
