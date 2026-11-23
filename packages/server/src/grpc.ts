/**
 * gRPC/ConnectRPC transport layer for Mnemosyne.
 *
 * Hexagonal purity: this file is the ONLY place in packages/server that
 * imports @connectrpc/* and @bufbuild/*. packages/core and packages/federation
 * must never import these.
 *
 * Wave R — R1: 10 unary RPCs + auth interceptor
 * Wave R — R2: 7 streaming RPCs over the Wave Q event bus
 */

import {
  WrongRegionError,
  assertWorkspaceRegion,
  createWorkspaceRegionLookup,
} from "./middleware/region.js";
import { gunzipSync } from "node:zlib";

import { LRUCache } from "lru-cache";
import { registerAuthCaches } from "./auth-cache-registry.js";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  ConnectError,
  Code,
  type ConnectRouter,
  type ContextValues,
  type HandlerContext,
  type Interceptor,
  createContextKey,
  createContextValues,
} from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";

import {
  evaluateSelfEdit,
  applySelfEdit,
  DEFAULT_SELF_EDIT_POLICY,
  parseTarget,
  SelfEditContentRequiredError,
  SelfEditTargetNotFoundError,
  selfEditContentMissing,
} from "@mnemo-ai/core/cognitive";
import { setAnticipationAccuracy } from "./metrics.js";
import {
  SELF_EDIT_SESSIONLESS,
  bumpSelfEditDeletes,
  bumpSelfEditEdits,
  bumpSelfEditLastEdit,
  readSelfEditDeletes,
  readSelfEditEdits,
  readSelfEditLastEdit,
  readSelfEditStrengthens,
  readSelfEditWeakens,
  readSelfEditStrengthensForTarget,
  bumpSelfEditStrengthens,
  bumpSelfEditWeakens,
} from "./selfedit-counters.js";
import type { SelfEditContext } from "@mnemo-ai/core/cognitive";
import { evaluateAccess, type AccessRequest } from "@mnemo-ai/core";
import { resolveCollapsePolicyForSession } from "./grpc-collapse-policy.js";
import { resolveApiKey } from "./auth.js";
import { recallEffectsFor } from "./provenance.js";
import {
  evaluateResolvedKey,
  keyUserAllowed,
  workspaceRoleScopesDisabled,
  type KeyDeprecation,
  type PostResolveDenyReason,
} from "./auth-evaluate.js";
import { decideScopeAccess, legacyFullScopeAllowed } from "./middleware/scopeGuard.js";
import { authFailuresTotal, authScopeNarrowedTotal } from "./metrics/index.js";
import { logger as serverLogger } from "./logging.js";
import {
  canReadSensitivity,
  effectiveCeiling,
  filterBySensitivity,
  resolveDefaultCeiling,
} from "./rbac.js";
import type { Sensitivity, AuthContext, MnemoBusEvent } from "@mnemo-ai/types";
import { visibleEventFor } from "./ws.js";
import { clientIpOf } from "./client-ip.js";
import { maxDecompressedBytes } from "./routes/import-route.js";
import { formatActorRef } from "@mnemo-ai/types";
import {
  rpcScopeFor,
  rpcActionFor,
  rpcTriggerFor,
  rpcIsFederation,
} from "./middleware/rbac-policy.js";
import type { ServerDeps } from "./deps.js";
import {
  MnemosyneService,
  MemoryItemSchema,
  RecallResponseSchema,
  RememberResponseSchema,
  ResolveReasoningResponseSchema,
  TaskSchema,
  EventSchema,
  SelfEditResponseSchema,
  HealthSnapshotSchema,
  MemoryEventSchema,
  TaskEventSchema,
  IngestSummarySchema,
  ImportResultSchema,
  SessionResponseSchema,
  SessionErrorSchema,
  ForgetResponseSchema,
  RecordReasoningResponseSchema,
} from "./gen/mnemosyne_pb.js";

// ── Auth context key ───────────────────────────────────────────────────────────

interface AuthCtx {
  workspaceId: string;
  scopes: ReadonlyArray<string>;
  /** API-key record id = the agent identity used for edit attribution. */
  actorId: string;
  apiKeyPrefix: string;
  userId?: string | null;
  /**
   * This transport only authenticates legacy mns_* keys (via resolveApiKey) —
   * there is no scoped-key/federation path here, so "user" is the same
   * blunt-but-consistent assumption auth.ts makes for legacy keys on HTTP
   * (see its `c.set("actorType", "user")` comment).
   */
  actorType: "user";
  maxSensitivity?: Sensitivity;
}

/** gRPC equivalent of provenance.ts's resolveProvenance() — see that file for
 * the design rationale. AuthCtx (this file) is not a Hono Context, so it
 * can't share that function directly; this mirrors its logic for the one
 * key kind this transport supports. */
function resolveGrpcProvenance(auth: AuthCtx): import("@mnemo-ai/types").ActorProvenance {
  return {
    actorType: auth.actorType,
    actorId: formatActorRef("key", auth.actorId),
    userId: auth.userId ?? null,
  };
}

export const kAuth = createContextKey<AuthCtx | undefined>(undefined);

// ── Scope map ─────────────────────────────────────────────────────────────────

const RPC_SCOPE: Record<string, string> = {
  Recall: "memory:read",
  ResolveReasoning: "memory:read",
  GetHealth: "memory:read",
  Remember: "memory:write",
  CreateTask: "memory:write",
  UpdateTask: "memory:write",
  RecordEvent: "memory:write",
  // §6/§13: self-edit is its own scope — a key without memory:self_edit must not
  // mutate memory via the SelfEdit RPC just because it has memory:write.
  SelfEdit: "memory:self_edit",
  // §6: Forget calls core.closeFact (a delete) — the HTTP DELETE path requires
  // memory:delete (app.ts getScopeForRequest), so memory:write was too weak.
  // There is no hard-delete variant on the gRPC surface (ForgetRequest carries
  // no hard flag), so this is the soft-delete scope only — matching HTTP's
  // default DELETE (memory:hard_delete is reserved for /hard paths, which gRPC
  // does not expose).
  Forget: "memory:delete",
  RecordReasoning: "memory:write",
  // AUTH-GRPC-PARITY G1b: the streaming RPCs require the scope their HTTP
  // equivalent does. They had none, so a key with any scope could stream.
  WatchMemory: "memory:subscribe", // HTTP /subscribe
  WatchTasks: "memory:subscribe",
  StreamHealth: "memory:subscribe",
  IngestBatch: "memory:write", // HTTP POST /import
  ImportMemory: "memory:write",
  Session: "memory:write", // HTTP POST /session/*
  FederationSync: "memory:federation", // HTTP /federation
};

/** Cap on a reassembled ImportMemory stream — mirrors routes/import-route.ts. */
const GRPC_IMPORT_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB

/**
 * Cap on each message the Connect adapter reads (AUTH-GRPC-PARITY G4). Connect
 * reads a unary body into memory before any interceptor runs, so without a cap
 * an unauthenticated caller could make the server buffer up to Connect's ~4 GiB
 * default. Past the cap Connect answers ResourceExhausted. 1 MiB is HTTP's /v1
 * body limit (app.ts BODY_LIMIT_BYTES), so a payload legal over HTTP is legal
 * here. It applies per message: an ImportMemory stream is still bounded by
 * GRPC_IMPORT_MAX_BYTES in total.
 */
const GRPC_READ_MAX_BYTES = 1024 * 1024; // 1 MiB

