import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";

/**
 * `memory_relocate` — move a fact that was written into the wrong workspace.
 *
 * P72's last piece. The server route and the SDK method have existed since the
 * first half landed; this is the surface an agent can actually reach, and
 * without it the only remediation was two manual steps (`memory_forget` in the
 * wrong place, `memory_remember` with `targetWorkspaceId` in the right one) —
 * bitemporally correct, but leaving two rows with no `supersedes` between them
 * and nothing recording that they are the same knowledge.
 *
 * WHY ITS OWN TOOL, and not a `targetWorkspaceId` field on `memory_update`:
 * that was tried first, on the reasonable theory that correcting a fact's TEXT
 * and correcting its PLACE are both bitemporal corrections. It rippled through
 * two guard systems at once — the MCP route map and the coverage guard — because
 * an either/or between two optional fields is not a shape that machinery can
 * express: its fixtures are indexed by discriminant value, and both branches
 * carried the same one. Forcing it through LOST the `/self/edit` coverage:
 * less coverage than before, wearing the costume of more. The friction was the
 * signal. A declared operation gets its own route-map entry and its own fixture
 * key, and nothing has to lie about which branch it is.
 *
 * The move is NOT an `UPDATE ... SET workspace_id`. That would rewrite history
 * and punch a hole in the audit trail of the workspace the fact was in. The
 * fact is closed where it was misfiled and a successor is created in the target,
 * linked by `supersedes`, in one transaction.
 */
export function registerRelocate(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_relocate",
    {
      title: "Move a fact to another workspace",
      inputSchema: {
        factId: z
          .string()
          .min(1, d("fields.memory_relocate.factIdRequired"))
          .describe(d("fields.memory_relocate.factId")),
        targetWorkspaceId: z
          .uuid(d("fields.memory_relocate.targetWorkspaceIdUuid"))
          .describe(d("fields.memory_relocate.targetWorkspaceId")),
        reason: z.string().max(500).optional().describe(d("fields.memory_relocate.reason")),
      },
    },
    async ({ factId, targetWorkspaceId, reason }) => {
      try {
        const moved = await client.relocateFact(factId, targetWorkspaceId, reason);
        return {
          content: [
            {
              type: "text" as const,
              text: t(locale, "out.memory_relocate.moved", {
                workspace: targetWorkspaceId,
                previousId: moved.previousId,
                newId: moved.newId,
              }),
            },
          ],
          structuredContent: moved as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_relocate", err, locale);
      }
    }
  );
}
