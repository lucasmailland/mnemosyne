import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_self_edit` — editás tu propia memoria (spec §13). Seis acciones:
 * append | replace | strengthen | weaken | reflect | link. El `target` es
 * polimórfico: un fact_id, "profile", o "strategy:{id}". El motivo es
 * obligatorio como contexto de política, pero todavía no se audita de forma durable.
 *
 * link: forma un hiperedge n-ario. target = id del fact ancla; content =
 * ids de los demás miembros separados por coma (mínimo 2, total ≥3).
 *
 * NOTA (B4): "forget" NO es una acción soportada acá — no existe flujo de
 * aprobación que la resuelva, así que el servidor la rechaza con 422. Para
 * invalidar un fact o strategy usa `memory_forget` (kind: "fact" | "strategy"),
 * que hace el mismo archivado bitemporal sin dejar al llamador esperando una
 * aprobación que nunca llega.
 */
export function registerSelfEdit(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_self_edit",
    {
      title: "Edit your own memory",
      inputSchema: {
        action: z
          .enum(["append", "replace", "strengthen", "weaken", "reflect", "link"])
          .describe(d("fields.memory_self_edit.action")),
        target: z.string().min(1).describe(d("fields.memory_self_edit.target")),
        content: z.string().max(20_000).optional().describe(d("fields.memory_self_edit.content")),
        reason: z.string().min(1).max(2_000).describe(d("fields.memory_self_edit.reason")),
        idempotencyKey: z.string().optional().describe(d("fields.memory_self_edit.idempotencyKey")),
        sessionId: z.string().optional().describe(d("fields.memory_self_edit.sessionId")),
      },
    },
    async ({ action, target, content, reason, idempotencyKey, sessionId }) => {
      try {
        const result = await client.selfEdit(
          {
            action,
            target,
            ...(content !== undefined ? { content } : {}),
            reason,
            ...(sessionId ? { sessionId } : {}),
          },
          undefined,
          idempotencyKey
        );
        return {
          content: [{ type: "text" as const, text: jsonText(result) }],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_self_edit", err, locale);
      }
    }
  );
}
