import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { displayHits, renderMemoryHits } from "./render-memory.js";
import { formatMcpError } from "./errors.js";
import { RECALL_KINDS } from "./recall.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";

/**
 * `memory_search` — búsqueda semántica pura (vectorial) en el pool de
 * memoria del workspace.
 *
 * A diferencia de `memory_recall` que puede usar pesos mixtos, este tool
 * prioriza ranking vectorial 100% semántico cuando hay embedder
 * disponible. Útil cuando la similitud conceptual importa más que el
 * match lexical exacto.
 *
 * CaMeL-style output: el payload `structuredContent` incluye
 * `_mnemo_label: "untrusted_external_content"` para que los orchestrators
 * downstream puedan tratar los resultados con el nivel de confianza
 * correcto antes de actuar sobre ellos.
 *
 * MCP-1 fix (2026-07-29, see docs/archive/openspec/tool-promise-remediation/spec.md
 * Requirement 8): `POST /recall` (packages/server/src/routes/recall.ts)
 * used to silently drop the request's `vectorWeight`/`mode` fields before
 * they reached `RecallQuery` — every call resolved to `mode: "auto"`
 * regardless of what was requested. That routing bug is now fixed: `mode`
 * and `vectorWeight` genuinely reach `recallCold()`.
 *
 * That fix is WHY this tool deliberately does NOT force `mode: "semantic"`
 * (nor `vectorWeight: 1.0`, which `recallCold` treats identically — see its
 * `requestedMode` ternary in recall-cold.ts) even though "100% semántica"
 * is the promise: a REAL strict `"semantic"` mode throws
 * `semantic_search_unavailable` when no embedder is configured, by design
 * (B5.9, no silent fallback) — proven in
 * packages/core/src/cognitive/__tests__/search-mode-fts-fallback.contract.test.ts.
 * Forcing it here, now that it actually reaches core, would turn every
 * no-embedder call into a hard error and break this tool's own documented
 * FTS-fallback promise. So this tool omits `mode`/`vectorWeight` entirely
 * and relies on the default `"auto"` mode instead, which — proven in
 * packages/server/src/__tests__/integration/
 * search-recall-vectorweight-noop.integration.test.ts — produces IDENTICAL
 * ranking/scores to strict `"semantic"` whenever an embedder IS available
 * (both run the same HNSW vector cascade; `"auto"` only differs from
 * `"semantic"` in that it degrades to FTS instead of throwing when the
 * embedder is unavailable). So the "100% semántica" claim holds in
 * practice with no loss, and the FTS-fallback claim now holds by genuine
 * design rather than as a side effect of the routing bug.
 * The `debug` field below (when present) reports the real `searchMode`
 * used for that specific call, so a caller who wants ground truth can
 * check it instead of assuming "semantic" from the tool's name alone.
 */
export function registerSearch(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_search",
    {
      title: "Search memory (semantic)",
      inputSchema: {
        query: z
          .string()
          .min(1, d("fields.memory_search.queryEmpty"))
          .describe(d("fields.memory_search.query")),
        kinds: z.array(z.enum(RECALL_KINDS)).min(1).optional().describe(d("fields.memory_search.kinds")),
        limit: z.number().int().min(1).max(20).optional().describe(d("fields.memory_search.limit")),
        scope: z
          .enum(["global", "conversation", "personal"])
          .optional()
          .describe(d("fields.memory_search.scope")),
        scopeRef: z.string().optional().describe(d("fields.memory_search.scopeRef")),
        actorId: z.string().optional().describe(d("fields.memory_search.actorId")),
      },
    },
    async ({ query, limit, scope, scopeRef, actorId, kinds }) => {
      try {
        // Deliberately omits mode/vectorWeight — see the MCP-1 fix note
        // above: default "auto" ranks identically to strict "semantic" when
        // an embedder is available, and degrades to FTS instead of
        // throwing when it isn't.
        const result = await client.recall({
          query,
          topK: limit ?? 5,
          // APP-020: same budget as memory_recall; a cut hit says how to get the rest.
          projection: "compact",
          ...(scope ? { scope } : {}),
          ...(scopeRef ? { scopeRef } : {}),
          ...(actorId ? { actorId } : {}),
          ...(kinds ? { kinds } : {}),
        });

        // Surface the real ranking mode to the caller instead of silently
        // dropping it. `debug.searchMode` is what actually ran for this
        // call ("fts" = keyword/ts_rank fallback, anything else = the
        // vector cascade) — the caller should not assume "semantic" just
        // because that's what this tool requested (see KNOWN GAP above).
        const fellBackToFts = result.debug?.searchMode === "fts";
        const hits = result.hits as unknown as Record<string, unknown>[];
        const shown = {
          compact: true,
          ...("nothingRelevant" in result
            ? { nothingRelevant: result.nothingRelevant as boolean }
            : {}),
        };

        return {
          content: [
            {
              type: "text",
              text: renderMemoryHits(hits, {
                ...shown,
                locale,
                heading: t(
                  locale,
                  fellBackToFts ? "out.memory_search.foundFts" : "out.memory_search.foundSemantic",
                  { n: result.hits.length }
                ),
              }),
            },
          ],
          structuredContent: {
            memories: displayHits(hits, shown),
            ...("nothingRelevant" in result ? { nothingRelevant: result.nothingRelevant } : {}),
            ...(result.debug ? { debug: result.debug } : {}),
            _mnemo_label: "untrusted_external_content",
            _mnemo_version: "3.0",
          },
        };
      } catch (err) {
        return formatMcpError("memory_search", err, locale);
      }
    }
  );
}
