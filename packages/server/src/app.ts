import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";

import { createAuthMiddleware, type AuthVariables } from "./auth.js";
import type { ServerDeps } from "./deps.js";
import { ForbiddenError, HttpError, toErrorBody } from "./errors.js";
import { localeMiddleware } from "./i18n/locale.js";
import { decideScopeAccess, legacyFullScopeAllowed } from "./middleware/scopeGuard.js";
import { assertRbacLimitsWired } from "./middleware/assertRbacLimits.js";
import { createWorkspaceRegionLookup, regionLockMiddleware } from "./middleware/region.js";
import { createIdempotencyMiddleware } from "./idempotency.js";
import { logger as rootLogger } from "./logging.js";
import { requestDuration, requestsTotal, errorsTotal } from "./metrics/index.js";
import { mountOpenApi } from "./openapi.js";
import { createRateLimitMiddleware } from "./ratelimit.js";
import { createRbacMiddleware } from "./middleware/rbac-policy.js";
import { mountApprovals } from "./routes/approvals.js";
import { mountBreakGlass } from "./routes/break-glass.js";
import { createVersioningMiddleware } from "./versioning.js";
import { mountAudit } from "./routes/audit.js";
import { mountCitations } from "./routes/citations.js";
import { mountDecisions } from "./routes/decisions.js";
import { mountEntities } from "./routes/entities.js";
import { mountEpisodes } from "./routes/episodes.js";
import { mountExport } from "./routes/export.js";
import { mountImport } from "./routes/import-route.js";
import { mountAggregates } from "./routes/aggregates.js";
import { mountFacts } from "./routes/facts.js";
import { mountFactsCompare } from "./routes/factsCompare.js";
import { mountGraph } from "./routes/graph.js";
import {
  mountProbes,
  mountVitals,
  mountCognitiveHealth,
  mountHealthHistory,
} from "./routes/health.js";
import { mountRecall } from "./routes/recall.js";
import { mountMetrics, mountPrometheusEndpoint } from "./routes/metrics.js";
import { mountRelations } from "./routes/relations.js";
import { mountReview } from "./routes/review.js";
import { mountTimeline } from "./routes/timeline.js";
import { mountWebhooks } from "./routes/webhooks.js";
import { mountReminders } from "./routes/reminders.js";
import { mountTasks } from "./routes/tasks.js";
import { mountEvents } from "./routes/events.js";
import { mountReasoning } from "./routes/reasoning.js";
import { mountStrategies } from "./routes/strategies.js";
import { mountHyperedges } from "./routes/hyperedges.js";
import { mountMetacognition } from "./routes/metacognition.js";
import { mountGovernance } from "./routes/governance.js";
import { mountAdminLlmConfig } from "./routes/admin-llm-config.js";
import { mountAdminRetention } from "./routes/admin-retention.js";
import { mountAdminErasure } from "./routes/admin-erasure.js";
import { mountAdminStats } from "./routes/admin-stats.js";
import { mountAdminEmbeddingMigrations } from "./routes/admin-embedding-migrations.js";
import { mountAdminAgentPolicies } from "./routes/admin-agent-policies.js";
import { mountAdminScopedKeys } from "./routes/admin-scoped-keys.js";
import { mountAnticipation } from "./routes/anticipation.js";
import { mountFederation } from "./routes/federation.js";
import { assertSupportedConsolidationRequest, mountConsolidation } from "./routes/consolidation.js";
import { mountComposition } from "./routes/composition.js";
import { mountSelf } from "./routes/self.js";
import { mountMemoryEvents } from "./routes/memoryEvents.js";
import { mountProcedural } from "./routes/procedural.js";
import { mountRecallTiering } from "./routes/recallTiering.js";
import { mountWorkflows } from "./routes/workflows.js";
import { mountSkills } from "./routes/skills.js";
import { mountRemember } from "./routes/remember.js";
import { mountTopicKeySuggest } from "./routes/topicKey.js";
import { mountForget } from "./routes/forget.js";
import { mountRoutes } from "./routes/index.js";
import { buildUsageRouter } from "./routes/usage.js";
import { mountCost } from "./routes/cost.js";
import { mountDoctor } from "./routes/doctor.js";
import { mountCapture } from "./routes/capture.js";
import { mountConflicts } from "./routes/conflicts.js";
import { mountBootstrap } from "./routes/bootstrap.js";
import { mountDashboard } from "./routes/dashboard.js";
import { mountDashboardAuth } from "./routes/dashboard-auth.js";
import { mountDashboardApi } from "./routes/dashboard-api.js";
import { mountWorkspaceConfig, mountRetentionConfig } from "./routes/workspace-config.js";
import { mountWorkspaceMode } from "./routes/workspace-mode.js";
import { mountKeys } from "./routes/keys.js";
import { mountTenants } from "./routes/tenants.js";
import { mountUserTokens } from "./routes/user-tokens.js";

