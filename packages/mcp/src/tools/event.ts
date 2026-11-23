import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, isoDateTimeInput, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

const TypeEnum = z.enum(["system", "external", "user", "agent", "scheduled"]);

/** `memory_event` — registra un evento inmutable en el log del workspace. */
export function registerEvent(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_event",
    {
      title: "Append an immutable event",
      inputSchema: {
        action: z
          .enum(["create", "get", "list", "archive", "annotate", "sensitivity"])
          .describe(d("fields.memory_event.action")),
        id: z.string().optional().describe(d("fields.memory_event.id")),
        type: TypeEnum.optional().describe(d("fields.memory_event.type")),
        name: z.string().min(1).max(500).optional().describe(d("fields.memory_event.name")),
        description: z
          .string()
          .max(20_000)
          .optional()
          .describe(d("fields.memory_event.description")),
        occurredAt: isoDateTimeInput().optional().describe(d("fields.memory_event.occurredAt")),
        durationS: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(d("fields.memory_event.durationS")),
        source: z.string().min(1).max(200).optional().describe(d("fields.memory_event.source")),
        relatedEntities: z
          .array(z.string())
          .optional()
          .describe(d("fields.memory_event.relatedEntities")),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(d("fields.memory_event.metadata")),
        sourceFilter: z.string().optional().describe(d("fields.memory_event.sourceFilter")),
        after: isoDateTimeInput().optional().describe(d("fields.memory_event.after")),
        before: isoDateTimeInput().optional().describe(d("fields.memory_event.before")),
        limit: z.number().int().min(1).max(200).optional().describe(d("fields.memory_event.limit")),
        sensitivity: z
          .enum(["public", "internal", "confidential", "restricted"])
          .optional()
          .describe(d("fields.memory_event.sensitivity")),
        idempotencyKey: z.string().optional().describe(d("fields.memory_event.idempotencyKey")),
        author: z.string().min(1).max(200).optional().describe(d("fields.memory_event.author")),
        content: z
          .string()
          .min(1)
          .max(20_000)
          .optional()
          .describe(d("fields.memory_event.content")),
        at: isoDateTimeInput().optional().describe(d("fields.memory_event.at")),
        targetWorkspaceId: z.uuid().optional().describe(d("fields.memory_event.targetWorkspaceId")),
      },
    },
    async (args) => {
      let result: unknown;
      try {
        if (args.action !== "create" && args.targetWorkspaceId !== undefined) {
          return errorOut(t(locale, "out.targetWorkspaceOnlyCreate", { when: "action='create'" }));
        }
        switch (args.action) {
          case "create": {
            if (!args.type || !args.name || !args.description || !args.occurredAt || !args.source) {
              return errorOut(t(locale, "out.memory_event.createNeeds"));
            }
            const body: Record<string, unknown> = {
              type: args.type,
              name: args.name,
              description: args.description,
              occurredAt: args.occurredAt,
              source: args.source,
            };
            if (args.durationS !== undefined) body["durationS"] = args.durationS;
            if (args.relatedEntities !== undefined) body["relatedEntities"] = args.relatedEntities;
            if (args.sensitivity !== undefined) body["sensitivity"] = args.sensitivity;
            if (args.metadata !== undefined) body["metadata"] = args.metadata;
            if (args.targetWorkspaceId !== undefined)
              body["targetWorkspaceId"] = args.targetWorkspaceId;
            result = await client.createEvent(
              body as unknown as Parameters<typeof client.createEvent>[0],
              undefined,
              args.idempotencyKey
            );
            break;
          }
          case "get": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "get", field: "id" }));
            result = await client.getEvent(args.id);
            break;
          }
          case "list": {
            const params: Record<string, unknown> = {};
            if (args.type !== undefined) params["type"] = args.type;
            if (args.sourceFilter !== undefined) params["source"] = args.sourceFilter;
            if (args.after !== undefined) params["after"] = args.after;
            if (args.before !== undefined) params["before"] = args.before;
            if (args.limit !== undefined) params["limit"] = args.limit;
            result = await client.listEvents(params as Parameters<typeof client.listEvents>[0]);
            break;
          }
          case "archive": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "archive", field: "id" }));
            try {
              await client.archiveEvent(args.id);
            } catch (err) {
              // Since PRIM-10 (WP-5) the server refuses with 409
              // `event_immutable` instead of an empty 204. Both mean the row
              // was not touched, so the answer stays the same; anything else
              // (a 404 above the caller's ceiling) is still an error.
              const e = err as { status?: unknown; code?: unknown };
              if (!(e?.status === 409 && e?.code === "event_immutable")) throw err;
            }
            result = { id: args.id, archived: false, immutable: true };
            break;
          }
          case "annotate": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "annotate", field: "id" }));
            if (!args.author || !args.content)
              return errorOut(t(locale, "out.memory_event.annotateNeeds"));
            result = await client.annotateEvent(args.id, {
              author: args.author,
              content: args.content,
              ...(args.at ? { at: args.at } : {}),
            });
            break;
          }
          case "sensitivity": {
            if (!args.id)
              return errorOut(t(locale, "out.requires", { action: "sensitivity", field: "id" }));
            if (!args.sensitivity)
              return errorOut(
                t(locale, "out.requires", { action: "sensitivity", field: "sensitivity" })
              );
            result = await client.updateEventSensitivity(args.id, {
              sensitivity: args.sensitivity,
            });
            break;
          }
        }
      } catch (err) {
        return formatMcpError("memory_event", err, locale);
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
