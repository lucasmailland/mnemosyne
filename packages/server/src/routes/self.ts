/**
 * Self-Editing Memory routes (spec §13 — Wave M2).
 *
 * POST /self/edit    — 6-action self-edit with policy enforcement
 * POST /self/reflect — trigger the full reflection cycle
 * GET  /self/profile — read the current agent profile
 *
 * No database connections in this file — all I/O goes through deps.storage.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import {
  DEFAULT_SELF_EDIT_POLICY,
  evaluateSelfEdit,
  applySelfEdit,
  parseTarget,
  runReflectionCycle,
  SelfEditContentRequiredError,
  SelfEditTargetNotFoundError,
  selfEditContentMissing,
} from "@mnemo-ai/core/cognitive";
import { getAuthCtx } from "../auth.js";
import { resolveProvenance } from "../provenance.js";
import { canReadSensitivity, resolveCeiling } from "../rbac.js";
import {
  BadRequestError,
  HttpError,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
} from "../errors.js";
import {
  SELF_EDIT_SESSIONLESS,
  bumpSelfEditDeletes,
  bumpSelfEditEdits,
  bumpSelfEditLastEdit,
  bumpSelfEditStrengthens,
  bumpSelfEditWeakens,
  readSelfEditDeletes,
  readSelfEditEdits,
  readSelfEditLastEdit,
  readSelfEditStrengthens,
  readSelfEditStrengthensForTarget,
  readSelfEditWeakens,
} from "../selfedit-counters.js";

/**
 * Process-local stand-in for the CacheAdapter counter surface (get / set /
 * incrWithTtl), used only when no cache is wired. Entries expire on read, so
 * the per-day and 24h keys do not accumulate for the life of the process.
 */
function createLocalCounterCache(): NonNullable<ServerDeps["cache"]> {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  const read = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    async get<T>(key: string): Promise<T | null> {
      return (read(key)?.value as T | undefined) ?? null;
    },
    async set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void> {
      entries.set(key, { value, expiresAt: Date.now() + (opts?.ttlMs ?? 86_400_000) });
    },
    async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
      const current = read(key);
      const next = ((current?.value as number | undefined) ?? 0) + 1;
      entries.set(key, {
        value: next,
        expiresAt: current?.expiresAt ?? Date.now() + ttlSeconds * 1000,
      });
      return next;
    },
  } as unknown as NonNullable<ServerDeps["cache"]>;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const SelfEditBody = z.object({
  action: z.enum(["append", "replace", "strengthen", "weaken", "forget", "reflect", "link"]),
  target: z.string().min(1),
  content: z.string().max(20_000).optional(),
  reason: z.string().min(1).max(2_000),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
});

const SelfReflectBody = z.object({
  agentId: z.string().optional(),
});

// ─── OpenAPI documentation (doc-only, see note in mountSelf) ────────────────
//
// These 3 routes are mounted below with plain `app.post`/`app.get`, not
// `.openapi()` — each already has its own hand-written body parsing and
// error handling (the try/catch around `SelfEditBody.parse` above, the
// empty-profile fallback in GET /self/profile) that predates the OpenAPI
// convention used elsewhere in this package (see routes/decisions.ts).
// Wiring them through `.openapi()` would ALSO attach
// `@hono/zod-openapi`'s automatic request-validation middleware, which
// intercepts and reformats validation failures BEFORE this file's own
// handler runs — a real behavior change, not just documentation.
// `app.openAPIRegistry.registerPath()` is the exact call `.openapi()` makes
// internally to populate `/openapi.json` (see @hono/zod-openapi's own
// source), minus the validator wiring, so calling it directly documents
// these routes' real request/response shapes without touching how they
// validate or respond today.

const SelfEditAppliedResponse = z
  .object({
    applied: z.boolean(),
    action: z.enum(["append", "replace", "strengthen", "weaken", "forget", "link"]),
    target: z.string(),
    targetKind: z.string(),
    replacementId: z.string().optional(),
    countsAsEdit: z.boolean(),
    countsAsDelete: z.boolean(),
  })
  .openapi("SelfEditAppliedResponse");

const SelfEditReflectResponse = z
  .object({
    applied: z.literal(true),
    action: z.literal("reflect"),
    episode_id: z.string().nullable(),
    strengthened: z.number().int(),
    weakened: z.number().int(),
  })
  .openapi("SelfEditReflectResponse");