/** The socket peer of the request, set by createConnectHandler's contextValues. */
const kPeer = createContextKey<string | undefined>(undefined);

/**
 * The client address for the IP allowlist — client-ip.ts clientIpOf, as HTTP
 * reads it (APP-027): the socket peer is the truth, forwarding headers count
 * only from a trusted proxy. Without a peer (an in-process router transport)
 * clientIpOf keeps the old header reading, as it does for HTTP.
 */
function grpcClientIp(req: { header: Headers; contextValues: ContextValues }): string {
  const remoteAddress = req.contextValues.get(kPeer);
  return clientIpOf({
    env: remoteAddress ? { incoming: { socket: { remoteAddress } } } : undefined,
    req: { header: (name) => req.header.get(name) ?? undefined },
  });
}

// ── Auth interceptor ──────────────────────────────────────────────────────────

/** How a deny from the shared evaluator reaches a Connect client. */
const DENY_CODE: Record<PostResolveDenyReason, Code> = {
  ip_denied: Code.PermissionDenied,
  deprecated_sunset: Code.Unauthenticated,
  // The request asks for something this transport does not do.
  workspace_switch_unsupported: Code.InvalidArgument,
  // Reachable only on a transport that switches workspaces.
  not_user_token: Code.PermissionDenied,
  missing_user_binding: Code.PermissionDenied,
  not_member: Code.PermissionDenied,
  verifier_missing: Code.PermissionDenied,
};

/** The Deprecation and Sunset headers HTTP sends for a key in its grace window. */
function deprecationHeaders(dep: KeyDeprecation | undefined): Headers | undefined {
  if (!dep) return undefined;
  return new Headers({
    deprecation: dep.deprecatedAt.toUTCString(),
    sunset: dep.sunset.toUTCString(),
  });
}

/**
 * AUTH-GRPC-PARITY: after the key lookup, the interceptor decides as HTTP does.
 * The IP allowlist, deprecation sunset and role narrowing come from the
 * evaluator HTTP uses (auth-evaluate.ts); the coarse scope gate is HTTP's
 * decideScopeAccess. This transport does not switch workspaces: x-workspace-id
 * metadata other than the key's own is refused, not ignored.
 */
export function createAuthInterceptor(deps: ServerDeps): Interceptor {
  const cache = new LRUCache<
    string,
    {
      workspaceId: string;
      scopes: string[];
      plan: string;
      actorId: string;
      ipAllowlist: string[];
      deprecatedAt?: Date | null;
      userId?: string | null;
      maxSensitivity?: string | null;
    }
  >({
    max: 10_000,
    ttl: 60_000,
  });
  // Same knobs as the HTTP role cache (auth.ts), so a demotion reaches this
  // transport within the same TTL.
  const roleCache = new LRUCache<string, { role: string | null }>({
    max: Number(process.env.MNEMO_ROLE_CACHE_MAX ?? 5_000),
    ttl: Number(process.env.MNEMO_ROLE_CACHE_TTL_MS ?? 30_000),
  });
  registerAuthCaches(cache, roleCache);
  const getRole = deps.apiKeys.getWorkspaceMemberRole?.bind(deps.apiKeys);
  const resolveRole = getRole
    ? async (userId: string, workspaceId: string): Promise<string | null> => {
        const key = `${userId}:${workspaceId}`;
        const cached = roleCache.get(key);
        if (cached) return cached.role;
        const role = await getRole(userId, workspaceId);
        roleCache.set(key, { role });
        return role;
      }
    : undefined;
  const allowLegacyFullScope = legacyFullScopeAllowed();
  // §35 data residency, as the HTTP region lock decides it.
  const regionLookup = deps.metricsPgClient
    ? createWorkspaceRegionLookup(deps.metricsPgClient)
    : undefined;
  // §19 per-agent rate limits piggyback on the cache adapter's atomic
  // incr-with-ttl when available (Redis); absent → per-agent limits fail open,
  // exactly as createRbacMiddleware does on the HTTP path.
  const rateCounter =
    deps.cache && typeof deps.cache.incrWithTtl === "function"
      ? { incrWithTtl: (k: string, ttl: number) => deps.cache!.incrWithTtl!(k, ttl) }
      : undefined;

  return (next) => async (req) => {
    const header = req.header.get("authorization") ?? req.header.get("Authorization");
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      authFailuresTotal.inc({ adapter: "grpc", reason: "missing_token" });
      throw new ConnectError("Missing bearer token", Code.Unauthenticated);
    }
    const token = header.slice("bearer ".length).trim();
    const resolved = await resolveApiKey(deps.apiKeys, token, cache);
    if (!resolved) {
      authFailuresTotal.inc({ adapter: "grpc", reason: "invalid_key" });
      throw new ConnectError("Invalid API key", Code.Unauthenticated);
    }

    const decision = await evaluateResolvedKey(
      resolved,
      {
        clientIp: grpcClientIp(req),
        requestedWorkspaceId: req.header.get("x-workspace-id"),
        tokenIsUserKind: resolved.keyKind === "user" || token.startsWith("uk_"),
        allowWorkspaceSwitch: false,
        now: Date.now(),
      },
      {
        ...(resolveRole ? { resolveRole } : {}),
        disableRoleScopes: workspaceRoleScopesDisabled,
      }
    );
    const deprecation = deprecationHeaders(decision.deprecation);
    if (!decision.ok) {
      // HTTP counts every deny reason but ip_denied; so does this transport.
      if (decision.reason !== "ip_denied") {
        authFailuresTotal.inc({ adapter: "grpc", reason: decision.reason });
      }
      throw new ConnectError(decision.message, DENY_CODE[decision.reason], deprecation);
    }
    // Accounts stage A: a key bound to a disabled user does not authenticate,
    // as on HTTP (auth.ts). An unreadable status is Unavailable, never allowed.
    let userAllowed;
    try {
      userAllowed = await keyUserAllowed(deps.userStatus, resolved.userId);
    } catch {
      throw new ConnectError("Authentication service unavailable", Code.Unavailable, deprecation);
    }
    if (!userAllowed) {
      authFailuresTotal.inc({ adapter: "grpc", reason: "user_disabled" });
      throw new ConnectError("Invalid API key", Code.Unauthenticated);
    }
    if (decision.note === "home_role_missing") {
      serverLogger.warn(
        { userId: resolved.userId, workspaceId: resolved.workspaceId },
        "auth.role_missing_home_workspace — user-bound key has no membership row for its own home workspace; scopes left unnarrowed"
      );
    }
    if (decision.roleNarrowed && decision.workspaceRole) {
      authScopeNarrowedTotal.inc({ role: decision.workspaceRole });
    }

    // ── Coarse API-key scope gate, decided as HTTP decides it ───────────────
    // An empty-scope key is denied on every RPC, even one that requires no
    // scope, unless MNEMO_ALLOW_LEGACY_FULL_SCOPE=true.
    const scope = decideScopeAccess(decision.scopes, RPC_SCOPE[req.method.name] ?? null, {
      allowLegacyFullScope,
    });
    if (!scope.allowed) {
      throw new ConnectError(
        scope.reason ?? "API key scope insufficient",
        Code.PermissionDenied,
        deprecation
      );
    }

    try {
      await assertWorkspaceRegion(decision.workspaceId, regionLookup);
    } catch (err) {
      if (err instanceof WrongRegionError)
        throw new ConnectError(err.message, Code.PermissionDenied);
      throw new ConnectError("Region lookup failed", Code.Unavailable);
    }

    // ── §19 RBAC policy + per-agent rate limit + approval gate ───────────────
    // Mirrors createRbacMiddleware: pass-through when no policy is configured
    // for the agent. The HTTP gate's 202 + approval_request_id has no clean gRPC
    // analogue, so approval-required operations are rejected with
    // failed_precondition directing the caller to the HTTP approval flow.
    if (deps.accessPolicies) {
      await enforceRbac(deps, rateCounter, req.method.name, decision.workspaceId, resolved.actorId);
    }

    req.contextValues.set(kAuth, {
      workspaceId: decision.workspaceId,
      // Narrowed by role: the SelfEdit memory:admin override sees these too.
      scopes: decision.scopes,
      actorId: resolved.actorId,
      apiKeyPrefix: token.slice(0, 9),
      userId: resolved.userId,
      actorType: "user",
      maxSensitivity: resolved.maxSensitivity as Sensitivity | undefined,
    });
    const res = await next(req);
    deprecation?.forEach((value, name) => res.header.set(name, value));
    return res;
  };
}

