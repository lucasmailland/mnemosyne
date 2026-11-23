import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_compare` — fetches two facts by ID and returns a structured
 * diff, a suggested relation verb, and a same-subject assessment.
 *
 * Useful for answering:
 *   - "Are these two decisions contradicting each other?"
 *   - "Did I update my preference?"
 *   - "Is factB a refinement of factA?"
 *
 * Thin HTTP caller (docs/archive/openspec/decompose-recall-and-compare, Slice 2) — all
 * comparison logic (`computeDifferences`/`detectSameSubject`/`suggestVerb`)
 * now lives server-side in `packages/server/src/facts/compare.ts`, reachable
 * by any HTTP client, not only this MCP process. This tool just forwards
 * both ids to `client.compareFacts()` (POST /facts/compare) and returns its
 * response verbatim.
 *
 * Verb suggestion heuristic (server-side, see `facts/compare.ts`):
 *   - Both refer to the same subject AND one was created later      → supersedes
 *   - Same subject, different claims, no clear temporal order       → conflicts_with
 *   - One fact's content is a subset / qualifier of the other       → scoped
 *   - Everything else (including different workspaces)              → compatible
 *
 * Diff scope: content, pinned, and the valid-time interval only — `mnemo_fact`
 * has no persisted `tags` column, so tag-based diffing was removed rather than
 * left as unreachable dead code (docs/archive/openspec/complete-mcp-tools, B6).
 */
export function registerCompare(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_compare",
    {
      title: "Compare two facts",
      inputSchema: {
        factIdA: z.string().min(1).describe(d("fields.memory_compare.factIdA")),
        factIdB: z.string().min(1).describe(d("fields.memory_compare.factIdB")),
      },
    },
    async ({ factIdA, factIdB }) => {
      try {
        const result = await client.compareFacts({ factIdA, factIdB });
        return {
          content: [{ type: "text" as const, text: jsonText(result) }],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_compare", err, locale);
      }
    }
  );
}
