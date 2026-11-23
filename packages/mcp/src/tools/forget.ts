import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";

/**
 * `memory_forget` — archive (not destroy) a fact or any cognitive primitive.
 *
 * Important semantic: this is a SOFT delete. The primitive moves to an archived
 * state and disappears from recall but remains recoverable for audit and restore.
 * We surface that in the description so LLM callers don't treat this as a
 * destructive op and get cautious about using it when they should.
 *
 * P18 extension: accepts `kind` (default: 'fact') and `primitiveId`.
 * When `kind` is absent or 'fact', `factId` works as a backward-compat alias
 * for `primitiveId`. For any other kind, `primitiveId` is required.
 *
 * The `reason` string is truncated to 200 chars by the server; we let
 * Zod allow longer input and rely on the server to truncate, because
 * forcing the caller to count characters is a worse UX than silently
 * truncating an audit string.
 */
export function registerForget(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_forget",
    {
      title: "Forget a primitive",
      inputSchema: {
        factId: z
          .string()
          .min(1, d("fields.memory_forget.factIdRequired"))
          .optional()
          .describe(d("fields.memory_forget.factId")),
        primitiveId: z
          .string()
          .min(1, d("fields.memory_forget.primitiveIdRequired"))
          .optional()
          .describe(d("fields.memory_forget.primitiveId")),
        kind: z
          .enum([
            "fact",
            "decision",
            "episode",
            "entity",
            "strategy",
            "workflow",
            "skill",
            "task",
            "event",
            "reasoning",
            "hyperedge",
          ])
          .default("fact")
          .describe(d("fields.memory_forget.kind")),
        reason: z.string().optional().describe(d("fields.memory_forget.reason")),
        idempotencyKey: z.string().optional().describe(d("fields.memory_forget.idempotencyKey")),
      },
    },
    async ({ factId, primitiveId, kind, reason, idempotencyKey }) => {
      try {
        // P18: resolve the target id.
        // When kind='fact' (or kind is absent — default), factId is the backward-compat alias.
        // For any other kind, primitiveId is required.
        // NOTE: Zod .default("fact") applies during schema validation but the handler
        // may be called directly in tests with kind=undefined; normalize here.
        const effectiveKind = kind ?? "fact";
        const id = primitiveId ?? (effectiveKind === "fact" ? factId : undefined);
        if (!id) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: t(locale, "out.failed", {
                  tool: "memory_forget",
                  message: t(locale, "out.memory_forget.idRequired"),
                }),
              },
            ],
          };
        }

        // APP-062: the tool is annotated idempotent, so a repeat must succeed.
        let alreadyForgotten = false;
        if (effectiveKind === "fact") {
          // Backward-compat path: use forgetFact which supports idempotency keys.
          try {
            if (reason !== undefined) {
              await client.forgetFact(id, undefined, idempotencyKey, reason);
            } else {
              await client.forgetFact(id, undefined, idempotencyKey);
            }
          } catch (err) {
            // DELETE /facts/:id answers 404 for an already-closed fact too. A
            // fact that still reads back, closed, was forgotten before; a missing
            // or ceiling-hidden one 404s here as well, and the original error stands.
            if ((err as { status?: unknown } | null)?.status !== 404) throw err;
            const existing = await client
              .getFact(id, undefined, { includeClosed: true })
              .catch(() => undefined);
            if (!existing?.validTo) throw err;
            alreadyForgotten = true;
          }
        } else {
          // P18 path: route to generic primitive archive endpoint.
          // §34.9: idempotencyKey must be honored for every kind, not only 'fact'.
          const res =
            reason !== undefined
              ? await client.forgetPrimitive(effectiveKind, id, undefined, reason, idempotencyKey)
              : await client.forgetPrimitive(
                  effectiveKind,
                  id,
                  undefined,
                  undefined,
                  idempotencyKey
                );
          alreadyForgotten = res?.alreadyForgotten === true;
        }

        const result = {
          id,
          kind: effectiveKind,
          forgotten: true,
          ...(alreadyForgotten ? { alreadyForgotten: true } : {}),
          reason: reason ?? "mcp_forget",
        };
        const text = alreadyForgotten
          ? `${jsonText(result)}\n${t(locale, "out.memory_forget.already")}`
          : jsonText(result);
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_forget", err, locale);
      }
    }
  );
}
