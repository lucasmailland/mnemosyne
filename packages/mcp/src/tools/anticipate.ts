import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { z } from "zod";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

export function registerAnticipate(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_anticipate",
    {
      title: "What memory might be useful next?",
      inputSchema: {
        recentlyRecalledId: z
          .string()
          .optional()
          .describe(d("fields.memory_anticipate.recentlyRecalledId")),
        context: z.string().max(500).optional().describe(d("fields.memory_anticipate.context")),
        lookAhead: z
          .number()
          .int()
          .min(0)
          .max(10_080)
          .optional()
          .describe(d("fields.memory_anticipate.lookAhead")),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ recentlyRecalledId, context, lookAhead, limit }) => {
      try {
        const feed = await client.getAnticipationFeed({
          recentlyRecalledId,
          context,
          lookAhead,
          limit,
        });
        return {
          content: [{ type: "text" as const, text: jsonText(feed) }],
          structuredContent: feed as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_anticipate", err, locale);
      }
    }
  );
}