const SelfEditApprovalRequiredResponse = z
  .object({
    applied: z.literal(false),
    action: z.string(),
    target: z.string(),
    targetKind: z.string(),
    approvalRequired: z.literal(true),
    scope: z.string(),
    reason: z.string(),
  })
  .openapi("SelfEditApprovalRequiredResponse");

const selfEditRoute = createRoute({
  method: "post",
  path: "/self/edit",
  tags: ["self"],
  summary:
    "Apply a self-edit action (append/replace/strengthen/weaken/forget/reflect/link). Requires `memory:self_edit` scope.",
  request: {
    body: { content: { "application/json": { schema: SelfEditBody } }, required: true },
  },
  responses: {
    200: {
      description: "Edit applied (or the 'reflect' action's cycle result).",
      content: {
        "application/json": { schema: z.union([SelfEditAppliedResponse, SelfEditReflectResponse]) },
      },
    },
    202: {
      description:
        "Action maps to an approval-gated scope other than 'forget'; not applied automatically.",
      content: { "application/json": { schema: SelfEditApprovalRequiredResponse } },
    },
    400: {
      description:
        "Invalid body — action, target and reason are required; `content` must be non-empty for append/replace (code `self_edit_content_required`).",
    },
    404: { description: "Self-edit target not found." },
    422: {
      description:
        "action:'forget' is not supported — no approval flow exists to resolve it. " +
        "Use memory_forget (kind: 'fact' | 'strategy') instead.",
    },
    429: { description: "Policy limit reached (edits/deletes/strengthen/weaken budget)." },
  },
});

const SelfReflectResponse = z
  .object({
    episode_id: z.string().nullable(),
    strengthened: z.number().int(),
    weakened: z.number().int(),
  })
  .openapi("SelfReflectResponse");

const selfReflectRoute = createRoute({
  method: "post",
  path: "/self/reflect",
  tags: ["self"],
  summary: "Trigger a full reflection cycle for an agent. Requires `memory:self_edit` scope.",
  request: {
    body: { content: { "application/json": { schema: SelfReflectBody } }, required: false },
  },
  responses: {
    200: {
      description: "Reflection cycle result.",
      content: { "application/json": { schema: SelfReflectResponse } },
    },
  },
});

const SelfProfileQuerySchema = z.object({
  agentId: z.string().optional().openapi({ description: "Defaults to 'default' when omitted." }),
});

