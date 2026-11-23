import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_pin` — protect a fact from automated forgetting.
 *
 * Why this is its own tool instead of a flag on `remember`:
 * pinning is a curation action that typically happens AFTER a fact has
 * existed for some time and proven its value. Bundling it with creation
 * would tempt LLMs to pin everything they write, defeating the purpose
 * (pinned facts skip prune heuristics).
 *
 * The server returns an error if the fact is already archived; we
 * surface that verbatim because it's actionable for the caller.
 *
 * Tool-promise audit (2026-07-28, docs/archive/openspec/tool-promise-remediation/tools/memory_pin.md):
 * ⚠️ PARTIAL. Verified against real Postgres + the real (unmocked)
 * consolidation gate:
 *   - "protege de prune/forget automáticos": TRUE. `pinFact()`
 *     (packages/core/src/factory.ts) writes `mnemosyne.mnemo_fact.pinned` —
 *     confirmed to be the SAME column/table `ConsolidationGate.ts` reads,
 *     not the orphaned `public.mnemo_fact` shadow copy the legacy migration
 *     stream also creates. A pinned fact reliably fails the gate's `pinned`
 *     condition and is never merged (packages/server/src/__tests__/integration/
 *     pin-consolidation-gate.integration.test.ts).
 *   - "le da prioridad en recall": FALSE for the live recall path. `memory_recall`
 *     / `memory_search` both resolve to `POST /recall` →
 *     `deps.cognitive.recall()` → `recallCold()`
 *     (packages/core/src/cognitive/recall-cold.ts). That pipeline's `viewFact()`
 *     projection never copies `fact.pinned` onto the `PrimitiveView` the Stage 5
 *     blended-score formula reads, so a pinned fact and an otherwise-identical
 *     unpinned fact score IDENTICALLY — no ranking boost exists in practice
 *     (packages/core/src/cognitive/__tests__/recall-cold-pin-priority.test.ts).
 *     A separate legacy module (packages/core/src/recall/search.ts) DOES compute
 *     a `pin_bonus` column, but it backs `deps.core.recall`/`searchMnemo`, which
 *     is NOT the code path `memory_recall`/`memory_search` exercise — that
 *     bonus is unreachable from this tool.
 */
export function registerPin(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_pin",
    {
      title: "Pin a fact",
      inputSchema: {
        factId: z
          .string()
          .min(1, d("fields.memory_pin.factIdRequired"))
          .describe(d("fields.memory_pin.factId")),
        unpin: z.boolean().optional().describe(d("fields.memory_pin.unpin")),
        idempotencyKey: z.string().optional().describe(d("fields.memory_pin.idempotencyKey")),
      },
    },
    async ({ factId, unpin, idempotencyKey }) => {
      try {
        // The server exposes a single pin route (POST /facts/:id/pin
        // with a `{ pinned }` flag); client-ts wraps it as pinFact/unpinFact
        // which send pinned:true / pinned:false. Pick based on intent.
        const result = unpin
          ? await client.unpinFact(factId, undefined, idempotencyKey)
          : await client.pinFact(factId, undefined, idempotencyKey);
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_pin", err, locale);
      }
    }
  );
}
