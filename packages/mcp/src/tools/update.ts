import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_update` — ergonomic wrapper for correcting an existing fact.
 *
 * Delegates to `client.selfEdit` with `action: "replace"` so the server
 * applies the full bitemporal replace: closes `valid_to` on the current
 * fact and creates a new row with the corrected statement. The caller only
 * needs to supply the fact ID and the new statement — the bitemporal
 * bookkeeping is invisible from this surface.
 *
 * Design: this is intentionally thin. All business logic (authz, RLS,
 * authorization and worth inheritance lives in the server's SelfEditPolicy.
 * We do not re-implement any of that here.
 */
export function registerUpdate(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_update",
    {
      title: "Update a fact",
      inputSchema: {
        factId: z
          .string()
          .min(1, d("fields.memory_update.factIdRequired"))
          .describe(d("fields.memory_update.factId")),
        statement: z.string().min(1).max(1000).describe(d("fields.memory_update.statement")),
        reason: z.string().optional().describe(d("fields.memory_update.reason")),
        sessionId: z.string().optional().describe(d("fields.memory_update.sessionId")),
      },
    },
    async ({ factId, statement, reason, sessionId }) => {
      try {
        const result = await client.selfEdit({
          action: "replace",
          target: factId,
          content: statement,
          reason: reason ?? "Updated via memory_update",
          ...(sessionId ? { sessionId } : {}),
        });
        return {
          content: [{ type: "text" as const, text: jsonText(result) }],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_update", err, locale);
      }
    }
  );
}
