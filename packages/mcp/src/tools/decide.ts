import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_decide` — registra una decisión durable con su rationale en el
 * workspace.
 *
 * Las decisiones son distintas de los hechos: representan compromisos
 * explícitos ("vamos a hacer X porque Y") con trazabilidad de
 * alternativas consideradas (en prosa, dentro de `body` — no hay campos
 * estructurados separados para "alternativas"/"elegida"; ver `body`'s
 * descripción). Se almacenan en `mnemo_decision`, no en `mnemo_fact`.
 *
 * Idempotencia — FIXED 2026-07-31 (DECIDE-1, docs/STATUS.md): el servidor
 * hace upsert por (workspace_id, topic_key) en
 * `packages/core/src/primitives/decision.ts`, y la comparación ahora es
 * `lower(btrim(topic_key))` — case/whitespace-insensitive — tanto en la
 * query de lookup como en el índice único parcial
 * `uniq_mnemo_decision_topic` (migración 0017, expression index sobre la
 * misma forma normalizada, para que una escritura concurrente con distinto
 * casing no pueda ganarle la carrera al SELECT y crear un duplicado).
 * "Auth-Strategy" y "auth-strategy" (o "auth-strategy " con espacio de
 * más) ahora matchean la MISMA fila. El valor almacenado conserva el
 * casing exacto que mandó quien creó la decisión por primera vez — solo el
 * matching es normalizado, no se reescribe el dato. Omitir `topicKey`
 * sigue sin derivarlo de `title` — cada llamada sin `topicKey` crea una
 * fila nueva sin deduplicar (eso no cambió; nunca estuvo implementado a
 * pesar de lo que la doc original insinuaba). Proving tests:
 * packages/server/src/__tests__/integration/decide-topic-key.integration.test.ts.
 */
export function registerDecide(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_decide",
    {
      title: "Record a decision",
      inputSchema: {
        kind: z
          .enum([
            "decision",
            "architecture",
            "policy",
            "process",
            "bugfix",
            "learning",
            "discovery",
            "config",
          ])
          .describe(d("fields.memory_decide.kind")),
        title: z
          .string()
          .min(1, d("fields.memory_decide.titleEmpty"))
          .max(500, d("fields.memory_decide.titleTooLong"))
          .describe(d("fields.memory_decide.title")),
        body: z
          .string()
          .min(1, d("fields.memory_decide.bodyEmpty"))
          .describe(d("fields.memory_decide.body")),
        topicKey: z.string().optional().describe(d("fields.memory_decide.topicKey")),
        conversationId: z.string().optional().describe(d("fields.memory_decide.conversationId")),
        sensitivity: z
          .enum(["public", "internal", "confidential", "restricted"])
          .optional()
          .describe(d("fields.memory_decide.sensitivity")),
        scopeRef: z.string().optional().describe(d("fields.memory_decide.scopeRef")),
        idempotencyKey: z.string().optional().describe(d("fields.memory_decide.idempotencyKey")),
        targetWorkspaceId: z
          .uuid()
          .optional()
          .describe(d("fields.memory_decide.targetWorkspaceId")),
      },
    },
    async ({
      kind,
      title,
      body,
      topicKey,
      conversationId,
      scopeRef,
      sensitivity,
      idempotencyKey,
      targetWorkspaceId,
    }) => {
      try {
        const result = await client.createDecision(
          {
            kind,
            title,
            body,
            ...(topicKey !== undefined ? { topicKey } : {}),
            ...(conversationId !== undefined ? { conversationId } : {}),
            ...(scopeRef !== undefined ? { scopeRef } : {}),
            ...(sensitivity !== undefined ? { sensitivity } : {}),
            // NOTE: `targetWorkspaceId` is not yet a named field on
            // `CreateDecisionInput` — that typed addition ships in Slice 3c
            // (client-ts). Spread properties are not excess-property-checked
            // by TS, and `createDecision` passes `body: input` wholesale
            // server-side, so this is wire-correct today, ahead of 3c
            // (mirrors how `sensitivity` above already forwards the same way).
            ...(targetWorkspaceId !== undefined ? { targetWorkspaceId } : {}),
          },
          undefined,
          idempotencyKey
        );

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
        return formatMcpError("memory_decide", err, locale);
      }
    }
  );
}
