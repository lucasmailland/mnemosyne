import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

export function registerHyperedge(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_hyperedge",
    {
      title: "Manage n-ary memory relations",
      inputSchema: {
        action: z.enum(["create", "get", "list", "patch", "archive"]),
        id: z.string().optional(),
        memberIds: z
          .array(z.string())
          .min(3)
          .max(50)
          .optional()
          .describe(d("fields.memory_hyperedge.memberIds")),
        label: z.string().min(1).max(200).optional(),
        description: z.string().max(20_000).optional(),
        contextQuery: z.string().max(20_000).optional(),
        // list filters
        memberIdFilter: z.string().optional(),
        labelFilter: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        idempotencyKey: z.string().optional().describe(d("fields.memory_hyperedge.idempotencyKey")),
      },
    },
    async (args) => {
      let result: unknown;
      try {
        switch (args.action) {
          case "create": {
            if (!args.memberIds || args.memberIds.length < 3) {
              return {
                isError: true as const,
                content: [
                  {
                    type: "text" as const,
                    text: t(locale, "out.memory_hyperedge.createNeeds"),
                  },
                ],
              };
            }
            const body: Parameters<typeof client.createHyperedge>[0] = {
              memberIds: args.memberIds,
            };
            if (args.label) body.label = args.label;
            if (args.description) body.description = args.description;
            if (args.contextQuery) body.contextQuery = args.contextQuery;
            result = await client.createHyperedge(body, undefined, args.idempotencyKey);
            break;
          }
          case "get": {
            if (!args.id) {
              return {
                isError: true as const,
                content: [
                  {
                    type: "text" as const,
                    text: t(locale, "out.requires", { action: "get", field: "id" }),
                  },
                ],
              };
            }
            result = await client.getHyperedge(args.id);
            break;
          }
          case "list": {
            const params: Parameters<typeof client.listHyperedges>[0] = {};
            if (args.memberIdFilter) params.memberId = args.memberIdFilter;
            if (args.labelFilter) params.label = args.labelFilter;
            if (args.limit) params.limit = args.limit;
            result = await client.listHyperedges(params);
            break;
          }
          case "patch": {
            if (!args.id) {
              return {
                isError: true as const,
                content: [
                  {
                    type: "text" as const,
                    text: t(locale, "out.requires", { action: "patch", field: "id" }),
                  },
                ],
              };
            }
            const patch: Parameters<typeof client.patchHyperedge>[1] = {};
            if (args.label !== undefined) patch.label = args.label;
            if (args.description !== undefined) patch.description = args.description;
            if (args.contextQuery !== undefined) patch.contextQuery = args.contextQuery;
            result = await client.patchHyperedge(args.id, patch);
            break;
          }
          case "archive": {
            if (!args.id) {
              return {
                isError: true as const,
                content: [
                  {
                    type: "text" as const,
                    text: t(locale, "out.requires", { action: "archive", field: "id" }),
                  },
                ],
              };
            }
            await client.archiveHyperedge(args.id);
            result = { id: args.id, archived: true };
            break;
          }
        }
      } catch (err) {
        return formatMcpError("memory_hyperedge", err, locale);
      }
      return {
        content: [{ type: "text" as const, text: jsonText(result) }],
        structuredContent: result as { [key: string]: unknown },
      };
    }
  );
}
