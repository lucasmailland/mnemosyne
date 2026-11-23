import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_skill` — registra y recupera capacidades/habilidades del agente via /skills.
 *
 * FIXED (2026-07-31), three independent, compounding bugs (found and
 * verified 2026-07-28, real Postgres, NOSUPERUSER `mnemo_app_role`; see
 * packages/server/src/__tests__/integration/skills-forget.integration.test.ts):
 *
 *   1. `action:"forget"` used to not route through `/skills` at all — it
 *      called `client.forgetFact(id)`, which hits `DELETE /facts/:id`. A
 *      skill id never exists in `mnemo_fact`, so this ALWAYS 404d and left
 *      the skill row completely untouched. Fixed: now calls
 *      `client.forgetPrimitive("skill", id)`, the primitive-agnostic archive
 *      route (`DELETE /forget/skill/:id`) that actually reaches
 *      `mnemo_skill` and sets `validTo`.
 *   2. That route itself 500d under the real production role, for EVERY
 *      primitive kind, not just skills — `core/src/cognitive/forget.ts`'s
 *      soft path appends a non-terminal audit entry
 *      (`AuditRepository.appendAuditEntry`) whose Merkle-chain lookup ran
 *      `SELECT merkle_hash ... FOR UPDATE`, and Postgres requires UPDATE
 *      privilege for any `FOR UPDATE` clause — a privilege `mnemo_app_role`
 *      deliberately lacks on `mnemo_audit_log` (S3, append-only invariant).
 *      Fixed by dropping `FOR UPDATE` from that read — the pre-existing
 *      `pg_advisory_xact_lock` already fully serializes concurrent appends
 *      per workspace, so the locking clause was redundant. This also fixes
 *      the same soft-archive path for `workflow`/`strategy`/`task`/`event`/
 *      `entity`/`episode`/`reasoning`/`hyperedge`, and `memory_forget` for
 *      any non-fact `kind`.
 *   3. `GET /skills` (`action:"list"`) used to never exclude archived
 *      (validTo-closed) skills — `KnowledgeRepository.querySkills` only
 *      applied the validity window when a caller passed `validAt`, and the
 *      route never did. Fixed: the route now passes `openOnly: true`
 *      by default, so archived skills are excluded from `action:"list"`.
 *
 * All four (`create`/`get`/`list`/`forget`) now genuinely round-trip through
 * `/skills` (or `/forget/skill/:id`) as documented.
 */
export function registerSkill(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_skill",
    {
      title: "Manage agent skills (procedural memory)",
      inputSchema: {
        action: z
          .enum(["create", "get", "list", "update", "forget"])
          .describe(d("fields.memory_skill.action")),
        id: z.string().optional().describe(d("fields.memory_skill.id")),
        name: z.string().min(1).max(500).optional().describe(d("fields.memory_skill.name")),
        promptTemplate: z
          .string()
          .min(1)
          .max(50_000)
          .optional()
          .describe(d("fields.memory_skill.promptTemplate")),
        content: z
          .string()
          .min(1)
          .max(20_000)
          .optional()
          .describe(d("fields.memory_skill.content")),
        tags: z.array(z.string()).optional().describe(d("fields.memory_skill.tags")),
        limit: z.number().int().min(1).max(200).optional(),
        targetWorkspaceId: z.uuid().optional().describe(d("fields.memory_skill.targetWorkspaceId")),
      },
    },
    async (args) => {
      let result: unknown;
      try {
        if (args.targetWorkspaceId !== undefined && args.action !== "create") {
          return errorOut(t(locale, "out.targetWorkspaceOnlyCreate", { when: "action='create'" }));
        }
        switch (args.action) {
          case "create": {
            const name = args.name ?? args.content;
            const promptTemplate = args.promptTemplate ?? args.content;
            if (!name || !promptTemplate) {
              return errorOut(t(locale, "out.memory_skill.createNeeds"));
            }
            const body: Record<string, unknown> = { name, promptTemplate };
            if (args.tags !== undefined) body["metadata"] = { tags: args.tags };
            if (args.targetWorkspaceId !== undefined)
              body["targetWorkspaceId"] = args.targetWorkspaceId;
            result = await client.createSkill(
              body as unknown as Parameters<typeof client.createSkill>[0]
            );
            break;
          }
          case "get": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "get", field: "id" }));
            result = await client.getSkill(args.id);
            break;
          }
          // P111 — until now a skill could be created and never corrected: the
          // storage method existed, with no route, no SDK method and no action
          // here. For a stored prompt template that is the whole point of
          // storing it.
          case "update": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "update", field: "id" }));
            const patch: Record<string, unknown> = {};
            if (args.name !== undefined) patch["name"] = args.name;
            if (args.promptTemplate !== undefined) patch["promptTemplate"] = args.promptTemplate;
            if (args.tags !== undefined) patch["metadata"] = { tags: args.tags };
            if (Object.keys(patch).length === 0) {
              return errorOut(t(locale, "out.memory_skill.updateNeeds"));
            }
            result = await client.updateSkill(
              args.id,
              patch as unknown as Parameters<typeof client.updateSkill>[1]
            );
            break;
          }
          case "list": {
            result = await client.listSkills({
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
            });
            break;
          }
          case "forget": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "forget", field: "id" }));
            const { forgotten } = await client.forgetPrimitive("skill", args.id);
            result = { id: args.id, forgotten };
            break;
          }
        }
      } catch (err) {
        return formatMcpError("memory_skill", err, locale);
      }
      return {
        content: [{ type: "text" as const, text: jsonText(result) }],
        structuredContent: result as { [key: string]: unknown },
      };
    }
  );
}

function errorOut(msg: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
}
