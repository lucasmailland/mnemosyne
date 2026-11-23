import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { NotFoundError } from "../errors.js";
import {
  assertCanReadFact,
  assertCanWriteSensitivity,
  canReadSensitivity,
  filterBySensitivity,
  findHiddenFor,
  resolveCeiling,
} from "../rbac.js";
import { resolveProvenance } from "../provenance.js";
import { resolveTargetWorkspace } from "../workspace-target.js";
import {
  tokensSavedTotal,
  reasoningResolve,
  reasoningWorthHistogram,
  reasoningResolveLatency,
} from "../metrics/index.js";
import { reasoningToWire } from "./_mappers.js";

/** Rough token estimate for a cached chain (chars/4) — what a hit avoids regenerating. */
function estimateChainTokens(chain: unknown): number {
  try {
    return Math.round(JSON.stringify(chain ?? "").length / 4);
  } catch {
    return 0;
  }
}
import type { CreateReasoningInput, ReasoningFilter, UpdateReasoningInput } from "@mnemo-ai/types";
import { MNEMO_SPAN_NAMES } from "@mnemo-ai/types";
import {
  resolveDecision,
  dedupDecision,
  lifecycleTransition,
  passesTopicKeyResolveGate,
} from "@mnemo-ai/core/cognitive";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const ReasoningStatusEnum = z
  .enum(["active", "archived", "pruned", "quarantined", "golden"])
  .openapi("ReasoningStatusEnum");

const ChainStepSchema = z.object({
  step: z.number().int().nonnegative(),
  reasoning: z.string().min(1).max(20_000),
  conclusion: z.string().max(20_000).optional(),
});

const SensitivityEnum = z.enum(["public", "internal", "confidential", "restricted"]);

const ReasoningSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    agentId: z.string().optional(),
    question: z.string(),
    chain: z.array(ChainStepSchema),
    conclusion: z.string(),
    successCount: z.number().int(),
    failureCount: z.number().int(),
    worth: z.number(),
    topicKey: z.string().optional(),
    status: ReasoningStatusEnum,
    sensitivity: SensitivityEnum,
    lastUsedAt: z.iso.datetime().optional(),
    usageCount: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .openapi("ReasoningSchema");

const ListReasoningQuery = z
  .object({
    status: ReasoningStatusEnum.optional(),
    topicKey: z.string().optional(),
    includeClosed: z.enum(["true", "false"]).optional().openapi({
      description: "Include closed rows (archived chains). Default false.",
    }),
    offset: z.coerce.number().int().min(0).optional().default(0),
    limit: z.coerce.number().int().min(1).max(200).optional().default(25),
  })
  .openapi("ListReasoningQuery");

