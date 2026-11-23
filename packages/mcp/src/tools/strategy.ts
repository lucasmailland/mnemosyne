import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, isoDateTimeInput, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

const StatusEnum = z.enum(["active", "superseded", "archived"]);

/** `memory_strategy` — gestiona estrategias trigger→action del workspace. */
export function registerStrategy(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_strategy",
    {
      title: "Manage trigger→action strategies",
      inputSchema: {
        op: z
          .enum(["create", "get", "list", "patch", "archive", "store", "recall", "rate"])
          .describe(d("fields.memory_strategy.op")),
        outcome: z
          .enum(["success", "failure"])
          .optional()
          .describe(d("fields.memory_strategy.outcome")),
        id: z.string().optional().describe(d("fields.memory_strategy.id")),
        trigger: z.string().max(20_000).optional().describe(d("fields.memory_strategy.trigger")),
        action: z.string().max(20_000).optional().describe(d("fields.memory_strategy.action")),
        context: z.string().max(20_000).optional().describe(d("fields.memory_strategy.context")),
        agentId: z.string().optional().describe(d("fields.memory_strategy.agentId")),
        supersedesId: z.string().optional().describe(d("fields.memory_strategy.supersedesId")),
        status: StatusEnum.optional().describe(d("fields.memory_strategy.status")),
        validFrom: isoDateTimeInput().optional().describe(d("fields.memory_strategy.validFrom")),
        validTo: isoDateTimeInput().optional().describe(d("fields.memory_strategy.validTo")),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(d("fields.memory_strategy.metadata")),
        statusFilter: z
          .enum(["active", "superseded", "archived"])
          .optional()
          .describe(d("fields.memory_strategy.statusFilter")),
        validAt: isoDateTimeInput().optional().describe(d("fields.memory_strategy.validAt")),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(d("fields.memory_strategy.limit")),
        sensitivity: z
          .enum(["public", "internal", "confidential", "restricted"])
          .optional()
          .describe(d("fields.memory_strategy.sensitivity")),
        scopeRef: z.string().optional().describe(d("fields.memory_strategy.scopeRef")),
        idempotencyKey: z.string().optional().describe(d("fields.memory_strategy.idempotencyKey")),
        targetWorkspaceId: z
          .uuid()
          .optional()
          .describe(d("fields.memory_strategy.targetWorkspaceId")),
      },
    },
    async (args) => {
      let result: unknown;
      try {
        if (args.targetWorkspaceId !== undefined && args.op !== "create" && args.op !== "store") {
          return errorOut(
            t(locale, "out.targetWorkspaceOnlyCreate", { when: "op='create'/'store'" })
          );
        }
        // APP-022: patch drops both server-side; scopeRef is also a list/recall filter.
        const creates = args.op === "create" || args.op === "store";
        const ignored = creates
          ? undefined
          : args.sensitivity !== undefined
            ? "sensitivity"
            : args.scopeRef !== undefined && args.op !== "list" && args.op !== "recall"
              ? "scopeRef"
              : undefined;
        if (ignored) {
          return errorOut(
            t(locale, "out.onlyOnCreate", {
              field: ignored,
              when:
                ignored === "scopeRef" ? "op='create'/'store'/'list'/'recall'" : "op='create'/'store'",
              action: `op='${args.op}'`,
            })
          );
        }
        switch (args.op) {
          case "store":
          case "create": {
            if (!args.trigger || !args.action)
              return errorOut(t(locale, "out.memory_strategy.createNeeds", { op: args.op }));
            const body: Record<string, unknown> = { trigger: args.trigger, action: args.action };
            if (args.context !== undefined) body["context"] = args.context;
            if (args.agentId !== undefined) body["agentId"] = args.agentId;
            if (args.scopeRef !== undefined) body["scopeRef"] = args.scopeRef;
            if (args.supersedesId !== undefined) body["supersedesId"] = args.supersedesId;
            if (args.validFrom !== undefined) body["validFrom"] = args.validFrom;
            if (args.sensitivity !== undefined) body["sensitivity"] = args.sensitivity;
            if (args.metadata !== undefined) body["metadata"] = args.metadata;
            if (args.targetWorkspaceId !== undefined)
              body["targetWorkspaceId"] = args.targetWorkspaceId;
            result = await client.createStrategy(
              body as unknown as Parameters<typeof client.createStrategy>[0],
              undefined,
              args.idempotencyKey
            );
            break;
          }
          case "get": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "get", field: "id" }));
            result = await client.getStrategy(args.id);
            break;
          }
          case "recall":
          case "list": {
            // §24 `recall` = retrieve relevant strategies. We map it to the
            // workspace strategy list; `recall` defaults to the "active" slice
            // (the heuristics worth executing now) unless an explicit filter is
            // given, while plain `list` stays unfiltered for back-compat.
            const params: Record<string, unknown> = {};
            if (args.statusFilter !== undefined) params["status"] = args.statusFilter;
            else if (args.op === "recall") params["status"] = "active";
            if (args.scopeRef !== undefined) params["scopeRef"] = args.scopeRef;
            if (args.validAt !== undefined) params["validAt"] = args.validAt;
            if (args.limit !== undefined) params["limit"] = args.limit;
            result = await client.listStrategies(
              params as Parameters<typeof client.listStrategies>[0]
            );
            break;
          }
          case "rate": {
            // §24 `rate` records the success/failure outcome of a strategy so the
            // server can update successCount/failureCount and recompute worth via
            // Beta-Bernoulli: alpha=2+successCount, beta=2+failureCount, worth=alpha/(alpha+beta).
            if (!args.id || !args.outcome)
              return errorOut(t(locale, "out.memory_strategy.rateNeeds"));
            result = await client.rateStrategy(args.id, args.outcome as "success" | "failure");
            break;
          }
          case "patch": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "patch", field: "id" }));
            const patch: Record<string, unknown> = {};
            if (args.trigger !== undefined) patch["trigger"] = args.trigger;
            if (args.action !== undefined) patch["action"] = args.action;
            if (args.context !== undefined) patch["context"] = args.context;
            if (args.status !== undefined) patch["status"] = args.status;
            if (args.validTo !== undefined) patch["validTo"] = args.validTo;
            if (args.metadata !== undefined) patch["metadata"] = args.metadata;
            result = await client.patchStrategy(
              args.id,
              patch as Parameters<typeof client.patchStrategy>[1]
            );
            break;
          }
          case "archive": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "archive", field: "id" }));
            await client.archiveStrategy(args.id);
            result = { id: args.id, archived: true };
            break;
          }
        }
      } catch (err) {
        return formatMcpError("memory_strategy", err, locale);
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
