import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MnemosyneAPIError, type MnemosyneClient } from "@mnemo-ai/client-ts";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";

/**
 * `memory_consolidate` — triggers an on-demand consolidation pass on the
 * Mnemosyne server for the caller's workspace.
 *
 * Delegates to `POST /consolidation/trigger` via @mnemo-ai/client-ts.
 * The server-side consolidation scheduler already runs on a background
 * interval; this tool is for forcing a pass immediately — e.g. after a
 * large batch of `memory_remember` calls, or when an orchestrator wants
 * to process the current bounded low-worth candidate set before reasoning.
 *
 * Only fast mode with dryRun false is currently supported. Manual deep mode
 * and dry-run requests return HTTP 422 without running consolidation.
 */
export function registerConsolidate(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_consolidate",
    {
      title: "Consolidate memory",
      inputSchema: {
        mode: z
          .enum(["fast", "deep"])
          .optional()
          .default("fast")
          .describe(d("fields.memory_consolidate.mode")),
        dryRun: z
          .boolean()
          .optional()
          .default(false)
          .describe(d("fields.memory_consolidate.dryRun")),
        idempotencyKey: z
          .string()
          .optional()
          .describe(d("fields.memory_consolidate.idempotencyKey")),
      },
    },
    async (args) => {
      const mode = (args.mode ?? "fast") as "fast" | "deep";
      const dryRun = args.dryRun ?? false;

      let result: Awaited<ReturnType<typeof client.triggerConsolidation>>;
      try {
        result = await client.triggerConsolidation(
          { mode, dryRun },
          undefined,
          args.idempotencyKey
        );
      } catch (err: unknown) {
        let text: string;
        if (err instanceof MnemosyneAPIError) {
          const code = err.code ?? "unknown_error";
          text = t(locale, "out.failed", {
            tool: "memory_consolidate",
            message: `HTTP ${err.status} (${code}): ${err.message}`,
          });

          if (err.status === 503 && err.code === "consolidation_unavailable") {
            text += `\n\n${t(locale, "out.memory_consolidate.installConsolidation")}`;
          } else if (err.status === 503 && err.code === "storage_unavailable") {
            text += `\n\n${t(locale, "out.memory_consolidate.wirePostgres")}`;
          }
        } else {
          const message = err instanceof Error ? err.message : String(err);
          text = t(locale, "out.failed", { tool: "memory_consolidate", message });
        }

        return {
          content: [
            {
              type: "text" as const,
              text,
            },
          ],
          isError: true,
        };
      }

      const lines: string[] = [
        t(
          locale,
          dryRun ? "out.memory_consolidate.completeDryRun" : "out.memory_consolidate.complete"
        ),
        `  mode:       ${result.mode}`,
        `  candidates: ${result.candidatesProcessed}`,
        `  merged:     ${t(locale, "out.memory_consolidate.pairs", { n: result.mergedPairs })}`,
        `  skipped:    ${t(locale, "out.memory_consolidate.pairs", { n: result.skippedPairs })}`,
        `  errors:     ${result.errors}`,
        `  took:       ${result.tookMs} ms`,
      ];

      if (result.mergedPairs === 0 && result.skippedPairs === 0 && result.errors === 0) {
        lines.push(
          "",
          result.candidatesProcessed === 0
            ? t(locale, "out.memory_consolidate.noCandidates")
            : t(locale, "out.memory_consolidate.noClusters")
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: lines.join("\n"),
          },
        ],
      };
    }
  );
}