const SelfProfileResponse = z
  .object({
    workspaceId: z.string(),
    agentId: z.string(),
    summary: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .openapi("SelfProfileResponse");

const selfProfileRoute = createRoute({
  method: "get",
  path: "/self/profile",
  tags: ["self"],
  summary:
    "Read the current agent profile. Returns an empty profile (not 404) when none exists yet.",
  request: { query: SelfProfileQuerySchema },
  responses: {
    200: {
      description: "The agent profile, or an empty default profile when none exists.",
      content: { "application/json": { schema: SelfProfileResponse } },
    },
  },
});

// ─── Minimal ctx stub for core functions ─────────────────────────────────────

function makeCtx(storage: NonNullable<ServerDeps["storage"]>) {
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child(_bindings: Record<string, unknown>) {
      return logger;
    },
  };
  return {
    storage,
    telemetry: {
      startSpan: (_name: string, _opts?: Record<string, unknown>) => ({
        end() {},
        setAttribute(_k: string, _v: unknown) {},
        setStatus(_s: unknown) {},
      }),
      counter() {},
      histogram() {},
      gauge() {},
      async shutdown() {},
    },
    logger,
  };
}

// ─── Route mounting ───────────────────────────────────────────────────────────

export function mountSelf(app: OpenAPIHono<{ Variables: AuthVariables }>, deps: ServerDeps): void {
  // Documentation-only: registers these 3 routes' real shapes in
  // /openapi.json without wiring `.openapi()`'s validator middleware (see
  // the note above the schemas). The handlers mounted below are unchanged.
  app.openAPIRegistry.registerPath(selfEditRoute);
  app.openAPIRegistry.registerPath(selfReflectRoute);
  app.openAPIRegistry.registerPath(selfProfileRoute);

  // ─── Durable budget counters ──────────────────────────────────────────────
  // Counters live in Redis via CacheAdapter when one is wired, so every replica
  // and BOTH transports (HTTP here, gRPC in grpc.ts) agree on one budget: the
  // key builders are shared in selfedit-counters.ts. Without a cache (dev/test)
  // a process-local stand-in with the same get/set/incrWithTtl semantics is
  // used — enforced per instance only, acceptable for local development and
  // not for multi-instance production.
  //
  // PRIM-6 / RECALL-12 / CLIENTS-6 — every key carries the AUTHENTICATED actor
  // (provenance, never the body's agentId), and the cooldown carries the
  // target:
  //   edits    → mnemo:selfedit:edits:{ws}:{actor}:{session|__anonymous__}  24h
  //   deletes  → mnemo:selfedit:deletes:{day}:{ws}:{actor}                   48h
  //   lastedit → mnemo:selfedit:lastedit:{ws}:{actor}:{target}               24h
  //   strengthens / weakens (RDD-7) → per day and actor
  // Before, sessionless callers (every MCP memory_update) shared ONE budget per
  // workspace and one cooldown per workspace+agentId for any target, and a new
  // agentId in the body reset both.

  const cache: NonNullable<ServerDeps["cache"]> = deps.cache ?? createLocalCounterCache();
  const policy = DEFAULT_SELF_EDIT_POLICY;

  /**
   * The budget a request draws from: its own session when `sessionId` names a
   * real session of this workspace, otherwise the actor's sessionless budget.
   * An arbitrary string used to open a fresh five-edit budget per call.
   */
  async function budgetSession(
    storage: NonNullable<ServerDeps["storage"]>,
    workspaceId: string,
    sessionId: string | undefined
  ): Promise<{ key: string; sessionless: boolean }> {
    if (!sessionId) return { key: SELF_EDIT_SESSIONLESS, sessionless: true };
    let session = null;
    try {
      session = await storage.getSession(sessionId, workspaceId);
    } catch {
      session = null; // an unparseable id is no session either
    }
    return session
      ? { key: sessionId, sessionless: false }
      : { key: SELF_EDIT_SESSIONLESS, sessionless: true };
  }

  // POST /self/edit
  const SELF_EDIT_TARGETED = new Set(["append", "replace", "strengthen", "weaken", "forget"]);
  app.post("/self/edit", async (c) => {
    const storage = deps.storage;
    if (!storage) {
      throw new ServiceUnavailableError("Storage not available");
    }

    const auth = getAuthCtx(c);
    const provenance = resolveProvenance(c);
    const { workspaceId } = auth;

    let body: z.infer<typeof SelfEditBody>;
    try {
      const rawBody = await c.req.json();
      body = SelfEditBody.parse(rawBody);
    } catch {
      throw new BadRequestError("Invalid request body — action, target and reason are required.");
    }

    const { action, target, content, reason, agentId: bodyAgentId = "default", sessionId } = body;
    // PRIM-1: blank text for append/replace is a client error, refused before
    // the target lookup and before any budget or cooldown is read or charged.
    if (selfEditContentMissing(action, content)) {
      throw new HttpError(
        400,
        "self_edit_content_required",
        `content is required (non-empty) for action '${action}'.`
      );
    }
    const parsedTarget = parseTarget(target);
    const requestedBy = provenance.userId ?? provenance.actorId;
    let agentId = bodyAgentId;
    let actorIsolationId: string | undefined;
    let userIsolationId: string | undefined;

    const ctx = makeCtx(storage);

    // Every action that addresses a row: one above the caller's ceiling reads
    // exactly like a missing one, and both answer before any budget is read.
    if (SELF_EDIT_TARGETED.has(action) && parsedTarget.kind !== "profile") {
      const row =
        parsedTarget.kind === "fact"
          ? await storage.getFact(parsedTarget.id, workspaceId)
          : await storage.getStrategy(parsedTarget.id, workspaceId);
      if (!row || !canReadSensitivity(resolveCeiling(c), row.sensitivity)) {
        throw new NotFoundError("Self-edit target not found");
      }
    }

    if (action === "replace" && parsedTarget.kind === "fact") {
      const fact = await storage.getFact(parsedTarget.id, workspaceId);
      const notFound = () => new NotFoundError("Self-edit target not found");
      if (
        !fact ||
        fact.status !== "active" ||
        fact.validTo != null ||
        !canReadSensitivity(resolveCeiling(c), fact.sensitivity)
      ) {
        throw notFound();
      }

      // Ownership is checked on TWO separate fields, not one shared identity
      // list — fact.userId and fact.actorId mean different things (the
      // platform account vs. the namespaced credential reference) and must
      // each be compared against their own counterpart on the auth context.
      // apiKeyPrefix (a shared constant like "mns_live_") never participates —
      // it MUST NOT, or any legacy-key holder in the workspace would match
      // any fact whose actorId happened to equal that constant.
      const userMatches = fact.userId != null && fact.userId === provenance.userId;
      const actorMatches = fact.actorId != null && fact.actorId === provenance.actorId;
      const legacyShared = fact.actorId == null && fact.userId == null;
      if (userMatches || actorMatches) {
        // Each match feeds its own RLS isolation backstop — actorIsolationId
        // compares against the actor_id column, userIsolationId against the
        // user_id column. They are kept separate because a userId value
        // would never match a stored actor_id, and vice versa.
        if (actorMatches) actorIsolationId = fact.actorId as string;
        if (userMatches) userIsolationId = fact.userId as string;
      } else if (!legacyShared && !auth.scopes.includes("memory:admin")) {
        throw notFound();
      }

      // Fact edits are attributed to authenticated tool identity, never body input.
      agentId = provenance.actorId;
    }

    // For "reflect" action, shortcut to runReflectionCycle
    if (action === "reflect") {
      const result = await runReflectionCycle(ctx, { workspaceId, scopes: [] }, agentId);
      return c.json({
        applied: true,
        action: "reflect",
        episode_id: result.episodeId,
        strengthened: result.strengthened,
        weakened: result.weakened,
      });
    }

    // Evaluate policy (reads durable counters via Redis when available)
    // RDD-7: also read strengthen/weaken daily totals so the policy engine can
    // enforce maxStrengthensPerDay / maxWeakensPerDay / per-fact strengthen cap.
    // PRIM-6: every counter is keyed by the authenticated actor; the cooldown
    // by actor AND target.
    const actor = provenance.actorId;
    const session = await budgetSession(storage, workspaceId, sessionId);
    const [editsThisSession, deletesToday, lastEditAt, strengthensToday, weakensToday] =
      await Promise.all([
        readSelfEditEdits(cache, workspaceId, actor, session.key),
        readSelfEditDeletes(cache, workspaceId, actor),
        readSelfEditLastEdit(cache, workspaceId, actor, target),
        readSelfEditStrengthens(cache, workspaceId, actor),
        readSelfEditWeakens(cache, workspaceId, actor),
      ]);
    const strengthensTodayForTarget =
      action === "strengthen"
        ? await readSelfEditStrengthensForTarget(cache, workspaceId, actor, target)
        : undefined;

    const eval_ = evaluateSelfEdit(
      {
        action,
        target,
        reason,
        editsThisSession,
        deletesToday,
        lastEditAt,
        strengthensToday,
        weakensToday,
        strengthensTodayForTarget,
      },
      policy
    );

    if (!eval_.allow) {
      const limit = eval_.reason ?? "Policy limit reached.";
      throw new RateLimitedError(
        session.sessionless && limit.startsWith("maxEditsPerSession")
          ? `${limit} This request had no session (no sessionId, or one that names no session of ` +
              "this workspace), so it drew from this credential's sessionless budget; pass the " +
              "sessionId from POST /session/start for a per-session budget."
          : limit,
        // APP-062: a cooldown knows its real wait; without it app.ts says 60.
        eval_.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: eval_.retryAfterSeconds }
          : undefined
      );
    }

    // B4: action:"forget" has no approval flow to resolve to — no
    // ApprovalStore row is ever created for it, and no resume executor
    // exists to re-apply it later. Framing it as "202 pending" left the
    // caller waiting on something that could never complete. Gate it with
    // a definitive, actionable 422 instead — memory_forget already does
    // everything applySelfEdit("forget") can do (archiveFact/archiveStrategy),
    // so nothing is lost.
    if (action === "forget" && policy.requireApproval.includes("delete_fact")) {
      throw new HttpError(
        422,
        "self_edit_forget_unsupported",
        "memory_self_edit(action:'forget') is not supported under this workspace's " +
          "approval policy — no approval flow exists to resolve it. Use memory_forget " +
          "(kind: 'fact' | 'strategy') instead, which performs the identical bitemporal " +
          "archive without waiting on an approval that will never arrive.",
        { action, target, targetKind: parsedTarget.kind }
      );
    }

    // Enforce requireApproval scopes — destructive/edit actions require explicit
    // human approval and must not be applied automatically.
    const approvalScope =
      action === "replace" && parsedTarget.kind !== "fact" ? "edit_entity" : null;
    if (approvalScope !== null && policy.requireApproval.includes(approvalScope)) {
      return c.json(
        {
          applied: false,
          action,
          target,
          targetKind: parsedTarget.kind,
          approvalRequired: true,
          scope: approvalScope,
          reason: `Action '${action}' maps to approval-gated scope '${approvalScope}'.`,
        },
        202
      );
    }

    // Apply the edit
    let outcome;
    try {
      outcome = await applySelfEdit(ctx, {
        workspaceId,
        agentId,
        requestedBy,
        ...(actorIsolationId ? { actorIsolationId } : {}),
        ...(userIsolationId ? { userIsolationId } : {}),
        action,
        target,
        content,
        reason,
        ...(sessionId ? { sessionId } : {}),
        provenance,
      });
    } catch (error) {
      if (error instanceof SelfEditTargetNotFoundError) {
        throw new NotFoundError("Self-edit target not found");
      }
      if (error instanceof SelfEditContentRequiredError) {
        throw new HttpError(400, "self_edit_content_required", error.message);
      }
      throw error;
    }

    // The edit is already committed. Counter failures must not turn success into
    // an error that hides a replacementId and makes a retry target closed history.
    await Promise.allSettled([
      ...(outcome.countsAsEdit ? [bumpSelfEditEdits(cache, workspaceId, actor, session.key)] : []),
      ...(outcome.countsAsDelete ? [bumpSelfEditDeletes(cache, workspaceId, actor)] : []),
      ...(action === "strengthen" && outcome.applied
        ? [bumpSelfEditStrengthens(cache, workspaceId, actor, target)]
        : []),
      ...(action === "weaken" && outcome.applied
        ? [bumpSelfEditWeakens(cache, workspaceId, actor)]
        : []),
      ...(outcome.countsAsEdit
        ? [bumpSelfEditLastEdit(cache, workspaceId, actor, target, Date.now())]
        : []),
    ]);

    return c.json({
      applied: outcome.applied,
      action: outcome.action,
      target,
      targetKind: outcome.targetKind,
      ...(outcome.replacementId ? { replacementId: outcome.replacementId } : {}),
      countsAsEdit: outcome.countsAsEdit,
      countsAsDelete: outcome.countsAsDelete,
    });
  });

  // POST /self/reflect
  app.post("/self/reflect", async (c) => {
    const storage = deps.storage;
    if (!storage) {
      throw new ServiceUnavailableError("Storage not available");
    }

    const workspaceId = c.get("workspaceId");

    let body: z.infer<typeof SelfReflectBody> = {};
    try {
      const rawBody = await c.req.json().catch(() => ({}));
      body = SelfReflectBody.parse(rawBody);
    } catch {
      body = {};
    }

    const agentId = body.agentId ?? "default";
    const ctx = makeCtx(storage);

    const result = await runReflectionCycle(ctx, { workspaceId, scopes: [] }, agentId);

    return c.json({
      episode_id: result.episodeId,
      strengthened: result.strengthened,
      weakened: result.weakened,
    });
  });

  // GET /self/profile
  app.get("/self/profile", async (c) => {
    const storage = deps.storage;
    if (!storage) {
      throw new ServiceUnavailableError("Storage not available");
    }

    const workspaceId = c.get("workspaceId");
    const agentId = c.req.query("agentId") ?? "default";

    const profile = await storage.getAgentProfile(workspaceId, agentId);

    if (!profile) {
      // Return an empty profile rather than 404 — profiles are auto-created
      return c.json({
        workspaceId,
        agentId,
        summary: "",
        metadata: {},
        createdAt: null,
        updatedAt: null,
      });
    }

    return c.json({
      workspaceId: profile.workspaceId,
      agentId: profile.agentId,
      summary: profile.summary,
      metadata: profile.metadata,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    });
  });
}
