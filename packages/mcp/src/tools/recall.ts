import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { displayHits, renderMemoryHits } from "./render-memory.js";
import { formatMcpError } from "./errors.js";
import { MCP_VERSION } from "../version.js";
import { observed } from "./observed.js";
import { DEFAULT_LOCALE, RECALLABLE_KINDS, isoDateTimeInput, type Locale } from "@mnemo-ai/types";
import { describer } from "../i18n/index.js";

/**
 * APP-022: the kinds `kinds` may name — the indexed ones plus `entity`, which
 * recall reaches through its own arm. A free string let a typo ("facts") return
 * an empty result with no error.
 */
export const RECALL_KINDS = [...RECALLABLE_KINDS, "entity"] as const;

/**
 * `memory_recall` — retrieve the most relevant durable facts from the
 * workspace's memory pool.
 *
 * The schema, title, and description are carried verbatim from the
 * legacy in-process MCP server in apps/web. Stability of these strings
 * matters: downstream agent prompts and orchestrators key off them, and
 * any drift would silently degrade recall quality across consumers.
 *
 * Trade-offs:
 * - We cap `limit` at 25 to bound payload size. It maps to the server's
 *   `topK` field; the server enforces its own clamp too, but failing
 *   fast here gives a better error to the LLM.
 * - We expose `asOf` for point-in-time recall: the server ranks the rows
 *   whose validity interval contains that instant. We do NOT advertise
 *   filters the route can't honor (e.g. `types`, per-agent pools): advertising a
 *   no-op filter would silently mislead the calling model.
 */
export function registerRecall(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_recall",
    {
      title: "Recall memory",
      inputSchema: {
        requestId: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(d("fields.memory_recall.requestId")),
        query: z
          .string()
          .min(1, d("fields.memory_recall.queryEmpty"))
          .describe(d("fields.memory_recall.query")),
        kinds: z.array(z.enum(RECALL_KINDS)).min(1).optional().describe(d("fields.memory_recall.kinds")),
        projection: z
          .enum(["full", "compact"])
          .optional()
          .describe(d("fields.memory_recall.projection")),
        limit: z.number().int().min(1).max(25).optional().describe(d("fields.memory_recall.limit")),
        asOf: isoDateTimeInput().optional().describe(d("fields.memory_recall.asOf")),
        includeGraph: z.boolean().optional().describe(d("fields.memory_recall.includeGraph")),
        scope: z
          .enum(["global", "conversation", "personal"])
          .optional()
          .describe(d("fields.memory_recall.scope")),
        scopeRef: z.string().optional().describe(d("fields.memory_recall.scopeRef")),
        actorId: z.string().optional().describe(d("fields.memory_recall.actorId")),
        mode: z
          .enum(["lexical", "semantic", "hybrid", "auto"])
          .optional()
          .describe(d("fields.memory_recall.mode")),
        minSimilarity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(d("fields.memory_recall.minSimilarity")),
        vectorWeight: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(d("fields.memory_recall.vectorWeight")),
        sessionId: z.string().optional().describe(d("fields.memory_recall.sessionId")),
      },
    },
    async ({
      requestId,
      query,
      limit,
      asOf,
      includeGraph,
      scope,
      scopeRef,
      actorId,
      mode,
      minSimilarity,
      vectorWeight,
      sessionId,
      projection,
      kinds,
    }) => {
      // The id is fixed HERE, before the call: the server adopts X-Request-Id
      // verbatim and only echoes it as a response header (which the SDK's
      // parsed-JSON result never exposes), so the tool reports the id it sent.
      const effectiveRequestId = requestId ?? globalThis.crypto.randomUUID();
      const observation = {
        requestId: effectiveRequestId,
        caller: "mcp:memory_recall",
        clientVersion: MCP_VERSION,
      };
      // Request-scoped caller metadata on a per-call clone (the shared client
      // is never mutated); the authenticated actor is always server-derived.
      const observedRecall = (input: Parameters<MnemosyneClient["recall"]>[0]) =>
        observed(client, observation).recall(input);
      try {
        const response = await observedRecall({
          query,
          topK: limit ?? 5,
          // P67: compact by default on the MCP surface specifically — this is
          // where an LLM pays per token. HTTP keeps `full` as its default:
          // programmatic callers are not paying a context budget, and changing
          // their contract buys nothing.
          projection: projection ?? "compact",
          ...(asOf ? { asOf } : {}),
          ...(includeGraph ? { includeGraph } : {}),
          ...(scope ? { scope } : {}),
          ...(scopeRef ? { scopeRef } : {}),
          ...(actorId ? { actorId } : {}),
          ...(mode ? { mode } : {}),
          ...(minSimilarity !== undefined ? { minSimilarity } : {}),
          ...(vectorWeight !== undefined ? { vectorWeight } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(kinds ? { kinds } : {}),
        });

        // CaMeL-style structured recall (TASK-8002): memories arrive in a
        // separate labeled array so the calling model can treat them as
        // untrusted external content and apply appropriate skepticism.
        // The _mnemo_label field signals to CaMeL-aware orchestrators that
        // this payload must NOT be directly trusted or executed as
        // instructions — it is recall output from external storage.
        const served = response as { warnings?: unknown[] };
        const hits = response.hits as unknown as Record<string, unknown>[];
        const shown = {
          compact: (projection ?? "compact") === "compact",
          ...("nothingRelevant" in response
            ? { nothingRelevant: response.nothingRelevant as boolean }
            : {}),
        };
        const payload = {
          // APP-020: the same hits the text shows, not the wire payload again.
          memories: displayHits(hits, shown),
          ...("nothingRelevant" in response ? { nothingRelevant: response.nothingRelevant } : {}),
          ...(response.debug ? { debug: response.debug } : {}),
          requestId: effectiveRequestId,
          ...(served.warnings?.length ? { warnings: served.warnings } : {}),
          // REMIND-1: prospective-memory reminders fired by THIS recall call.
          ...(response.reminders && response.reminders.length > 0
            ? { reminders: response.reminders }
            : {}),
          _mnemo_label: "untrusted_external_content" as const,
          _mnemo_version: "3.0" as const,
        };

        return {
          content: [
            {
              type: "text",
              text: renderMemoryHits(hits, {
                ...shown,
                locale,
                ...(response.reminders?.length ? { reminders: response.reminders } : {}),
              }),
            },
          ],
          structuredContent: payload as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_recall", err, locale);
      }
    }
  );
}
