import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_relate` — crea o lista relaciones tipadas entre primitivas de
 * memoria en el grafo del workspace.
 *
 * El vocabulario de verbos está BLOQUEADO en 9 valores (ver spec §4.2).
 *
 * `action='history'` (agregado 2026-07-31, caso de uso "linaje de
 * decisiones/facts"): NO es una tool de traverse genérica — deliberadamente
 * angosta. Reusa `client.relationsTraverse()` (POST /relations/traverse,
 * ya usado por `create`/`list` vía el mismo cliente) fijando
 * `verbs: ['supersedes', 'derived_from']` — ignora los otros 7 verbos a
 * propósito, porque el objetivo es reconstruir CÓMO se llegó a la primitiva
 * actual, no explorar el grafo en general. Explorado y descartado como tool
 * separada `memory_graph`/traverse genérico: caso de uso especulativo, sin
 * gatillo de lenguaje claro para que el modelo lo invoque — ver
 * docs/archive/BACKLOG.md para el análisis completo. Direccional únicamente
 * (source→target, mismo límite que el traverse subyacente): sirve para
 * "¿qué reemplazó esta primitiva?" partiendo de la MÁS RECIENTE; no sirve
 * para el caso inverso ("¿qué reemplazó a ESTA vieja?") sin conocer el id
 * de la primitiva más nueva.
 */
export function registerRelate(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_relate",
    {
      title: "Relate two memories or list relations",
      inputSchema: {
        action: z
          .enum(["create", "list", "history", "retract"])
          .default("create")
          .describe(d("fields.memory_relate.action")),
        relationId: z.string().optional().describe(d("fields.memory_relate.relationId")),
        sourceKind: z
          .enum(["fact", "decision", "entity", "episode"])
          .optional()
          .describe(d("fields.memory_relate.sourceKind")),
        from: z.string().optional().describe(d("fields.memory_relate.from")),
        targetKind: z
          .enum(["fact", "decision", "entity", "episode"])
          .optional()
          .describe(d("fields.memory_relate.targetKind")),
        to: z.string().optional().describe(d("fields.memory_relate.to")),
        verb: z
          .enum([
            "related",
            "compatible",
            "scoped",
            "conflicts_with",
            "supersedes",
            "not_conflict",
            "derived_from",
            "part_of",
            "member_of",
          ])
          .optional()
          .describe(d("fields.memory_relate.verb")),
        reason: z.string().optional().describe(d("fields.memory_relate.reason")),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(d("fields.memory_relate.confidence")),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(d("fields.memory_relate.limit")),
        judgmentStatus: z
          .enum(["pending", "judged", "dismissed"])
          .optional()
          .describe(d("fields.memory_relate.judgmentStatus")),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe(d("fields.memory_relate.maxDepth")),
        idempotencyKey: z.string().optional().describe(d("fields.memory_relate.idempotencyKey")),
      },
    },
    async (args) => {
      try {
        let result: unknown;
        const action = args.action ?? "create";
        switch (action) {
          case "list": {
            result = await client.listRelations({
              limit: args.limit ?? 20,
              ...(args.from ? { sourceId: args.from } : {}),
              ...(args.to ? { targetId: args.to } : {}),
              ...(args.judgmentStatus ? { judgmentStatus: args.judgmentStatus } : {}),
            } as Parameters<MnemosyneClient["listRelations"]>[0]);
            break;
          }
          case "create": {
            if (!args.sourceKind || !args.from || !args.targetKind || !args.to || !args.verb) {
              return {
                isError: true as const,
                content: [
                  {
                    type: "text" as const,
                    text: t(locale, "out.memory_relate.createNeeds"),
                  },
                ],
              };
            }
            result = await client.createRelation(
              {
                sourceKind: args.sourceKind,
                sourceId: args.from,
                targetKind: args.targetKind,
                targetId: args.to,
                relation: args.verb,
                markedByKind: "agent",
                ...(args.reason !== undefined ? { reason: args.reason } : {}),
                ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
              },
              undefined,
              args.idempotencyKey
            );
            break;
          }
          // P111 — until now a relation could be created and retracted through
          // nothing. P74's dangling-write path could create one against an id
          // matching no row, with no way to take it back.
          case "retract": {
            if (!args.relationId) {
              return {
                isError: true as const,
                content: [
                  {
                    type: "text" as const,
                    text: t(locale, "out.memory_relate.retractNeeds"),
                  },
                ],
              };
            }
            await client.closeRelation(args.relationId);
            result = { id: args.relationId, retracted: true };
            break;
          }
          case "history": {
            if (!args.sourceKind || !args.from) {
              return {
                isError: true as const,
                content: [
                  {
                    type: "text" as const,
                    text: t(locale, "out.memory_relate.historyNeeds"),
                  },
                ],
              };
            }
            result = await client.relationsTraverse({
              rootId: args.from,
              rootKind: args.sourceKind,
              maxDepth: args.maxDepth ?? 5,
              verbs: ["supersedes", "derived_from"],
            });
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
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_relate", err, locale);
      }
    }
  );
}
