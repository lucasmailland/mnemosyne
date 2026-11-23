import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { buildSelfModel } from "@mnemo-ai/core/cognitive";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

// SelfModel — intentionally workspace-aggregate-only.
// Aggregate counts over restricted-sensitivity rows are acceptable
// (no per-fact content is exposed). See ARCHITECTURE_INVARIANTS §10.
const TrendPairSchema = z.object({ current: z.number(), previous: z.number(), delta: z.number() });

const SelfModelSchema = z
  .object({
    workspaceId: z.string(),
    generatedAt: z.iso.datetime(),
    confidenceMap: z.array(
      z.object({
        entity: z.string(),
        coverage: z.enum(["expert", "familiar", "aware", "minimal", "blind"]),
        freshness: z.enum(["current", "recent", "aging", "stale"]),
        factCount: z.number(),
        avgWorth: z.number(),
      })
    ),
    strongTopics: z.array(
      z.object({
        topicKey: z.string(),
        memoryCount: z.number(),
        avgWorth: z.number(),
        evidenceVolume: z.number(),
      })
    ),
    strengths: z.array(
      z.object({ topic: z.string(), avgWorth: z.number(), factCount: z.number() })
    ),
    gaps: z.array(
      z.object({
        topicKey: z.string(),
        gapScore: z.number(),
        recallHits30d: z.number(),
        avgWorth: z.number(),
        memoryCount: z.number(),
        suggestedAction: z.enum(["ask_user", "search_codebase", "wait_for_data"]),
      })
    ),
    trends: z
      .object({
        recallHitRate: TrendPairSchema,
        avgRecallLatency: TrendPairSchema,
        sessionCollapseQuality: TrendPairSchema,
        strategySuccessRate: TrendPairSchema,
      })
      .optional(),
    summary: z.object({
      totalTopics: z.number(),
      strongTopicsCount: z.number(),
      gapsCount: z.number(),
      blindCount: z.number(),
      avgWorthAcrossWorkspace: z.number(),
    }),
  })
  .openapi("SelfModel");

const getSelfModel = createRoute({
  method: "get",
  path: "/metacognition",
  tags: ["metacognition"],
  summary: "Return the workspace SelfModel (§31 meta-cognition).",
  request: {
    query: z.object({
      aspect: z.enum(["coverage", "trends", "gaps", "strengths", "all"]).optional(),
      entity: z.string().optional(),
      // §31: cap the size of each returned list (topics/strengths/gaps).
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: {
      description:
        "Current SelfModel. Aggregates are workspace-scoped; no per-fact content is exposed.",
      content: { "application/json": { schema: SelfModelSchema } },
    },
  },
});

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountMetacognition(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(getSelfModel, async (c) => {
    const workspaceId = c.get("workspaceId");
    const { aspect, entity, limit } = c.req.valid("query");

    if (!deps.storage) throw new Error("storage adapter not available");

    // Reads directly from deps.storage — NOT through withMnemoTx or CoreLike.
    // The adapter's WHERE workspace_id filter provides isolation (MVs bypass RLS).
    // 'trends' aspect is served by mnemo_metacognition_trends() (migration 0020).
    const model = await buildSelfModel(deps.storage, workspaceId, { aspect, entity });
    // §31: optionally cap each list so callers can request a compact view.
    // The SelfModel's lists are confidenceMap / strongTopics / strengths / gaps —
    // cap all four (an earlier version capped a non-existent `topics` field, so
    // the two largest lists were never trimmed).
    if (limit !== undefined) {
      const cap = <T>(a: T[] | undefined): T[] | undefined =>
        Array.isArray(a) ? a.slice(0, limit) : a;
      const m = model as {
        confidenceMap?: unknown[];
        strongTopics?: unknown[];
        strengths?: unknown[];
        gaps?: unknown[];
      };
      if (m.confidenceMap) m.confidenceMap = cap(m.confidenceMap);
      if (m.strongTopics) m.strongTopics = cap(m.strongTopics);
      if (m.strengths) m.strengths = cap(m.strengths);
      if (m.gaps) m.gaps = cap(m.gaps);
    }
    return c.json(model, 200);
  });
}