/** 1 MiB — maximum accepted request body size. */
const BODY_LIMIT_BYTES = 1 * 1024 * 1024;
const IMPORT_BODY_LIMIT_BYTES = 100 * 1024 * 1024;

/** APP-028 — the request body limit for a route. */
export function bodyLimitFor(method: string, path: string): number {
  return method === "POST" && /^\/(v1\/)?import\/?$/.test(path) ? IMPORT_BODY_LIMIT_BYTES : BODY_LIMIT_BYTES;
}

// Scope rule table lives in app-scope.ts so the dashboard bridge can share it
// without a circular import. Re-exported here for existing consumers
// (grpc.ts, scope-matrix tests).
export { getScopeForRequest } from "./app-scope.js";
import { getScopeForRequest } from "./app-scope.js";
import { redactLinkPath } from "./single-use-link.js";

/**
 * App factory. Kept separate from `index.ts` (the boot script) so tests
 * can construct an app with fake deps and hit it via `app.request(...)`
 * without ever opening a real socket.
 *
 * Layout:
 *   1. Root Hono app   — CORS, request id, structured logging, error handler,
 *                        unauthenticated /healthz and /readyz.
 *   2. /v1 sub-router  — body-limit → auth → region lock → scope-guard → rate-limit → routes.
 */
export interface CreateAppOptions {
  deps: ServerDeps;
  /** Version string baked into the OpenAPI doc. Read from package.json at boot. */
  version: string;
}

function isSessionScratchMutation(method: string, path: string): boolean {
  return method === "POST" && /^\/session\/[^/]+\/scratch$/.test(path);
}

function isHarnessProtocolMutation(method: string, path: string): boolean {
  return method === "POST" && (path === "/harness/v1/probe" || path === "/harness/v1/events");
}

/**
 * CORS request-header allowlist. The SDK's `withObservation()` declares the
 * caller/version headers, so a cross-origin browser preflight must accept them.
 */
export const CORS_ALLOW_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Request-Id",
  "X-Mnemo-Caller",
  "X-Mnemo-Client-Version",
  "X-Mnemo-Plugin-Version",
];

/**
 * The caller's X-Request-Id when it is a usable correlation id (at most 128
 * characters of [A-Za-z0-9._:-]), else a fresh UUID. It lands on every log line
 * of the request and is echoed back, so it was logged at any length and with
 * any bytes (re-audit 2026-11-22).
 */
export function requestIdFrom(header: string | undefined): string {
  return header && /^[A-Za-z0-9._:-]{1,128}$/.test(header) ? header : randomUUID();
}

