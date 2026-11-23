import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { jsonText } from "./json-text.js";

/**
 * `memory_stats` — aggregate workspace statistics snapshot.
 *
 * Returns a comprehensive overview of the workspace's memory state:
 *   - Fact counts: live (open validity), closed (forgotten), pinned, archived,
 *     and facts with zero recall hits (candidates for pruning or enrichment).
 *   - Decision count (active).
 *   - Conflict relations count (relations with verb = conflicts_with).
 *   - Embedding coverage: indexed vs pending (how many facts lack vectors).
 *   - Recall metrics: 30-day hit rate and last recall timestamp.
 *   - Last write timestamp (when the workspace was last modified).
 *
 * No input parameters are required — all stats are scoped to the authenticated
 * workspace via RLS on the server side.
 *
 * Use this to get a quick health snapshot before running recall, to surface
 * stale/zero-hit facts for review, or to monitor embedding backlog.
 *
 * Delegates to `GET /admin/stats`.
 *
 * FIXED 2026-07-31 (STATS-1): facts.archived, facts.withZeroHits,
 * decisions.active and recall.hitRate30d are backed
 * by a periodic `mnemo_health` snapshot (a "mnemo.health.snapshot" cron now
 * refreshes it daily, packages/server/src/cron/jobs.ts) rather than a
 * live-per-request query, so those four fields can lag by up to a day —
 * everything else on this tool is computed live on every call. See
 * docs/STATUS.md's `memory_stats` row for the two bugs this fix closed
 * (a missing GRANT that made the manual refresh path throw, and the
 * absence of any automatic refresh at all).
 *
 * FIXED 2026-07-31 (STATS-2): the description used to point callers at
 * "memory_status's GET /governance/drift?fresh=true equivalent" to
 * force-refresh those fields. No such equivalent exists — the real
 * `GET /governance/drift` route (packages/server/src/routes/governance.ts)
 * has zero client-ts callers and requires the `memory:governance` scope,
 * which typical MCP keys don't hold. Rewrote the description to say plainly
 * that there is no MCP-callable refresh and to name the daily cron instead.
 * Deliberately did NOT add a client-ts wrapper: most callers still couldn't
 * use it (scope gate), `fresh=true` has real unthrottled per-workspace
 * write side-effects unsuited to a read-shaped tool, and it would duplicate
 * the STATS-1 cron.
 */
export function registerStats(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  server.registerTool(
    "memory_stats",
    {
      title: "Workspace memory statistics",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.getStats();

        return {
          content: [
            {
              type: "text" as const,
              text: jsonText(result),
            },
          ],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_stats", err, locale);
      }
    }
  );
}
