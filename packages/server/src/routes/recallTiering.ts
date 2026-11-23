import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { ServerDeps } from "../deps.js";
import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import { auditRecall } from "./recall.js";
import { emitMeter } from "../metering/MeterEmitter.js";
import { resolveProvenance, resolveRecallEffects } from "../provenance.js";
import { observeDuration, recallLatency, recallTierHits } from "../metrics/index.js";
import { filterBySensitivity, resolveCeiling, DEFAULT_SENSITIVITY } from "../rbac.js";

/**
 * §4 Recall tiering surface (deep re-audit P1-3).
 *
 * Three new endpoints that expose the three-tier recall cascade explicitly,
 * rather than the implicit blend behind POST /memory/recall:
 *
 *   POST /recall/hot     — hot-tier only (Redis ACT-R ZSet). Sub-5ms path:
 *                             NO embedding round-trip, NO cold cascade fallthrough.
 *                             Returns [] on a hot-tier miss (the caller decides
 *                             whether to fall back to the full /recall).
 *   POST /recall/unified — KB + memory blend. Memory leg uses the full
 *                             hot→pointer→cold cascade; the KB leg is supplied by
 *                             the caller (host owns KB). Scores are min-max
 *                             normalised per source then weighted-summed.
 *   POST /recall/explain — why-this-result. Runs a normal recall, then
 *                             surfaces the per-hit scoring signals (worth,
 *                             Wilson lower bound, injection score, provenance,
 *                             contested flag, relations, serving tier) that the
 *                             plain recall response hides.
 *
 * All three require the cognitive core (`deps.cognitive`). When absent the routes return
 * 501 — the hot tier and structured explainability require it; the
 * legacy CoreLike.recall has no equivalent.
 */

// ─── Shared schemas ───────────────────────────────────────────────────────────

const HotRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(10).openapi({
      description: "Maximum number of hot-tier hits to return.",
    }),
    includeLowWorth: z.boolean().default(false).openapi({
      description: "When true, bypasses the §11 worth serving gate (returns even low-worth hits).",
    }),
  })
  .openapi("RecallHotRequest");

const HotHitSchema = z
  .object({
    id: z.string(),
    content: z.string(),
    score: z.number(),
    worth: z.number().optional(),
    sensitivity: z.string(),
    provenance: z.string(),
  })
  .openapi("RecallHotHit");

const HotResponseSchema = z
  .object({
    hits: z.array(HotHitSchema),
    fromHotTier: z.boolean().openapi({
      description: "Always true when hits are present; false on a hot-tier miss.",
    }),
    tookMs: z.number(),
  })
  .openapi("RecallHotResponse");

const KbHitSchema = z
  .object({
    id: z.string(),
    content: z.string(),
    score: z.number().openapi({ description: "Raw provider score (any scale)." }),
    docId: z.string().optional(),
    docTitle: z.string().optional(),
    page: z.number().int().optional(),
  })
  .openapi("UnifiedKbHit");

const UnifiedRequestSchema = z
  .object({
    query: z.string().min(1).max(8000),
    vector: z.array(z.number()).min(8).max(4096).optional().openapi({
      description: "Optional precomputed embedding for the memory leg.",
    }),
    limit: z.number().int().min(1).max(100).default(10),
    memoryWeight: z.number().min(0).max(1).default(0.6).openapi({
      description: "Weight of the memory leg in the blended score (KB weight = 1 - this).",
    }),
    kbHits: z.array(KbHitSchema).max(200).default([]).openapi({
      description:
        "KB chunks supplied by the caller (the host owns KB). Scores are normalised before blending; pass [] for memory-only.",
    }),
  })
  .openapi("RecallUnifiedRequest");

const UnifiedHitSchema = z
  .object({
    source: z.enum(["memory", "kb"]),
    id: z.string(),
    content: z.string(),
    score: z.number().openapi({ description: "Blended, source-comparable score in [0,1]." }),
    metadata: z.record(z.string(), z.unknown()),
  })
  .openapi("RecallUnifiedHit");

const UnifiedResponseSchema = z
  .object({
    hits: z.array(UnifiedHitSchema),
    tookMs: z.number(),
  })
  .openapi("RecallUnifiedResponse");

