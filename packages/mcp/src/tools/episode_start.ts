import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";

/**
 * `memory_episode_start` — starts a new ephemeral session (episode).
 *
 * Delegates to `client.createSession()` → POST /session/start.
 * Returns the session id so the caller can pass it to
 * `memory_episode_end` when the conversation is over.
 */
export function registerEpisodeStart(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_episode_start",
    {
      title: "Start memory episode",
      inputSchema: {
        agentId: z.string().optional().describe(d("fields.memory_episode_start.agentId")),
        label: z.string().optional().describe(d("fields.memory_episode_start.label")),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(d("fields.memory_episode_start.metadata")),
        idempotencyKey: z
          .string()
          .optional()
          .describe(d("fields.memory_episode_start.idempotencyKey")),
      },
    },
    async (args) => {
      try {
        const session = await client.createSession(
          { agentId: args.agentId, label: args.label, metadata: args.metadata },
          undefined,
          args.idempotencyKey
        );
        const labelSuffix = session.label
          ? t(locale, "out.memory_episode_start.label", { label: session.label })
          : "";
        return {
          content: [
            {
              type: "text",
              text: t(locale, "out.memory_episode_start.started", {
                sessionId: session.id,
                label: labelSuffix,
              }),
            },
          ],
          isError: false,
        };
      } catch (err) {
        return formatMcpError("memory_episode_start", err, locale);
      }
    }
  );
}
