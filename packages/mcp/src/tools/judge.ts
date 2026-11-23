import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_judge` — surfaces unresolved fact conflicts and resolves them.
 *
 * The consolidation pass detects contradicting facts and stores a
 * `conflicts_with` relation between them. This tool exposes those conflicts
 * to the AI so it can resolve them interactively.
 *
 * Two modes:
 *   action: "list"    — returns unresolved conflict pairs (default limit 5)
 *   action: "resolve" — resolves a specific conflict
 *     requires: relationId + resolution (supersede_a|supersede_b|keep_both|merge)
 *     for merge: also requires mergedStatement
 *
 * Resolution strategies (verified 2026-07-27 against real Postgres —
 * packages/server/src/__tests__/integration/conflicts.integration.test.ts):
 *   supersede_a  — forgets factA only (factB is untouched); the ORIGINAL
 *                  `conflicts_with` relation is patched to `not_conflict`
 *                  (not to `supersedes` as the field-level description below
 *                  once implied) and a SEPARATE new relation row
 *                  (factB --supersedes--> factA) is created.
 *   supersede_b  — mirror of supersede_a (forgets factB only; new relation
 *                  factA --supersedes--> factB).
 *   keep_both    — original relation patched to `not_conflict`; neither fact
 *                  is touched; no new relation is created.
 *   merge        — forgets both originals, creates one new fact carrying
 *                  mergedStatement, and creates two new `supersedes`
 *                  relations (merged -> factA, merged -> factB).
 *
 * All 4 strategies correctly retire the original `conflicts_with` relation,
 * so a resolved conflict never resurfaces in a later action='list' call.
 *
 * AUDIT FINDINGS (docs/archive/openspec/tool-promise-remediation, memory_judge):
 *   1. [FIXED 2026-07-27] `mountConflicts(v1, deps)` was never called in
 *      packages/server/src/app.ts — GET /conflicts and
 *      POST /conflicts/:id/resolve were registered nowhere on the live
 *      app despite the route file being fully implemented. Every
 *      memory_judge call 404'd against any real deployment. Fixed by wiring
 *      the missing mount call (server/src/app.ts, next to mountRelations).
 *   2. [OPEN — design divergence, not a bug] The `merge` resolution does
 *      NOT reuse `StorageAdapter.replaceFact` (the atomic single-transaction
 *      close+create+lineage-relation mechanism that memory_self_edit's
 *      `replace` action and memory_update use — see
 *      packages/adapter-postgres/src/repositories/FactRepository.ts and
 *      docs/STATUS.md §13). Instead packages/server/src/routes/conflicts.ts
 *      hand-rolls the same "supersede with lineage" outcome across SIX
 *      separate withMnemoTx transactions (two parallel closeFact calls, one
 *      createFact, one patchRelation, two parallel createRelation calls) with
 *      no cross-transaction atomicity. A crash or error partway through can
 *      leave both originals forgotten with no merged fact, or a merged fact
 *      with incomplete lineage. It also loses the source facts' subject/kind
 *      (createFact hardcodes subject:"workspace", kind:"other"), unlike
 *      replaceFact which preserves them. Two independent implementations of
 *      "supersede with lineage" is a maintenance/correctness risk even
 *      though both currently pass their contract tests.
 */
export function registerJudge(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_judge",
    {
      title: "Judge memory conflicts",
      inputSchema: {
        action: z.enum(["list", "resolve"]).describe(d("fields.memory_judge.action")),
        limit: z.number().int().min(1).max(20).optional().describe(d("fields.memory_judge.limit")),
        relationId: z.string().optional().describe(d("fields.memory_judge.relationId")),
        resolution: z
          .enum(["supersede_a", "supersede_b", "keep_both", "merge"])
          .optional()
          .describe(d("fields.memory_judge.resolution")),
        mergedStatement: z.string().optional().describe(d("fields.memory_judge.mergedStatement")),
      },
    },
    async ({ action, limit, relationId, resolution, mergedStatement }) => {
      try {
        if (action === "list") {
          const result = await client.judge(limit != null ? { limit } : undefined);
          return {
            content: [{ type: "text", text: jsonText(result) }],
            structuredContent: result as unknown as { [key: string]: unknown },
          };
        }

        // action === "resolve"
        if (!relationId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: t(locale, "out.memory_judge.needsRelationId"),
              },
            ],
          };
        }

        if (!resolution) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: t(locale, "out.memory_judge.needsResolution"),
              },
            ],
          };
        }

        if (resolution === "merge" && !mergedStatement?.trim()) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: t(locale, "out.memory_judge.needsMergedStatement"),
              },
            ],
          };
        }

        const result = await client.resolveConflict(relationId, {
          action: resolution,
          ...(mergedStatement ? { mergedStatement } : {}),
        });

        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_judge", err, locale);
      }
    }
  );
}
