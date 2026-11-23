import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_purge` — hard-delete facts from a workspace.
 *
 * Two actions:
 *   - `fact`   — hard-delete a single fact by ID.
 *   - `closed` — bulk-delete all forgotten (soft-deleted) facts in the workspace.
 *
 * Both actions require the API key to have the `memory:hard_delete` scope.
 * The server returns 403 when the scope is absent.
 *
 * FIXED 2026-07-31 (PURGE-1) — previously both actions always 404'd and
 * deleted nothing (`deps.core.hardDeleteFact`/`purgeClosedFacts` were
 * declared but never implemented on `createCore()`, and `DELETE
 * /facts/purge` was registered after `DELETE /facts/{id}` and silently
 * unreachable). Both bugs are fixed — see
 * packages/server/src/__tests__/integration/purge-facts-hard-delete.integration.test.ts
 * for the proving tests and docs/STATUS.md's `memory_purge` row.
 *
 * NOT a GDPR-compliant erasure: this performs a raw `DELETE FROM mnemo_fact`
 * only — no deletion-log entry, no actor DEK crypto-erasure, no audit trail.
 * GDPR Article 17 erasure of a person is the operator route
 * `POST /admin/erasure` (destroys their encryption keys; CLI `mnemo erase`),
 * deliberately not an MCP tool. Use `memory_purge` for test-workspace cleanup.
 *
 * DESTRUCTIVE: unlike `memory_forget`'s soft mode, this permanently removes
 * rows from `mnemo_fact` with no undo.
 */
export function registerPurge(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_purge",
    {
      title: "Purge facts (hard-delete, non-GDPR)",
      inputSchema: {
        action: z.enum(["fact", "closed"]).describe(d("fields.memory_purge.action")),
        factId: z.string().optional().describe(d("fields.memory_purge.factId")),
        confirm: z.boolean().optional().describe(d("fields.memory_purge.confirm")),
      },
    },
    async ({ action, factId, confirm }) => {
      try {
        if (action === "fact") {
          if (!factId || factId.trim() === "") {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: t(locale, "out.failed", {
                    tool: "memory_purge",
                    message: t(locale, "out.memory_purge.factIdRequired"),
                  }),
                },
              ],
            };
          }
          const result = await client.purgeFact(factId.trim());
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: result as unknown as { [key: string]: unknown },
          };
        }

        // action === "closed": every forgotten fact, no undo. One explicit flag
        // keeps a mistyped action from wiping the workspace's history.
        if (confirm !== true) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: t(locale, "out.failed", {
                  tool: "memory_purge",
                  message: t(locale, "out.memory_purge.confirmRequired"),
                }),
              },
            ],
          };
        }
        const result = await client.purgeClosedFacts();
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_purge", err, locale);
      }
    }
  );
}
