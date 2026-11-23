import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { collapseTimeoutMs } from "../env.js";

/**
 * `memory_episode_end` — closes an open episode and collapses its
 * ephemeral buffer into durable memory.
 *
 * Delegates to `client.collapseSession()` → POST /session/:id/collapse.
 * The collapse pipeline extracts facts, decisions and strategies from the
 * session turns, links them to the knowledge graph and marks the session
 * closed.
 */
export function registerEpisodeEnd(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_episode_end",
    {
      title: "End memory episode",
      inputSchema: {
        sessionId: z
          .string()
          .min(1, d("fields.memory_episode_end.sessionIdEmpty"))
          .describe(d("fields.memory_episode_end.sessionId")),
        collapseHint: z.string().optional().describe(d("fields.memory_episode_end.collapseHint")),
        idempotencyKey: z
          .string()
          .optional()
          .describe(d("fields.memory_episode_end.idempotencyKey")),
      },
    },
    async (args) => {
      try {
        // APP-014: a collapse runs an LLM pass (~50 s measured); the shared
        // client's budget made every one of them report a timeout.
        const result = await client.withTimeout(collapseTimeoutMs()).collapseSession(
          args.sessionId,
          {
            // collapseHint is advisory metadata; the HTTP route maps
            // "explicit" strategy when a hint is provided so the pipeline
            // does a full LLM pass rather than relying on the recurrence gate.
            strategy: args.collapseHint ? "explicit" : "auto",
            ...(args.collapseHint ? { collapseHint: args.collapseHint } : {}),
          },
          undefined,
          args.idempotencyKey
        );
        // The server has reported the pipeline's verdict since P115, and the
        // route's own comment says why it had to: `accepted:true` with no
        // other signal is exactly what let discarded sessions stay invisible.
        // Reporting "collapsed" unconditionally here recreated that blindness
        // one layer up — the caller was told its knowledge was saved even when
        // the pipeline had skipped extraction entirely. So the verdict travels
        // out, verbatim, and a skip reads as a skip.
        const status = result.status ?? "completed";
        const reason = result.skipReason
          ? t(locale, "out.memory_episode_end.reason", { reason: result.skipReason })
          : "";
        // A failure is an error (nothing was written); `collapse_pending` is
        // accepted work still running, not a skip (APP-014).
        const text =
          status === "completed"
            ? t(locale, "out.memory_episode_end.completed", { sessionId: result.sessionId }) +
              (result.resumed ? t(locale, "out.memory_episode_end.resumed") : "")
            : status === "failed"
              ? t(locale, "out.memory_episode_end.failed", { reason, sessionId: result.sessionId })
              : status === "collapse_pending"
                ? t(locale, "out.memory_episode_end.pending", { sessionId: result.sessionId })
                : t(locale, "out.memory_episode_end.skipped", {
                    status,
                    reason,
                    sessionId: result.sessionId,
                    why: t(
                      locale,
                      result.skipReason === "llm_unavailable"
                        ? "out.memory_episode_end.llmUnavailable"
                        : "out.memory_episode_end.turnsPreserved"
                    ),
                  });
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            sessionId: result.sessionId,
            status,
            ...(result.skipReason ? { skipReason: result.skipReason } : {}),
            ...(result.resumed !== undefined ? { resumed: result.resumed } : {}),
          },
          isError: status === "failed",
        };
      } catch (err) {
        return formatMcpError("memory_episode_end", err, locale);
      }
    }
  );
}
