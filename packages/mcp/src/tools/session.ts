import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { describer, t } from "../i18n/index.js";
import { jsonText } from "./json-text.js";
import { collapseTimeoutMs } from "../env.js";

/**
 * `memory_session` — the spec §24 unified session-control tool.
 *
 * The original spec described a single tool with
 * `action: pin | scratch | collapse | discard`. The prior API had split this surface
 * across `memory_pin`, `memory_episode_start` and `memory_episode_end`, which
 * meant `scratch` and `discard` were not reachable via MCP at all and the
 * unified verb the spec mandates simply did not exist. This tool restores the
 * unified contract additively — the legacy tools keep working unchanged.
 *
 * DOC-CLEANUP-1 (2026-07-31): the tool's own top-level description used to
 * name only 4 of the 8 real `action` values (`pin`/`collapse`/`scratch`/`discard`)
 * even though `start`, `turn`, `pin_turn`, and `feedback` all have live handler
 * branches below — they were documented only in per-field `.describe()` calls
 * the LLM reads after the top-level description. Fixed to list all 8.
 *
 * Action → transport mapping (thin adapter; the server owns the logic),
 * confirmed against the real client-ts method bodies (not copied on faith):
 *   - start    → client.createSession                      (POST /session/start)
 *   - turn     → client.appendTurn                          (POST /session/:id/turn)
 *   - pin_turn → client.pinSessionTurn                       (POST /session/:id/pin)
 *   - pin      → client.pinFact / client.unpinFact           (POST /facts/:id/pin)
 *   - scratch  → client.updateSessionScratch                 (POST /session/:id/scratch)
 *                Note: `content` is stored under key `note` in the scratch object.
 *                Additional `metadata` keys are spread alongside `note`.
 *   - collapse → client.collapseSession                      (POST /session/:id/collapse)
 *   - discard  → client.discardSession                       (POST /session/:id/discard)
 *   - feedback → client.sessionFeedback                      (POST /session/:id/feedback)
 *   - get      → client.getSession                           (GET /session/:id)
 *   - list     → client.listSessions                         (GET /session/list)
 *
 * `get`/`list` close a real orphan-route gap found during a promise-fidelity
 * audit (2026-07-31): `GET /session/:id` and `GET /session/list` were
 * implemented server-side but unreachable from any client (client-ts had no
 * method for either, so no CLI/MCP surface could exist).
 */
