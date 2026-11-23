import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { ServerDeps } from "../deps.js";
import type { AuthVariables } from "../auth.js";
import { BadRequestError } from "../errors.js";

/**
 * Citations read surface.
 *
 *   GET /citations  — list citations (optional memoryKind/memoryId filter)
 *
 * Every memory primitive (fact / decision / entity / episode) traces
 * back to source spans via `mnemo_citation`. The composite
 * (workspace_id, memory_kind, memory_id) index supports the
 * provenance-walk path the inspector renders ("where did this fact
 * come from?").
 *
 * Citation writes are NOT exposed here today — the extraction pipeline
 * is the sole writer in production. An operator-facing create path
 * can ship in a follow-up tramo when there's a concrete need.
 */

const CitationMemoryKindEnum = z.enum(["fact", "decision", "entity", "episode"]);

const CitationSourceKindEnum = z.enum([
  "message",
  "document",
  "tool_call",
  "llm_extraction",
  "user_edit",
  "agent_save",
  "imported",
]);

const CitationSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    memoryKind: CitationMemoryKindEnum,
    memoryId: z.string(),
    sourceKind: CitationSourceKindEnum,
    sourceId: z.string().nullable(),
    extractorModel: z.string().nullable(),
    extractorPromptVersion: z.string().nullable(),
    judgeModel: z.string().nullable(),
    judgeRelationId: z.string().nullable(),
    evidenceExcerpt: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Citation");

const ListCitationsQuerySchema = z
  .object({
    memoryKind: CitationMemoryKindEnum.optional(),
    memoryId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
  })
  .openapi("ListCitationsQuery");

const ListCitationsResponseSchema = z
  .object({ items: z.array(CitationSchema) })
  .openapi("ListCitationsResponse");

const listCitationsRoute = createRoute({
  method: "get",
  path: "/citations",
  tags: ["citations"],
  summary: "List citations linked to a memory primitive.",
  request: { query: ListCitationsQuerySchema },
  responses: {
    200: {
      description: "Matching citations, newest first.",
      content: { "application/json": { schema: ListCitationsResponseSchema } },
    },
    400: { description: "Invalid query." },
  },
});

export function mountCitations(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(listCitationsRoute, async (c) => {
    const { memoryKind, memoryId, limit } = c.req.valid("query");
    const workspaceId = c.get("workspaceId");
    // flatten-legacy-dual-core PR9e port: the legacy CoreLike listCitations
    // call is replaced by deps.storage.listCitations (v3 StorageAdapter,
    // design.md D6.5). Same query-param forwarding contract as the legacy
    // handler, pinned by __tests__/parity/citations.parity.test.ts.
    if (!deps.storage) throw new BadRequestError("storage adapter not available");
    const items = await deps.storage.listCitations({
      workspaceId,
      ...(memoryKind ? { memoryKind } : {}),
      ...(memoryId ? { memoryId } : {}),
      limit,
    });
    return c.json({ items }, 200);
  });
}
