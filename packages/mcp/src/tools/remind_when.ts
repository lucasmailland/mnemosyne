import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, isoDateTimeInput, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_remind_when` — crea, lista o descarta recordatorios prospectivos (memoria futura).
 *
 * La memoria prospectiva — hechos que deben surfacearse en condiciones futuras
 * — se activa de forma temporal (`triggerAt`) o semántica (`condition`), y el
 * runtime evalúa ambas en cada ciclo de recall. Si se proporcionan ambas, se
 * aplica lógica AND: ambas condiciones deben cumplirse para activar el
 * recordatorio.
 *
 * `action='list'` por default solo muestra recordatorios `pending`. Un
 * recordatorio que ya disparó pasa a `status='triggered'` pero NO se borra —
 * pasa `status:'triggered'` (o `'all'`) para verlo, incluyendo su `content`
 * completo. Sin esto el contenido de un recordatorio disparado quedaba
 * inalcanzable desde esta tool aunque siguiera existiendo en la base.
 */
export function registerRemindWhen(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_remind_when",
    {
      title: "Remind when",
      inputSchema: {
        action: z
          .enum(["create", "list", "dismiss"])
          .default("create")
          .describe(d("fields.memory_remind_when.action")),
        id: z.string().optional().describe(d("fields.memory_remind_when.id")),
        status: z
          .enum(["pending", "triggered", "dismissed", "all"])
          .optional()
          .describe(d("fields.memory_remind_when.status")),
        content: z
          .string()
          .min(1, d("fields.memory_remind_when.contentEmpty"))
          .optional()
          .describe(d("fields.memory_remind_when.content")),
        condition: z
          .string()
          .min(1, d("fields.memory_remind_when.conditionEmpty"))
          .optional()
          .describe(d("fields.memory_remind_when.condition")),
        triggerAt: isoDateTimeInput().optional().describe(d("fields.memory_remind_when.triggerAt")),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(d("fields.memory_remind_when.limit")),
        idempotencyKey: z
          .string()
          .optional()
          .describe(d("fields.memory_remind_when.idempotencyKey")),
        targetWorkspaceId: z
          .uuid()
          .optional()
          .describe(d("fields.memory_remind_when.targetWorkspaceId")),
      },
    },
    async (args) => {
      try {
        let result: unknown;
        const action = args.action ?? "create";

        // D5 guard (spec.md "pin, relate, and hyperedge are unaffected" /
        // design.md D5): targetWorkspaceId only makes sense on the
        // create/store op that actually writes a new row. Extends the same
        // arg-combination-guard posture already used below for
        // action='create' (content + condition/triggerAt) and
        // action='dismiss' (requires id) — reject loudly, make zero client
        // calls, instead of silently ignoring the param.
        if (args.targetWorkspaceId !== undefined && action !== "create") {
          return {
            isError: true as const,
            content: [
              {
                type: "text" as const,
                text: t(locale, "out.targetWorkspaceOnlyCreate", { when: "action='create'" }),
              },
            ],
          };
        }

        switch (action) {
          case "list": {
            result = await client.listReminders({
              ...(args.status ? { status: args.status } : {}),
              ...(args.limit ? { limit: args.limit } : {}),
            });
            break;
          }
          case "dismiss": {
            if (!args.id) {
              return {
                isError: true as const,
                content: [
                  {
                    type: "text" as const,
                    text: t(locale, "out.requires", { action: "action='dismiss'", field: "id" }),
                  },
                ],
              };
            }
            await client.dismissReminder(args.id);
            result = { id: args.id, dismissed: true };
            break;
          }
          case "create": {
            if (!args.content || (!args.condition && !args.triggerAt)) {
              return {
                isError: true as const,
                content: [
                  {
                    type: "text" as const,
                    text: t(locale, "out.memory_remind_when.createNeeds"),
                  },
                ],
              };
            }
            {
              const body: Record<string, unknown> = { content: args.content };
              if (args.condition) body["condition"] = args.condition;
              if (args.triggerAt) body["triggerAt"] = args.triggerAt;
              if (args.targetWorkspaceId !== undefined)
                body["targetWorkspaceId"] = args.targetWorkspaceId;
              result = await client.createReminder(
                body as unknown as Parameters<typeof client.createReminder>[0],
                undefined,
                args.idempotencyKey
              );
            }
            break;
          }
        }

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
        return formatMcpError("memory_remind_when", err, locale);
      }
    }
  );
}
