// packages/server/src/routes/composition.ts
// §32 Compositionality — admin HTTP routes (Wave H4).
// All writes go via deps.storage.* directly (not through CoreLike).
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { evaluateRule } from "@mnemo-ai/core/cognitive";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { resolveProvenance } from "../provenance.js";
import { dropHiddenPointers } from "../rbac.js";
import {
  ConditionDslSchema,
  ActionDslSchema,
  type CreateCompositionRuleInput,
  type UpdateCompositionRuleInput,
  isoDateTimeInput,
} from "@mnemo-ai/types";

// §34.6 — composition rules may only reference the 9 locked relation verbs and
// the locked condition/action op set. The DSL blobs arrive as opaque JSON
// (z.record), so we validate them explicitly against the canonical core schemas
// here and reject malformed rules with a 400 (instead of failing later at
// execution time, when the rule would silently never fire).
// Structural shape so this works across the two bundled zod versions
// (@hono/zod-openapi's z vs @mnemo-ai/types' z) without a type clash.
function zodDetail(err: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}
function checkConditionDsl(conditionDsl: unknown): void {
  const r = ConditionDslSchema.safeParse(conditionDsl);
  if (!r.success) {
    throw new BadRequestError(
      `Invalid conditionDsl: ${zodDetail(r.error)}`,
      undefined,
      "conditionDsl"
    );
  }
}
function checkActionDsl(actionDsl: unknown): void {
  const r = ActionDslSchema.safeParse(actionDsl);
  if (!r.success) {
    throw new BadRequestError(`Invalid actionDsl: ${zodDetail(r.error)}`, undefined, "actionDsl");
  }
}
/** Create-time strict check: both DSLs must be present and valid. */
function validateRuleDsl(conditionDsl: unknown, actionDsl: unknown): void {
  checkConditionDsl(conditionDsl);
  checkActionDsl(actionDsl);
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const CompositionRuleSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    // DSL blobs are opaque JSON objects. z.record(z.string(), z.unknown()) aligns with the
    // ruleToWire cast (Record<string, unknown>) and avoids TypedResponse<never>.
    conditionDsl: z.record(z.string(), z.unknown()),
    actionDsl: z.record(z.string(), z.unknown()),
    priority: z.number().int(),
    isActive: z.boolean(),
    executionCount: z.number().int(),
    source: z.enum(["manual", "mined", "imported"]),
    createdBy: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("CompositionRule");

const CompositionRuleListSchema = z
  .object({
    items: z.array(CompositionRuleSchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
    hasMore: z.boolean(),
  })
  .openapi("CompositionRuleList");

/**
 * P111 — the inference log had a writer and no reader.
 *
 * `compositionality.ts` appends an entry on every derivation (and
 * `materialiseInference` writes one atomically with the derived fact), and
 * `queryInferences` was implemented on every adapter with no caller: there was
 * no way to answer "why does this fact exist?" or "what has this rule actually
 * derived?" from outside the database.
 */
const InferenceLogEntrySchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    ruleId: z.string(),
    inputFactIds: z.array(z.string()),
    derivedKind: z.string().optional(),
    derivedId: z.string().optional(),
    confidence: z.number(),
    rationale: z.string().optional(),
    triggeredByQuery: z.string().optional(),
    conversationId: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .openapi("InferenceLogEntry");

const InferenceLogListSchema = z
  .object({
    items: z.array(InferenceLogEntrySchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
    hasMore: z.boolean(),
  })
  .openapi("InferenceLogList");

const CompositionRuleCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    conditionDsl: z.unknown(),
    actionDsl: z.unknown(),
    priority: z.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
    source: z.enum(["manual", "mined", "imported"]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("CompositionRuleCreate");

const CompositionRulePatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    conditionDsl: z.unknown().optional(),
    actionDsl: z.unknown().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("CompositionRulePatch");

const DryRunRequestSchema = z
  .object({
    ruleId: z.string().optional(),
    rule: CompositionRuleCreateSchema.optional(),
    hits: z.array(
      z.object({
        id: z.string(),
        primitive: z.string(),
        content: z.string(),
        score: z.number().min(0).max(1),
        factKind: z.string().optional(),
        worth: z.number().optional(),
        tags: z.array(z.string()).optional(),
      })
    ),
  })
  .openapi("CompositionDryRunRequest");

const DerivedInferenceSchema = z
  .object({
    ruleId: z.string(),
    ruleName: z.string(),
    inputFactIds: z.array(z.string()),
    derivedKind: z.string(),
    derivedStatement: z.string(),
    confidence: z.number(),
    type: z.enum(["fact", "warning"]),
    rationale: z.string(),
    materialisedFactId: z.string().optional(),
  })
  .openapi("DerivedInference");

const DryRunResponseSchema = z
  .object({
    inferences: z.array(DerivedInferenceSchema),
    ruleId: z.string(),
    ruleName: z.string(),
  })
  .openapi("CompositionDryRunResponse");

// ─── Route definitions ────────────────────────────────────────────────────────

const listRulesRoute = createRoute({
  method: "get",
  path: "/composition/rules",
  tags: ["composition"],
  summary: "List composition rules for the workspace.",
  request: {
    query: z.object({
      isActive: z
        .enum(["true", "false"])
        .transform((v) => v === "true")
        .optional(),
      offset: z.coerce.number().int().min(0).optional().default(0),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    }),
  },
  responses: {
    200: {
      description: "Paginated list of composition rules.",
      content: { "application/json": { schema: CompositionRuleListSchema } },
    },
  },
});

const listInferencesRoute = createRoute({
  method: "get",
  path: "/composition/inferences",
  tags: ["composition"],
  summary: "List derivations the inference engine has recorded (append-only log).",
  request: {
    query: z.object({
      ruleId: z.string().optional().openapi({ description: "Only derivations from this rule." }),
      derivedId: z.string().optional().openapi({
        description: "Only derivations that produced this primitive — 'why does this exist?'.",
      }),
      since: isoDateTimeInput().optional(),
      offset: z.coerce.number().int().min(0).optional().default(0),
      limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    }),
  },
  responses: {
    200: {
      description: "Paginated inference log.",
      content: { "application/json": { schema: InferenceLogListSchema } },
    },
  },
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/composition/rules",
  tags: ["composition"],
  summary: "Create a new composition rule.",
  request: {
    body: {
      content: { "application/json": { schema: CompositionRuleCreateSchema } },
    },
  },
  responses: {
    201: {
      description: "Created composition rule.",
      content: { "application/json": { schema: CompositionRuleSchema } },
    },
  },
});

const getRuleRoute = createRoute({
  method: "get",
  path: "/composition/rules/{id}",
  tags: ["composition"],
  summary: "Get a single composition rule by id.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "The requested composition rule.",
      content: { "application/json": { schema: CompositionRuleSchema } },
    },
    404: { description: "Not found." },
  },
});

const patchRuleRoute = createRoute({
  method: "patch",
  path: "/composition/rules/{id}",
  tags: ["composition"],
  summary: "Partially update a composition rule.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: CompositionRulePatchSchema } },
    },
  },
  responses: {
    200: {
      description: "Updated composition rule.",
      content: { "application/json": { schema: CompositionRuleSchema } },
    },
    404: { description: "Not found." },
  },
});

