import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { buildAnticipationFeed } from "@mnemo-ai/core/cognitive";
import type { AuthContext } from "@mnemo-ai/types";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { AnticipatedMemory, AnticipationFeed } from "@mnemo-ai/core/cognitive";
import { logger } from "../logging.js";
import { resolveProvenance } from "../provenance.js";

const AnticipatedMemorySchema = z.object({
  id: z.string(),
  score: z.number(),
  source: z.enum(["sequential", "periodic", "conditional", "co-occurrence", "blended"]),
  rationale: z.string(),
});

const AnticipationFeedSchema = z
  .object({
    workspaceId: z.string(),
    generatedAt: z.iso.datetime(),
    cue: z.object({ recentlyRecalledId: z.string() }).nullable(),
    items: z.array(AnticipatedMemorySchema),
  })
  .openapi("AnticipationFeed");

const getAnticipation = createRoute({
  method: "get",
  path: "/anticipation",
  tags: ["anticipation"],
  summary: "Return ranked anticipated memories (§8 Anticipation Engine).",
  request: {
    query: z.object({
      recentlyRecalledId: z.string().optional(),
      // §30: minutes to anticipate ahead (default 30) — shifts the periodic slot.
      lookAhead: z.coerce.number().int().min(0).max(10_080).optional().default(30),
      // §30: query context for conditional anticipation patterns.
      context: z.string().max(500).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: "Ranked anticipated memories.",
      content: { "application/json": { schema: AnticipationFeedSchema } },
    },
  },
});

/**
 * LLM-enhanced contextual anticipation.
 *
 * When a context string is supplied and an LLM adapter is available, asks the
 * LLM to generate 2-3 related search queries for that context, runs those
 * queries against core.recall(), and merges the resulting hits into the
 * statistical feed (deduplicating by fact id).
 *
 * This is purely additive — SQL-based items are never removed.
 * Failures are non-fatal: any error is logged and the statistical feed is
 * returned unchanged.
 */
async function enrichWithLlmContext(
  feed: AnticipationFeed,
  context: string,
  workspaceId: string,
  deps: ServerDeps,
  limit: number,
  auth: AuthContext
): Promise<AnticipationFeed> {
  // Resolve the LLM adapter (chat, not embed): workspace DB config → boot adapter.
  let llmAdapter = deps.llmAdapter;
  if (!llmAdapter && deps.llmConfigResolver) {
    const { buildWorkspaceLlmAdapter } = await import("../config/WorkspaceLlmAdapter.js");
    llmAdapter =
      (await buildWorkspaceLlmAdapter(workspaceId, deps.llmConfigResolver, deps.llmAdapter)) ??
      undefined;
  }

  if (!llmAdapter) return feed; // No LLM available — return unmodified.

  // Ask the LLM for 2-3 related search queries.
  let extraQueries: string[] = [];
  try {
    const out = await llmAdapter.generate({
      system:
        "You are a memory retrieval assistant. Given a context description, output a JSON array of 2-3 short search queries that would surface related stored memories. Reply with ONLY the JSON array, no other text.",
      messages: [
        {
          role: "user",
          content: `Context: "${context}"\n\nGenerate 2-3 search queries as a JSON string array. Example: ["query one", "query two"]`,
        },
      ],
      maxTokens: 150,
      temperature: 0,
      task: "prefilter",
    });

    const raw = out.content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      extraQueries = (parsed as unknown[])
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .slice(0, 3)
        .map((q) => q.trim());
    }
  } catch (err) {
    logger.warn({ err, workspaceId }, "anticipation.llm_query_generation_failed");
    return feed; // Degrade gracefully.
  }

  if (extraQueries.length === 0) return feed;

  // Run recall queries in parallel. v3 `deps.cognitive.recall` is the direct
  // equivalent of the legacy core's `recall` method — `topK`→`limit`,
  // `query`→`text`. `vectorWeight` has no v3 per-call knob: v3's 7-stage
  // cascade always fuses vector + lexical internally (recall-cold.ts), and
  // this call site never exposed the constant 0.5 to callers anyway —
  // dropping it is a safe, disclosed equivalent, not a behavior loss.
  const recallResults = await Promise.allSettled(
    extraQueries.map((query) => deps.cognitive.recall({ workspaceId, text: query, limit: 5 }, auth))
  );

  // Merge hits into the feed, deduplicating by id.
  const existingIds = new Set(feed.items.map((item) => item.id));
  const newItems: AnticipatedMemory[] = [];

  // Base score for LLM-derived items (slightly below the lowest SQL item score
  // so statistical predictions keep priority, but still appear if below limit).
  const LLM_BASE_SCORE = 0.1;

  for (let i = 0; i < recallResults.length; i++) {
    const result = recallResults[i]!;
    const query = extraQueries[i]!;
    if (result.status === "rejected") {
      logger.warn(
        { err: result.reason, query, workspaceId },
        "anticipation.llm_recall_query_failed"
      );
      continue;
    }
    for (const hit of result.value.hits) {
      if (existingIds.has(hit.id)) continue; // Already in feed — skip.
      existingIds.add(hit.id);
      newItems.push({
        id: hit.id,
        score: LLM_BASE_SCORE * (hit.score ?? 1),
        source: "conditional",
        rationale: `LLM-suggested context match for "${query}".`,
      });
    }
  }

  if (newItems.length === 0) return feed;

  const merged = [...feed.items, ...newItems].sort((a, b) => b.score - a.score).slice(0, limit);

  return { ...feed, items: merged };
}

export function mountAnticipation(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(getAnticipation, async (c) => {
    const workspaceId = c.get("workspaceId");
    const { recentlyRecalledId, lookAhead, context, limit } = c.req.valid("query");

    if (!deps.storage) throw new Error("storage adapter not available");

    // Reads directly from deps.storage — NOT through withMnemoTx or CoreLike.
    // Adapter's WHERE workspace_id filter provides isolation (MVs bypass RLS).
    const feed = await buildAnticipationFeed(deps.storage, workspaceId, {
      ...(recentlyRecalledId ? { recentlyRecalledId } : {}),
      ...(context ? { queryContext: context } : {}),
      lookAheadMinutes: lookAhead,
      limit,
    });

    // LLM-enhanced contextual enrichment (§gap4): when context is provided and
    // an LLM adapter is available, generate additional search queries and merge
    // results. This is purely additive and non-fatal.
    if (context) {
      const provenance = resolveProvenance(c);
      const auth: AuthContext = {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        userId: provenance.userId,
        scopes: [...c.get("scopes")] as AuthContext["scopes"],
        maxSensitivity: c.get("maxSensitivity"),
      };
      const enriched = await enrichWithLlmContext(
        feed,
        context,
        workspaceId,
        deps,
        limit,
        auth
      ).catch((err: unknown) => {
        logger.warn({ err, workspaceId }, "anticipation.llm_enrichment_failed");
        return feed;
      });
      return c.json(enriched, 200);
    }

    return c.json(feed, 200);
  });
}
