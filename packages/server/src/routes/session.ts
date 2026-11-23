import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import {
  BadRequestError,
  ConflictError,
  HttpError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors.js";
import { mnemoDegraded } from "../errorCodes.js";
import { emitMeter } from "../metering/MeterEmitter.js";
import { buildCollapseAuditDetail, collapseWithPhases } from "./_collapsePhases.js";
import {
  observeDuration,
  collapseLatency,
  sessionsTotal,
  sessionsStartedTotal,
  sessionTurnsHistogram,
} from "../metrics/index.js";
import { setAnticipationAccuracy } from "../metrics.js";
import { IdParamSchema } from "../schemas.js";
import {
  MNEMO_SPAN_NAMES,
  RECOVERABLE_MANAGED_ARCHIVE_REASONS,
  TRAFFIC_ORIGINS,
  TURN_ORIGINS,
  classifyTurnOrigin,
} from "@mnemo-ai/types";
import { explicitSignal, resolveCollapsePolicy } from "@mnemo-ai/core";
import { resolveProvenance, resolveTrafficOrigin } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";
import { awaitPendingObservations } from "../recall/pending-observations.js";

// ─── Shared output schema ─────────────────────────────────────────────────────

export const SessionOut = z
  .object({
    id: z.string(),
    trafficOrigin: z.enum(TRAFFIC_ORIGINS).optional(),
    sourceSessionId: z.string().nullable().optional(),
    sourceClientInstanceId: z.string().nullable().optional(),
    sourceGeneration: z.number().nullable().optional(),
    predecessorSessionId: z.string().nullable().optional(),
    agentId: z.string().nullable(),
    status: z.string(),
    createdAt: z.iso.datetime(),
    label: z.string().nullable(),
    anticipated: z
      .array(z.object({ id: z.string(), score: z.number(), source: z.string() }))
      .optional()
      .openapi({
        description: "Top-N anticipated memory ids pre-staged into the L0 working-memory slot.",
      }),
    lastRecallAt: z.string().nullable().optional().openapi({
      description:
        "autonomous-memory Requirement 1/4: ISO timestamp of the most recent POST /recall call that supplied this session's id as sessionId, or null if none has. Read from metadata.lastRecallAt — see recordSessionRecall.",
    }),
    collapse: z
      .object({
        attempts: z.number().int(),
        lastError: z.string().nullable(),
        nextAttemptAt: z.string().nullable(),
        collapsedAt: z.string().nullable(),
        factCount: z.number().int().nullable(),
        episodeId: z.string().nullable(),
        outcome: z.string().nullable(),
        archiveReason: z.string().nullable(),
      })
      .optional()
      .openapi({
        description:
          "LIFECYCLE-14 (GET /session/:id only): collapse diagnostics. `attempts`/`lastError`/" +
          "`nextAttemptAt` describe failed attempts the sweep will retry; `collapsedAt`, `factCount`, " +
          "`episodeId` and `outcome` what a completed collapse produced; `archiveReason` why a " +
          "session was archived (e.g. `collapse_failed` after the sweep's last attempt).",
      }),
  })
  .openapi("V3Session");

/** Longest stored collapse error returned to a client. */
const LAST_ERROR_MAX_CHARS = 500;

/**
 * LIFECYCLE-14 — what the session row already knows about its collapse, which
 * `GET /session/:id` used to drop: an agent could not tell "pending retry" from
 * "never tried" from "gave up".
 */
function collapseDiagnostics(session: import("@mnemo-ai/types").MnemoSession) {
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const summary = session.collapseSummary ?? null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const lastError = str(metadata.collapseLastError);
  return {
    attempts: session.collapseAttempts ?? 0,
    lastError:
      lastError && lastError.length > LAST_ERROR_MAX_CHARS
        ? `${lastError.slice(0, LAST_ERROR_MAX_CHARS)}…`
        : lastError,
    nextAttemptAt: session.collapseNextAttemptAt
      ? new Date(session.collapseNextAttemptAt).toISOString()
      : null,
    collapsedAt: session.collapsedAt ? new Date(session.collapsedAt).toISOString() : null,
    factCount:
      typeof session.factCount === "number" && (summary || session.status === "collapsed")
        ? session.factCount
        : null,
    episodeId: str(summary?.episodeId),
    outcome: str(summary?.outcome),
    archiveReason: session.archiveReason ?? str(metadata.archiveReason),
  };
}

/** Shared mapper so GET /session/:id and GET /session/list expose lastRecallAt identically. */
function extractLastRecallAt(metadata: unknown): string | null {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.lastRecallAt;
  return typeof raw === "string" ? raw : null;
}

// ─── /session/* ────────────────────────────────────────────────────────────

export function mountSession(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  // GET /session/list — must be registered before /session/{id} to avoid Hono
  // treating "list" as the {id} path parameter.
  app.openapi(
    createRoute({
      method: "get",
      path: "/session/list",
      tags: ["session"],
      summary: "List sessions for the workspace.",
      responses: {
        200: {
          description: "Sessions list.",
          content: {
            "application/json": {
              schema: z.object({ sessions: z.array(SessionOut) }).openapi("SessionListResponse"),
            },
          },
        },
        401: { description: "Missing or invalid bearer token." },
        503: { description: "Storage adapter not wired." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");
      const sessions = deps.storage.listSessions
        ? await deps.storage.listSessions(workspaceId)
        : [];
      return c.json(
        {
          sessions: sessions.map((s) => ({
            id: s.id,
            trafficOrigin: s.trafficOrigin ?? "unknown",
            agentId: s.agentId ?? null,
            status: s.status,
            createdAt: s.openedAt.toISOString(),
            label: s.label ?? null,
            lastRecallAt: extractLastRecallAt(s.metadata),
          })),
        },
        200
      );
    }
  );

  // GET /session/:id — fetch a session by id
  app.openapi(
    createRoute({
      method: "get",
      path: "/session/{id}",
      tags: ["session"],
      summary: "Fetch a session by id.",
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "Session.",
          content: { "application/json": { schema: SessionOut } },
        },
        401: { description: "Missing or invalid bearer token." },
        404: { description: "Session not found." },
        503: { description: "Storage adapter not wired." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");
      const session = await deps.storage.getSession(id, workspaceId);
      if (!session) throw new NotFoundError(`Session ${id} not found.`);
      return c.json(
        {
          id: session.id,
          trafficOrigin: session.trafficOrigin ?? "unknown",
          sourceSessionId: session.sourceSessionId ?? null,
          sourceClientInstanceId: session.sourceClientInstanceId ?? null,
          sourceGeneration: session.sourceGeneration ?? null,
          predecessorSessionId: session.predecessorSessionId ?? null,
          agentId: session.agentId ?? null,
          status: session.status,
          createdAt: session.openedAt.toISOString(),
          label: session.label ?? null,
          lastRecallAt: extractLastRecallAt(session.metadata),
          collapse: collapseDiagnostics(session),
        },
        200
      );
    }
  );

  // POST /session/start
  app.openapi(
    createRoute({
      method: "post",
      path: "/session/start",
      tags: ["session"],
      summary: "Start a new ephemeral session.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  trafficOrigin: z.enum(TRAFFIC_ORIGINS).optional(),
                  sourceSessionId: z.string().min(1).max(256).optional(),
                  sourceClientInstanceId: z.string().min(1).max(256).optional(),
                  sourceGeneration: z.number().int().min(0).max(2147483647).optional(),
                  predecessorSessionId: z.string().min(1).max(256).optional(),
                  agentId: z.string().optional(),
                  label: z.string().optional(),
                  metadata: z.record(z.string(), z.unknown()).optional(),
                })
                .openapi("StartSessionRequest"),
            },
          },
          required: false,
        },
      },
      responses: {
        201: {
          description: "Session created.",
          content: { "application/json": { schema: SessionOut } },
        },
        400: { description: "Invalid or incomplete continuity binding." },
        401: { description: "Missing or invalid bearer token." },
        403: { description: "Traffic origin is not authorized for this credential." },
        404: { description: "Predecessor session not found in the workspace." },
        409: { description: "Predecessor is active or has a different continuity binding." },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      const provenance = resolveProvenance(c);
      const trafficOrigin = resolveTrafficOrigin(c, deps.trafficOrigins, body.trafficOrigin);
      const hasBinding =
        body.sourceSessionId !== undefined ||
        body.sourceClientInstanceId !== undefined ||
        body.sourceGeneration !== undefined ||
        body.predecessorSessionId !== undefined;
      if (
        hasBinding &&
        (!body.sourceSessionId ||
          !body.sourceClientInstanceId ||
          body.sourceGeneration === undefined ||
          (body.sourceGeneration > 0 && !body.predecessorSessionId))
      )
        throw new BadRequestError(
          "Continuity requires conversation, client, generation and predecessor for successors"
        );
      if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");

      // flatten-legacy-dual-core Slice 3c pt.1 (PR10): `mnemo_session` has no
      // actor_id/actor_type columns to model (confirmed by PR4's provenance
      // audit — design.md Open Questions) even though `CreateSessionInput`
      // declares those fields; stuffing them into `metadata` (as legacy
      // always did) is the only way they survive on the wire.
      const session = await deps.storage
        .createSession({
          trafficOrigin,
          actorId: provenance.actorId,
          actorType: provenance.actorType,
          sourceSessionId: body.sourceSessionId,
          sourceClientInstanceId: body.sourceClientInstanceId,
          sourceGeneration: body.sourceGeneration,
          predecessorSessionId: body.predecessorSessionId,
          workspaceId,
          agentId: body.agentId,
          userId: provenance.userId,
          metadata: {
            ...body.metadata,
            actorId: provenance.actorId,
            actorType: provenance.actorType,
          },
          label: body.label,
        })
        .catch((err: unknown) => {
          const code = (err as { code?: string }).code;
          if (code === "NOT_FOUND") throw new NotFoundError("Predecessor session not found");
          if (code === "SESSION_BINDING_MISMATCH" || code === "SESSION_ACTIVE")
            throw new ConflictError("Session continuity rejected", { cause: code });
          throw err;
        });

      // B2.1: emit session-started counter
      if (trafficOrigin === "organic") sessionsStartedTotal.inc({});

      // p45 Slice B / p50: session_open audit entry — mutate first, then audit
      // (mirrors facts.ts:302-313). Never blocks session creation on a failed
      // audit write (emitAudit swallows-and-logs).
      await emitAudit(deps, {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        action: "session_open",
        resourceKind: "session",
        resourceId: session.id,
        isTerminal: false,
        detail: {
          ...(provenance.userId ? { userId: provenance.userId } : {}),
          agentId: body.agentId,
        },
      });

      // §30 Anticipation — pre-inject anticipated context before the agent's
      // first turn. Non-fatal: any failure is caught and logged so session
      // creation is never blocked.
      let anticipated: Array<{ id: string; score: number; source: string }> = [];
      if (trafficOrigin === "organic" && deps.storage && deps.workingMemory) {
        const { preinjectAnticipation } = await import("@mnemo-ai/core");
        try {
          const staged = await preinjectAnticipation({
            storage: deps.storage,
            workingMemory: deps.workingMemory,
            workspaceId,
            agentId: body.agentId ?? "default",
          });
          anticipated = staged.map((s) => ({ id: s.id, score: s.score, source: s.source }));
        } catch (err: unknown) {
          console.warn({ err, sessionId: session.id }, "anticipation.preinject_failed");
        }
      }

      return c.json(
        {
          id: session.id,
          trafficOrigin: session.trafficOrigin ?? "unknown",
          sourceSessionId: session.sourceSessionId ?? null,
          sourceClientInstanceId: session.sourceClientInstanceId ?? null,
          sourceGeneration: session.sourceGeneration ?? null,
          predecessorSessionId: session.predecessorSessionId ?? null,
          agentId: session.agentId ?? null,
          status: session.status,
          createdAt:
            session.openedAt instanceof Date ? session.openedAt.toISOString() : session.openedAt,
          label: session.label ?? null,
          anticipated,
        },
        201
      );
    }
  );

  // POST /session/:id/turn
  app.openapi(
    createRoute({
      method: "post",
      path: "/session/{id}/turn",
      tags: ["session"],
      summary: "Append a turn to an active session.",
      request: {
        params: IdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  sourceMessageId: z.string().min(1).max(256).optional(),
                  sourceGeneration: z.number().int().min(0).max(2147483647).optional(),
                  turnOrigin: z.enum(TURN_ORIGINS).optional(),
                  turnOriginEvidence: z.string().max(256).optional(),
                  role: z.enum(["user", "assistant", "system"]),
                  content: z.string().min(1),
                })
                // APP-018: unknown fields are a 400. `turnId` and `metadata`
                // were accepted and dropped — a turn row has no column for
                // either (the server generates the id) — so a caller believed
                // they were stored.
                .strict()
                .openapi("AppendTurnRequest"),
            },
          },
          required: true,
        },
      },
      responses: {
        204: { description: "Turn appended." },
        401: { description: "Missing or invalid bearer token." },
        404: { description: "Session not found." },
        409: { description: "Session is closed or requires managed harness ingestion." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const workspaceId = c.get("workspaceId");

      try {
        if (!deps.storage) {
          throw new ServiceUnavailableError("Storage adapter not available");
        }
        const session = await deps.storage.getSession(id, workspaceId);
        if (!session) throw new NotFoundError(`Session ${id} not found.`);
        if (session.sourceHost) {
          throw new ConflictError("Managed sessions must use harness ingestion for turns.", {
            cause: "MANAGED_FENCING",
          });
        }

        if (
          body.sourceGeneration !== undefined &&
          body.sourceGeneration !== (session.sourceGeneration ?? 0)
        )
          throw new ConflictError("Session generation mismatch", {
            cause: "SESSION_BINDING_MISMATCH",
          });
        const origin = classifyTurnOrigin(
          body.role,
          body.content,
          body.turnOrigin
            ? {
                turnOrigin: body.turnOrigin,
                turnOriginEvidence: body.turnOriginEvidence,
              }
            : undefined
        );
        const turn = {
          workspaceId,
          sessionId: id,
          turnIndex: 0,
          role: body.role,
          content: body.content,
          tokenCount: Math.ceil(Buffer.byteLength(body.content, "utf8") / 4),
          sourceMessageId: body.sourceMessageId,
          ...origin,
        };
        if (deps.sessionBuffer) await deps.sessionBuffer.appendTurn(workspaceId, id, turn);
        else await deps.storage.appendTurn(id, turn);
      } catch (err: unknown) {
        if (err instanceof NotFoundError || err instanceof ConflictError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string }).code;
        if (code === "NOT_FOUND" || msg.includes("not found")) {
          throw new NotFoundError(`Session ${id} not found.`);
        }
        if (code === "SESSION_TERMINAL" || code === "SESSION_CLOSED") {
          throw new HttpError(409, code, `Session ${id} is closed for writes.`, {
            cause: code === "SESSION_TERMINAL" ? "SESSION_TERMINAL" : "SESSION_CLOSED",
          });
        }
        if (code === "SOURCE_MESSAGE_CONFLICT")
          throw new ConflictError("Message identity reused", { cause: code });
        throw err;
      }

      return c.body(null, 204);
    }
  );

  // POST /session/:id/collapse
  app.openapi(
    createRoute({
      method: "post",
      path: "/session/{id}/collapse",
      tags: ["session"],
      summary: "Collapse a session into durable knowledge units.",
      request: {
        params: IdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  strategy: z.enum(["auto", "explicit"]).default("auto").optional(),
                  collapseHint: z
                    .string()
                    .optional()
                    .openapi({ description: "Natural-language hint to guide LLM extraction" }),
                })
                .openapi("CollapseSessionRequest"),
            },
          },
          required: false,
        },
      },
      responses: {
        202: {
          description:
            "Collapse accepted (async). `resumed` is true when an idempotent retry short-circuited completed phases (spec §RDD9). " +
            "`status` is the pipeline's verdict or `collapse_pending` when an archived managed session was accepted for retry.",
          content: {
            "application/json": {
              schema: z
                .object({
                  accepted: z.boolean(),
                  sessionId: z.string(),
                  resumed: z.boolean(),
                  status: z.enum(["collapse_pending", "skipped", "completed", "failed"]).openapi({
                    description:
                      "P115: `accepted:true` only means the request was processed. A `skipped` " +
                      "collapse extracted NOTHING and archived the session — the turns are kept " +
                      "but no episode, fact, decision or strategy was created. Re-issue the " +
                      "collapse with strategy 'explicit' to force extraction past the gate.",
                  }),
                  skipReason: z
                    .enum(["too_few_turns", "low_recurrence_signal", "llm_unavailable", "no_pin"])
                    .optional()
                    .openapi({ description: "Present when the collapse pipeline was skipped." }),
                })
                .openapi("CollapseAccepted"),
            },
          },
        },
        401: { description: "Missing or invalid bearer token." },
        404: { description: "Session not found." },
        409: { description: "Managed sessions must use the managed collapse lifecycle." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      const collapseStart = performance.now();

      // F2: resolve the session's agent CollapsePolicy so per-agent thresholds
      // (maxTurns/maxTokens/inactivityTimeout/requirePin/mode/extract*) govern
      // collapse instead of hardcoded defaults. Profile lookup failures fall back
      // to documented defaults, but session classification must fail closed.
      if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");
      let collapsePolicy = resolveCollapsePolicy(null);
      if (deps.storage) {
        const session = await deps.storage.getSession(id, workspaceId);
        if (session?.sourceHost) {
          const recoverable = new Set<string>(RECOVERABLE_MANAGED_ARCHIVE_REASONS);
          if (
            body?.strategy === "explicit" &&
            session.status === "archived" &&
            typeof session.archiveReason === "string" &&
            recoverable.has(session.archiveReason) &&
            typeof deps.storage.retryLegacyManagedArchive === "function" &&
            (await deps.storage.retryLegacyManagedArchive({ workspaceId, sessionId: id }))
          ) {
            return c.json(
              {
                accepted: true,
                sessionId: id,
                resumed: false,
                status: "collapse_pending" as const,
              },
              202
            );
          }
          throw new ConflictError("Managed sessions must use the managed collapse lifecycle.");
        }
        const agentId = session?.agentId;
        if (agentId) {
          try {
            const profile = await deps.storage.getAgentProfile(workspaceId, agentId);
            collapsePolicy = resolveCollapsePolicy(profile);
          } catch (err) {
            console.warn({ err, sessionId: id, workspaceId }, "collapse.policy_resolution_failed");
          }
        }
      }

      // §Idempotency RDD9: when this is a keyed mutation, the middleware exposed
      // a phase recorder + the recovery point we resumed from. A retry whose
      // durable phases already completed short-circuits without re-running.
      const recordPhase = c.get("idempotencyRecordPhase");
      const startRecoveryPoint = c.get("idempotencyRecoveryPoint");

      const collapseSpan = deps.telemetry.startSpan(MNEMO_SPAN_NAMES.sessionCollapse, {
        attributes: {
          "mnemo.workspace_id": workspaceId,
          "mnemo.collapse.reason": "manual",
          "mnemo.collapse.mode": collapsePolicy.mode ?? "auto",
          "mnemo.idempotency.resumed_from": startRecoveryPoint ?? "none",
        },
      });
      let collapseResult: {
        turnsProcessed?: number;
        anticipationAccuracy?: number | null;
        // P115: the pipeline's verdict. Without it this handler cannot tell an
        // extraction from a discard, and answered `accepted:true` for both.
        status?: "skipped" | "completed" | "failed";
        skipReason?: "too_few_turns" | "low_recurrence_signal" | "llm_unavailable" | "no_pin";
      } = {};
      let resumed = false;
      let collapseOutcome: import("./_collapsePhases.js").CollapseWithPhasesOutput<unknown>["outcome"] =
        "failed";
      let collapseError: unknown;
      try {
        // Resolve workspace LLM override (P6 dynamic config API).
        // If the workspace has a configured LLM provider (DB config → global → env),
        // use it for the collapse pipeline instead of the boot-time provider.
        let llmOverride: import("@mnemo-ai/types").LLMAdapter | undefined;
        if (deps.llmConfigResolver) {
          const { buildWorkspaceLlmAdapter } = await import("../config/WorkspaceLlmAdapter.js");
          llmOverride =
            (await buildWorkspaceLlmAdapter(
              workspaceId,
              deps.llmConfigResolver,
              deps.llmAdapter
            )) ?? undefined;
        }

        const provenance = resolveProvenance(c);
        const collapseAuth: import("@mnemo-ai/types").AuthContext = {
          workspaceId,
          actorId: provenance.actorId,
          actorType: provenance.actorType,
          userId: provenance.userId,
          scopes: ["memory:write", "memory:read", "session:manage"],
        };

        const phased = await collapseWithPhases<{
          turnsProcessed?: number;
          anticipationAccuracy?: number | null;
          status?: "skipped" | "completed" | "failed";
          skipReason?: "too_few_turns" | "low_recurrence_signal" | "llm_unavailable" | "no_pin";
        }>({
          startRecoveryPoint,
          recordPhase,
          runCollapse: () =>
            deps.cognitive.collapseSession(
              {
                sessionId: id,
                workspaceId,
                strategy: body?.strategy,
                ...(body?.collapseHint ? { collapseHint: body.collapseHint } : {}),
                policy: collapsePolicy,
                ...(llmOverride ? { llmOverride } : {}),
              },
              collapseAuth
            ),
        });
        resumed = phased.resumed;
        collapseOutcome = phased.outcome;
        collapseResult = phased.result ?? {};
        if (typeof collapseResult.turnsProcessed === "number") {
          collapseSpan.setAttribute("mnemo.collapse.turns", collapseResult.turnsProcessed);
        }
        if (collapseResult?.anticipationAccuracy != null) {
          setAnticipationAccuracy(workspaceId, collapseResult.anticipationAccuracy);
        }
      } catch (err: unknown) {
        collapseSpan.setStatus("error", String(err));
        collapseError = err;
        const code = (err as { code?: string }).code;
        const msg = err instanceof Error ? err.message : String(err);
        if (code === "NOT_FOUND" || msg.includes("not found")) {
          throw new NotFoundError(`Session ${id} not found.`);
        }
        if (code === "LLM_UNAVAILABLE") {
          // MNEMO_004: LLM failed mid-collapse — session left active for retry.
          throw mnemoDegraded("MNEMO_004");
        }
        throw err;
      } finally {
        collapseSpan.end();
        const auditProv = resolveProvenance(c);
        await emitAudit(deps, {
          workspaceId,
          actorId: auditProv.actorId,
          actorType: auditProv.actorType,
          action: "session_close",
          resourceKind: "session",
          resourceId: id,
          isTerminal: false,
          detail: buildCollapseAuditDetail({
            operationId: `collapse:${workspaceId}:${id}`,
            attempt: 1,
            reason: "manual",
            outcome: collapseOutcome,
            result: collapseResult,
            error: collapseError,
            startedAt: collapseStart,
            now: performance.now(),
          }),
        });
      }

      // P115: a collapse the pipeline SKIPPED is not a success, and saying so
      // was not a cosmetic problem — it was the whole reason a discarded session
      // was invisible. `accepted:true` with no other signal, plus a metric
      // labelled `success`, is what let the RecMem gate throw sessions away for
      // as long as it did. The status now travels all the way out: to the
      // caller, to the latency histogram, and to the sessions counter.
      const collapseStatus = collapseResult.status ?? "completed";
      const skipped = collapseStatus === "skipped";
      observeDuration(
        collapseLatency,
        { tier: "cognitive", outcome: skipped ? "skipped" : "success" },
        collapseStart
      );
      // mnemo_requests_total emitted globally by app.ts middleware — no ad-hoc inc.
      // Session lifecycle signal: a collapse is a terminal session transition.
      // (Session START lives in the L0 handler outside this region; "collapsed"
      // is the one lifecycle event reachable from the route layer.)
      // B1.3: sessions metric renamed; emit with {reason,outcome} labels per new spec
      sessionsTotal.inc({
        reason: "collapse",
        outcome: skipped ? "skipped" : resumed ? "resumed" : "success",
      });
      if (typeof collapseResult.turnsProcessed === "number") {
        sessionTurnsHistogram.observe({}, collapseResult.turnsProcessed);
      }
      emitMeter(workspaceId, "session");
      return c.json(
        {
          accepted: true,
          sessionId: id,
          resumed,
          status: collapseStatus,
          ...(collapseResult.skipReason ? { skipReason: collapseResult.skipReason } : {}),
        },
        202
      );
    }
  );

  // POST /session/:id/feedback — thumbs up/down explicit outcome rating
  app.openapi(
    createRoute({
      method: "post",
      path: "/session/{id}/feedback",
      tags: ["session"],
      summary: "Record explicit user feedback for a session (thumbs up/down).",
      request: {
        params: IdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({ rating: z.enum(["up", "down"]) })
                .openapi("SessionFeedbackRequest"),
            },
          },
          required: true,
        },
      },
      responses: {
        204: { description: "Feedback recorded." },
        401: { description: "Missing or invalid bearer token." },
        404: { description: "Session not found." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { rating } = c.req.valid("json");
      const workspaceId = c.get("workspaceId");

      if (!deps.storage) return c.body(null, 204);

      // Persist the session-level rating FIRST. `mnemo_session.outcome_rating`
      // is read by three consumers — the mnemo_metacognition_trends SQL function
      // (it is literally `sessionCollapseQuality`), PluginRepository's §14
      // scored-trajectory list, and MeteringRepository — and nothing ever wrote
      // it, so all three averaged a permanently NULL column. The thumbs signal
      // was being spent entirely on fact worth and then discarded.
      const found = await deps.storage.recordSessionOutcome(
        id,
        workspaceId,
        rating === "up" ? "success" : "failure"
      );
      if (!found) throw new NotFoundError(`Session ${id} not found`);

      // Map thumbs to explicit outcome signal
      const outcome = rating === "up" ? "resolved" : "failed";
      const signal = explicitSignal(outcome);
      const delta = {
        success: signal.score,
        failure: 1 - signal.score,
        creditWeight: 1.0,
      };

      // Apply worth update to all facts recalled in this session.
      // `getRecalledFactIds` reads mnemo_recall_log.session_id, which was NULL
      // on the API-key path until the recall route started threading the body's
      // sessionId into AuthContext — so this list was always empty and the
      // thumbs updated no worth at all while still answering 204. An empty list
      // is still legitimate (a session with no recalls), so it is not an error,
      // but the rating above is now recorded either way.
      // /recall writes its session history detached: wait (bounded) for any
      // write still in flight so feedback right after a recall is not lost.
      await awaitPendingObservations(deps.storage, workspaceId, id);
      const factIds = await deps.storage.getRecalledFactIds(workspaceId, id).catch(() => []);
      if (factIds.length > 0) {
        await Promise.allSettled(
          factIds.map((fid) => deps.storage!.updateWorth(fid, workspaceId, "fact", delta))
        );
      }

      return c.body(null, 204);
    }
  );

  // POST /session/:id/pin — pin or unpin a turn
  app.openapi(
    createRoute({
      method: "post",
      path: "/session/{id}/pin",
      tags: ["session"],
      summary: "Pin or unpin a session turn.",
      request: {
        params: IdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  // APP-018: the turn id column is a uuid; any other string
                  // reached Postgres and failed there as a 500 (22P02).
                  turnId: z.string().uuid().optional(),
                  // Ordinal position within the session. `memory_session
                  // action:'pin_turn'` has always advertised this selector; the
                  // route never accepted it, so the MCP tool stringified the
                  // index into `turnId` and it reached SQL as the id "1".
                  turnIndex: z.number().int().nonnegative().optional(),
                  pinned: z.boolean(),
                })
                .refine((b) => (b.turnId === undefined) !== (b.turnIndex === undefined), {
                  message: "supply exactly one of `turnId` or `turnIndex`",
                })
                .openapi("PinTurnRequest"),
            },
          },
          required: true,
        },
      },
      responses: {
        204: { description: "Turn pin state updated." },
        401: { description: "Missing or invalid bearer token." },
        404: { description: "Session or turn not found." },
        409: { description: "Session is closed for writes." },
        503: { description: "Storage adapter not wired." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");
      const session = await deps.storage.getSession(id, workspaceId);
      if (!session) throw new NotFoundError(`Session ${id} not found.`);
      if (
        session.sourceHost &&
        !(
          session.status === "active" ||
          (session.status === "collapse_pending" &&
            session.closeKind === "provisional" &&
            session.collapseLeaseOwner == null &&
            session.collapseLeaseExpiresAt == null)
        )
      ) {
        throw new ConflictError(`Session ${id} is closed for writes.`);
      }
      const selector =
        body.turnId !== undefined ? { turnId: body.turnId } : { turnIndex: body.turnIndex };
      // The storage layer now reports whether a turn matched. It used to return
      // void, so pinning a turn that does not exist — index 99 of a two-turn
      // session — answered 204 and looked like it had worked.
      let matched: boolean;
      try {
        matched = deps.sessionBuffer
          ? await deps.sessionBuffer.pinTurn(workspaceId, id, selector, body.pinned)
          : await deps.storage.pinSessionTurn({
              sessionId: id,
              workspaceId,
              ...selector,
              pinned: body.pinned,
            });
      } catch (error) {
        if ((error as { code?: string }).code === "SESSION_CLOSED") {
          throw new ConflictError(`Session ${id} is closed for writes.`);
        }
        throw error;
      }
      if (!matched) {
        throw new NotFoundError(
          body.turnId !== undefined
            ? `Turn ${body.turnId} not found in session ${id}.`
            : `Turn index ${String(body.turnIndex)} not found in session ${id}.`
        );
      }
      return c.body(null, 204);
    }
  );

  // POST /session/:id/scratch — update scratch pad
  app.openapi(
    createRoute({
      method: "post",
      path: "/session/{id}/scratch",
      tags: ["session"],
      summary: "Update the session scratch pad (ephemeral key-value store).",
      request: {
        params: IdParamSchema,
        body: {
          content: {
            "application/json": {
              schema: z
                .object({ scratch: z.record(z.string(), z.unknown()) })
                .openapi("UpdateScratchRequest"),
            },
          },
          required: true,
        },
      },
      responses: {
        204: { description: "Scratch updated." },
        401: { description: "Missing or invalid bearer token." },
        404: { description: "Session not found." },
        500: { description: "Scratch update failed." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      if (!deps.sessionBuffer && !deps.storage) {
        throw new ServiceUnavailableError("Storage adapter not available");
      }
      const updated = deps.sessionBuffer
        ? await deps.sessionBuffer.setScratch(workspaceId, id, body.scratch)
        : await deps.storage!.replaceSessionScratch({
            workspaceId,
            sessionId: id,
            scratch: body.scratch,
          });
      if (!updated) throw new NotFoundError(`Session ${id} not found.`);
      return c.body(null, 204);
    }
  );

  // POST /session/:id/discard — archive without collapsing
  app.openapi(
    createRoute({
      method: "post",
      path: "/session/{id}/discard",
      tags: ["session"],
      summary: "Discard a session (archive without collapsing into memory).",
      request: { params: IdParamSchema },
      responses: {
        204: { description: "Session discarded." },
        401: { description: "Missing or invalid bearer token." },
        404: { description: "Session not found." },
        409: { description: "Managed sessions must use the managed collapse lifecycle." },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspaceId = c.get("workspaceId");
      const provenance = resolveProvenance(c);
      if (deps.storage) {
        const session = await deps.storage.getSession(id, workspaceId);
        if (!session) throw new NotFoundError(`Session ${id} not found.`);
        if (session.sourceHost) {
          throw new ConflictError("Managed sessions must use the managed collapse lifecycle.");
        }
        // §7 discard = archive WITHOUT collapse. Prefer the dedicated archive
        // method (writes status='archived'); fall back to closeSession only on
        // adapters that predate archiveSession.
        if (deps.storage.archiveSession) {
          await deps.storage.archiveSession(id, workspaceId);
        } else {
          await deps.storage.closeSession(id, workspaceId);
        }
        // Drop the ephemeral Redis footprint — discarded knowledge is gone.
        if (deps.sessionBuffer) {
          await deps.sessionBuffer.clear(workspaceId, id).catch(() => undefined);
        }
      } else {
        // flatten-legacy-dual-core Slice 3c pt.1 (PR10): no storage adapter
        // wired — every OTHER handler in this file already 503s in this case
        // (GET /session/list, GET /session/:id, POST /session/:id/pin,
        // POST /episodes). Converges discard onto that same convention
        // instead of the legacy core client's discardSession fallback.
        throw new ServiceUnavailableError("Storage adapter not available");
      }
      // p45 Slice B / p50: session_close audit entry — mutate first, then audit
      // (mirrors facts.ts:302-313). Covers both the deps.storage and
      // factory-discard branches above; never blocks the 204 on a failed write.
      await emitAudit(deps, {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        action: "session_close",
        resourceKind: "session",
        resourceId: id,
        isTerminal: false,
        detail: {
          ...(provenance.userId ? { userId: provenance.userId } : {}),
          reason: "discard",
        },
      });
      return c.body(null, 204);
    }
  );
}
