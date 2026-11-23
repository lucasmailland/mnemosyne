import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_timeline` — list recent memory events (created / updated /
 * archived) in the workspace.
 *
 * Primary use case: a weekly "what did my AI learn?" diff. The legacy
 * apps/web tool exposed exactly this shape and several internal agents
 * already depend on the field names (`updatedAt`, `pinned`, `status`),
 * so we mirror them.
 *
 * Limit is capped at 100 to keep responses small enough to fit in a
 * single tool result block. Callers that need more should paginate via
 * `sinceIso` (the server returns events newest-first, so
 * `sinceIso = lastSeenEventTime` gives clean pagination without offsets).
 *
 * Note: the server's GET /timeline only reads `since` + `limit` — it
 * has no `kind`/`status` filter — so we no longer expose those here
 * rather than advertise a no-op param. The MCP-facing `sinceIso` is
 * mapped onto the server's `since` query param before the HTTP call.
 *
 * Verified (tool-promise-remediation audit,
 * docs/archive/openspec/tool-promise-remediation/tools/memory_timeline.md):
 *  - Ordering IS by most-recent create/update/archive, not just creation
 *    time: `packages/core/src/factory.ts`'s `timeline()` queries
 *    `ORDER BY updated_at DESC`, and `mnemo_fact` carries a `BEFORE
 *    UPDATE` trigger that stamps `updated_at = now()` on every mutation
 *    (pin/unpin, the archive-on-forget path, edits) — confirmed against a
 *    real Postgres NOSUPERUSER role in
 *    `packages/server/src/__tests__/integration/timeline-nonsuperuser.integration.test.ts`.
 *  - "max 100" is enforced by the tool's own zod schema (rejecting
 *    out-of-range `limit` as an MCP tool error) rather than by silently
 *    clamping an over-large request down to 100 — the requirement ("never
 *    return more than 100 rows") holds either way.
 *  - Event kinds (server `routes/timeline.ts`, B3): a fact yields a real
 *    `created` event, plus `updated` / `pinned` / `closed` derived from its
 *    current row once it has changed since creation (an unpin therefore
 *    reads as `updated`; `unpinned` is in the wire enum but never emitted).
 *    Decisions add `decision_created` / `decision_superseded` /
 *    `decision_withdrawn`. The served description lists exactly these.
 */
export function registerTimeline(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_timeline",
    {
      title: "List recent memory events",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(d("fields.memory_timeline.limit")),
        sinceIso: z.string().optional().describe(d("fields.memory_timeline.sinceIso")),
      },
    },
    async ({ limit, sinceIso }) => {
      try {
        // Map the MCP-facing `sinceIso` onto the server's `since` query
        // param. The server doesn't support a kind filter on this route,
        // so we don't forward one.
        const result = await client.timeline({
          limit: limit ?? 20,
          ...(sinceIso !== undefined ? { since: sinceIso } : {}),
        });
        return {
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_timeline", err, locale);
      }
    }
  );
}
