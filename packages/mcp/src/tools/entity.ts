import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_entity` — gestiona entidades (persona, organización, proyecto, concepto, lugar)
 * en el grafo de conocimiento del workspace via /entities.
 */
export function registerEntity(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_entity",
    {
      title: "Track an entity",
      inputSchema: {
        action: z
          .enum(["create", "get", "list", "update", "linked_facts", "link_user", "unlink_user"])
          .default("create")
          .describe(d("fields.memory_entity.action")),
        id: z.string().optional().describe(d("fields.memory_entity.id")),
        userId: z.string().optional().describe(d("fields.memory_entity.userId")),
        name: z.string().min(1).max(200).optional().describe(d("fields.memory_entity.name")),
        kind: z
          .enum(["person", "organization", "project", "concept", "place", "other"])
          .optional()
          .describe(d("fields.memory_entity.kind")),
        description: z.string().optional().describe(d("fields.memory_entity.description")),
        aliases: z.array(z.string()).optional().describe(d("fields.memory_entity.aliases")),
        q: z.string().optional().describe(d("fields.memory_entity.q")),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(d("fields.memory_entity.limit")),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(d("fields.memory_entity.metadata")),
        sensitivity: z
          .enum(["public", "internal", "confidential", "restricted"])
          .optional()
          .describe(d("fields.memory_entity.sensitivity")),
        idempotencyKey: z.string().optional().describe(d("fields.memory_entity.idempotencyKey")),
        targetWorkspaceId: z
          .uuid()
          .optional()
          .describe(d("fields.memory_entity.targetWorkspaceId")),
      },
    },
    async (args) => {
      let result: unknown;
      try {
        const action = args.action ?? "create";
        if (action !== "create" && args.targetWorkspaceId !== undefined) {
          return errorOut(t(locale, "out.targetWorkspaceOnlyCreate", { when: "action='create'" }));
        }
        // APP-022: update drops sensitivity server-side; refuse, never drop silently.
        if (action !== "create" && args.sensitivity !== undefined) {
          return errorOut(
            t(locale, "out.onlyOnCreate", {
              field: "sensitivity",
              when: "action='create'",
              action: `action='${action}'`,
            })
          );
        }
        switch (action) {
          case "create": {
            if (!args.name || !args.kind) {
              return errorOut(t(locale, "out.memory_entity.createNeeds"));
            }
            result = await client.createEntity(
              {
                name: args.name,
                kind: args.kind,
                ...(args.description !== undefined ? { description: args.description } : {}),
                ...(args.aliases !== undefined ? { aliases: args.aliases } : {}),
                ...(args.sensitivity !== undefined ? { sensitivity: args.sensitivity } : {}),
                ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
                ...(args.targetWorkspaceId !== undefined
                  ? { targetWorkspaceId: args.targetWorkspaceId }
                  : {}),
              },
              undefined,
              args.idempotencyKey
            );
            break;
          }
          case "get": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "get", field: "id" }));
            result = await client.getEntity(args.id);
            break;
          }
          case "list": {
            result = await client.listEntities({
              ...(args.kind ? { kind: args.kind } : {}),
              ...(args.q ? { q: args.q } : {}),
              ...(args.limit ? { limit: args.limit } : {}),
            });
            break;
          }
          case "update": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "update", field: "id" }));
            result = await client.updateEntity(args.id, {
              ...(args.name !== undefined ? { name: args.name } : {}),
              ...(args.kind !== undefined ? { kind: args.kind } : {}),
              ...(args.description !== undefined ? { description: args.description } : {}),
              ...(args.aliases !== undefined ? { aliases: args.aliases } : {}),
              ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
            });
            break;
          }
          case "linked_facts": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "linked_facts", field: "id" }));
            result = await client.listEntityFacts(args.id, {
              ...(args.limit ? { limit: args.limit } : {}),
            });
            break;
          }
          case "link_user": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "link_user", field: "id" }));
            if (!args.userId)
              return errorOut(t(locale, "out.requires", { action: "link_user", field: "userId" }));
            result = await client.linkEntityUser(args.id, { userId: args.userId });
            break;
          }
          case "unlink_user": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "unlink_user", field: "id" }));
            result = await client.unlinkEntityUser(args.id);
            break;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: jsonText(result),
            },
          ],
          structuredContent: result as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_entity", err, locale);
      }
    }
  );
}

function errorOut(msg: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
}