/**
 * §19 RBAC parity for the gRPC transport. Runs the same evaluateAccess()
 * decision the HTTP createRbacMiddleware runs, plus the per-agent fixed-window
 * rate limit. Differences from HTTP, by transport constraint:
 *   • Namespace allow-lists: HTTP reads `x-mnemo-namespace`; the gRPC contract
 *     has no namespace channel, so req.namespace is left unset (evaluateAccess
 *     only enforces namespaces when populated — same no-op as an HTTP request
 *     without the header).
 *   • Approval: HTTP returns 202 + approval_request_id (a control-plane handle).
 *     gRPC cannot express that, so approval_required → failed_precondition.
 *   • x-mnemo-approval-id pre-approval bypass: no gRPC header channel, so an
 *     already-approved request cannot be replayed over gRPC — it must use HTTP.
 */
async function enforceRbac(
  deps: ServerDeps,
  rateCounter: { incrWithTtl(key: string, ttlSeconds: number): Promise<number> } | undefined,
  rpcMethod: string,
  workspaceId: string,
  actorId: string
): Promise<void> {
  const policy = await deps.accessPolicies!.getPolicy(workspaceId, actorId);
  if (!policy) {
    if (process.env.MNEMO_RBAC_DEFAULT_DENY === "true") {
      throw new ConnectError(
        "No RBAC policy found for this agent (default-deny mode active).",
        Code.PermissionDenied
      );
    }
    return;
  }

  const action = rpcActionFor(rpcMethod);
  const trigger = rpcTriggerFor(rpcMethod);
  const accessReq: AccessRequest = {
    scope: rpcScopeFor(rpcMethod),
    action,
    federation: rpcIsFederation(rpcMethod),
    ...(trigger ? { trigger } : {}),
  };

  // §19 per-agent rate limit: fixed 60s window keyed by (workspace, actor,
  // metric). limit <= 0 = unlimited. Best-effort: store outage fails open
  // (never hard-blocks on a limiter hiccup) — identical to the HTTP path.
  const limit =
    action === "read" ? policy.limits?.maxRecallsPerMinute : policy.limits?.maxWritesPerMinute;
  if (rateCounter && typeof limit === "number" && limit > 0) {
    const metric = action === "read" ? "recall" : "write";
    const nowMs = Date.now();
    const windowKey = `mnemo:rl:agent:${workspaceId}:${actorId}:${metric}:${Math.floor(nowMs / 60_000)}`;
    let count: number | undefined;
    try {
      count = await rateCounter.incrWithTtl(windowKey, 60);
    } catch {
      count = undefined; // counter unavailable → fail open
    }
    if (count !== undefined && count > limit) {
      throw new ConnectError(
        `Per-agent ${metric} rate limit exceeded (${limit}/min)`,
        Code.ResourceExhausted
      );
    }
  }

  const decision = evaluateAccess(policy, accessReq);
  if (decision.decision === "deny") {
    throw new ConnectError(decision.reason, Code.PermissionDenied);
  }
  if (decision.decision === "approval_required") {
    throw new ConnectError(
      `operation '${rpcMethod}' requires human approval (trigger '${decision.trigger}'); ` +
        `the gRPC transport cannot issue an approval request — use the HTTP API ` +
        `to obtain approval, then retry over HTTP`,
      Code.FailedPrecondition
    );
  }
}

// ── Auth helper ───────────────────────────────────────────────────────────────

function authOf(ctx: HandlerContext): AuthCtx {
  const a = ctx.values.get(kAuth);
  if (!a) throw new ConnectError("unauthenticated", Code.Unauthenticated);
  return a;
}

/** True when the caller may read a row of this sensitivity (same ceiling as Recall). */
function readable(auth: AuthCtx, sensitivity: string | undefined): boolean {
  return canReadSensitivity(
    effectiveCeiling(
      resolveDefaultCeiling(process.env.MNEMO_SENSITIVITY_CEILING),
      auth.maxSensitivity
    ),
    sensitivity
  );
}

// ── Proto helpers ─────────────────────────────────────────────────────────────

