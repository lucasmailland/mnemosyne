import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PRIMITIVE_KINDS, PRIMITIVE_SUBTYPES, isoDateTimeInput } from "@mnemo-ai/types";
import { RememberConflictError } from "@mnemo-ai/core/cognitive";

import type { AuthVariables } from "../auth.js";
import { getAuthCtx } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { getUserPersonalWorkspaceId } from "../recall/multi-level.js";
import { emitMeter } from "../metering/MeterEmitter.js";
import { observeDuration, writeLatency, vectorUpsertTotal } from "../metrics/index.js";
import { DEFAULT_SENSITIVITY, canReadSensitivity, resolveCeiling } from "../rbac.js";
import { BadRequestError, ConflictError, HttpError, NotFoundError } from "../errors.js";
import { resolveProvenance } from "../provenance.js";
import { emitEvent } from "../events.js";
import { dispatchWebhookEvent } from "../webhookDispatch.js";
import { buildPluginContext } from "../plugins/context.js";
import { resolveTargetWorkspace } from "../workspace-target.js";
import { emitWriterNormalizationAudit, type SubtypeState } from "../audit-emit.js";

// ─── Response schema ──────────────────────────────────────────────────────────

/**
 * Q-3 — what an unknown `subtype` is stored as, per kind. A decision has no
 * `other`, so it gets its default. An entity gets `other`, not its default
 * `concept`: an unknown category is not a concept.
 */
const SUBTYPE_FALLBACK = {
  fact: "other",
  decision: "decision",
  entity: "other",
} as const satisfies {
  [K in keyof typeof PRIMITIVE_SUBTYPES]: (typeof PRIMITIVE_SUBTYPES)[K][number];
};

const RememberWarningOut = z.object({
  code: z.enum(["subtype_substituted", "scope_ref_canonicalized", "scope_ref_unrecognized"]),
  field: z.enum(["subtype", "scopeRef"]),
  received: z.string(),
  storedAs: z.string(),
  /** `scope_ref_unrecognized` only: the project the value most resembles. */
  suggestion: z.string().optional(),
  message: z.string(),
});
type RememberWarning = z.infer<typeof RememberWarningOut>;

/** P135: the `warnings` entries for how the scopeRef met the workspace's projects. */
function scopeRefWarnings(
  resolution: import("@mnemo-ai/types").RememberResponse["scopeRefResolution"]
): RememberWarning[] {
  const out: RememberWarning[] = [];
  if (resolution?.canonicalized) {
    const { received, storedAs } = resolution.canonicalized;
    out.push({
      code: "scope_ref_canonicalized",
      field: "scopeRef",
      received,
      storedAs,
      message: `scopeRef '${received}' names the project '${storedAs}', stored as '${storedAs}'.`,
    });
  }
  if (resolution?.suggestion) {
    const { received, project } = resolution.suggestion;
    out.push({
      code: "scope_ref_unrecognized",
      field: "scopeRef",
      received,
      storedAs: received,
      suggestion: project,
      message:
        `scopeRef '${received}' names no project, stored as sent. It resembles the project '${project}': ` +
        `if it is the same one, add '${received}' to that project entity's aliases.`,
    });
  }
  return out;
}