const dryRunRoute = createRoute({
  method: "post",
  path: "/composition/dry-run",
  tags: ["composition"],
  summary: "Dry-run a rule against a set of recall hits. Never persists inferences.",
  request: {
    body: {
      content: { "application/json": { schema: DryRunRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Derived inferences (not persisted).",
      content: { "application/json": { schema: DryRunResponseSchema } },
    },
    400: { description: "Neither ruleId nor inline rule provided." },
    404: { description: "ruleId not found." },
  },
});

// ─── Helper: row → wire ───────────────────────────────────────────────────────

function ruleToWire(r: {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  conditionDsl: unknown;
  actionDsl: unknown;
  priority: number;
  isActive: boolean;
  executionCount: number;
  source: "manual" | "mined" | "imported";
  createdBy?: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    name: r.name,
    description: r.description,
    // Cast DSL blobs to Record<string, unknown> so Hono's TypedResponse can
    // serialise them without hitting the z.unknown() → never mismatch.
    conditionDsl: (r.conditionDsl ?? {}) as Record<string, unknown>,
    actionDsl: (r.actionDsl ?? {}) as Record<string, unknown>,
    priority: r.priority,
    isActive: r.isActive,
    executionCount: r.executionCount,
    source: r.source,
    createdBy: r.createdBy,
    metadata: r.metadata,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountComposition(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  const storage = deps.storage;

  // ── GET /composition/rules ──────────────────────────────────────────────────
  app.openapi(listInferencesRoute, async (c) => {
    if (!storage) throw new Error("storage adapter not available");
    const workspaceId = c.get("workspaceId");
    const { ruleId, derivedId, since, offset, limit } = c.req.valid("query");

    const page = await storage.queryInferences({
      workspaceId,
      ...(ruleId !== undefined ? { ruleId } : {}),
      ...(derivedId !== undefined ? { derivedId } : {}),
      ...(since !== undefined ? { since: new Date(since) } : {}),
      offset,
      limit,
    });

    // An input or a derived row above the caller's ceiling is not named.
    const shown = await dropHiddenPointers(c, storage, workspaceId, page.items, {
      lists: ["inputFactIds"],
      optionalIds: ["derivedId"],
    });
    return c.json(
      {
        items: shown.map((e) => ({
          id: e.id,
          workspaceId: e.workspaceId,
          ruleId: e.ruleId,
          inputFactIds: e.inputFactIds,
          ...(e.derivedKind !== undefined ? { derivedKind: e.derivedKind } : {}),
          ...(e.derivedId !== undefined ? { derivedId: e.derivedId } : {}),
          confidence: e.confidence,
          ...(e.rationale !== undefined ? { rationale: e.rationale } : {}),
          ...(e.triggeredByQuery !== undefined ? { triggeredByQuery: e.triggeredByQuery } : {}),
          ...(e.conversationId !== undefined ? { conversationId: e.conversationId } : {}),
          createdAt: e.createdAt.toISOString(),
        })),
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        hasMore: page.hasMore,
      },
      200
    );
  });

  app.openapi(listRulesRoute, async (c) => {
    if (!storage) throw new Error("storage adapter not available");
    const workspaceId = c.get("workspaceId");
    const { isActive, offset, limit } = c.req.valid("query");

    const page = await storage.queryCompositionRules({
      workspaceId,
      ...(isActive !== undefined ? { isActive } : {}),
      offset,
      limit,
    });

    return c.json(
      {
        items: page.items.map(ruleToWire),
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        hasMore: page.hasMore,
      },
      200
    );
  });

  // ── POST /composition/rules ─────────────────────────────────────────────────
  app.openapi(createRuleRoute, async (c) => {
    if (!storage) throw new Error("storage adapter not available");
    const workspaceId = c.get("workspaceId");
    const provenance = resolveProvenance(c);
    const body = c.req.valid("json");

    // §34.6: reject rules whose DSL references verbs/ops outside the locked set.
    validateRuleDsl(body.conditionDsl, body.actionDsl);

    const input: CreateCompositionRuleInput = {
      workspaceId,
      name: body.name,
      description: body.description,
      conditionDsl: body.conditionDsl,
      actionDsl: body.actionDsl,
      priority: body.priority,
      isActive: body.isActive,
      source: body.source,
      metadata: body.metadata,
      // p45: reuses the existing free-text created_by column for the
      // namespaced ActorRef. user_id deferred, see BACKLOG.
      createdBy: provenance.actorId,
    };

    const rule = await storage.createCompositionRule(input);
    return c.json(ruleToWire(rule), 201);
  });

  // ── GET /composition/rules/:id ──────────────────────────────────────────────
  app.openapi(getRuleRoute, async (c) => {
    if (!storage) throw new Error("storage adapter not available");
    const workspaceId = c.get("workspaceId");
    const { id } = c.req.valid("param");

    const rule = await storage.getCompositionRule(id, workspaceId);
    if (!rule) throw new NotFoundError(`Composition rule ${id} not found`);
    return c.json(ruleToWire(rule), 200);
  });

  // ── PATCH /composition/rules/:id ────────────────────────────────────────────
  app.openapi(patchRuleRoute, async (c) => {
    if (!storage) throw new Error("storage adapter not available");
    const workspaceId = c.get("workspaceId");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    // §34.6: validate any DSL blob the patch replaces (partial update).
    if (body.conditionDsl !== undefined) checkConditionDsl(body.conditionDsl);
    if (body.actionDsl !== undefined) checkActionDsl(body.actionDsl);

    const input: UpdateCompositionRuleInput = body;
    const updated = await storage.updateCompositionRule(id, workspaceId, input);
    if (!updated) throw new NotFoundError(`Composition rule ${id} not found`);
    return c.json(ruleToWire(updated), 200);
  });

  // ── POST /composition/dry-run ───────────────────────────────────────────────
  app.openapi(dryRunRoute, async (c) => {
    if (!storage) throw new Error("storage adapter not available");
    const workspaceId = c.get("workspaceId");
    const { ruleId, rule: inlineRule, hits } = c.req.valid("json");

    if (!ruleId && !inlineRule) {
      return c.json({ error: "Provide ruleId or inline rule." } as never, 400);
    }

    // §34.6: an inline dry-run rule must also use only the locked verbs/ops.
    if (inlineRule) {
      validateRuleDsl(
        (inlineRule as { conditionDsl: unknown }).conditionDsl,
        (inlineRule as { actionDsl: unknown }).actionDsl
      );
    }

    let syntheticRule: {
      id: string;
      name: string;
      conditionDsl: unknown;
      actionDsl: unknown;
      priority: number;
      isActive: boolean;
      executionCount: number;
    };

    if (ruleId) {
      const stored = await storage.getCompositionRule(ruleId, workspaceId);
      if (!stored) {
        throw new NotFoundError(`Composition rule ${ruleId} not found`);
      }
      syntheticRule = stored;
    } else {
      syntheticRule = {
        id: "dry-run-inline",
        name: (inlineRule as { name: string }).name,
        conditionDsl: (inlineRule as { conditionDsl: unknown }).conditionDsl,
        actionDsl: (inlineRule as { actionDsl: unknown }).actionDsl,
        priority: (inlineRule as { priority?: number }).priority ?? 0,
        isActive: true,
        executionCount: 0,
      };
    }

    // Build a minimal CoreContext-like object for evaluateRule.
    // dry-run: materialise is always false; appendInference / bumpExecution are no-ops.
    const fakeCtx = {
      storage: {
        appendInference: async () => ({}),
        bumpCompositionExecution: async () => undefined,
        materialiseInference: async () => ({ id: "dry-run-noop" }),
      },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
        child() {
          return this;
        },
      },
    } as unknown as Parameters<typeof evaluateRule>[0];

    // Cast hits — the dry-run route accepts a minimal hit subset.
    const recallHits = (hits ?? []).map((h) => ({
      ...h,
      sensitivity: "internal" as const,
      injectionScore: 0,
      provenance: "user_stated" as const,
      origin: "local" as const,
      contested: false,
      validFrom: new Date(),
      validTo: null,
      tags: h.tags ?? [],
      relations: [],
    }));

    const inferences = await evaluateRule(
      fakeCtx,
      syntheticRule,
      workspaceId,
      recallHits as Parameters<typeof evaluateRule>[3],
      // Preview: show every inference the rule WOULD produce (confidence is
      // returned per inference) — the §32 >0.5 gate only filters recall.
      { materialise: false, minConfidence: 0 }
    );

    return c.json(
      {
        inferences,
        ruleId: syntheticRule.id,
        ruleName: syntheticRule.name,
      },
      200
    );
  });
}
