import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

const StatusEnum = z.enum(["active", "archived", "pruned", "quarantined", "golden"]);
const ChainStep = z.object({
  step: z.number().int().nonnegative(),
  reasoning: z.string().min(1).max(20_000),
  conclusion: z.string().max(20_000).optional(),
});

/** `memory_reasoning` — almacena chains-of-thought reutilizables. */
export function registerReasoning(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_reasoning",
    {
      title: "Persist a reasoning chain",
      inputSchema: {
        action: z
          .enum(["create", "get", "list", "patch", "archive", "resolve", "record", "feedback"])
          .describe(d("fields.memory_reasoning.action")),
        id: z.string().optional().describe(d("fields.memory_reasoning.id")),
        agentId: z.string().optional().describe(d("fields.memory_reasoning.agentId")),
        question: z.string().max(20_000).optional().describe(d("fields.memory_reasoning.question")),
        chain: z.array(ChainStep).max(200).optional().describe(d("fields.memory_reasoning.chain")),
        conclusion: z
          .string()
          .max(20_000)
          .optional()
          .describe(d("fields.memory_reasoning.conclusion")),
        topicKey: z.string().max(200).optional().describe(d("fields.memory_reasoning.topicKey")),
        status: StatusEnum.optional().describe(d("fields.memory_reasoning.status")),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(d("fields.memory_reasoning.metadata")),
        topicKeyFilter: z.string().optional().describe(d("fields.memory_reasoning.topicKeyFilter")),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(d("fields.memory_reasoning.limit")),
        query: z.string().max(20_000).optional().describe(d("fields.memory_reasoning.query")),
        outcome: z
          .enum(["success", "fail"])
          .optional()
          .describe(d("fields.memory_reasoning.outcome")),
        reasoningId: z.string().optional().describe(d("fields.memory_reasoning.reasoningId")),
        sensitivity: z
          .enum(["public", "internal", "confidential", "restricted"])
          .optional()
          .describe(d("fields.memory_reasoning.sensitivity")),
        targetWorkspaceId: z
          .uuid()
          .optional()
          .describe(d("fields.memory_reasoning.targetWorkspaceId")),
      },
    },
    async (args) => {
      let result: unknown;
      try {
        if (args.action !== "create" && args.targetWorkspaceId !== undefined) {
          return errorOut(t(locale, "out.targetWorkspaceOnlyCreate", { when: "action='create'" }));
        }
        // APP-022/APP-013: create and record store sensitivity (record since
        // server 17088ebe); patch drops it, so refuse rather than store it lower.
        if (
          args.action !== "create" &&
          args.action !== "record" &&
          args.sensitivity !== undefined
        ) {
          return errorOut(
            t(locale, "out.onlyOnCreate", {
              field: "sensitivity",
              when: "action='create' or 'record'",
              action: `action='${args.action}'`,
            })
          );
        }
        switch (args.action) {
          case "create": {
            if (!args.question || !args.chain || args.chain.length === 0 || !args.conclusion) {
              return errorOut(t(locale, "out.memory_reasoning.createNeeds", { action: "create" }));
            }
            const body: Record<string, unknown> = {
              question: args.question,
              chain: args.chain,
              conclusion: args.conclusion,
            };
            if (args.agentId !== undefined) body["agentId"] = args.agentId;
            if (args.topicKey !== undefined) body["topicKey"] = args.topicKey;
            if (args.sensitivity !== undefined) body["sensitivity"] = args.sensitivity;
            if (args.metadata !== undefined) body["metadata"] = args.metadata;
            if (args.targetWorkspaceId !== undefined)
              body["targetWorkspaceId"] = args.targetWorkspaceId;
            result = await client.createReasoning(
              body as unknown as Parameters<typeof client.createReasoning>[0]
            );
            break;
          }
          case "get": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "get", field: "id" }));
            result = await client.getReasoning(args.id);
            break;
          }
          case "list": {
            const params: Record<string, unknown> = {};
            if (args.status !== undefined) params["status"] = args.status;
            if (args.topicKeyFilter !== undefined) params["topicKey"] = args.topicKeyFilter;
            if (args.limit !== undefined) params["limit"] = args.limit;
            result = await client.listReasoning(
              params as Parameters<typeof client.listReasoning>[0]
            );
            break;
          }
          case "patch": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "patch", field: "id" }));
            const patch: Record<string, unknown> = {};
            if (args.status !== undefined) patch["status"] = args.status;
            if (args.chain !== undefined) patch["chain"] = args.chain;
            if (args.conclusion !== undefined) patch["conclusion"] = args.conclusion;
            if (args.metadata !== undefined) patch["metadata"] = args.metadata;
            result = await client.patchReasoning(
              args.id,
              patch as Parameters<typeof client.patchReasoning>[1]
            );
            break;
          }
          case "archive": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "archive", field: "id" }));
            await client.archiveReasoning(args.id);
            result = { id: args.id, archived: true };
            break;
          }
          case "resolve": {
            if (!args.query)
              return errorOut(t(locale, "out.requires", { action: "resolve", field: "query" }));
            const body: Record<string, unknown> = { query: args.query };
            if (args.topicKey !== undefined) body["topicKey"] = args.topicKey;
            result = await client.resolveReasoning(
              body as unknown as Parameters<typeof client.resolveReasoning>[0]
            );
            break;
          }
          case "record": {
            if (!args.question || !args.chain || args.chain.length === 0 || !args.conclusion) {
              return errorOut(t(locale, "out.memory_reasoning.createNeeds", { action: "record" }));
            }
            result = await client.recordReasoning({
              question: args.question,
              chain: args.chain as any,
              conclusion: args.conclusion,
              ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
              ...(args.topicKey !== undefined ? { topicKey: args.topicKey } : {}),
              ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
              ...(args.sensitivity !== undefined ? { sensitivity: args.sensitivity } : {}),
            });
            break;
          }
          case "feedback": {
            if (!args.reasoningId || !args.outcome)
              return errorOut(t(locale, "out.memory_reasoning.feedbackNeeds"));
            result = await client.reasoningFeedback({
              reasoning_id: args.reasoningId,
              outcome: args.outcome,
            });
            break;
          }
        }
      } catch (err) {
        return formatMcpError("memory_reasoning", err, locale);
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