export const FactOut = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    actorId: z
      .string()
      .optional()
      .openapi({
        description:
          'The namespaced actor reference that stored this fact (e.g. "key:<id>") — the credential, ' +
          "NOT reliably a userId. Use `userId` below for the platform account, when present. Omitted for legacy facts.",
      }),
    userId: z.string().nullable().optional().openapi({
      description: "The platform account (mnemo_user.id) that stored this fact, when one exists.",
    }),
    statement: z.string(),
    confidence: z.number().nullable(),
    topicKey: z.string().nullable(),
    status: z.string(),
    sensitivity: z.string().openapi({
      description:
        "Sensitivity level: public | internal | confidential | restricted. Compared numerically server-side.",
    }),
    pinned: z.boolean(),
    attribution: z.record(z.string(), z.unknown()),
    tags: z.array(z.string()),
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    redactedCategories: z.array(z.string()).optional().openapi({
      description:
        "P121. Present ONLY when PII was redacted out of `statement` before storage — its presence is the signal, so there is no empty-array case to check. `statement` above is the text that was actually stored, which is what a later recall will return; the original is not kept anywhere.",
    }),
    conflict: z
      .object({
        judgmentRequired: z.boolean(),
        candidates: z.array(
          z.object({
            id: z.string(),
            subject: z.string(),
            statement: z.string(),
            action: z.enum(["supersede", "reject", "review"]),
            relationId: z.string().optional(),
          })
        ),
      })
      .optional()
      .openapi({
        description:
          "Write-time §33 contradiction verdicts. When judgmentRequired is true the caller " +
          "must resolve each candidate's relationId via POST /conflicts/:id/resolve.",
      }),
    warnings: z.array(RememberWarningOut).optional().openapi({
      description:
        "Q-3. Present ONLY when part of the request was stored differently from how it was sent, or may have been meant differently. `subtype_substituted`: the `subtype` is not in its kind's list, so it was stored as `storedAs` (fact and entity: 'other'; decision: 'decision'). `scope_ref_canonicalized` (P135): the `scopeRef` names a `project` entity by an alias or another casing, so the project's canonical name was stored. `scope_ref_unrecognized` (P135): the `scopeRef` names no project but resembles the one in `suggestion`; it was stored as sent — create the project entity, or add the value as an alias, if it is the same project. The write itself succeeded.",
    }),
    embeddingDeferred: z.boolean().optional().openapi({
      description:
        "CHAOS-5. Present (true) only when the embed provider was unavailable: the memory WAS stored and is full-text searchable now; its embedding is queued and it becomes semantically searchable once the provider answers. Write-time conflict detection, which needs the embedding, did not run for this write.",
    }),
  })
  .openapi("V3Fact");

// ─── POST /remember ────────────────────────────────────────────────────────

