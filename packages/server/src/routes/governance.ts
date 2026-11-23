import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { wilsonLowerBound, wilsonUpperBound, classifyGovernance } from "@mnemo-ai/core/cognitive";
import type { HealthSnapshot } from "@mnemo-ai/types";
import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { NotFoundError } from "../errors.js";
import { OffsetPaginationSchema } from "../schemas.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";
import { canReadSensitivity, resolveCeiling } from "../rbac.js";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const WorthItemSchema = z.object({
  id: z.string(),
  subject: z.string(),
  statement: z.string(),
  worth: z.number(),
  worthAlpha: z.number(),
  worthBeta: z.number(),
  confidenceLower: z.number(),
  hitCount: z.number().int(),
  action: z.enum(["canonical", "promote", "demote", "neutral"]),
});

const WorthResponseSchema = z
  .object({
    workspaceId: z.string(),
    computedAt: z.iso.datetime(),
    items: z.array(WorthItemSchema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
    hasMore: z.boolean(),
  })
  .openapi("GovernanceWorthResponse");

const worthQuery = z.object({
  ...OffsetPaginationSchema.shape,
  action: z.enum(["canonical", "promote", "demote", "neutral"]).optional(),
});

const GateBody = z
  .object({
    factId: z.string().min(1),
    gate: z.enum(["canonical", "release"]),
    reason: z.string().max(2_000).optional(),
  })
  .openapi("GovernanceGateBody");

const GateResponseSchema = z
  .object({
    factId: z.string(),
    gate: z.enum(["canonical", "release"]),
    pinned: z.boolean(),
  })
  .openapi("GovernanceGateResponse");

const DriftResponseSchema = z
  .object({
    workspaceId: z.string(),
    snapshotAt: z.iso.datetime(),
    factCountActive: z.number().int(),
    factCountArchived: z.number().int(),
    factCountEmbedded: z.number().int(),
    factCountUnembedded: z.number().int(),
    decisionCountActive: z.number().int(),
    relationCountConflicts: z.number().int(),
    factsWithZeroHits: z.number().int(),
    recallHitRate30d: z.number().nullable(),
    extractionJobsFailed7d: z.number().int(),
    extractionJobsDeferred: z.number().int(),
  })
  .nullable()
  .openapi("GovernanceDriftResponse");

const driftQuery = z.object({ fresh: z.coerce.boolean().optional().default(false) });

// ─── Route definitions ────────────────────────────────────────────────────────

const getWorth = createRoute({
  method: "get",
  path: "/governance/worth",
  tags: ["governance"],
  summary: "Per-fact worth scores with Wilson CI lower bound and governance action.",
  request: { query: worthQuery },
  responses: {
    200: {
      description: "Worth scores for workspace facts, classified by governance action.",
      content: { "application/json": { schema: WorthResponseSchema } },
    },
  },
});

const postGate = createRoute({
  method: "post",
  path: "/governance/gate",
  tags: ["governance"],
  summary: "Operator override — pin (canonical) or release a fact from consolidation.",
  request: {
    body: {
      content: { "application/json": { schema: GateBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Gate applied.",
      content: { "application/json": { schema: GateResponseSchema } },
    },
    404: {
      description: "Fact not found.",
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
    },
  },
});

const getDrift = createRoute({
  method: "get",
  path: "/governance/drift",
  tags: ["governance"],
  summary: "Memory drift report (getHealthSnapshot data exposed over HTTP).",
  request: { query: driftQuery },
  responses: {
    200: {
      description: "Latest persisted health snapshot or null when none exists yet.",
      content: { "application/json": { schema: DriftResponseSchema } },
    },
  },
});

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountGovernance(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // API-1: GET /governance/worth
  app.openapi(getWorth, async (c) => {
    const workspaceId = c.get("workspaceId");
    const { offset, limit, action: actionFilter } = c.req.valid("query");

    if (!deps.storage) {
      return c.json(
        {
          workspaceId,
          computedAt: new Date().toISOString(),
          items: [],
          total: 0,
          offset,
          limit,
          hasMore: false,
        },
        200
      );
    }

    const page = await deps.storage.queryFacts({
      workspaceId,
      status: "active",
      offset,
      limit,
    });

    const allItems = page.items.map((f) => {
      const alpha = f.worthAlpha ?? 2;
      const beta = f.worthBeta ?? 2;
      const confidenceLower = wilsonLowerBound(alpha, beta);
      const action = classifyGovernance(f.worth, confidenceLower, wilsonUpperBound(alpha, beta));
      return {
        id: f.id,
        subject: f.subject,
        statement: f.statement,
        worth: f.worth,
        worthAlpha: alpha,
        worthBeta: beta,
        confidenceLower,
        hitCount: f.hitCount,
        action,
      };
    });

    const filtered = actionFilter
      ? allItems.filter((item) => item.action === actionFilter)
      : allItems;

    return c.json(
      {
        workspaceId,
        computedAt: new Date().toISOString(),
        items: filtered,
        total: page.total,
        offset,
        limit,
        hasMore: offset + page.items.length < page.total,
      },
      200
    );
  });

  // API-2: POST /governance/gate
  app.openapi(postGate, async (c) => {
    const workspaceId = c.get("workspaceId");
    const provenance = resolveProvenance(c);
    const { factId, gate } = c.req.valid("json");
    if (!deps.storage) throw new Error("storage adapter not available");

    const fact = await deps.storage.getFact(factId, workspaceId);
    // Above the ceiling reads exactly like missing: the gate is no way to pin,
    // or to confirm, a fact the caller cannot read.
    if (!fact || !canReadSensitivity(resolveCeiling(c), fact.sensitivity)) {
      throw new NotFoundError(`Fact '${factId}' not found`);
    }

    const pinned = gate === "canonical";
    // v3 has no dedicated `pinFact` method — `pinned` is one of
    // `UpdateFactInput`'s fields, so `updateFact` is the direct 1:1
    // equivalent (ports.ts:113).
    await deps.storage.updateFact(factId, workspaceId, { pinned });

    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "update",
      resourceKind: "governance_gate",
      resourceId: gate,
      isTerminal: false,
      detail: { factId, pinned },
    });

    return c.json({ factId, gate, pinned }, 200);
  });

  // API-3: GET /governance/drift
  app.openapi(getDrift, async (c) => {
    const workspaceId = c.get("workspaceId");
    const { fresh } = c.req.valid("query");

    // flatten-legacy-dual-core Phase 9 (task 9.1): ported off the legacy
    // core's direct `@mnemo-ai/core` `getHealthSnapshot` import onto the v3
    // StorageAdapter port (packages/types/src/ports.ts's getHealthSnapshot),
    // implemented in adapter-postgres's HealthRepository. Response shape
    // unchanged.
    let snapshot: HealthSnapshot | null = null;
    try {
      snapshot = (await deps.storage?.getHealthSnapshot({ workspaceId, fresh })) ?? null;
    } catch {
      // Storage not available or no snapshot exists yet — return null
    }

    if (!snapshot) {
      return c.json(null, 200);
    }

    return c.json(
      {
        workspaceId: snapshot.workspaceId,
        snapshotAt:
          snapshot.snapshotAt instanceof Date
            ? snapshot.snapshotAt.toISOString()
            : String(snapshot.snapshotAt),
        factCountActive: snapshot.factCountActive,
        factCountArchived: snapshot.factCountArchived,
        factCountEmbedded: snapshot.factCountEmbedded,
        factCountUnembedded: snapshot.factCountUnembedded,
        decisionCountActive: snapshot.decisionCountActive,
        relationCountConflicts: snapshot.relationCountConflicts,
        factsWithZeroHits: snapshot.factsWithZeroHits,
        recallHitRate30d: snapshot.recallHitRate30d,
        extractionJobsFailed7d: snapshot.extractionJobsFailed7d,
        extractionJobsDeferred: snapshot.extractionJobsDeferred,
      },
      200
    );
  });
}