function taskToProto(task: {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  assignedTo?: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return create(TaskSchema, {
    id: task.id,
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    priority: task.priority,
    assignedTo: task.assignedTo ?? "",
    createdAt: timestampFromDate(task.createdAt),
    updatedAt: timestampFromDate(task.updatedAt),
  });
}

// ── Bus stream helper (for server-streaming RPCs, Wave R2) ────────────────────

interface BusEventPayload {
  channel: string;
  type: string;
  payload: unknown;
  /** ISO-8601 string (from MnemoBusEvent) or Date (from test fakes) */
  timestamp: Date | string;
  traceId: string;
}

/**
 * S1 (re-audit 2026-11-22): what a watch stream may forward — the WebSocket
 * rule (ws.ts visibleEventFor): the caller's workspace only, nothing above its
 * ceiling, and nothing from an event that names no workspace.
 */
function visibleTo(auth: AuthCtx): (e: unknown) => BusEventPayload | null {
  const ceiling = effectiveCeiling(
    resolveDefaultCeiling(process.env.MNEMO_SENSITIVITY_CEILING),
    auth.maxSensitivity
  );
  // The bus already matched the channel against the subscribed glob.
  const sub = { channel: "*", workspaceId: auth.workspaceId, ceiling };
  return (e) => visibleEventFor(sub, e as MnemoBusEvent) as BusEventPayload | null;
}

async function* busStream(
  bus: NonNullable<ServerDeps["bus"]>,
  channels: string[],
  ctx: HandlerContext,
  visible: (e: unknown) => BusEventPayload | null = (e) => e as BusEventPayload
): AsyncGenerator<BusEventPayload> {
  const queue: BusEventPayload[] = [];
  // Use a shared resolve ref so both the bus subscriber and abort can wake the waiter.
  let wakeUp: (() => void) | undefined;
  const globs = channels.length ? channels : ["*"];
  const unsubs = globs.map((g) =>
    bus.subscribe(g, (e: unknown) => {
      const v = visible(e);
      if (!v) return;
      queue.push(v);
      wakeUp?.();
    })
  );
  const onAbort = () => wakeUp?.();
  ctx.signal.addEventListener("abort", onAbort);
  try {
    while (!ctx.signal.aborted) {
      // Drain any queued events first.
      while (queue.length) yield queue.shift()!;
      // If aborted while draining, stop.
      if (ctx.signal.aborted) break;
      // Wait for either a new event or an abort.
      await new Promise<void>((resolve) => {
        wakeUp = resolve;
        // If something was pushed while we were setting wakeUp, resolve immediately.
        if (queue.length > 0 || ctx.signal.aborted) {
          wakeUp = undefined;
          resolve();
        }
      });
      wakeUp = undefined;
    }
  } finally {
    for (const u of unsubs) u();
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

function toDate(ts: Date | string | undefined): Date {
  if (!ts) return new Date();
  if (ts instanceof Date) return ts;
  return new Date(ts);
}

// ── SelfEdit context factory ───────────────────────────────────────────────────

function makeSelfEditCtx(storage: NonNullable<ServerDeps["storage"]>): SelfEditContext {
  const logger: import("@mnemo-ai/types").Logger = {
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
      startSpan: () => ({ end() {}, setAttribute() {}, setStatus() {} }),
      counter() {},
      histogram() {},
      gauge() {},
      async shutdown() {},
    },
    logger,
  };
}

// ── SelfEdit durable budget counters ───────────────────────────────────────────
// Shared with routes/self.ts (selfedit-counters.ts), so HTTP and gRPC draw from
// ONE budget per authenticated actor (PRIM-6). The proto carries no sessionId,
// so a gRPC edit always draws from the actor's sessionless budget — the same
// one an HTTP call without a (valid) session uses. Without a cache adapter the
// readers return 0 / null and nothing is enforced (degraded dev/test mode).

// ── Routes ────────────────────────────────────────────────────────────────────

export function createMnemosyneRoutes(router: ConnectRouter, deps: ServerDeps): void {
  router.service(MnemosyneService, {
    // ── Unary: Recall ──────────────────────────────────────────────────────────
    async recall(req, ctx) {
      const auth = authOf(ctx);
      const { workspaceId } = auth;
      const provenance = resolveGrpcProvenance(auth);
      const started = performance.now();
      const topK = req.limit && req.limit > 0 ? req.limit : 5;
      const asOf = req.asOf ? new Date(req.asOf) : undefined;

      // flatten-legacy-dual-core Phase 6d (PR17): ported off the legacy
      // core client's `recall()` onto v3 `deps.cognitive.recall` (anticipation.ts's
      // established call shape — `topK`→`limit`, `query`→`text`). The manual
      // `deps.llm.embed(...)` pre-computation this used to run is dropped:
      // v3's 7-stage cascade always computes/fuses the embedding internally
      // via its own boot-wired embed adapter, and this call site never
      // exposed the constant 0.5 `vectorWeight` to callers anyway — same
      // "safe, disclosed equivalent, not a behavior loss" precedent
      // anticipation.ts already established. The `mode` label heuristic
      // (`deps.llm` presence) is preserved unchanged — it was always a
      // pre-call label, not a functional gate, so this is not a regression.
      // The effective process/key ceiling goes INTO core, so the recall
      // observation (and its reinforcement) only covers hits this transport
      // actually delivers — never ones the filter below would drop.
      const ceiling = effectiveCeiling(
        resolveDefaultCeiling(process.env.MNEMO_SENSITIVITY_CEILING),
        auth.maxSensitivity
      );
      const recallAuth: AuthContext = {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        userId: provenance.userId,
        scopes: ["memory:read"],
        maxSensitivity: ceiling,
      };
      const mode = deps.llm ? "hybrid" : "fts_only";

      const resp = await deps.cognitive.recall(
        {
          workspaceId,
          effects: recallEffectsFor(deps.trafficOrigins?.[provenance.actorId] ?? "organic"),
          text: req.query,
          limit: topK,
          ...(asOf ? { asOf } : {}),
        },
        recallAuth,
        {
          // The core recall boundary owns the single observation; gRPC only
          // identifies its transport and the authenticated actor.
          observation: {
            requestId: ctx.requestHeader.get("x-request-id") ?? globalThis.crypto.randomUUID(),
            verifiedActor: { type: recallAuth.actorType, id: recallAuth.actorId },
            declaredCaller: "grpc:recall",
          },
        }
      );

      // Drop any hit above the caller's ceiling — mirrors POST /recall and
      // the other read surfaces. RecallHit carries a real `sensitivity`
      // (never missing, unlike the legacy CoreRecallHit's optional field).
      //
      // Per-key ceiling: the gRPC transport authenticates via the legacy mns_*
      // ApiKeyLookup (resolveApiKey → AuthCtx), which carries NO maxSensitivity
      // grant — so no per-key ceiling is reachable here and the keyMax is always
      // undefined. effectiveCeiling(envCeiling, undefined) is therefore a no-op
      // that preserves the process-wide ceiling; routing through it keeps this
      // surface uniform with the HTTP handlers and ready if the gRPC auth ctx
      // ever carries a grant.
      const hits = filterBySensitivity(resp.hits, ceiling);

      return create(RecallResponseSchema, {
        mode,
        tookMs: BigInt(Math.round(performance.now() - started)),
        results: hits.map((h) =>
          create(MemoryItemSchema, {
            id: h.id,
            // DISCLOSED improvement: legacy CoreRecallHit never actually set
            // `type`/`confidence` (both were always `?? "fact"`/`?? 0`
            // fallbacks over a cast that could never be populated — verified
            // by reading factory.ts's `recall()` return object literal). v3
            // RecallHit carries a real `primitive`/`worth` — mapping them is
            // a genuine improvement, not a behavior change to preserve.
            type: h.primitive,
            content: h.content,
            confidence: h.worth ?? 0,
            worth: h.worth ?? 0,
            relevanceScore: h.score,
            validFrom: h.validFrom instanceof Date ? h.validFrom.toISOString() : "",
            validTo: h.validTo instanceof Date ? h.validTo.toISOString() : "",
          })
        ),
      });
    },

    // ── Unary: Remember ────────────────────────────────────────────────────────
    async remember(req, ctx) {
      const auth = authOf(ctx);
      const { workspaceId } = auth;
      const provenance = resolveGrpcProvenance(auth);
      // flatten-legacy-dual-core Phase 6d (PR17): ported off the legacy
      // core client's `createFact()` onto v3 `deps.cognitive.remember` — the same
      // write path `capture.ts`/`events.ts` already use (PR12/PR13
      // precedent). Legacy `createFact` always hardcoded `kind: "other"` on
      // the `mnemo_fact` row and stored `args.attribution` verbatim as free
      // -form `metadata` (confirmed by reading factory.ts's `createFact` —
      // `req.type` never selected a PrimitiveKind, it just rode along inside
      // metadata) — so it folds into `metadata` here too, matching D2's
      // established "free-form attribution bag → metadata" distinction, NOT
      // `remember()`'s own fixed-enum `kind`/`attribution` fields.
      const rememberAuth: AuthContext = {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        userId: provenance.userId,
        scopes: ["memory:write"],
      };
      const fact = await deps.cognitive.remember(
        {
          workspaceId,
          kind: "fact",
          content: req.content,
          tags: req.relatedEntities ?? [],
          metadata: {
            type: req.type || "fact",
            ...(req.topicKey ? { topicKey: req.topicKey } : {}),
            ...(req.confidence ? { confidence: req.confidence } : {}),
          },
        },
        rememberAuth
      );
      return create(RememberResponseSchema, {
        id: fact.id,
        // DISCLOSED improvement: legacy always returned `conflictDetected:
        // false` — CoreFact has no conflict field at all, so this was
        // permanently dead. v3 `remember()` carries real §33 write-time
        // contradiction verdicts; surfacing them is a genuine capability
        // gain, not a behavior change to preserve (same D2 bar PR9/routes'
        // `client-ts.createFact` widening already applied).
        conflictDetected: fact.conflict?.judgmentRequired ?? false,
        revision: 1,
      });
    },

    // ── Unary: ResolveReasoning ────────────────────────────────────────────────
    async resolveReasoning(req, ctx) {
      const auth = authOf(ctx);
      const { workspaceId } = auth;
      if (!deps.storage) throw new ConnectError("storage unavailable", Code.Unavailable);
      const found = await (
        deps.storage as unknown as {
          getReasoning?: (query: string, workspaceId: string) => Promise<unknown>;
        }
      ).getReasoning?.(req.query, workspaceId);
      // A chain above the caller's ceiling is a cache miss, not a hit.
      const existing =
        found && readable(auth, (found as { sensitivity?: string }).sensitivity) ? found : null;
      return create(ResolveReasoningResponseSchema, {
        reasoningId: (existing as { id?: string } | null)?.id ?? "",
        cacheHit: existing != null,
        chain: existing ? JSON.stringify((existing as { chain?: unknown }).chain ?? "") : "",
        confidence: (existing as { confidence?: number } | null)?.confidence ?? 0,
      });
    },

    // ── Unary: CreateTask ──────────────────────────────────────────────────────
    async createTask(req, ctx) {
      const { workspaceId } = authOf(ctx);
      if (!deps.storage) throw new ConnectError("storage unavailable", Code.Unavailable);
      const task = await (
        deps.storage as unknown as {
          createTask: (args: unknown) => Promise<{
            id: string;
            title: string;
            description?: string | null;
            status: string;
            priority: string;
            assignedTo?: string | null;
            createdAt: Date;
            updatedAt: Date;
          }>;
        }
      ).createTask({
        workspaceId,
        title: req.title,
        description: req.description || undefined,
        priority: req.priority || "medium",
        assignedTo: req.assignedTo || undefined,
        relatedFacts: req.relatedFacts ?? [],
      });
      return taskToProto(task);
    },

    // ── Unary: UpdateTask ──────────────────────────────────────────────────────
    async updateTask(req, ctx) {
      const auth = authOf(ctx);
      const { workspaceId } = auth;
      if (!deps.storage) throw new ConnectError("storage unavailable", Code.Unavailable);
      const storage = deps.storage as unknown as {
        getTask?: (id: string, workspaceId: string) => Promise<unknown>;
        updateTask: (
          id: string,
          args: unknown
        ) => Promise<{
          id: string;
          title: string;
          description?: string | null;
          status: string;
          priority: string;
          assignedTo?: string | null;
          createdAt: Date;
          updatedAt: Date;
        }>;
      };
      if (storage.getTask) {
        const existing = await storage.getTask(req.id, workspaceId);
        if (!existing || !readable(auth, (existing as { sensitivity?: string }).sensitivity)) {
          throw new ConnectError("task not found", Code.NotFound);
        }
      }
      const task = await storage.updateTask(req.id, {
        title: req.title || undefined,
        status: req.status || undefined,
        priority: req.priority || undefined,
        assignedTo: req.assignedTo || undefined,
      });
      return taskToProto(task);
    },

    // ── Unary: RecordEvent ─────────────────────────────────────────────────────
    async recordEvent(req, ctx) {
      const { workspaceId } = authOf(ctx);
      if (!deps.storage) throw new ConnectError("storage unavailable", Code.Unavailable);
      const event = await (
        deps.storage as unknown as {
          createEvent: (args: unknown) => Promise<{
            id: string;
            type: string;
            subject?: string | null;
            occurredAt?: Date | null;
          }>;
        }
      ).createEvent({
        workspaceId,
        type: req.type,
        subject: req.subject || undefined,
        payload: req.payload ?? {},
        occurredAt: req.occurredAt ? new Date(req.occurredAt) : undefined,
      });
      return create(EventSchema, {
        id: event.id,
        type: event.type,
        subject: event.subject ?? "",
        occurredAt: timestampFromDate(event.occurredAt ?? new Date()),
      });
    },

    // ── Unary: Forget ──────────────────────────────────────────────────────────
    async forget(req, ctx) {
      const auth = authOf(ctx);
      const { workspaceId } = auth;
      if (!deps.storage) throw new ConnectError("storage unavailable", Code.Unavailable);
      // flatten-legacy-dual-core Phase 6d (PR17): ported off the legacy
      // core client's `closeFact()` (read: `packages/core/src/factory.ts`'s
      // `closeFact` — `SET valid_to = now(), status = 'forgotten' WHERE ...
      // valid_to IS NULL`, i.e. a bitemporal soft-close, returning a
      // found/not-found boolean) onto the SAME `getFact` + `archiveFact`
      // pattern `routes/facts.ts`'s `DELETE /facts/:id` already established
      // (PR8) — v3 `archiveFact(id, workspaceId)` returns void, so existence
      // (and "still open") is checked first via `getFact`, preserving the
      // identical 404/success matrix. Legacy `closeFact`'s in-process L1
      // recall/fact-count cache invalidation has no v3 equivalent to
      // preserve — it belonged to the legacy core's OWN in-process cache
      // (deleted wholesale in Slice 4), not to any v3 read path this RPC
      // exercises.
      const existing = await deps.storage.getFact(req.id, workspaceId);
      if (!existing || existing.validTo || !readable(auth, existing.sensitivity)) {
        throw new ConnectError("fact not found", Code.NotFound);
      }
      // PRIM-3 / CHAOS-8: a concurrent forget may close the fact between the
      // read above and this call; archiveFact reports that as `false`.
      const closed = await deps.storage.archiveFact(req.id, workspaceId);
      if (closed === false) {
        throw new ConnectError("fact not found", Code.NotFound);
      }
      // APP-030: the same audit entry DELETE /facts/:id writes (FORGET-1). This
      // transport wrote none, so a delete over Connect left no trace. Mutate
      // first, then audit, as the HTTP route does.
      const provenance = resolveGrpcProvenance(auth);
      const reason = req.reason ? req.reason.slice(0, 200) : undefined;
      await deps.storage.appendAuditEntry({
        workspaceId,
        actorType: provenance.actorType,
        actorId: provenance.actorId,
        action: "delete",
        resourceKind: "fact",
        resourceId: req.id,
        isTerminal: false,
        ...(reason ? { detail: { reason } } : {}),
      });
      return create(ForgetResponseSchema, { success: true });
    },

    // ── Unary: RecordReasoning ─────────────────────────────────────────────────
    async recordReasoning(req, ctx) {
      const { workspaceId } = authOf(ctx);
      if (!deps.storage) throw new ConnectError("storage unavailable", Code.Unavailable);
      const storage = deps.storage as unknown as {
        createReasoning: (input: {
          workspaceId: string;
          question: string;
          chain: Array<{ step: number; reasoning: string }>;
          conclusion: string;
        }) => Promise<{ id: string }>;
        updateWorth: (
          id: string,
          workspaceId: string,
          kind: "reasoning",
          delta: { success: number; failure: number; creditWeight: number }
        ) => Promise<void>;
      };
      const created = await storage.createReasoning({
        workspaceId,
        question: req.query,
        chain: [{ step: 0, reasoning: req.chain }],
        conclusion: req.chain,
      });
      await storage.updateWorth(created.id, workspaceId, "reasoning", {
        success: req.confidence >= 0.5 ? 1 : 0,
        failure: req.confidence >= 0.5 ? 0 : 1,
        creditWeight: 1,
      });
      return create(RecordReasoningResponseSchema, { reasoningId: created.id });
    },

    // ── Unary: GetHealth ───────────────────────────────────────────────────────
    async getHealth(_req, ctx) {
      const { workspaceId } = authOf(ctx);
      if (!deps.storage) throw new ConnectError("storage unavailable", Code.Unavailable);
      // flatten-legacy-dual-core Phase 6d (PR17): ported off the legacy
      // core client's `ping()`/`vitals({workspaceId})` onto
      // `deps.storage.healthCheck()`/`deps.storage.getWorkspaceVitals(
      // workspaceId)` — the SAME v3 port methods `routes/doctor.ts`'s
      // `checkConnectivity` and `routes/admin.ts`'s `GET /admin/stats`
      // already use (PR6/PR12 precedent). `healthCheck()` "always returns a
      // value (never throws)" per its own port contract, but the try/catch
      // is kept — matching `checkConnectivity`'s own defensive shape — since
      // an adapter that violates that contract must still degrade, not crash
      // this RPC.
      let status = "healthy";
      try {
        const health = await deps.storage.healthCheck();
        if (health.status !== "ok") status = "degraded";
      } catch {
        status = "degraded";
      }
      const vitals = await deps.storage.getWorkspaceVitals(workspaceId);
      const recallMode = deps.llm ? "hybrid" : "fts_only";
      return create(HealthSnapshotSchema, {
        status,
        recallMode,
        checks: {
          facts_live: String(vitals.factsLive),
          facts_closed: String(vitals.factsClosed),
          pinned: String(vitals.pinnedCount),
          embeddings_pending: String(vitals.embeddings.pending),
        },
        snapshotAt: timestampFromDate(new Date()),
      });
    },

    // ── Unary: SelfEdit ────────────────────────────────────────────────────────
    async selfEdit(req, ctx) {
      // §13: thread the REAL agent identity (the API-key id, same source the
      // HTTP self-edit route uses as actorId) and the durable session/day
      // budget counters — previously hardcoded to "default"/0/0, which made the
      // per-agent self-edit rate limits in evaluateSelfEdit a no-op.
      const auth = authOf(ctx);
      const { workspaceId, actorId: agentId } = auth;
      const provenance = resolveGrpcProvenance(auth);
      if (!deps.storage) throw new ConnectError("storage unavailable", Code.Unavailable);
      const action = req.action as "append" | "replace" | "strengthen" | "weaken" | "forget";
      // PRIM-1: an omitted proto string arrives as "" — refuse blank text for
      // append/replace before the target read and before any budget is touched.
      if (selfEditContentMissing(action, req.content)) {
        throw new ConnectError(
          `content is required (non-empty) for self-edit action '${action}'`,
          Code.InvalidArgument
        );
      }
      const parsedTarget = parseTarget(req.targetId);
      const requestedBy = provenance.userId ?? provenance.actorId;
      let actorIsolationId: string | undefined;

      // Every action that addresses a row: one above the caller's ceiling reads
      // exactly like a missing one (same as POST /self/edit).
      if (
        ["append", "replace", "strengthen", "weaken", "forget"].includes(action) &&
        parsedTarget.kind !== "profile"
      ) {
        const row =
          parsedTarget.kind === "fact"
            ? await deps.storage.getFact(parsedTarget.id, workspaceId)
            : await deps.storage.getStrategy(parsedTarget.id, workspaceId);
        if (!row || !readable(auth, row.sensitivity)) {
          throw new ConnectError("Self-edit target not found", Code.NotFound);
        }
      }

      if (action === "replace" && parsedTarget.kind === "fact") {
        const candidate = await deps.storage.getFact(parsedTarget.id, workspaceId);
        const ceiling = effectiveCeiling(
          resolveDefaultCeiling(process.env.MNEMO_SENSITIVITY_CEILING),
          auth.maxSensitivity
        );
        if (
          !candidate ||
          candidate.status !== "active" ||
          candidate.validTo != null ||
          !canReadSensitivity(ceiling, candidate.sensitivity)
        ) {
          throw new ConnectError("Self-edit target not found", Code.NotFound);
        }

        // Ownership is checked on TWO separate fields — see the matching
        // comment in routes/self.ts. apiKeyPrefix never participates.
        const userMatches = candidate.userId != null && candidate.userId === provenance.userId;
        const actorMatches = candidate.actorId != null && candidate.actorId === provenance.actorId;
        const legacyShared = candidate.actorId == null && candidate.userId == null;
        if (userMatches || actorMatches) {
          // Only the actorId match feeds the RLS actor-isolation backstop —
          // see routes/self.ts's matching comment for why a userId match
          // must not be routed through the actor_id-keyed GUC.
          if (actorMatches) actorIsolationId = candidate.actorId as string;
        } else if (!legacyShared && !auth.scopes.includes("memory:admin")) {
          throw new ConnectError("Self-edit target not found", Code.NotFound);
        }
      }
      const editCtx = makeSelfEditCtx(deps.storage);
      // PRIM-6: budgets are keyed by the authenticated actor (the same
      // `key:<id>` the HTTP route uses), and the proto has no sessionId.
      const actor = provenance.actorId;
      const policy = DEFAULT_SELF_EDIT_POLICY;
      // RDD-7 (§34.7): read the per-day strengthen/weaken totals and the per-fact
      // strengthen count so evaluateSelfEdit enforces maxStrengthensPerDay (3),
      // maxWeakensPerDay (5) and the "max 1 strengthen per fact per day" cap over
      // gRPC exactly as the HTTP POST /self/edit route does. Same Redis key
      // namespace → caps are shared per-agent across transports. Only read the
      // per-target count for strengthen (the only action it gates).
      const strengthensTodayForTarget =
        action === "strengthen"
          ? await readSelfEditStrengthensForTarget(deps.cache, workspaceId, actor, req.targetId)
          : undefined;
      const evalResult = evaluateSelfEdit(
        {
          action,
          target: req.targetId,
          reason: req.reason,
          editsThisSession: await readSelfEditEdits(
            deps.cache,
            workspaceId,
            actor,
            SELF_EDIT_SESSIONLESS
          ),
          deletesToday: await readSelfEditDeletes(deps.cache, workspaceId, actor),
          lastEditAt: await readSelfEditLastEdit(deps.cache, workspaceId, actor, req.targetId),
          strengthensToday: await readSelfEditStrengthens(deps.cache, workspaceId, actor),
          weakensToday: await readSelfEditWeakens(deps.cache, workspaceId, actor),
          strengthensTodayForTarget,
        },
        policy
      );
      if (!evalResult.allow) {
        throw new ConnectError(
          evalResult.reason ?? "self-edit policy denied",
          Code.PermissionDenied
        );
      }

      // §13 approval gate: destructive/edit actions that map to an
      // approval-required scope must NOT be applied automatically. The HTTP
      // route returns 202 + approvalRequired here; gRPC has no such control
      // channel, so reject with failed_precondition directing the caller to the
      // HTTP self-edit flow (mirrors the transport-parity decision in the
      // interceptor's RBAC approval gate).
      const approvalScope =
        action === "forget"
          ? "delete_fact"
          : action === "replace" && parsedTarget.kind !== "fact"
            ? "edit_entity"
            : null;
      if (approvalScope !== null && policy.requireApproval.includes(approvalScope)) {
        throw new ConnectError(
          `self-edit action '${action}' maps to approval-gated scope '${approvalScope}'; ` +
            `the gRPC transport cannot issue an approval request — use the HTTP ` +
            `POST /self/edit flow to obtain approval`,
          Code.FailedPrecondition
        );
      }

      let outcome;
      try {
        outcome = await applySelfEdit(editCtx, {
          workspaceId,
          agentId,
          requestedBy,
          ...(actorIsolationId ? { actorIsolationId } : {}),
          action,
          target: req.targetId,
          content: req.content || undefined,
          reason: req.reason,
          provenance,
        });
      } catch (error) {
        if (error instanceof SelfEditTargetNotFoundError) {
          throw new ConnectError("Self-edit target not found", Code.NotFound);
        }
        if (error instanceof SelfEditContentRequiredError) {
          throw new ConnectError(error.message, Code.InvalidArgument);
        }
        throw error;
      }

      // The edit is already committed. Treat budget/cooldown persistence as
      // best-effort so an outage cannot hide a successful replacementId.
      await Promise.allSettled([
        ...(outcome.countsAsEdit
          ? [bumpSelfEditEdits(deps.cache, workspaceId, actor, SELF_EDIT_SESSIONLESS)]
          : []),
        ...(outcome.countsAsDelete ? [bumpSelfEditDeletes(deps.cache, workspaceId, actor)] : []),
        ...(action === "strengthen" && outcome.applied
          ? [bumpSelfEditStrengthens(deps.cache, workspaceId, actor, req.targetId)]
          : []),
        ...(action === "weaken" && outcome.applied
          ? [bumpSelfEditWeakens(deps.cache, workspaceId, actor)]
          : []),
        ...(outcome.countsAsEdit
          ? [bumpSelfEditLastEdit(deps.cache, workspaceId, actor, req.targetId, Date.now())]
          : []),
      ]);

      return create(SelfEditResponseSchema, {
        applied: outcome.applied,
        note: outcome.action,
        targetKind: outcome.targetKind,
        replacementId: outcome.replacementId ?? "",
      });
    },

    // ── Server-streaming: WatchMemory ──────────────────────────────────────────
    async *watchMemory(req, ctx) {
      const auth = authOf(ctx);
      if (!deps.bus) throw new ConnectError("event bus unavailable (Wave Q)", Code.Unavailable);
      for await (const e of busStream(deps.bus, req.channels ?? [], ctx, visibleTo(auth))) {
        yield create(MemoryEventSchema, {
          id: e.channel,
          channel: e.channel,
          type: e.type,
          timestamp: timestampFromDate(toDate(e.timestamp)),
          traceId: e.traceId,
        });
      }
    },

    // ── Server-streaming: WatchTasks ───────────────────────────────────────────
    async *watchTasks(_req, ctx) {
      const auth = authOf(ctx);
      if (!deps.bus) throw new ConnectError("event bus unavailable (Wave Q)", Code.Unavailable);
      for await (const e of busStream(deps.bus, ["tasks.*"], ctx, visibleTo(auth))) {
        const p = (e.payload ?? {}) as {
          taskId?: string;
          previousStatus?: string;
          newStatus?: string;
        };
        yield create(TaskEventSchema, {
          taskId: p.taskId ?? "",
          previousStatus: p.previousStatus ?? "",
          newStatus: p.newStatus ?? "",
          occurredAt: timestampFromDate(toDate(e.timestamp)),
        });
      }
    },

    // ── Server-streaming: StreamHealth ─────────────────────────────────────────
    async *streamHealth(_req, ctx) {
      authOf(ctx);
      if (!deps.bus) throw new ConnectError("event bus unavailable (Wave Q)", Code.Unavailable);
      for await (const e of busStream(deps.bus, ["health"], ctx)) {
        const p = (e.payload ?? {}) as { status?: string; recallMode?: string };
        yield create(HealthSnapshotSchema, {
          status: p.status ?? "healthy",
          recallMode: p.recallMode ?? "",
          snapshotAt: timestampFromDate(toDate(e.timestamp)),
        });
      }
    },

    // ── Client-streaming: IngestBatch ─────────────────────────────────────────
    async ingestBatch(reqs, ctx) {
      const auth = authOf(ctx);
      const { workspaceId } = auth;
      const provenance = resolveGrpcProvenance(auth);
      // flatten-legacy-dual-core Phase 6d (PR17): same `remember` port as
      // above, `AuthContext` built once for the whole RPC (not per streamed
      // item — preserves the P51 invariant `grpc-ingest-batch.test.ts`
      // already proves for `resolveGrpcProvenance`).
      const ingestAuth: AuthContext = {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        userId: provenance.userId,
        scopes: ["memory:write"],
      };
      let accepted = 0;
      let rejected = 0;
      for await (const item of reqs) {
        try {
          await deps.cognitive.remember(
            {
              workspaceId,
              kind: "fact",
              content: item.content,
              tags: [],
              metadata: { type: item.type, topicKey: item.topicKey },
            },
            ingestAuth
          );
          accepted++;
        } catch {
          rejected++;
        }
      }
      return create(IngestSummarySchema, { accepted, rejected });
    },

    // ── Client-streaming: ImportMemory ─────────────────────────────────────────
    // The client streams the export file as raw byte Chunks. We reassemble the
    // buffer, decompress it (gzip JSONL, same format as GET /export/jsonl),
    // and persist each `fact` line via core.createFact — mirroring ingestBatch.
    // Non-fact entity types are counted as skipped (cross-referenced types like
    // relations/tasks need the richer storage adapter; see routes/import-route.ts).
    async importMemory(chunks, ctx) {
      const auth = authOf(ctx);
      const { workspaceId } = auth;
      const provenance = resolveGrpcProvenance(auth);
      // flatten-legacy-dual-core Phase 6d (PR17): same `remember` port as
      // above, `AuthContext` built once for the whole RPC.
      const importAuth: AuthContext = {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        userId: provenance.userId,
        scopes: ["memory:write"],
      };

      // Reassemble the streamed byte chunks into a single buffer.
      const parts: Uint8Array[] = [];
      let totalBytes = 0;
      for await (const chunk of chunks) {
        if (chunk.data && chunk.data.length > 0) {
          parts.push(chunk.data);
          totalBytes += chunk.data.length;
          if (totalBytes > GRPC_IMPORT_MAX_BYTES) {
            throw new ConnectError("import payload exceeds 100 MiB", Code.ResourceExhausted);
          }
        }
      }
      const buffer = Buffer.concat(parts.map((p) => Buffer.from(p)));
      if (buffer.length === 0) {
        return create(ImportResultSchema, { imported: 0, skipped: 0 });
      }

      // Decompress (gzip) — fall back to plain JSONL when not gzip-framed.
      let jsonlText: string;
      try {
        // APP-028 parity: the same inflate ceiling as HTTP POST /import.
        jsonlText = gunzipSync(buffer, { maxOutputLength: maxDecompressedBytes() }).toString(
          "utf8"
        );
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
          throw new ConnectError(
            `import payload inflates past ${maxDecompressedBytes()} bytes`,
            Code.ResourceExhausted
          );
        }
        jsonlText = buffer.toString("utf8");
      }

      const lines = jsonlText.split("\n").filter((l) => l.trim().length > 0);
      let imported = 0;
      let skipped = 0;
      // Line 0 is the export header; skip it if it parses as a header object.
      let startIdx = 0;
      try {
        const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
        if (first["version"] !== undefined || first["_type"] === "header") startIdx = 1;
      } catch {
        // No parseable header — treat every line as a record.
      }

      for (const line of lines.slice(startIdx)) {
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          skipped++;
          continue;
        }
        const type = record["_type"] as string | undefined;
        // Only facts are persistable through the CoreLike surface here.
        if (type && type !== "fact") {
          skipped++;
          continue;
        }
        const statement = (record["statement"] ?? record["content"]) as string | undefined;
        if (!statement) {
          skipped++;
          continue;
        }
        try {
          await deps.cognitive.remember(
            {
              workspaceId,
              kind: "fact",
              content: statement,
              tags: Array.isArray(record["tags"]) ? (record["tags"] as string[]) : [],
              metadata: (record["metadata"] as Record<string, unknown> | undefined) ?? {},
            },
            importAuth
          );
          imported++;
        } catch {
          skipped++;
        }
      }

      return create(ImportResultSchema, { imported, skipped });
    },

    // ── Bidi: Session ─────────────────────────────────────────────────────────
    // The client drives a session over a single bidi stream:
    //   • the first controlFrame "start" (optionally a JSON body with agentId)
    //     opens an ephemeral session — we ack with an assistantTurn carrying the
    //     new session id;
    //   • each userTurn string is appended as a 'user' turn — we ack with an
    //     assistantTurn echo so the caller can confirm persistence;
    //   • controlFrame "collapse" collapses the session into durable knowledge.
    // Any error is surfaced as a SessionError frame (the stream stays open so the
    // caller can decide whether to continue or close).
    async *session(msgs, ctx) {
      const auth = authOf(ctx);
      const { workspaceId } = auth;
      const provenance = resolveGrpcProvenance(auth);
      if (!deps.storage) throw new ConnectError("storage unavailable", Code.Unavailable);
      // flatten-legacy-dual-core Phase 6d (PR17): ported off the legacy
      // core client's `startSession()`/`appendTurn()`/`collapseSession()` onto v3
      // `deps.storage.createSession`/`.appendTurn`/`deps.cognitive.
      // collapseSession` — the SAME v3 methods `routes/session.ts` already
      // uses (PR10/PR16 precedent). `storage` captured into a local const so
      // it stays narrowed inside the `ensureSession` closure (TS does not
      // narrow property access on `deps` across a function boundary).
      const storage = deps.storage;

      let sessionId: string | null = null;

      // Lazily open a session on first use if the client didn't send an explicit
      // start frame (keeps simple clients that only send userTurns working).
      // `mnemo_session` has no actor_id/actor_type columns to model (PR4's
      // provenance audit) — stuffed into `metadata` instead, same as
      // `routes/session.ts`'s `POST /session/start`.
      async function ensureSession(agentId?: string): Promise<string> {
        if (sessionId) return sessionId;
        const s = await storage.createSession({
          workspaceId,
          ...(agentId ? { agentId } : {}),
          userId: provenance.userId,
          metadata: { actorId: provenance.actorId, actorType: provenance.actorType },
        });
        sessionId = s.id;
        return sessionId;
      }

      for await (const m of msgs) {
        try {
          if (m.payload.case === "controlFrame") {
            const frame = m.payload.value.trim();
            if (frame === "collapse") {
              if (!sessionId) {
                yield create(SessionResponseSchema, {
                  payload: {
                    case: "error",
                    value: create(SessionErrorSchema, { message: "no active session to collapse" }),
                  },
                });
                continue;
              }
              const grpcCollapsePolicy = await resolveCollapsePolicyForSession(
                deps.storage,
                sessionId,
                workspaceId
              );
              // §session.ts's collapseAuth scope set (memory:write +
              // memory:read + session:manage) — real caller provenance
              // instead of a synthetic actor, same disclosed improvement
              // PR16 already made for the HTTP route (session/collapse.ts's
              // `auth` param is unused by the pipeline today, so this is a
              // no-op behaviorally but strictly more correct per S11).
              const collapseAuth: AuthContext = {
                workspaceId,
                actorId: provenance.actorId,
                actorType: provenance.actorType,
                userId: provenance.userId,
                scopes: ["memory:write", "memory:read", "session:manage"],
              };
              const grpcCollapseResult = await deps.cognitive.collapseSession(
                {
                  sessionId,
                  workspaceId,
                  strategy: "auto",
                  policy: grpcCollapsePolicy,
                },
                collapseAuth
              );
              if (grpcCollapseResult?.anticipationAccuracy != null) {
                setAnticipationAccuracy(workspaceId, grpcCollapseResult.anticipationAccuracy);
              }
              yield create(SessionResponseSchema, {
                payload: { case: "assistantTurn", value: `collapsed:${sessionId}` },
              });
              sessionId = null;
              continue;
            }
            // "start" or "start <json>" — optional JSON body may carry agentId.
            let agentId: string | undefined;
            const body = frame.replace(/^start\s*/, "");
            if (body) {
              try {
                const parsed = JSON.parse(body) as { agentId?: string };
                agentId = parsed.agentId;
              } catch {
                // Non-JSON control body — ignore, just start a default session.
              }
            }
            const id = await ensureSession(agentId);
            yield create(SessionResponseSchema, {
              payload: { case: "assistantTurn", value: `started:${id}` },
            });
            continue;
          }

          if (m.payload.case === "userTurn") {
            const id = await ensureSession();
            // turnIndex computed from the durable turn count — same pattern
            // `routes/session.ts`'s no-sessionBuffer fallback uses (PR10).
            const existingTurns = await storage.listTurns(id, workspaceId);
            await storage.appendTurn(id, {
              workspaceId,
              sessionId: id,
              turnIndex: existingTurns.length,
              role: "user",
              content: m.payload.value,
            });
            // Ack the turn — a real agent runtime would stream a model response
            // here; the transport contract only requires durable persistence.
            yield create(SessionResponseSchema, {
              payload: { case: "assistantTurn", value: `ack:${m.payload.value.length}` },
            });
            continue;
          }
        } catch (err) {
          yield create(SessionResponseSchema, {
            payload: {
              case: "error",
              value: create(SessionErrorSchema, {
                message: err instanceof Error ? err.message : String(err),
              }),
            },
          });
        }
      }
    },

    // ── Bidi: FederationSync ───────────────────────────────────────────────────
    // Refused, always. Each message would be items a caller pushes into this
    // server, and federation over HTTP never lets a peer write here: a peer's
    // mk_fed_ key only reads (GET /memory/federation/items) and cannot start a
    // sync (POST /memory/federation/sync answers 403 to it). The peer gate
    // would prove who the peer is, not that it may write, so this RPC cannot be
    // held to the HTTP rules; a pull is started with POST /memory/federation/sync.
    async *federationSync() {
      throw new ConnectError(
        "FederationSync is not available: federation is pull-only. Start a pull with POST /memory/federation/sync; peers read with GET /memory/federation/items.",
        Code.Unimplemented
      );
    },
  });
}

// ── Connect adapter ───────────────────────────────────────────────────────────

// Return type annotated via ReturnType<> so tsc can name it without referencing
// connect-node's internal node-universal-handler path (TS2742 portability).
export function createConnectHandler(deps: ServerDeps): ReturnType<typeof connectNodeAdapter> {
  return connectNodeAdapter({
    readMaxBytes: GRPC_READ_MAX_BYTES,
    contextValues: (req) => createContextValues().set(kPeer, req.socket?.remoteAddress),
    interceptors: [createAuthInterceptor(deps)],
    routes: (router) => createMnemosyneRoutes(router, deps),
  });
}

export const GRPC_PATH_PREFIX = "/mnemosyne.v1.MnemosyneService/";