export function registerSession(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  const d = describer(locale);
  server.registerTool(
    "memory_session",
    {
      title: "Control a memory session",
      inputSchema: {
        action: z
          .enum([
            "start",
            "turn",
            "pin_turn",
            "pin",
            "scratch",
            "collapse",
            "discard",
            "feedback",
            "get",
            "list",
          ])
          .describe(d("fields.memory_session.action")),
        sessionId: z.string().optional().describe(d("fields.memory_session.sessionId")),
        rating: z.enum(["up", "down"]).optional().describe(d("fields.memory_session.rating")),
        agentId: z.string().optional().describe(d("fields.memory_session.agentId")),
        factId: z.string().optional().describe(d("fields.memory_session.factId")),
        turnIndex: z.number().int().optional().describe(d("fields.memory_session.turnIndex")),
        turnId: z.string().optional().describe(d("fields.memory_session.turnId")),
        unpin: z.boolean().optional().describe(d("fields.memory_session.unpin")),
        content: z.string().max(20_000).optional().describe(d("fields.memory_session.content")),
        role: z
          .enum(["user", "assistant", "system"])
          .optional()
          .describe(d("fields.memory_session.role")),
        collapseHint: z.string().optional().describe(d("fields.memory_session.collapseHint")),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(d("fields.memory_session.metadata")),
        idempotencyKey: z.string().optional().describe(d("fields.memory_session.idempotencyKey")),
      },
    },
    async (args) => {
      try {
        switch (args.action) {
          case "start": {
            const result = await client.createSession(
              {
                ...(args.agentId ? { agentId: args.agentId } : {}),
                ...(args.metadata ? { metadata: args.metadata } : {}),
              },
              undefined,
              args.idempotencyKey
            );
            return okOut(result);
          }
          case "turn": {
            if (!args.sessionId || !args.content) {
              return errorOut(t(locale, "out.memory_session.turnNeeds"));
            }
            // APP-018: a turn stores no turnId or metadata (no column holds
            // them); the server refuses them, so say so here instead of
            // sending a call that cannot succeed.
            if (args.turnId !== undefined || args.metadata !== undefined) {
              return errorOut(t(locale, "out.memory_session.turnFieldsUnsupported"));
            }
            await client.appendTurn(args.sessionId, {
              role: args.role ?? "user",
              content: args.content,
            });
            return okOut({ appended: true, sessionId: args.sessionId });
          }
          case "pin_turn": {
            if (!args.sessionId || (!args.turnId && args.turnIndex === undefined)) {
              return errorOut(t(locale, "out.memory_session.pinTurnNeeds"));
            }
            // Pass the index THROUGH as an index. This used to be
            // `args.turnId ?? String(args.turnIndex)`, which sent the ordinal
            // as an id — so `turnIndex: 1` reached the uuid column as "1" and
            // the call died with `invalid input syntax for type uuid`, retried
            // three times, and surfaced as a 500. The route resolves the index
            // against `mnemo_session_turn.turn_index` now.
            const selector =
              args.turnId !== undefined ? { turnId: args.turnId } : { turnIndex: args.turnIndex };
            await client.pinSessionTurn(args.sessionId, {
              ...selector,
              pinned: !args.unpin,
            });
            return okOut({ pinned: !args.unpin, sessionId: args.sessionId, ...selector });
          }
          case "pin": {
            if (!args.factId)
              return errorOut(t(locale, "out.requires", { action: "pin", field: "factId" }));
            const result = args.unpin
              ? await client.unpinFact(args.factId, undefined, args.idempotencyKey)
              : await client.pinFact(args.factId, undefined, args.idempotencyKey);
            return okOut(result);
          }
          case "collapse": {
            if (!args.sessionId)
              return errorOut(
                t(locale, "out.requires", { action: "collapse", field: "sessionId" })
              );
            // APP-014: a collapse outlasts the shared client's budget.
            const result = await client.withTimeout(collapseTimeoutMs()).collapseSession(
              args.sessionId,
              {
                strategy: args.collapseHint ? "explicit" : "auto",
                ...(args.collapseHint ? { collapseHint: args.collapseHint } : {}),
              },
              undefined,
              args.idempotencyKey
            );
            return okOut(result);
          }
          case "scratch": {
            if (!args.sessionId || !args.content) {
              return errorOut(t(locale, "out.memory_session.scratchNeeds"));
            }
            // `content` is stored under key `note`; additional metadata is spread
            // alongside it so callers can pass structured context (e.g. role).
            await client.updateSessionScratch(args.sessionId, {
              note: args.content,
              ...(args.role ? { role: args.role } : {}),
              ...(args.metadata ?? {}),
            });
            return okOut({ scratched: true, sessionId: args.sessionId });
          }
          case "discard": {
            if (!args.sessionId)
              return errorOut(t(locale, "out.requires", { action: "discard", field: "sessionId" }));
            await client.discardSession(args.sessionId);
            return okOut({ discarded: true, sessionId: args.sessionId });
          }
          case "feedback": {
            if (!args.sessionId || !args.rating) {
              return errorOut(t(locale, "out.memory_session.feedbackNeeds"));
            }
            await client.sessionFeedback(args.sessionId, args.rating);
            return okOut({ feedback: true, sessionId: args.sessionId, rating: args.rating });
          }
          case "get": {
            if (!args.sessionId)
              return errorOut(t(locale, "out.requires", { action: "get", field: "sessionId" }));
            const result = await client.getSession(args.sessionId);
            return okOut(result);
          }
          case "list": {
            const result = await client.listSessions();
            return okOut(result);
          }
        }
      } catch (err) {
        return formatMcpError("memory_session", err, locale);
      }
    }
  );
}

function okOut(result: unknown) {
  return {
    content: [{ type: "text" as const, text: jsonText(result) }],
    structuredContent: result as { [key: string]: unknown },
  };
}

function errorOut(msg: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
}
