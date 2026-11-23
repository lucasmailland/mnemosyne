import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { formatMcpError } from "./errors.js";
import { DEFAULT_LOCALE, type Locale } from "@mnemo-ai/types";
import { z } from "zod";
import { jsonText } from "./json-text.js";

export function registerIntrospect(
  server: McpServer,
  client: MnemosyneClient,
  _probe?: unknown,
  locale: Locale = DEFAULT_LOCALE
): void {
  server.registerTool(
    "memory_introspect",
    {
      title: "What do I know? What are my gaps?",
      inputSchema: {
        // Accept BOTH vocabularies (F22): the §31 meta-cognition aspects
        // (coverage/trends/gaps/strengths/all) AND the §29 governance aspects
        // (health/worth/drift/types/recent_changes). The §29 names are aliases
        // mapped onto §31 backend aspects below, so a client written against
        // either spec section is served.
        aspect: z
          .enum([
            "coverage",
            "trends",
            "gaps",
            "strengths",
            "all",
            "health",
            "worth",
            "drift",
            "types",
            "recent_changes",
          ])
          .default("all"),
        entity: z.string().optional(),
        // §31: cap each returned list (default 10 per spec).
        limit: z.number().int().min(1).max(200).optional().default(10),
      },
    },
    async ({ aspect, entity, limit }) => {
      try {
        // Map §29 governance aspects onto the §31 backend aspects the client
        // (getSelfModel) accepts. §31 aspects pass through unchanged.
        const ASPECT_ALIAS: Record<string, "coverage" | "trends" | "gaps" | "strengths" | "all"> = {
          coverage: "coverage",
          trends: "trends",
          gaps: "gaps",
          strengths: "strengths",
          all: "all",
          // §29 → §31 mapping:
          health: "all", // overall health == full self-model
          worth: "strengths", // high-worth topics == strengths
          drift: "trends", // drift over time == trends
          types: "coverage", // knowledge-type balance == coverage
          recent_changes: "trends", // recent changes == temporal trends
        };
        const backendAspect = ASPECT_ALIAS[aspect] ?? "all";
        const model = await client.getSelfModel({ aspect: backendAspect, entity, limit });
        return {
          content: [{ type: "text" as const, text: jsonText(model) }],
          structuredContent: model as unknown as { [key: string]: unknown },
        };
      } catch (err) {
        return formatMcpError("memory_introspect", err, locale);
      }
    }
  );
}