export function mountRemember(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/remember",
      tags: ["memory"],
      summary: "Store a new memory fact.",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  statement: z.string().min(1).max(50_000).openapi({
                    description: "The fact statement. One claim per fact.",
                  }),
                  subject: z.string().optional().openapi({
                    description: "Subject of the fact. Default 'workspace'.",
                  }),
                  kind: z.string().optional().openapi({
                    description:
                      "Which primitive to create: 'fact' | 'decision' | 'episode' | 'entity' | 'strategy' | 'workflow' | 'skill' | 'task' | 'event' | 'reasoning'. Default 'fact'. ('hyperedge' is not creatable here — use POST /hyperedges.) An unrecognized value returns 400.",
                  }),
                  subtype: z.string().optional().openapi({
                    description:
                      "Type-specific subtype, ignored unless kind is 'fact', 'decision', or 'entity'. fact: 'preference'|'trait'|'event'|'relationship'|'skill'|'concern'|'architecture'|'bugfix'|'config'|'discovery'|'policy'|'process'|'other' (default 'other'). decision: 'decision'|'architecture'|'policy'|'process'|'bugfix'|'learning'|'discovery'|'config' (default 'decision'). entity: 'person'|'organization'|'project'|'concept'|'place'|'other' (default 'concept'). Matched without regard to case or surrounding space. A value outside the kind's list is stored as 'other' (a decision: 'decision') and the response carries a `warnings` entry naming the substitution. An empty value returns 400.",
                  }),
                  title: z.string().min(1).max(500).optional().openapi({
                    description:
                      "kind 'decision' only: the decision's title. Omitted → the statement's first sentence (capped at 120 characters). The whole statement is always the body; `subject` is kept in the decision's metadata.",
                  }),
                  confidence: z.number().min(0).max(1).default(1.0).openapi({
                    description: "Confidence in the fact (0–1).",
                  }),
                  agentId: z.string().optional().openapi({
                    description: "Agent ID or tool that originated the fact.",
                  }),
                  conversationId: z.string().optional().openapi({
                    description: "Conversation ID for cite-back traceability.",
                  }),
                  sensitivity: z
                    .enum(["public", "internal", "confidential", "restricted"])
                    .optional()
                    .openapi({
                      description: "Sensitivity level.",
                    }),
                  topicKey: z.string().optional().openapi({
                    description:
                      "Idempotency key for grouping/upserting, e.g. 'infra/pg' or 'auth-strategy' (levels separated by '/', words within a level joined by '-'). A second write with the same topicKey updates the existing active row in place (revision bumped) instead of creating a duplicate — works for kind 'fact' and 'decision'. Use memory_suggest_topic_key to derive one deterministically.",
                  }),
                  attribution: z
                    .union([z.string(), z.record(z.string(), z.unknown())])
                    .optional()
                    .openapi({
                      description: "Provenance: agent id string or structured bag.",
                    }),
                  tags: z.array(z.string()).max(64).default([]),
                  sessionId: z.string().optional().openapi({
                    description:
                      "The session this write happened during. Correlation only (no FK). Passing it is what lets the episodic collapse back-fill `episodeId` — the canonical origin link — for every fact written during the session.",
                  }),
                  episodeId: z.string().optional().openapi({
                    description:
                      "Attach the fact to an episode that ALREADY exists (post-hoc correction, backfill, import). The normal path is to pass `sessionId` and let the collapse fill this in. An id that names no episode is dropped with a warning and the fact is still written — never a rejected write.",
                  }),
                  validFrom: isoDateTimeInput().optional().openapi({
                    description:
                      "kind 'fact' only: when the fact became true in the world (valid time). Omitted → now. A future instant returns 400; other kinds ignore it.",
                  }),
                  validUntil: isoDateTimeInput().nullable().optional().openapi({
                    description:
                      "Accepted and ignored: a fact stays valid until it is forgotten or superseded.",
                  }),
                  metadata: z.record(z.string(), z.unknown()).optional(),
                  scope: z.enum(["global", "conversation", "personal"]).optional().openapi({
                    description:
                      "Scope of this fact. Default 'global'. Use 'personal' to store in the user's personal workspace (cross-project). Pair with scopeRef to namespace by project.",
                  }),
                  scopeRef: z.string().optional().openapi({
                    description:
                      "Entity/project ref to namespace this fact (e.g. 'mnemosyne', 'project:abc'). Use with memory_recall scopeRef to filter.",
                  }),
                  scopeOwner: z.string().optional().openapi({
                    description:
                      "Ownership level: 'workspace:<id>' | 'user:<id>' | 'tenant:<id>'. Default: workspace-level. Use 'user:<userId>' for personal facts visible across all workspaces.",
                  }),
                  targetWorkspaceId: z.guid().optional().openapi({
                    description:
                      "Write to a different workspace than the one in the API key. The key's user must be a member of the target workspace. Requires userId binding on the key (mk_user_* or mk_live_* with user_id set).",
                  }),
                  vector: z.array(z.number()).min(8).max(4096).optional().openapi({
                    description:
                      "Host-side pre-computed embedding vector. When supplied the server skips its own embed pass — caller must use the same model as the workspace recall embedding (default: text-embedding-3-small, 1536 dims).",
                  }),
                })
                .openapi("RememberRequest"),
            },
          },
          required: true,
        },
      },
      responses: {
        201: {
          description: "Fact created.",
          content: { "application/json": { schema: FactOut } },
        },
        400: { description: "Invalid request body." },
        401: { description: "Missing or invalid bearer token." },
        404: {
          description:
            "`sensitivity` is above this credential's read ceiling (code `sensitivity_above_ceiling`): the memory could never be read back by its writer, so it is not stored.",
        },
        409: {
          description:
            "kind 'entity': a live entity with this name and kind already exists (`details.existingId`). Update it instead.",
        },
        501: {
          description:
            "No embed provider configured (MNEMO_LLM_PROVIDER/MNEMO_LLM_API_KEY unset) and no precomputed `vector` supplied in the request. An embed provider that is configured but unreachable does NOT fail the write — see `embeddingDeferred`.",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const { workspaceId: keyWorkspaceId, userId, tenantId } = getAuthCtx(c);
      const provenance = resolveProvenance(c);
      const rememberStart = performance.now();

      // Reject unknown `kind` here rather than letting it fall through to
      // core's createPrimitive() switch, whose default branch throws a plain
      // Error → uncaught → 500. "hyperedge" is a valid PrimitiveKind but not
      // creatable via remember() (needs memberIds), so it's excluded too.
      if (
        body.kind !== undefined &&
        (!PRIMITIVE_KINDS.includes(body.kind as (typeof PRIMITIVE_KINDS)[number]) ||
          body.kind === "hyperedge")
      ) {
        throw new BadRequestError(
          `Invalid kind '${body.kind}'. Must be one of: ${PRIMITIVE_KINDS.filter((k) => k !== "hyperedge").join(", ")}.`,
          undefined,
          "kind"
        );
      }

      // AGENTSIM-8 / Q-3 — a subtype outside its kind's list first fell back to
      // the default in silence (40 of 50 agent facts became `kind=other`), then
      // (WP-5) answered 400, which lost 45 of 62 writes from an agent following
      // the protocol: agents file facts under the decision vocabulary. The
      // fact list now has those categories (migration 0048); any other value
      // is stored as the kind's fallback and the response says so in
      // `warnings`. An empty value is still a 400: it is no subtype at all.
      // Kinds without subtypes ignore the field.
      const effectiveKind = body.kind ?? "fact";
      // Valid time cannot start after the write: every later close stamps the
      // database clock, and a validity interval that ends before it starts is refused.
      const validFrom = body.validFrom ? new Date(body.validFrom) : undefined;
      if (validFrom && validFrom.getTime() > Date.now()) {
        throw new BadRequestError("validFrom cannot be in the future.", undefined, "validFrom");
      }
      const warnings: RememberWarning[] = [];
      let subtype = body.subtype;
      let subtypeState: SubtypeState = "absent";
      if (body.subtype !== undefined && effectiveKind in PRIMITIVE_SUBTYPES) {
        const subtypeKind = effectiveKind as keyof typeof PRIMITIVE_SUBTYPES;
        const allowed = PRIMITIVE_SUBTYPES[subtypeKind] as readonly string[];
        const normalized = body.subtype.trim().toLowerCase();
        if (normalized.length === 0) {
          throw new BadRequestError(
            "subtype must not be empty: omit it to use the kind's default.",
            undefined,
            "subtype"
          );
        }
        if (allowed.includes(normalized)) {
          subtype = normalized;
          subtypeState = normalized === "other" ? "explicit-other" : "valid";
        } else {
          subtypeState = "invalid";
          subtype = SUBTYPE_FALLBACK[subtypeKind];
          const ownerKinds = (
            Object.keys(PRIMITIVE_SUBTYPES) as Array<keyof typeof PRIMITIVE_SUBTYPES>
          ).filter((k) => (PRIMITIVE_SUBTYPES[k] as readonly string[]).includes(normalized));
          warnings.push({
            code: "subtype_substituted",
            field: "subtype",
            received: body.subtype,
            storedAs: subtype,
            message:
              `Unknown subtype '${body.subtype}' for kind '${effectiveKind}', stored as '${subtype}'. ` +
              `Valid values: ${allowed.join(", ")}.` +
              (ownerKinds.length > 0
                ? ` '${normalized}' is a subtype of kind '${ownerKinds.join("' / '")}'.`
                : ""),
          });
        }
      }

      // CHAOS-12 (statement half) — `min(1)` let a whitespace-only statement
      // through (stored, then "recalled" by unrelated queries), and a NUL byte
      // reached Postgres, which rejects it, as a 500. Both are the caller's.
      if (body.statement.trim().length === 0) {
        throw new BadRequestError(
          "statement must contain non-whitespace text.",
          undefined,
          "statement"
        );
      }
      for (const [field, value] of [
        ["statement", body.statement],
        ["subject", body.subject],
        ["title", body.title],
      ] as const) {
        if (value?.includes("\u0000")) {
          throw new BadRequestError(
            `${field} must not contain NUL (\\u0000) characters.`,
            undefined,
            field
          );
        }
      }

      // PRIM-14 — a write above the caller's own read ceiling was accepted
      // (201) and could never be read back by that caller: GET, list and
      // recall all answer 404 for it, and nothing said so. Refused before any
      // hook, embedding or row. 404 per the ceiling rule (S6), with its own
      // code: there is no existing row to protect from probing here, and the
      // caller needs to know to lower the tier or use a credential that can
      // read it. Never silently downgraded.
      const ceiling = resolveCeiling(c);
      const requestedSensitivity = body.sensitivity ?? DEFAULT_SENSITIVITY;
      if (!canReadSensitivity(ceiling, requestedSensitivity)) {
        throw new HttpError(
          404,
          "sensitivity_above_ceiling",
          `sensitivity '${requestedSensitivity}' is above this credential's read ceiling ('${ceiling}'); ` +
            "the memory could never be read back, so it was not stored.",
          { sensitivity: requestedSensitivity, ceiling }
        );
      }

      // B6.7: Scope ownership validation — prevent forged ownership labels
      if (body.scopeOwner) {
        if (body.scopeOwner.startsWith("user:")) {
          const requestedUserId = body.scopeOwner.slice(5);
          if (!userId || requestedUserId !== userId) {
            return c.json(
              {
                error: "forbidden",
                message: "scopeOwner 'user:<id>' must match the authenticated userId",
              } as never,
              403 as never
            );
          }
        } else if (body.scopeOwner.startsWith("tenant:")) {
          const requestedTenantId = body.scopeOwner.slice(7);
          if (!tenantId || requestedTenantId !== tenantId) {
            return c.json(
              {
                error: "forbidden",
                message: "scopeOwner 'tenant:<id>' must match the authenticated tenantId",
              } as never,
              403 as never
            );
          }
        } else if (body.scopeOwner.startsWith("workspace:")) {
          const requestedWsId = body.scopeOwner.slice(10);
          if (requestedWsId !== keyWorkspaceId && requestedWsId !== body.targetWorkspaceId) {
            return c.json(
              {
                error: "forbidden",
                message: "scopeOwner 'workspace:<id>' must match the target workspaceId",
              } as never,
              403 as never
            );
          }
        } else {
          return c.json(
            {
              error: "bad_request",
              message: "scopeOwner must start with 'workspace:', 'user:', or 'tenant:'",
            } as never,
            400 as never
          );
        }
      }

      // Resolve effective workspace: body.targetWorkspaceId overrides key workspace
      // when the user has membership in the target workspace.
      const target = await resolveTargetWorkspace({
        keyWorkspaceId,
        userId,
        sql: deps.metricsPgClient,
        targetWorkspaceId: body.targetWorkspaceId,
      });
      if (!target.ok) return c.json(target.body as never, target.status as never);
      let effectiveWorkspaceId = target.workspaceId;

      // Personal scope resolution: route to the user's personal workspace.
      // Requires a user-bound key (userId present). Sets scopeOwner to "user:<userId>".
      let personalScopeOwner: string | undefined;
      if (body.scope === "personal") {
        if (!userId || !deps.metricsPgClient) {
          return c.json(
            {
              error: "bad_request",
              message:
                "scope 'personal' requires a user-bound key (userId must be set on the API key)",
            } as never,
            400 as never
          );
        }
        const personalWsId = await getUserPersonalWorkspaceId(deps.metricsPgClient, userId);
        if (!personalWsId) {
          return c.json(
            {
              error: "bad_request",
              message: "No personal workspace found for this user. Register a user profile first.",
            } as never,
            400 as never
          );
        }
        effectiveWorkspaceId = personalWsId;
        personalScopeOwner = `user:${userId}`;
      }

      const workspaceId = effectiveWorkspaceId;

      // §21 plugin write-path hooks + fact.created event/webhook fan-out —
      // ported from the legacy POST /facts route (D2 step 1 of
      // flatten-legacy-dual-core). Scoped to kind 'fact' (the default):
      // PluginKnowledgeUnit's write-path is fact-shaped parity with what
      // /facts always sent, and MnemoEventType has no decision/episode/etc.
      // creation event — only "fact.created" exists, so firing it for a
      // non-fact primitive would be semantically wrong. Non-fact kinds are
      // unaffected: no hook, no event, no webhook, exactly like today.
      const isFactKind = (body.kind ?? "fact") === "fact";
      let effectiveStatement = body.statement;
      let effectiveTags = body.tags;
      let pluginCtx: ReturnType<typeof buildPluginContext> | undefined;
      if (isFactKind && deps.pluginLoader) {
        const unit = {
          content: body.statement,
          tags: body.tags,
          ...(body.subject ? { subject: body.subject } : {}),
          kind: "fact",
          ...(body.metadata ? { metadata: body.metadata } : {}),
          ...(body.sensitivity ? { sensitivity: body.sensitivity } : {}),
        };
        pluginCtx = buildPluginContext({
          pluginId: "__write__",
          config: {},
          workspaceId,
          deps,
          logger: {
            info: (o, m) => console.info(m, o),
            warn: (o, m) => console.warn(m, o),
            error: (o, m) => console.error(m, o),
          },
        });
        const mutated = await deps.pluginLoader.runBeforeWrite(unit, pluginCtx);
        if (mutated === null) {
          return c.json({ error: "write rejected by plugin" } as never, 400 as never);
        }
        effectiveStatement = mutated.content;
        effectiveTags = mutated.tags ?? body.tags;
      }

      const auth: import("@mnemo-ai/types").AuthContext = {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        userId: provenance.userId,
        // The write scope, plus memory:admin only when the credential holds it:
        // effectiveCeiling reads that one scope to decide how far the
        // write-time conflict screen may read, as recall does. Nothing else.
        scopes: getAuthCtx(c).scopes.includes("memory:admin")
          ? ["memory:write", "memory:admin"]
          : ["memory:write"],
        maxSensitivity: resolveCeiling(c),
      };
      // Personal scope: override scopeOwner with "user:<userId>" and strip the
      // "personal" scope value (not a stored scope — it's a routing directive).
      // The fact is stored as "global" in the personal workspace.
      const effectiveScope = body.scope === "personal" ? undefined : body.scope;
      const effectiveScopeOwner = personalScopeOwner ?? body.scopeOwner;
      const agentIdStr =
        typeof body.attribution === "string" ? body.attribution : (body.agentId ?? undefined);
      const rememberArgs = {
        workspaceId,
        kind: (body.kind as any) ?? ("fact" as const),
        ...(subtype ? { subtype } : {}),
        ...(body.title ? { title: body.title } : {}),
        content: effectiveStatement,
        ...(body.subject ? { subject: body.subject } : {}),
        ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
        ...(body.conversationId ? { conversationId: body.conversationId } : {}),
        ...(agentIdStr ? { agentId: agentIdStr } : {}),
        ...(body.sensitivity ? { sensitivity: body.sensitivity as any } : {}),
        tags: effectiveTags,
        sessionId: body.sessionId,
        episodeId: body.episodeId,
        metadata: body.metadata,
        ...(effectiveScope ? { scope: effectiveScope } : {}),
        ...(body.scopeRef ? { scopeRef: body.scopeRef } : {}),
        ...(effectiveScopeOwner ? { scopeOwner: effectiveScopeOwner } : {}),
        ...(body.vector ? { precomputedEmbedding: new Float32Array(body.vector) } : {}),
        ...(body.topicKey ? { topicKey: body.topicKey } : {}),
        ...(validFrom && effectiveKind === "fact" ? { validFrom } : {}),
      };
      // A fact write classifies its closest candidates with an LLM (WP-7). Use
      // the workspace's own provider (WP-1 resolver: workspace → global → env)
      // so a workspace that configured one never has its statements sent to
      // the boot provider. A lookup failure falls back to the boot adapter.
      let llmOverride: import("@mnemo-ai/types").LLMAdapter | undefined;
      if (deps.llmConfigResolver && rememberArgs.kind === "fact") {
        try {
          const { buildWorkspaceLlmAdapter } = await import("../config/WorkspaceLlmAdapter.js");
          llmOverride =
            (await buildWorkspaceLlmAdapter(
              workspaceId,
              deps.llmConfigResolver,
              deps.llmAdapter
            )) ?? undefined;
        } catch {
          llmOverride = undefined;
        }
      }
      const runRemember = () =>
        llmOverride
          ? deps.cognitive.remember(rememberArgs, auth, { llmOverride })
          : deps.cognitive.remember(rememberArgs, auth);
      let result;
      try {
        result = await (deps.circuitBreakers
          ? deps.circuitBreakers.storageWrite(runRemember)
          : runRemember());
      } catch (err) {
        // A live row already owns the key (a duplicate entity name) — the
        // caller's conflict, not a server fault.
        if (err instanceof RememberConflictError) {
          // Review round: the conflicting row may sit above this caller's read
          // ceiling. Its existence, and its id, stay hidden then (S6: 404).
          if (
            err.existingSensitivity !== undefined &&
            !canReadSensitivity(ceiling, err.existingSensitivity)
          ) {
            throw new NotFoundError("Not found");
          }
          throw new ConflictError(err.message, err.details);
        }
        throw err;
      }
      observeDuration(writeLatency, { tier: "direct", kind: "fact" }, rememberStart);
      // mnemo_requests_total is now emitted globally by the app.ts timing
      // middleware (bounded route label) — no ad-hoc inc here (would double-count).
      vectorUpsertTotal.inc({ tier: "team", kind: result.kind ?? "fact" });
      emitMeter(workspaceId, "write");
      // v3 returns { id, kind, staged } — map to the v1 FactOut wire shape.
      // P74: `staged` is now always false. The surprise gate used to divert
      // low-prediction-error writes into a staging path that had no table, no
      // consumer and no promotion step, handing back a fabricated id; it no
      // longer diverts anything. The field and this mapping are kept so the wire
      // shape does not change, but "staged" is no longer a reachable status.
      const responseBody = {
        id: result.id,
        workspaceId,
        actorId: provenance.actorId,
        userId: provenance.userId,
        // P121: report what was STORED, not what was asked for.
        //
        // This used to be `effectiveStatement` — the caller's own input, echoed
        // straight back. `remember()` redacts PII before insert (CORE-1), so a
        // statement carrying a phone number is stored with `[REDACTED-phone]`
        // in its place, and the response cheerfully claimed otherwise. The row
        // recorded the redaction in `metadata.pii` all along; nobody told the
        // caller, so an agent recalled different text than it wrote two turns
        // earlier and had every reason to conclude the memory was broken.
        //
        // The `??` is wire-compat for a core older than this field, not a
        // fallback anyone should hit.
        statement: result.storedContent ?? effectiveStatement,
        // P122: report the row, fall back to the old fabricated values only
        // when there is no row to report (the non-fact kinds go through their
        // own repositories). Five fields used to be invented here —
        // `validFrom`/`createdAt` from `new Date()` at RESPONSE time, plus
        // hardcoded `pinned`/`confidence`/`sensitivity`. None was wrong the day
        // it was written; they were claims that happened to match, exactly like
        // `statement` did until PII redaction pulled them apart (P121). A
        // response that is assembled rather than reported starts correct and
        // drifts in silence.
        confidence: result.stored?.confidence ?? null,
        topicKey: body.topicKey ?? null,
        status: result.staged ? "staged" : "active",
        sensitivity: result.stored?.sensitivity ?? DEFAULT_SENSITIVITY,
        pinned: result.stored?.pinned ?? false,
        attribution:
          typeof body.attribution === "string"
            ? { actor: body.attribution }
            : (body.attribution ?? {}),
        tags: effectiveTags,
        validFrom: result.stored?.validFrom ?? new Date().toISOString(),
        validTo: result.stored ? result.stored.validTo : null,
        createdAt: result.stored?.createdAt ?? new Date().toISOString(),
        // P121: present ONLY when something was redacted, so its presence is
        // the signal. An always-present empty array would make every caller
        // check `.length` instead of existence, and most would forget.
        ...(result.redactedCategories?.length
          ? { redactedCategories: result.redactedCategories }
          : {}),
        ...(result.conflict ? { conflict: result.conflict } : {}),
        ...(result.embeddingDeferred ? { embeddingDeferred: true } : {}),
        // Q-3: present ONLY when part of the request was stored differently
        // from how it was sent, like `redactedCategories`.
        ...(warnings.length > 0 || result.scopeRefResolution
          ? { warnings: [...warnings, ...scopeRefWarnings(result.scopeRefResolution)] }
          : {}),
      };

      // §21 plugin write-path hooks (continued) + fact.created event/webhook
      // fan-out — see the isFactKind block above for why this is scoped to
      // kind 'fact'. Ordering mirrors the legacy /facts route exactly:
      // event + webhook fire on the committed write, runAfterWrite last.
      if (isFactKind) {
        const traceId = (c.get("requestId" as never) as string | undefined) ?? "";
        emitEvent(deps.bus, "fact.created", responseBody, traceId);
        // Best-effort, detached (never blocks the response) — same contract
        // as the legacy /facts route's fan-out.
        void dispatchWebhookEvent(
          deps,
          workspaceId,
          "fact.created",
          responseBody as unknown as Record<string, unknown>
        );
        if (deps.pluginLoader && pluginCtx) {
          await deps.pluginLoader.runAfterWrite(
            { content: effectiveStatement, tags: effectiveTags },
            pluginCtx
          );
        }
      }

      if (effectiveKind in PRIMITIVE_SUBTYPES) {
        await emitWriterNormalizationAudit(
          deps,
          {
            workspaceId,
            actorType: provenance.actorType,
            actorId: provenance.actorId,
            resourceKind: result.kind ?? effectiveKind,
            resourceId: result.id,
          },
          {
            subtypeState,
            receivedSubtype: body.subtype === undefined ? null : body.subtype.trim().toLowerCase(),
            storedSubtype: subtype ?? null,
            warningCode: warnings[0]?.code ?? null,
            writerVersion: c.req.header("x-mnemo-client-version") ?? "unknown",
          }
        );
      }

      return c.json(responseBody, 201);
    }
  );
}