const ListReasoningResponse = z
  .object({
    items: z.array(ReasoningSchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
    hasMore: z.boolean(),
  })
  .openapi("ListReasoningResponse");

const CreateReasoningBody = z
  .object({
    agentId: z.string().optional(),
    question: z.string().min(1).max(20_000),
    chain: z.array(ChainStepSchema).min(1).max(200),
    conclusion: z.string().min(1).max(20_000),
    topicKey: z.string().max(200).optional(),
    sensitivity: SensitivityEnum.default("internal").optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    targetWorkspaceId: z.guid().optional().openapi({
      description:
        "Write to a different workspace than the one in the API key. The key's user must be a member of the target workspace. Requires userId binding on the key (mk_user_* or mk_live_* with user_id set).",
    }),
  })
  .openapi("CreateReasoningBody");

const PatchReasoningBody = z
  .object({
    status: ReasoningStatusEnum.optional(),
    chain: z.array(ChainStepSchema).min(1).max(200).optional(),
    conclusion: z.string().min(1).max(20_000).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("PatchReasoningBody");

const IdParamSchema = z.object({ id: z.string() });

/**
 * The cache candidates the caller may read. One above the ceiling is neither
 * served, bumped nor named in `similar_attempts`: for this caller it is not in
 * the cache.
 */
async function readableCandidates<T extends { id: string }>(
  c: Parameters<typeof resolveCeiling>[0],
  deps: ServerDeps,
  workspaceId: string,
  rows: T[]
): Promise<T[]> {
  const hidden = await findHiddenFor(
    c,
    deps.storage!,
    workspaceId,
    rows.map((r) => r.id)
  );
  return rows.filter((r) => !hidden.has(r.id));
}

// ─── Wave M1 schemas ──────────────────────────────────────────────────────────

const ResolveBody = z
  .object({
    query: z.string().min(1).max(20_000),
    topicKey: z.string().max(200).optional(),
  })
  .openapi("ResolveBody");

const ResolveResponse = z
  .object({
    action: z.enum(["hit", "execute"]),
    reasoning_id: z.string().optional(),
    cached_cot: z.array(ChainStepSchema).optional(),
    conclusion: z.string().optional(),
    suggested_model: z.enum(["haiku"]).optional(),
    similar_attempts: z
      .array(z.object({ reasoning_id: z.string(), cosine: z.number() }))
      .optional(),
  })
  .openapi("ResolveResponse");

const RecordBody = z
  .object({
    agentId: z.string().optional(),
    question: z.string().min(1).max(20_000),
    chain: z.array(ChainStepSchema).min(1).max(200),
    conclusion: z.string().min(1).max(20_000),
    topicKey: z.string().max(200).optional(),
    outcome: z.enum(["success", "fail"]).default("success"),
    metadata: z.record(z.string(), z.unknown()).optional(),
    // APP-022: was missing, so a requested tier was silently dropped and the
    // chain stored at the default. Applies to a new chain only; a near-duplicate
    // upsert stores no new text.
    sensitivity: SensitivityEnum.optional(),
  })
  .openapi("RecordBody");

const FeedbackBody = z
  .object({
    reasoning_id: z.string(),
    outcome: z.enum(["success", "fail"]),
  })
  .openapi("FeedbackBody");

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountReasoning(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // GET /reasoning — list
  app.openapi(
    createRoute({
      method: "get",
      path: "/reasoning",
      tags: ["reasoning"],
      summary: "List reasoning chains for this workspace.",
      request: {
        query: ListReasoningQuery,
      },
      responses: {
        200: {
          description: "Paginated reasoning list.",
          content: { "application/json": { schema: ListReasoningResponse } },
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { status, topicKey, includeClosed, offset, limit } = c.req.valid("query");
      if (!deps.storage) throw new Error("storage adapter not available");

      const filter: ReasoningFilter = {
        workspaceId,
        ...(status !== undefined ? { status } : {}),
        ...(topicKey !== undefined ? { topicKey } : {}),
        // PRIM-16: current chains by default; includeClosed=true (or an explicit
        // status) is how a caller asks for archived ones.
        ...(includeClosed === "true" || status !== undefined ? {} : { openOnly: true }),
        offset,
        limit,
      };

      const result = await deps.storage.queryReasoning(filter);

      const filtered = filterBySensitivity(result.items, resolveCeiling(c));
      return c.json({
        items: filtered.map(reasoningToWire),
        total: result.total,
        offset: result.offset,
        limit: result.limit,
        hasMore: result.hasMore,
      });
    }
  );

  // POST /reasoning — create
  app.openapi(
    createRoute({
      method: "post",
      path: "/reasoning",
      tags: ["reasoning"],
      summary: "Create a new reasoning chain.",
      request: {
        body: {
          content: { "application/json": { schema: CreateReasoningBody } },
          required: true,
        },
      },
      responses: {
        201: {
          description: "Reasoning chain created.",
          content: { "application/json": { schema: ReasoningSchema } },
        },
      },
    }),
    async (c) => {
      const { workspaceId: keyWorkspaceId, userId } = getAuthCtx(c);
      const provenance = resolveProvenance(c);
      const body = c.req.valid("json");
      assertCanWriteSensitivity(c, body.sensitivity); // PRIM-14
      if (!deps.storage) throw new Error("storage adapter not available");

      const target = await resolveTargetWorkspace({
        keyWorkspaceId,
        userId,
        sql: deps.metricsPgClient,
        targetWorkspaceId: body.targetWorkspaceId,
      });
      if (!target.ok) return c.json(target.body as never, target.status as never);
      const workspaceId = target.workspaceId;

      const input: CreateReasoningInput = {
        workspaceId,
        actorId: provenance.actorId,
        userId: provenance.userId,
        actorType: provenance.actorType,
        question: body.question,
        chain: body.chain,
        conclusion: body.conclusion,
        ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
        ...(body.topicKey !== undefined ? { topicKey: body.topicKey } : {}),
        ...(body.sensitivity !== undefined ? { sensitivity: body.sensitivity } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      };

      const reasoning = await deps.storage.createReasoning(input);

      return c.json(reasoningToWire(reasoning), 201);
    }
  );

  // GET /reasoning/:id — single reasoning chain
  app.openapi(
    createRoute({
      method: "get",
      path: "/reasoning/{id}",
      tags: ["reasoning"],
      summary: "Get a single reasoning chain by ID.",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "The reasoning chain.",
          content: { "application/json": { schema: ReasoningSchema } },
        },
        404: { description: "Reasoning chain not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      const reasoning = await deps.storage.getReasoning(id, workspaceId);
      if (!reasoning) throw new NotFoundError(`Reasoning ${id} not found`);
      assertCanReadFact(c, id, reasoning.sensitivity, "Reasoning");

      return c.json(reasoningToWire(reasoning), 200);
    }
  );

  // PATCH /reasoning/:id — update
  app.openapi(
    createRoute({
      method: "patch",
      path: "/reasoning/{id}",
      tags: ["reasoning"],
      summary: "Update fields on an existing reasoning chain.",
      request: {
        params: IdParamSchema,
        body: {
          content: { "application/json": { schema: PatchReasoningBody } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Updated reasoning chain.",
          content: { "application/json": { schema: ReasoningSchema } },
        },
        404: { description: "Reasoning chain not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");

      // 404-first: confirm the reasoning belongs to this workspace, and is one
      // the caller may read, before mutating (the response carries it).
      const existing = await deps.storage.getReasoning(id, workspaceId);
      if (!existing) throw new NotFoundError(`Reasoning ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Reasoning");

      // Build patch field-by-field — all fields are plain (no date conversion needed)
      const patch: UpdateReasoningInput = { workspaceId };
      if (body.status !== undefined) patch.status = body.status;
      if (body.chain !== undefined) patch.chain = body.chain;
      if (body.conclusion !== undefined) patch.conclusion = body.conclusion;
      if (body.metadata !== undefined) patch.metadata = body.metadata;

      const updated = await deps.storage.updateReasoning(id, patch);
      return c.json(reasoningToWire(updated), 200);
    }
  );

  // DELETE /reasoning/:id — archive
  app.openapi(
    createRoute({
      method: "delete",
      path: "/reasoning/{id}",
      tags: ["reasoning"],
      summary: "Archive a reasoning chain (soft-delete).",
      request: { params: IdParamSchema },
      responses: {
        204: { description: "Reasoning chain archived." },
        404: { description: "Reasoning chain not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { id } = c.req.valid("param");
      if (!deps.storage) throw new Error("storage adapter not available");

      // 404-first pattern; a hidden chain answers like a missing one.
      const existing = await deps.storage.getReasoning(id, workspaceId);
      if (!existing) throw new NotFoundError(`Reasoning ${id} not found`);
      assertCanReadFact(c, id, existing.sensitivity, "Reasoning");

      await deps.storage.archiveReasoning(id, workspaceId);
      return c.body(null, 204);
    }
  );

  // POST /reasoning/resolve — spec §8c cache hit gate
  app.openapi(
    createRoute({
      method: "post",
      path: "/reasoning/resolve",
      tags: ["reasoning"],
      summary: "Resolve a question against the CoT cache (spec §8c).",
      request: {
        body: {
          content: { "application/json": { schema: ResolveBody } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Cache hit or execute decision.",
          content: { "application/json": { schema: ResolveResponse } },
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { query, topicKey } = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");

      const t0 = Date.now();
      let resolvePath: "topic_key" | "vector" = "vector";

      const span = deps.telemetry.startSpan(MNEMO_SPAN_NAMES.reasoningResolve, {
        attributes: { "mnemo.workspace_id": workspaceId },
      });
      try {
        // Topic-key fast-path: exact match by key, no embedding needed.
        if (topicKey) {
          const filter = { workspaceId, topicKey, offset: 0, limit: 1 };
          const result = await deps.storage.queryReasoning(filter);
          const candidate = result.items[0];
          // §8c: the O(1) topic-key path must enforce the SAME gate as the vector
          // path — active/golden ∧ worth>0.5 ∧ Wilson lower-bound>0.3 (>=5 uses).
          // Previously it served on worth>0.5 alone, letting low-evidence chains
          // through.
          if (
            candidate &&
            canReadSensitivity(resolveCeiling(c), candidate.sensitivity) &&
            passesTopicKeyResolveGate(candidate)
          ) {
            await deps.storage.recordReasoningUse(candidate.id, workspaceId);
            // B1.1: emit tokensSavedTotal{mechanism:"distillation"} (§22)
            tokensSavedTotal.inc(
              { mechanism: "distillation" },
              estimateChainTokens(candidate.chain)
            );
            // B1.2: observe worth at cache-hit path
            if (typeof candidate.worth === "number") {
              reasoningWorthHistogram.observe({}, Math.max(0, Math.min(1, candidate.worth)));
            }
            reasoningResolve.inc({ result: "cache_hit" });
            span.setAttribute("mnemo.reasoning.result", "cache_hit");
            // Only label the latency sample topic_key when the fast-path actually
            // resolved; a topic-key miss falls through to vector below.
            resolvePath = "topic_key";
            return c.json({
              action: "hit" as const,
              reasoning_id: candidate.id,
              cached_cot: candidate.chain,
              conclusion: candidate.conclusion,
              suggested_model: "haiku" as const,
            });
          }
          // Fall through to vector path — topic key miss
        }

        // Vector search path — requires embed capability.
        if (!deps.llm) {
          // No LLM for embedding; return execute miss with no similar attempts.
          reasoningResolve.inc({ result: "execute" });
          span.setAttribute("mnemo.reasoning.result", "execute");
          return c.json({ action: "execute" as const, similar_attempts: [] });
        }

        const model = deps.embedModel ?? "text-embedding-3-small";
        const vector = await deps.llm.embed(query, model);
        const candidates = await readableCandidates(
          c,
          deps,
          workspaceId,
          await deps.storage.searchReasoning({ workspaceId, vector, limit: 5 })
        );

        const decision = resolveDecision(candidates);
        if (decision.action === "hit") {
          const hit = await deps.storage.getReasoning(decision.reasoningId, workspaceId);
          await deps.storage.recordReasoningUse(decision.reasoningId, workspaceId);
          // B1.1: emit tokensSavedTotal{mechanism:"distillation"} (§22)
          tokensSavedTotal.inc({ mechanism: "distillation" }, estimateChainTokens(hit?.chain));
          // B1.2: observe worth at cache-hit path
          if (hit && typeof hit.worth === "number") {
            reasoningWorthHistogram.observe({}, Math.max(0, Math.min(1, hit.worth)));
          }
          reasoningResolve.inc({ result: "cache_hit" });
          span.setAttribute("mnemo.reasoning.result", "cache_hit");
          return c.json({
            action: "hit" as const,
            reasoning_id: decision.reasoningId,
            cached_cot: hit?.chain,
            conclusion: hit?.conclusion,
            suggested_model: decision.suggestedModel,
          });
        }
        reasoningResolve.inc({ result: "execute" });
        span.setAttribute("mnemo.reasoning.result", "execute");
        return c.json({
          action: "execute" as const,
          similar_attempts: decision.similarAttempts.map((a) => ({
            reasoning_id: a.reasoningId,
            cosine: a.cosine,
          })),
        });
      } catch (err) {
        span.setStatus("error", String(err));
        throw err;
      } finally {
        span.end();
        reasoningResolveLatency.observe({ path: resolvePath }, (Date.now() - t0) / 1000);
      }
    }
  );

  // POST /reasoning/record — spec §8 RECORD step
  app.openapi(
    createRoute({
      method: "post",
      path: "/reasoning/record",
      tags: ["reasoning"],
      summary: "Record a new reasoning chain into the CoT cache (spec §8).",
      request: {
        body: {
          content: { "application/json": { schema: RecordBody } },
          required: true,
        },
      },
      responses: {
        201: {
          description: "Recorded reasoning chain.",
          content: { "application/json": { schema: ReasoningSchema } },
        },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const provenance = resolveProvenance(c);
      const body = c.req.valid("json");
      assertCanWriteSensitivity(c, body.sensitivity); // PRIM-14
      if (!deps.storage) throw new Error("storage adapter not available");

      const isSuccess = body.outcome !== "fail";
      const worthDelta = {
        success: isSuccess ? 1 : 0,
        failure: isSuccess ? 0 : 1,
        creditWeight: 1,
      };

      // Find near-duplicates. Without LLM we fall through to insert.
      let candidates: Array<{
        id: string;
        cosine: number;
        worth: number;
        successCount: number;
        failureCount: number;
        status: string;
      }> = [];
      if (deps.llm) {
        const model = deps.embedModel ?? "text-embedding-3-small";
        const text = body.question + " " + body.conclusion;
        const vector = await deps.llm.embed(text, model);
        candidates = await readableCandidates(
          c,
          deps,
          workspaceId,
          await deps.storage.searchReasoning({
            workspaceId,
            vector,
            limit: 1,
            includeAllStatuses: true,
          })
        );
      }

      const dedup = dedupDecision(candidates as Parameters<typeof dedupDecision>[0]);

      let targetId: string;
      if (dedup.action === "upsert") {
        // Bump worth on the existing chain.
        targetId = dedup.reasoningId;
        await deps.storage.updateWorth(targetId, workspaceId, "reasoning", worthDelta);
        await deps.storage.recordReasoningUse(targetId, workspaceId);
      } else {
        // Insert a new chain.
        const input: CreateReasoningInput = {
          workspaceId,
          actorId: provenance.actorId,
          userId: provenance.userId,
          actorType: provenance.actorType,
          question: body.question,
          chain: body.chain,
          conclusion: body.conclusion,
          ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
          ...(body.topicKey !== undefined ? { topicKey: body.topicKey } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          ...(body.sensitivity !== undefined ? { sensitivity: body.sensitivity } : {}),
        };
        const created = await deps.storage.createReasoning(input);
        targetId = created.id;
        await deps.storage.updateWorth(targetId, workspaceId, "reasoning", worthDelta);
      }

      const final = await deps.storage.getReasoning(targetId, workspaceId);
      if (!final) throw new Error(`Reasoning ${targetId} not found after record`);

      return c.json(reasoningToWire(final), 201);
    }
  );

  // POST /reasoning/feedback — spec §8 FEEDBACK lifecycle
  app.openapi(
    createRoute({
      method: "post",
      path: "/reasoning/feedback",
      tags: ["reasoning"],
      summary: "Report outcome for a cached reasoning chain (spec §8 FEEDBACK).",
      request: {
        body: {
          content: { "application/json": { schema: FeedbackBody } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "Updated reasoning chain after feedback.",
          content: { "application/json": { schema: ReasoningSchema } },
        },
        404: { description: "Reasoning chain not found." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const { reasoning_id, outcome } = c.req.valid("json");
      if (!deps.storage) throw new Error("storage adapter not available");

      const existing = await deps.storage.getReasoning(reasoning_id, workspaceId);
      if (!existing) throw new NotFoundError(`Reasoning ${reasoning_id} not found`);
      assertCanReadFact(c, reasoning_id, existing.sensitivity, "Reasoning");

      const isSuccess = outcome !== "fail";
      await deps.storage.updateWorth(reasoning_id, workspaceId, "reasoning", {
        success: isSuccess ? 1 : 0,
        failure: isSuccess ? 0 : 1,
        creditWeight: 1,
      });

      // Refresh to get updated worth/usageCount before lifecycle check.
      const updated = await deps.storage.getReasoning(reasoning_id, workspaceId);
      if (!updated) throw new Error(`Reasoning ${reasoning_id} not found after updateWorth`);

      const transition = lifecycleTransition({
        worth: updated.worth,
        usageCount: updated.usageCount,
        status: updated.status,
      });

      if (transition !== null) {
        await deps.storage.setReasoningStatus(reasoning_id, workspaceId, transition);
      }

      // Fetch final state for the response.
      const final = await deps.storage.getReasoning(reasoning_id, workspaceId);
      if (!final) throw new Error(`Reasoning ${reasoning_id} not found after transition`);

      return c.json(reasoningToWire(final), 200);
    }
  );
}