export function createApp(opts: CreateAppOptions): Hono {
  const { deps, version } = opts;
  const app = new Hono();

  // 0. Locale post-filter — outermost, so it also covers the probes, bootstrap and
  //    dashboard-auth mounts, CORS preflights and everything onError returns.
  app.use("*", localeMiddleware);

  // 1. CORS — must come first so OPTIONS preflight is handled before auth/rate-limit.
  //    MNEMO_CORS_ORIGINS: comma-separated list of allowed origins. SEC-3: fail
  //    closed on credentials when unset — origin:"*" + credentials:true is the
  //    exact spec-invalid combination that lets a CORS layer reflect any Origin
  //    with Access-Control-Allow-Credentials:true (CWE-942). Operators MUST set
  //    MNEMO_CORS_ORIGINS to an explicit allowlist to opt into credentialed CORS.
  const rawOrigins = process.env.MNEMO_CORS_ORIGINS;
  const allowedOrigins = rawOrigins
    ? rawOrigins
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : [];
  if (allowedOrigins.length > 0) {
    app.use(
      "*",
      cors({
        origin: allowedOrigins,
        allowHeaders: CORS_ALLOW_HEADERS,
        exposeHeaders: ["X-Request-Id"],
        credentials: true,
      })
    );
  } else {
    rootLogger.warn(
      "MNEMO_CORS_ORIGINS unset — CORS credentials disabled (wildcard, reads only). Set the env var to enable credentialed CORS."
    );
  }
  // Final review I4: without a named proxy, any private or loopback peer is
  // treated as one and its X-Forwarded-For is believed. Behind a NAT that
  // rewrites the source (Kubernetes Cluster policy, Docker Desktop, rootless
  // Docker) that peer is the internet client's gateway.
  if (process.env.NODE_ENV === "production" && !process.env.MNEMO_TRUSTED_PROXY_IP?.trim()) {
    rootLogger.warn(
      "MNEMO_TRUSTED_PROXY_IP unset — every private or loopback peer is trusted as a proxy for the client IP (IP allowlists, login limiter, audit). Name your proxy."
    );
  }
  if (allowedOrigins.length === 0) {
    const wildcard = cors({
      origin: "*",
      allowHeaders: CORS_ALLOW_HEADERS,
      exposeHeaders: ["X-Request-Id"],
      credentials: false,
    });
    // Final review I1: the first-install routes are never readable from
    // another origin — a page open in the operator's browser must not be able
    // to read the setup token or drive the first claim.
    app.use("*", (c, next) =>
      /^\/(bootstrap|setup)(\/|$)/.test(c.req.path) ? next() : wildcard(c, next)
    );
  }

  // 2. Request id + structured request log line.
  //    request_id is taken from the X-Request-Id header if the caller
  //    provided a well-formed one (good citizenship in tracing pipelines),
  //    otherwise we mint a UUID. Echoed back so the caller can correlate too.
  app.use("*", async (c, next) => {
    const requestId = requestIdFrom(c.req.header("x-request-id"));
    c.set("requestId" as never, requestId);
    c.header("x-request-id", requestId);

    const start = performance.now();
    const log = rootLogger.child({ request_id: requestId });
    try {
      await next();
    } finally {
      const latencyMs = Math.round(performance.now() - start);
      // Matched route PATTERN (e.g. "/entities/:id"), never the raw URL —
      // params are collapsed by Hono so label cardinality stays bounded. Read
      // AFTER next() so routeIndex points at the responding handler; falls back
      // to a "/*"-style wildcard for unmatched (404) paths.
      const route = c.req.routePath;
      // §22: feed the SLO histogram (mnemo_request_duration_seconds) for EVERY
      // request — previously this was a dead metric (logged latency only).
      requestDuration.observe(
        { method: c.req.method, route, status: String(c.res.status) },
        latencyMs / 1000
      );
      // §22: count EVERY request here (the request-availability SLO divides by
      // mnemo_requests_total). Was previously inc'd ad-hoc on ~8 routes only,
      // which undercounted almost all traffic. Same bounded route label.
      requestsTotal.inc({ method: c.req.method, route, status: String(c.res.status) });
      log.info(
        {
          method: c.req.method,
          // A single-use link token in the path never reaches the logs.
          path: redactLinkPath(c.req.path),
          status: c.res.status,
          latency_ms: latencyMs,
          // workspaceId is set by auth middleware on /*; undefined elsewhere.
          workspace_id: (c.get("workspaceId" as never) as string | undefined) ?? undefined,
        },
        "http.request"
      );
    }
  });

  // 3. Single error handler. Anything thrown anywhere lands here.
  app.onError((err, c) => {
    const requestId = (c.get("requestId" as never) as string | undefined) ?? undefined;
    const { status, body } = toErrorBody(err, requestId);
    // §22: count every error (mnemo_errors_total) by status + machine code — was
    // a dead metric. Labels are bounded (status code + snake_case error code).
    errorsTotal.inc({ status: String(status), code: body.error.code });
    // 5xx bubble up at error level; 4xx are caller mistakes, debug only.
    if (status >= 500) {
      rootLogger.error({ err, request_id: requestId }, "http.error");
    } else {
      rootLogger.debug({ err, request_id: requestId }, "http.client_error");
    }
    if (status === 429) {
      // Keep the limiter's own delay; fall back to the historical 60s.
      const retryAfter =
        c.res.headers.get("Retry-After") ?? body.error.retryAfterSeconds?.toString() ?? "60";
      c.header("Retry-After", retryAfter);
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) body.error.retryAfterSeconds = seconds;
    } else if (status === 503 && body.error.retryAfterSeconds !== undefined) {
      // CHAOS-10: a dependency outage says when to come back, in the header too.
      c.header("Retry-After", String(body.error.retryAfterSeconds));
    }
    // Hono's `c.json(..., status as ContentfulStatusCode)` needs a cast.
    return c.json(body, status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 501 | 503);
  });

  // 4. Liveness & readiness probes — no auth, no /v1 prefix.
  //    Critical that these are mounted BEFORE the /v1 router so the auth
  //    middleware never runs against them.
  mountProbes(app, deps);
  // Prometheus scrape endpoint — bearer MNEMO_METRICS_TOKEN, 404 in production without one.
  mountPrometheusEndpoint(app, deps);
  // One-time bootstrap — registers the first API key for self-hosted deployments.
  // Open endpoint (no auth) until first key is stored; locked thereafter.
  mountBootstrap(app, deps);
  // Status dashboard — operator tool. Auth gated entirely client-side; no
  // server-side auth middleware so the HTML is always reachable (REQ-P22-01).
  mountDashboard(app);
  // Dashboard session auth (cookie JWT). No-op unless MNEMO_DASHBOARD_SECRET is
  // set. Root-mounted like bootstrap: login carries the API key in the body,
  // so it must not pass through the bearer middleware.
  mountDashboardAuth(app, deps);
  // Dashboard data bridge — session-cookie-authenticated mirror of the data
  // routes at /dashboard/api/*. Also a no-op when the secret is unset.
  mountDashboardApi(app, deps);

  // 5. Versioned API surface.
  //    Middleware order: body-limit → auth → region lock → scope-guard → rate-limit → routes.
  const v1 = new OpenAPIHono<{ Variables: AuthVariables }>({
    defaultHook: (result, c) => {
      if (result.success) return;
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      }));
      const first = issues[0];
      const { body } = toErrorBody(
        new HttpError(
          400,
          "validation_error",
          first ? `${first.path || "request"}: ${first.message}` : "Invalid request",
          { issues }
        ),
        (c.get("requestId" as never) as string | undefined) ?? undefined
      );
      return c.json(body, 400);
    },
  });

  // APP-028: one limit per request, decided by route. POST /import carries a
  // whole export and has its own 100 MiB limit (and a cap on what it inflates
  // to); every other route keeps 1 MiB.
  // One literal per message: the error-template table translates literals.
  const tooLarge = (err: HttpError) =>
    new Response(JSON.stringify(toErrorBody(err).body), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  const defaultBodyLimit = bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: () =>
      tooLarge(new HttpError(413, "payload_too_large", "Request body exceeds 1 MB limit")),
  });
  const importBodyLimit = bodyLimit({
    maxSize: IMPORT_BODY_LIMIT_BYTES,
    onError: () => tooLarge(new HttpError(413, "payload_too_large", "Payload too large")),
  });
  v1.use("*", (c, next) =>
    bodyLimitFor(c.req.method, c.req.path) === IMPORT_BODY_LIMIT_BYTES
      ? importBodyLimit(c, next)
      : defaultBodyLimit(c, next)
  );

  v1.use(
    "*",
    createAuthMiddleware(
      deps.apiKeys,
      {
        telemetry: deps.telemetry,
        storage: deps.storage,
        userStatus: deps.userStatus,
        trafficOrigins: deps.trafficOrigins,
      },
      deps.scopedAuthAdapter
    )
  );

  // §35 data residency: a workspace pinned to another region gets 403
  // wrong_region. No-op without MNEMO_REGION or a workspace region.
  v1.use(
    "*",
    regionLockMiddleware(
      deps.metricsPgClient
        ? { lookupRegion: createWorkspaceRegionLookup(deps.metricsPgClient) }
        : {}
    )
  );

  // ── Scope guard ─────────────────────────────────────────────────────────────
  // F11: DENY by default. An empty scopes array is no longer a free pass — it is
  // rejected 403 unless MNEMO_ALLOW_LEGACY_FULL_SCOPE=true restores the legacy
  // empty-scope-full-access behavior for a controlled migration. Non-empty
  // scoped keys are always enforced against the route's required scope.
  const allowLegacyFullScope = legacyFullScopeAllowed();
  v1.use("*", async (c, next) => {
    const scopes = c.get("scopes") as ReadonlyArray<string> | undefined;
    const required = getScopeForRequest(c.req.method, c.req.path);
    const decision = decideScopeAccess(scopes, required, { allowLegacyFullScope });
    if (!decision.allowed) {
      // Use a specific machine-readable code: INSUFFICIENT_SCOPE when a non-empty
      // key is missing the required scope; generic "forbidden" for the empty-scope
      // bypass-disabled case so callers can distinguish the two.
      if (decision.code === "INSUFFICIENT_SCOPE") {
        throw new HttpError(
          403,
          "INSUFFICIENT_SCOPE",
          decision.reason ?? "API key scope insufficient"
        );
      }
      throw new ForbiddenError(decision.reason ?? "API key scope insufficient");
    }
    return next();
  });

  // ── §19 RBAC policy + approval gate ─────────────────────────────────────────
  // Runs after auth (needs workspaceId + actorId) and after the coarse scope
  // guard, but before any route handler. Enforces per-agent namespace
  // allow-lists and returns 202 + approval_request_id for triggers that
  // require human approval (delete_fact, bulk_export, federation_share, …).
  // Pass-through when no policy is configured for the agent (rbac-policy.ts:54).
  if (deps.accessPolicies && deps.approvals) {
    // §19 per-agent rate limits piggyback on the cache adapter's atomic
    // incr-with-ttl when available (Redis). F11: in production a missing
    // rateCounter / activeSessions would make these limits fail open — assert
    // they are wired so they cannot silently no-op.
    const cache = deps.cache;
    const rateCounter =
      cache && typeof cache.incrWithTtl === "function"
        ? { incrWithTtl: (k: string, ttl: number) => cache.incrWithTtl!(k, ttl) }
        : undefined;
    const activeSessions = deps.activeSessions;
    assertRbacLimitsWired(
      { rateCounter, activeSessions },
      process.env as Record<string, string | undefined>
    );
    v1.use(
      "*",
      createRbacMiddleware({
        accessPolicies: deps.accessPolicies,
        approvals: deps.approvals,
        ...(deps.breakGlass ? { breakGlass: deps.breakGlass } : {}),
        ...(rateCounter ? { rateCounter } : {}),
        ...(activeSessions ? { activeSessions } : {}),
        defaultDeny: process.env.MNEMO_RBAC_DEFAULT_DENY === "true",
      })
    );
  }

  // ── Versioning → Rate limiting → consolidation preflight → Idempotency ─────
  // Order matters: rate-limit first, then reject supported-shape consolidation
  // options that cannot run, then deduplicate requests that can reach a handler.
  v1.use("*", createVersioningMiddleware());
  if (deps.rateLimitBackend) {
    v1.use(
      "*",
      createRateLimitMiddleware({
        backend: deps.rateLimitBackend,
        ...(deps.fleetUtil ? { fleetUtil: deps.fleetUtil } : {}),
      })
    );
  }
  v1.use("/consolidation/trigger", async (c, next) => {
    if (c.req.method !== "POST") return next();

    let body: unknown;
    try {
      body = JSON.parse(await c.req.raw.clone().text());
    } catch {
      return next();
    }
    assertSupportedConsolidationRequest(body);
    return next();
  });
  if (deps.idempotencyStore) {
    const idempotencyMiddleware = createIdempotencyMiddleware({ store: deps.idempotencyStore });
    v1.use("*", (c, next) => {
      if (
        isSessionScratchMutation(c.req.method, c.req.path) ||
        isHarnessProtocolMutation(c.req.method, c.req.path)
      )
        return next();
      return idempotencyMiddleware(c, next);
    });
  }

  // ── §9 Degradation ladder: 503 on session ops when Redis is unavailable ──────
  // Most session mutations require Redis (L1), while scratch is PostgreSQL-
  // authoritative. Gate the Redis-dependent mutations only; recall and tasks
  // keep working through their graceful-degradation paths.
  // Spec: MEMORY_MODEL.md lines 801-803.
  {
    let cachedHealth: { at: number; status: string } = { at: 0, status: "ok" };

    async function isRedisUp(): Promise<boolean> {
      if (!deps.cache) return false; // no cache adapter = sessions disabled
      const now = Date.now();
      if (now - cachedHealth.at > 5_000) {
        const h = await deps.cache.healthCheck().catch(() => ({ status: "down" as const }));
        cachedHealth = { at: now, status: h.status };
      }
      return cachedHealth.status !== "down";
    }

    v1.use("/session/*", async (c, next) => {
      // Only gate POST (start, turn, collapse) — not hypothetical GETs
      if (c.req.method !== "POST") return next();
      if (isSessionScratchMutation(c.req.method, c.req.path)) return next();
      if (!(await isRedisUp())) {
        // §3: surface the canonical operational code (spec MNEMO_001).
        c.header("X-Mnemo-Code", "MNEMO_001");
        return c.json(
          {
            error: "redis_unavailable",
            code: "MNEMO_001",
            detail: "Session operations require Redis (L1). Recall and tasks remain available.",
          },
          503
        );
      }
      return next();
    });
  }

  // Before mountFacts: GET /facts/{id} would otherwise answer GET /facts/stats.
  mountAggregates(v1, deps);
  mountRecall(v1, deps, version);
  mountRemember(v1, deps);
  mountTopicKeySuggest(v1, deps);
  mountForget(v1, deps);
  mountFacts(v1, deps);
  mountFactsCompare(v1, deps);
  mountTimeline(v1, deps);
  mountVitals(v1, deps);
  mountCognitiveHealth(v1, deps);
  mountHealthHistory(v1, deps);
  mountGraph(v1, deps);
  mountEntities(v1, deps);
  mountEpisodes(v1, deps);
  mountReview(v1, deps);
  mountAudit(v1, deps);
  if (deps.approvals) {
    mountApprovals(v1, { approvals: deps.approvals });
  }
  if (deps.breakGlass) {
    mountBreakGlass(v1, { breakGlass: deps.breakGlass });
  }
  mountExport(v1, deps);
  mountImport(v1, deps);
  mountDecisions(v1, deps);
  mountRelations(v1, deps);
  mountConflicts(v1, deps);
  mountCitations(v1, deps);
  mountMetrics(v1, deps);
  mountWebhooks(v1, deps);
  mountReminders(v1, deps);
  mountTasks(v1, deps);
  // Harness paths must be registered before the generic event route family.
  // Authentication, key scopes, and RBAC are global middleware above this point.
  mountRoutes(v1, deps);
  mountEvents(v1, deps);
  mountReasoning(v1, deps);
  mountStrategies(v1, deps);
  mountHyperedges(v1, deps);
  mountMetacognition(v1, deps);
  mountGovernance(v1, deps);
  mountAdminLlmConfig(v1, deps);
  mountAdminRetention(v1, deps);
  mountAdminErasure(v1, deps);
  mountAdminStats(v1, deps);
  mountAdminEmbeddingMigrations(v1, deps);
  mountAdminAgentPolicies(v1, deps);
  mountWorkspaceConfig(v1, deps);
  mountRetentionConfig(v1, deps);
  mountWorkspaceMode(v1, deps);
  mountAnticipation(v1, deps);
  if (deps.federation) {
    mountFederation(v1, deps);
  }
  mountConsolidation(v1, deps);
  mountComposition(v1, deps);
  mountSelf(v1, deps);
  mountMemoryEvents(v1, deps);
  mountProcedural(v1, deps);
  // Deep re-audit P1: recall tiering (/recall/hot|unified|explain) + the two
  // missing knowledge-unit creation routes (POST /workflows, POST /skills).
  mountRecallTiering(v1, deps);
  mountWorkflows(v1, deps);
  mountSkills(v1, deps);
  v1.route(
    "/usage",
    buildUsageRouter({
      storage: deps.storage as {
        getMonthToDateUsageFromDb?(workspaceId: string): Promise<Record<string, number>>;
      },
    })
  );
  mountCost(v1, deps);
  mountDoctor(v1, deps);
  mountCapture(v1, deps);
  mountKeys(v1, deps);
  mountAdminScopedKeys(v1, deps);
  mountTenants(v1, deps);
  mountUserTokens(v1, deps);
  mountOpenApi(v1, version);

  // ── Spec-exact path/verb aliases (T6.6) ────────────────────────────────────
  // Six mismatches between the published OpenAPI spec and the existing routes.
  // Registered BEFORE app.route("/", v1) so first-match wins.
  // Old routes remain untouched for backward compatibility.

  // Spec alias 1: DELETE /sessions/:id → POST /session/:id/discard
  app.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const newUrl = new URL(c.req.url);
    newUrl.pathname = `/session/${id}/discard`;
    const newReq = new Request(newUrl.toString(), {
      method: "POST",
      headers: c.req.raw.headers,
      // @ts-ignore — duplex is required for streaming bodies in some runtimes
      duplex: "half",
    });
    return app.fetch(newReq);
  });

  // Spec alias 2: GET /entities/:id/graph → GET /graph?focus=:id
  app.get("/entities/:id/graph", async (c) => {
    const id = c.req.param("id");
    const newUrl = new URL(c.req.url);
    newUrl.pathname = "/graph";
    newUrl.searchParams.set("focus", id);
    const newReq = new Request(newUrl.toString(), {
      method: "GET",
      headers: c.req.raw.headers,
    });
    return app.fetch(newReq);
  });

  // Spec alias 3: POST /admin/consolidate → POST /consolidation/trigger
  app.post("/admin/consolidate", async (c) => {
    const newUrl = new URL(c.req.url);
    newUrl.pathname = "/consolidation/trigger";
    const newReq = new Request(newUrl.toString(), {
      method: "POST",
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      // @ts-ignore — duplex is required for streaming bodies in some runtimes
      duplex: "half",
    });
    return app.fetch(newReq);
  });

  // Spec alias 4: POST /admin/export → POST /export
  // Forwards method + body so the POST /export handler runs (same scope gate).
  app.post("/admin/export", async (c) => {
    const newUrl = new URL(c.req.url);
    newUrl.pathname = "/export";
    const newReq = new Request(newUrl.toString(), {
      method: "POST",
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      // @ts-ignore — duplex required for streaming bodies on Node 18+ fetch
      duplex: "half",
    });
    return app.fetch(newReq);
  });

  // Spec alias 5: POST /admin/import → POST /import
  app.post("/admin/import", async (c) => {
    const newUrl = new URL(c.req.url);
    newUrl.pathname = "/import";
    const newReq = new Request(newUrl.toString(), {
      method: "POST",
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      // @ts-ignore — duplex is required for streaming bodies in some runtimes
      duplex: "half",
    });
    return app.fetch(newReq);
  });

  // Spec alias 6a: POST /sessions → POST /session/start
  app.post("/sessions", async (c) => {
    const newUrl = new URL(c.req.url);
    newUrl.pathname = "/session/start";
    const newReq = new Request(newUrl.toString(), {
      method: "POST",
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      // @ts-ignore — duplex is required for streaming bodies in some runtimes
      duplex: "half",
    });
    return app.fetch(newReq);
  });

  // Spec alias 6b: GET /sessions → re-dispatch through v1 auth middleware.
  // No canonical list endpoint exists yet, so this returns a 404 after auth
  // is enforced. The stub previously bypassed auth entirely; this fix ensures
  // unauthenticated requests get a 401, not a silently empty list.
  app.get("/sessions", async (c) => {
    const newUrl = new URL(c.req.url);
    newUrl.pathname = "/session/list";
    const newReq = new Request(newUrl.toString(), {
      method: "GET",
      headers: c.req.raw.headers,
    });
    return app.fetch(newReq);
  });

  // Spec alias 6c: POST /sessions/:id/turns → POST /session/:id/turn
  app.post("/sessions/:id/turns", async (c) => {
    const id = c.req.param("id");
    const newUrl = new URL(c.req.url);
    newUrl.pathname = `/session/${id}/turn`;
    const newReq = new Request(newUrl.toString(), {
      method: "POST",
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      // @ts-ignore — duplex is required for streaming bodies in some runtimes
      duplex: "half",
    });
    return app.fetch(newReq);
  });

  app.route("/", v1);

  return app;
}
