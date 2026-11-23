// packages/mcp/src/tools/compose.ts
// §32 Compositionality — MCP tool for managing and running composition rules (Wave H5).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { z } from "zod";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

export function registerCompose(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  const req = (field: string, action: string) =>
    t(locale, "out.memory_compose.requiredFor", { field, action });
  server.registerTool(
    "memory_compose",
    {
      title: "Run or manage composition (inference) rules",
      inputSchema: {
        action: z
          .enum(["list", "create", "get", "patch", "dry_run", "inferences"])
          .describe(d("fields.memory_compose.action")),
        derivedId: z.string().optional().describe(d("fields.memory_compose.derivedId")),
        since: z.string().optional().describe(d("fields.memory_compose.since")),
        // list options
        isActive: z.boolean().optional().describe(d("fields.memory_compose.isActive")),
        offset: z.number().int().min(0).optional().describe(d("fields.memory_compose.offset")),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(d("fields.memory_compose.limit")),
        // get / patch
        ruleId: z.string().optional().describe(d("fields.memory_compose.ruleId")),
        // create / patch shared fields
        name: z.string().optional().describe(d("fields.memory_compose.name")),
        description: z.string().optional().describe(d("fields.memory_compose.description")),
        conditionDsl: z.unknown().optional().describe(d("fields.memory_compose.conditionDsl")),
        actionDsl: z.unknown().optional().describe(d("fields.memory_compose.actionDsl")),
        priority: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe(d("fields.memory_compose.priority")),
        // create only
        isActiveOnCreate: z
          .boolean()
          .optional()
          .describe(d("fields.memory_compose.isActiveOnCreate")),
        // dry_run only
        hits: z
          .array(
            z.object({
              id: z.string(),
              primitive: z.string(),
              content: z.string(),
              score: z.number().min(0).max(1),
              factKind: z.string().optional(),
              worth: z.number().optional(),
              tags: z.array(z.string()).optional(),
            })
          )
          .optional()
          .describe(d("fields.memory_compose.hits")),
      },
    },
    async (args) => {
      try {
        const { action } = args;
        let result: unknown;

        switch (action) {
          case "list": {
            result = await client.composition.listRules({
              ...(args.isActive !== undefined ? { isActive: args.isActive } : {}),
              ...(args.offset != null ? { offset: args.offset } : {}),
              ...(args.limit != null ? { limit: args.limit } : {}),
            });
            break;
          }

          // P111 — the inference log had a writer and no reader anywhere.
          case "inferences": {
            result = await client.composition.listInferences({
              ...(args.ruleId !== undefined ? { ruleId: args.ruleId } : {}),
              ...(args.derivedId !== undefined ? { derivedId: args.derivedId } : {}),
              ...(args.since !== undefined ? { since: args.since } : {}),
              ...(args.offset != null ? { offset: args.offset } : {}),
              ...(args.limit != null ? { limit: args.limit } : {}),
            });
            break;
          }

          case "create": {
            if (!args.name) throw new Error(req("name", "create"));
            if (!args.conditionDsl) throw new Error(req("conditionDsl", "create"));
            if (!args.actionDsl) throw new Error(req("actionDsl", "create"));
            result = await client.composition.createRule({
              name: args.name,
              conditionDsl: args.conditionDsl,
              actionDsl: args.actionDsl,
              ...(args.description != null ? { description: args.description } : {}),
              ...(args.priority != null ? { priority: args.priority } : {}),
              ...(args.isActiveOnCreate !== undefined ? { isActive: args.isActiveOnCreate } : {}),
            });
            break;
          }

          case "get": {
            if (!args.ruleId) throw new Error(req("ruleId", "get"));
            result = await client.composition.getRule(args.ruleId);
            break;
          }

          case "patch": {
            if (!args.ruleId) throw new Error(req("ruleId", "patch"));
            result = await client.composition.patchRule(args.ruleId, {
              ...(args.name != null ? { name: args.name } : {}),
              ...(args.description != null ? { description: args.description } : {}),
              ...(args.conditionDsl != null ? { conditionDsl: args.conditionDsl } : {}),
              ...(args.actionDsl != null ? { actionDsl: args.actionDsl } : {}),
              ...(args.priority != null ? { priority: args.priority } : {}),
              ...(args.isActive !== undefined ? { isActive: args.isActive } : {}),
            });
            break;
          }

          case "dry_run": {
            if (!args.ruleId && !args.conditionDsl) {
              throw new Error(t(locale, "out.memory_compose.dryRunNeeds"));
            }
            const dryRunInput: Parameters<typeof client.composition.dryRun>[0] = {
              hits: args.hits ?? [],
            };
            if (args.ruleId) {
              dryRunInput.ruleId = args.ruleId;
            } else {
              dryRunInput.rule = {
                name: args.name ?? "inline-dry-run",
                conditionDsl: args.conditionDsl!,
                actionDsl: args.actionDsl!,
                ...(args.priority != null ? { priority: args.priority } : {}),
              };
            }
            result = await client.composition.dryRun(dryRunInput);
            break;
          }
        }

        return {
          content: [{ type: "text" as const, text: jsonText(result) }],
          structuredContent: result as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_compose", err, locale);
      }
    }
  );
}
