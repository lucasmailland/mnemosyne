import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_suggest_topic_key` — derive a deterministic, idempotent
 * `topicKey` from a subject/body pair, without writing anything.
 *
 * Pure proxy: this tool does NO local computation. It calls
 * `client.suggestTopicKey()`, which hits `POST /topic-key/suggest`, which
 * calls `@mnemo-ai/core`'s `suggestTopicKey()` — the single source of
 * truth for the derivation algorithm (see
 * docs/archive/openspec/topickey-suggest-and-hit-freshness/design.md §1). Keeping the
 * algorithm out of the MCP layer means it can never drift between the
 * tool, the HTTP API, and any other caller of the route.
 *
 * Use this BEFORE `memory_remember(kind:"fact"|"decision", topicKey:...)`
 * or `memory_decide(topicKey:...)` to get a stable idempotency key instead
 * of hand-rolling one — the same subject/body pair always derives the same
 * key, and feeding a previously-derived key back in as `subject` (no
 * `body`) returns it unchanged.
 */
export function registerSuggestTopicKey(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_suggest_topic_key",
    {
      title: "Suggest a topicKey",
      inputSchema: {
        subject: z.string().optional().describe(d("fields.memory_suggest_topic_key.subject")),
        body: z.string().optional().describe(d("fields.memory_suggest_topic_key.body")),
        attribute: z
          .string()
          .max(200)
          .optional()
          .describe(d("fields.memory_suggest_topic_key.attribute")),
      },
    },
    async ({ subject, body, attribute }) => {
      try {
        const input: Parameters<MnemosyneClient["suggestTopicKey"]>[0] = {
          ...(subject !== undefined ? { subject } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(attribute !== undefined ? { attribute } : {}),
        };
        const result = await client.suggestTopicKey(input);

        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_suggest_topic_key", err, locale);
      }
    }
  );
}
