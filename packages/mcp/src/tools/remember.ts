import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { MCP_VERSION } from "../version.js";
import { observed } from "./observed.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_remember` — persist a durable fact discovered during a
 * conversation.
 *
 * Why the parameters are loosely typed:
 * - `kind` is intentionally `string` (not a Zod enum). The product side
 *   evolves the taxonomy faster than the protocol; freezing it at the
 *   MCP boundary would break clients every time a new kind ships.
 * - `confidence` is clamped server-side to [0, 1]; we mirror the bound
 *   here so the LLM gets a helpful validation error rather than a 400.
 *
 * Idempotency: the server hashes the statement content and dedupes, so
 * an agent that re-issues the same `remember` call (e.g. after a retry)
 * won't create duplicate facts. We do NOT expose the hash here because
 * leaking it would let callers depend on an internal stability contract
 * we may want to change.
 */
export function registerRemember(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_remember",
    {
      title: "Remember a fact",
      inputSchema: {
        statement: z
          .string()
          .min(1, d("fields.memory_remember.statementLength"))
          .max(1000, d("fields.memory_remember.statementLength"))
          .describe(d("fields.memory_remember.statement")),
        subject: z.string().optional().describe(d("fields.memory_remember.subject")),
        kind: z.string().optional().describe(d("fields.memory_remember.kind")),
        subtype: z.string().optional().describe(d("fields.memory_remember.subtype")),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(d("fields.memory_remember.confidence")),
        agentId: z.string().optional().describe(d("fields.memory_remember.agentId")),
        conversationId: z.string().optional().describe(d("fields.memory_remember.conversationId")),
        idempotencyKey: z.string().optional().describe(d("fields.memory_remember.idempotencyKey")),
        scope: z
          .enum(["global", "conversation", "personal"])
          .optional()
          .describe(d("fields.memory_remember.scope")),
        scopeRef: z.string().optional().describe(d("fields.memory_remember.scopeRef")),
        scopeOwner: z.string().optional().describe(d("fields.memory_remember.scopeOwner")),
        targetWorkspaceId: z
          .string()
          .optional()
          .describe(d("fields.memory_remember.targetWorkspaceId")),
        topicKey: z.string().optional().describe(d("fields.memory_remember.topicKey")),
        sessionId: z.string().optional().describe(d("fields.memory_remember.sessionId")),
        episodeId: z.string().optional().describe(d("fields.memory_remember.episodeId")),
      },
    },
    async ({
      statement,
      subject,
      kind,
      subtype,
      confidence,
      agentId,
      conversationId,
      idempotencyKey,
      scope,
      scopeRef,
      scopeOwner,
      targetWorkspaceId,
      topicKey,
      sessionId,
      episodeId,
    }) => {
      try {
        // Request-scoped writer metadata; the actor is never caller-supplied.
        const result = await observed(client, {
          caller: "mcp:memory_remember",
          clientVersion: MCP_VERSION,
        }).remember(
          {
            statement,
            subject: subject ?? "workspace",
            kind: kind ?? "fact",
            ...(subtype ? { subtype } : {}),
            ...(confidence !== undefined ? { confidence } : {}),
            ...(agentId ? { agentId } : {}),
            ...(conversationId ? { conversationId } : {}),
            tags: [subtype ?? kind ?? "fact"],
            ...(scope ? { scope } : {}),
            ...(scopeRef ? { scopeRef } : {}),
            ...(scopeOwner ? { scopeOwner } : {}),
            ...(targetWorkspaceId ? { targetWorkspaceId } : {}),
            ...(topicKey ? { topicKey } : {}),
            ...(sessionId ? { sessionId } : {}),
            ...(episodeId ? { episodeId } : {}),
          },
          undefined,
          idempotencyKey
        );

        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_remember", err, locale);
      }
    }
  );
}