const ExplainRequestSchema = z
  .object({
    query: z.string().min(1).max(8000),
    vector: z.array(z.number()).min(8).max(4096).optional(),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .openapi("RecallExplainRequest");

const ExplainHitSchema = z
  .object({
    id: z.string(),
    content: z.string(),
    primitive: z.string(),
    score: z.number(),
    explain: z
      .object({
        worth: z.number().optional().openapi({ description: "TD(λ) worth posterior." }),
        worthLowerBound: z
          .number()
          .optional()
          .openapi({ description: "Wilson-score 95% CI lower bound on worth." }),
        injectionScore: z
          .number()
          .openapi({ description: "0–1; high = likely prompt injection (score is demoted)." }),
        provenance: z.string(),
        contested: z.boolean().openapi({ description: "True if a contradicting fact exists." }),
        servedFromHotTier: z.boolean(),
        relationCount: z.number().int(),
      })
      .openapi("RecallExplainBreakdown"),
  })
  .openapi("RecallExplainHit");

const ExplainResponseSchema = z
  .object({
    hits: z.array(ExplainHitSchema),
    fromHotTier: z.boolean(),
    tookMs: z.number(),
  })
  .openapi("RecallExplainResponse");

const NotImplementedSchema = z
  .object({ code: z.string(), message: z.string() })
  .openapi("RecallTieringNotImplemented");

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountRecallTiering(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // ── POST /recall/hot ────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/recall/hot",
      tags: ["recall"],
      summary: "Hot-tier-only recall (sub-5ms; no embedding, no cold fallthrough).",
      request: {
        body: {
          content: { "application/json": { schema: HotRequestSchema } },
          required: false,
        },
      },
      responses: {
        200: {
          description: "Hot-tier hits (empty array on a hot-tier miss).",
          content: { "application/json": { schema: HotResponseSchema } },
        },
        401: { description: "Missing or invalid bearer token." },
        501: {
          description: "Cognitive core not configured — hot tier requires full core.",
          content: { "application/json": { schema: NotImplementedSchema } },
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const { workspaceId } = getAuthCtx(c);
      const provenance = resolveProvenance(c);
      const started = performance.now();

      const auth: import("@mnemo-ai/types").AuthContext = {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        userId: provenance.userId,
        scopes: ["memory:read"],
      };

      // recallHot reads the Redis ACT-R ZSet directly — no embed, no cold cascade.
      const limit = body?.limit ?? 10;
      const hits = await (deps.circuitBreakers
        ? deps.circuitBreakers.storageRead(() => deps.cognitive.recallHot(workspaceId, auth, limit))
        : deps.cognitive.recallHot(workspaceId, auth, limit));

      const visible = filterBySensitivity(
        hits as Array<{ sensitivity?: string }>,
        resolveCeiling(c)
      ) as typeof hits;

      observeDuration(recallLatency, { tier: "hot", kind: "fact", cache_hit: "true" }, started);
      // mnemo_requests_total emitted globally by app.ts middleware — no ad-hoc inc.
      recallTierHits.inc({ tier: visible.length > 0 ? "hot" : "miss" });
      emitMeter(workspaceId, "recall");

      if (deps.storage) {
        auditRecall(deps.storage, {
          workspaceId,
          actorId: provenance.actorId,
          actorType: provenance.actorType,
          resultCount: visible.length,
          topK: limit,
          embedded: false,
        });
      }

      return c.json(
        {
          hits: visible.map((h) => ({
            id: h.id,
            content: h.content,
            score: h.score,
            ...(h.worth !== undefined ? { worth: h.worth } : {}),
            sensitivity: h.sensitivity ?? DEFAULT_SENSITIVITY,
            provenance: String(h.provenance),
          })),
          fromHotTier: visible.length > 0,
          tookMs: Math.round(performance.now() - started),
        },
        200
      );
    }
  );

  // ── POST /recall/unified ──────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/recall/unified",
      tags: ["recall"],
      summary: "Unified KB + memory recall (blended, source-normalised).",
      request: {
        body: {
          content: { "application/json": { schema: UnifiedRequestSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Blended hits ordered by unified score, descending.",
          content: { "application/json": { schema: UnifiedResponseSchema } },
        },
        400: { description: "Invalid request body." },
        401: { description: "Missing or invalid bearer token." },
        501: {
          description: "Cognitive core not configured.",
          content: { "application/json": { schema: NotImplementedSchema } },
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const { workspaceId } = getAuthCtx(c);
      const provenance = resolveProvenance(c);
      const effects = resolveRecallEffects(c, deps.trafficOrigins);
      const started = performance.now();

      const auth: import("@mnemo-ai/types").AuthContext = {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        userId: provenance.userId,
        scopes: ["memory:read"],
      };

      // Memory leg — full hot→pointer→cold cascade via v3.recall.
      const memoryResult = await (deps.circuitBreakers
        ? deps.circuitBreakers.storageRead(() =>
            deps.cognitive.recall(
              {
                workspaceId,
                effects,
                text: body.query,
                embedding: body.vector ? new Float32Array(body.vector) : undefined,
                limit: body.limit,
              },
              auth
            )
          )
        : deps.cognitive.recall(
            {
              workspaceId,
              effects,
              text: body.query,
              embedding: body.vector ? new Float32Array(body.vector) : undefined,
              limit: body.limit,
            },
            auth
          ));

      const memoryHits = filterBySensitivity(
        memoryResult.hits as Array<{ sensitivity?: string }>,
        resolveCeiling(c)
      ) as typeof memoryResult.hits;

      const memoryWeight = body.memoryWeight;
      const kbWeight = 1 - memoryWeight;

      // Per-source min-max normalisation so the two scales are comparable
      // before the weighted blend (mirrors core/recall/unified.ts semantics).
      const maxMemScore = memoryHits.length > 0 ? Math.max(...memoryHits.map((h) => h.score)) : 0;
      const memDivisor = maxMemScore > 0 ? maxMemScore : 1;
      const maxKbScore = body.kbHits.length > 0 ? Math.max(...body.kbHits.map((h) => h.score)) : 0;
      const kbDivisor = maxKbScore > 0 ? maxKbScore : 1;

      const blended: Array<z.infer<typeof UnifiedHitSchema>> = [
        ...memoryHits.map((h) => ({
          source: "memory" as const,
          id: h.id,
          content: h.content,
          score: memoryWeight * (h.score / memDivisor),
          metadata: {
            primitive: h.primitive,
            provenance: h.provenance,
            ...(h.worth !== undefined ? { worth: h.worth } : {}),
          } as Record<string, unknown>,
        })),
        ...body.kbHits.map((h) => ({
          source: "kb" as const,
          id: h.id,
          content: h.content,
          score: kbWeight * (h.score / kbDivisor),
          metadata: {
            ...(h.docId !== undefined ? { docId: h.docId } : {}),
            ...(h.docTitle !== undefined ? { docTitle: h.docTitle } : {}),
            ...(h.page !== undefined ? { page: h.page } : {}),
          } as Record<string, unknown>,
        })),
      ];

      blended.sort((a, b) => b.score - a.score);
      const top = blended.slice(0, body.limit);

      observeDuration(
        recallLatency,
        { tier: "unified", kind: "fact", cache_hit: "false" },
        started
      );
      // mnemo_requests_total emitted globally by app.ts middleware — no ad-hoc inc.
      recallTierHits.inc({ tier: "unified" });
      emitMeter(workspaceId, "recall");

      if (deps.storage) {
        auditRecall(deps.storage, {
          workspaceId,
          actorId: provenance.actorId,
          actorType: provenance.actorType,
          resultCount: top.length,
          topK: body.limit,
          embedded: !body.vector,
        });
      }

      return c.json({ hits: top, tookMs: Math.round(performance.now() - started) }, 200);
    }
  );

  // ── POST /recall/explain ──────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/recall/explain",
      tags: ["recall"],
      summary: "Recall with per-hit scoring breakdown (why-this-result).",
      request: {
        body: {
          content: { "application/json": { schema: ExplainRequestSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Hits with their scoring signals surfaced.",
          content: { "application/json": { schema: ExplainResponseSchema } },
        },
        400: { description: "Invalid request body." },
        401: { description: "Missing or invalid bearer token." },
        501: {
          description: "Cognitive core not configured.",
          content: { "application/json": { schema: NotImplementedSchema } },
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const { workspaceId } = getAuthCtx(c);
      const provenance = resolveProvenance(c);
      const effects = resolveRecallEffects(c, deps.trafficOrigins);
      const started = performance.now();

      const auth: import("@mnemo-ai/types").AuthContext = {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        userId: provenance.userId,
        scopes: ["memory:read"],
      };

      const result = await (deps.circuitBreakers
        ? deps.circuitBreakers.storageRead(() =>
            deps.cognitive.recall(
              {
                workspaceId,
                effects,
                text: body.query,
                embedding: body.vector ? new Float32Array(body.vector) : undefined,
                limit: body.limit,
              },
              auth
            )
          )
        : deps.cognitive.recall(
            {
              workspaceId,
              effects,
              text: body.query,
              embedding: body.vector ? new Float32Array(body.vector) : undefined,
              limit: body.limit,
            },
            auth
          ));

      const visible = filterBySensitivity(
        result.hits as Array<{ sensitivity?: string }>,
        resolveCeiling(c)
      ) as typeof result.hits;

      observeDuration(recallLatency, { tier: "cold", kind: "fact", cache_hit: "false" }, started);
      // mnemo_requests_total emitted globally by app.ts middleware — no ad-hoc inc.
      recallTierHits.inc({ tier: result.fromHotTier ? "hot" : "cold" });
      emitMeter(workspaceId, "recall");

      if (deps.storage) {
        auditRecall(deps.storage, {
          workspaceId,
          actorId: provenance.actorId,
          actorType: provenance.actorType,
          resultCount: visible.length,
          topK: body.limit,
          embedded: !body.vector,
        });
      }

      return c.json(
        {
          hits: visible.map((h) => ({
            id: h.id,
            content: h.content,
            primitive: String(h.primitive),
            score: h.score,
            explain: {
              ...(h.worth !== undefined ? { worth: h.worth } : {}),
              ...(h.worthLowerBound !== undefined ? { worthLowerBound: h.worthLowerBound } : {}),
              injectionScore: h.injectionScore,
              provenance: String(h.provenance),
              contested: h.contested,
              servedFromHotTier: result.fromHotTier,
              relationCount: h.relations?.length ?? 0,
            },
          })),
          fromHotTier: result.fromHotTier,
          tookMs: Math.round(performance.now() - started),
        },
        200
      );
    }
  );
}
