import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { redactPII } from "@mnemo-ai/core";
import type { Hono } from "hono";

import type { ServerDeps } from "../deps.js";
import type { AuthVariables } from "../auth.js";
import { verifyApiKeyToken } from "../auth.js";
import { keyUserAllowed } from "../auth-evaluate.js";
import { emitEvent } from "../events.js";
import {
  MnemoSLOs,
  reasoningResolve,
  recallTierHits,
  consolidationDecisionsTotal,
  sessionsStartedTotal,
  sessionsCollapsedTotal,
} from "../metrics/index.js";
import { getAnticipationAccuracy } from "../metrics.js";
import type { CognitiveHealthSnapshot } from "@mnemo-ai/types";
import { evaluateCanarySloGate, makeCanarySloGateSources } from "../deploy/canarySloGate.js";

// ── /health/history circular buffer ───────────────────────────────────────────

const MAX_HEALTH_HISTORY = 200;
type HealthEntry = {
  checkedAt: string;
  status: string;
  degraded: boolean;
  checks: { postgres: string; vector: string; cache: string; embed?: string };
};
const healthHistory: HealthEntry[] = [];
function recordHealthEntry(entry: HealthEntry): void {
  healthHistory.push(entry);
  if (healthHistory.length > MAX_HEALTH_HISTORY) healthHistory.shift();
}

/**
 * Health endpoints split into two flavours:
 *
 *  - /healthz  → liveness. Cheap, no auth, no DB hit. Used by k8s/ECS to
 *               decide whether to kill the pod. Never depend on external
 *               services here, or you'll cause restart storms when the DB
 *               is having a bad day.
 *
 *  - /readyz   → readiness. Probes the DB. Used by load balancers to decide
 *               whether to send traffic. Failing readiness is fine and
 *               recoverable; it does NOT trigger a restart.
 *
 *  - /health → "workspace cognitive vitals". Auth'd, scoped to the
 *               caller's workspace. Counts, recall p95, etc. Surfacing
 *               this in dashboards is the whole point.
 */

const VitalsSchema = z
  .object({
    workspaceId: z.string(),
    factsLive: z.number().int(),
    factsClosed: z.number().int(),
    pinnedCount: z.number().int(),
    lastRecallAt: z.iso.datetime().nullable(),
    lastWriteAt: z.iso.datetime().nullable(),
    embeddings: z.object({
      indexed: z.number().int(),
      pending: z.number().int(),
    }),
  })
  .openapi("WorkspaceVitals");

/**
 * Mount the unauthenticated liveness/readiness probes on the bare Hono
 * app (i.e. BEFORE the auth middleware is applied). These intentionally
 * do not appear in the OpenAPI spec — they're infra, not API.
 */
/**
 * Adapter refs for per-dependency health checks.
 *
 * P127 — these used to be described as "optional … for RICHER health checks",
 * and the wording was doing real damage: nothing in production ever populated
 * `deps.healthAdapters`, so the `?? { status: "ok" }` defaults below were the
 * ONLY thing this route ever reported for `vector` and `cache`. Two of three
 * checks were constants. `degraded` is computed from them, so it could never
 * become true, and the alerting branch it guards was unreachable code.
 *
 * They are not "richer". They are the check. An absent adapter now reports
 * `unknown`, never `ok` — see UNKNOWN below.
 */
export interface HealthAdapters {
  storage?: { healthCheck(): Promise<{ status: string; latencyMs?: number }> };
  vector?: { healthCheck(): Promise<{ status: string; latencyMs?: number }> };
  cache?: { healthCheck(): Promise<{ status: string; latencyMs?: number }> };
  /**
   * P127 — the embedder was not a dependency of this route at all, and it is
   * the one whose outage takes down ONE HUNDRED PERCENT of traffic: with the
   * provider unreachable, both `POST /remember` and `POST /recall` return 500
   * while this endpoint answered `ready`.
   */
  embed?: { healthCheck(): Promise<{ status: string; latencyMs?: number }> };
  /**
   * PG-TIMEOUTS / CHAOS-1: the pool-stall watchdog's last verdict
   * (`resilience/poolStallWatchdog.ts`). Read by `/health/live` only.
   */
  poolStall?: { state(): { stalled: boolean; failingSinceMs: number | null; reason: string } };
}

/**
 * CHAOS-4 / PG-TIMEOUTS: a readiness probe that does not settle is a failed
 * probe. With Redis down `/health/ready` took 10.7 s; with the pool wedged it
 * never answered. Default 3 s, `MNEMO_HEALTH_PROBE_TIMEOUT_MS`.
 */
export interface ProbeOptions {
  probeTimeoutMs?: number;
}

function defaultProbeTimeoutMs(): number {
  const n = Number(process.env["MNEMO_HEALTH_PROBE_TIMEOUT_MS"] ?? "");
  return Number.isFinite(n) && n > 0 ? n : 3_000;
}

/** `probe()`, or `down` once `ms` have passed without an answer. */
async function bounded(
  probe: () => Promise<{ status: string; latencyMs?: number }>,
  ms: number
): Promise<{ status: string; latencyMs?: number; detail?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ status: string; latencyMs: number; detail: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ status: "down", latencyMs: ms, detail: `probe timed out after ${ms} ms` }),
      ms
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(probe), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What an unwired adapter reports. NOT `ok`.
 *
 * P127, and the same inversion as P120: absent means "nobody looked", which is
 * a different claim from "looked, and it is fine". Reporting the second when
 * you mean the first is how a health endpoint ends up assuring an operator
 * about a dependency it has never contacted.
 */
const UNKNOWN = { status: "unknown", latencyMs: 0 } as const;

/**
 * flatten-legacy-dual-core PR6: the Postgres probe used by `/readyz`,
 * `/health/ready`, and `/health/deep`'s fallback branch (when
 * `deps.healthAdapters?.storage` isn't wired) — ported off the legacy core's `ping()`
 * onto `deps.storage.healthCheck()` (v3 `StorageAdapter`, already the primary
 * path when `healthAdapters` IS wired). `deps.storage` is optional on
 * `ServerDeps` for test-fixture flexibility only; every real boot wires it
 * unconditionally (`packages/server/src/index.ts`).
 */
async function pingStorage(deps: ServerDeps): Promise<{ status: string; latencyMs?: number }> {
  if (!deps.storage) throw new Error("no storage adapter available");
  return deps.storage.healthCheck();
}

export function mountProbes(
  app: Hono,
  deps: ServerDeps & { healthAdapters?: HealthAdapters },
  probeOptions: ProbeOptions = {}
): void {
  const probeTimeoutMs = probeOptions.probeTimeoutMs ?? defaultProbeTimeoutMs();
  // B2.4: 30s in-process cache for /health/deep (avoids repeated DB probes).
  // The cache is scoped inside mountProbes so it can't escape to tests.
  let deepHealthCache: { body: unknown; expiresAt: number } | null = null;

  // /health/live — liveness: 200 while the process is up. NEVER probes external
  // deps on the request path — that causes restart storms. The one exception is
  // the pool-stall watchdog's last verdict (computed in the background): a pool
  // that cannot run `SELECT 1` while a fresh connection can is a local wedge
  // only a restart clears (CHAOS-1). A database outage never trips it.
  app.get("/health/live", (c) => {
    const stall = (deps.healthAdapters as HealthAdapters | undefined)?.poolStall?.state();
    if (stall?.stalled) {
      return c.json(
        { status: "stalled", reason: "db_pool_stalled", failingSinceMs: stall.failingSinceMs },
        503
      );
    }
    return c.json({ status: "alive", pid: process.pid }, 200);
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }, 200));

  // /readyz — kept for backward compat; same logic as /health/ready below.
  app.get("/readyz", async (c) => {
    try {
      const status = await bounded(() => pingStorage(deps), probeTimeoutMs);
      if (status.status !== "ok") throw new Error(status.status);
      return c.json({ status: "ready" }, 200);
    } catch (err) {
      return c.json({ status: "not_ready", error: (err as Error).message }, 503);
    }
  });

  // /health/ready — canonical readiness with per-dependency status.
  // TASK-11002, AUDIT_REPORT.md OPS-01, OPERATIONAL_INTERFACES.md §2.
  // PG down → 503 not_ready. Cache/vector down → 200 ready (degraded).
  app.get("/health/ready", async (c) => {
    const adapters = deps.healthAdapters;

    const checks = await Promise.allSettled([
      bounded(() => adapters?.storage?.healthCheck() ?? pingStorage(deps), probeTimeoutMs),
      bounded(() => adapters?.vector?.healthCheck() ?? Promise.resolve(UNKNOWN), probeTimeoutMs),
      bounded(() => adapters?.cache?.healthCheck() ?? Promise.resolve(UNKNOWN), probeTimeoutMs),
      bounded(() => adapters?.embed?.healthCheck() ?? Promise.resolve(UNKNOWN), probeTimeoutMs),
    ]);

    const pgStatus = checks[0]!.status === "fulfilled" ? checks[0]!.value : { status: "down" };
    const vectorStatus =
      checks[1]!.status === "fulfilled" ? checks[1]!.value : { status: "degraded" };
    const cacheStatus =
      checks[2]!.status === "fulfilled" ? checks[2]!.value : { status: "degraded" };
    const embedStatus =
      checks[3]!.status === "fulfilled" ? checks[3]!.value : { status: "degraded" };

    if (pgStatus.status === "down") {
      // V-3: tell the caller (and the load balancer) when a retry is sensible,
      // as the other Postgres-outage 503s do.
      c.header("Retry-After", "5");
      return c.json({ status: "not_ready", reason: "postgres_unavailable" }, 503);
    }

    // P127: `unknown` counts as degraded. An unwired probe is not evidence of
    // health, and treating it as such is exactly what let this endpoint answer
    // `ready` while every read and write in the instance was returning 500.
    //
    // `embed` participates because it is the dependency whose outage is TOTAL:
    // without it `POST /remember` and `POST /recall` both fail, which is the
    // whole product. It stays out of the 503 branch on purpose — Postgres gone
    // means the instance can serve nothing and should leave the load-balancer
    // rotation, while a dead embedder still leaves the by-id reads, the
    // lexical paths and every admin surface working. Degraded, loudly, is the
    // honest answer for that.
    const degraded =
      cacheStatus.status !== "ok" || vectorStatus.status !== "ok" || embedStatus.status !== "ok";
    if (degraded) {
      const traceId = (c.get("requestId" as never) as string | undefined) ?? "";
      const alertPayload = {
        degraded,
        checks: {
          postgres: pgStatus.status,
          vector: vectorStatus.status,
          cache: cacheStatus.status,
          embed: embedStatus.status,
        },
      };
      emitEvent(deps.bus, "health.alert", alertPayload, traceId, "health");
    }
    recordHealthEntry({
      checkedAt: new Date().toISOString(),
      status: "ready",
      degraded,
      checks: {
        postgres: pgStatus.status,
        vector: vectorStatus.status,
        cache: cacheStatus.status,
        embed: embedStatus.status,
      },
    });
    return c.json(
      {
        status: "ready",
        degraded,
        checks: {
          postgres: pgStatus.status,
          vector: vectorStatus.status,
          cache: cacheStatus.status,
          embed: embedStatus.status,
        },
      },
      200
    );
  });

  // /canary/slo-gate — in-process canary SLO gate (spec §35 C9).
  // Evaluates mnemo_requests_total error-rate and recall p99 against SLO
  // thresholds. Returns 200 { allow: true } when safe to promote; 409 { allow:
  // false } when SLOs are violated or data is insufficient.
  // No auth required — this is CI infrastructure, network-restricted via infra.
  app.get("/canary/slo-gate", async (c) => {
    const sources = await makeCanarySloGateSources();
    const result = evaluateCanarySloGate(sources);
    return c.json(result, result.allow ? 200 : 409);
  });

  // /health/deep — full deep health check with latency figures.
  // B2.4: Requires a valid Bearer token with the memory:admin scope.
  //   - 401 if Authorization header is missing or token is invalid.
  //   - 403 if the token is valid but lacks memory:admin scope.
  //   - 200/503 as before for authenticated callers.
  // Also: 30s in-process response cache (deepHealthCache declared above).
  // Returns 200 even if cache/vector are degraded (non-critical).
  // Returns 503 only if Postgres is unreachable (system unavailable).
  app.get("/health/deep", async (c) => {
    // ── B2.4 admin-auth ────────────────────────────────────────────────────
    const authHeader = c.req.header("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return c.json({ error: "missing_bearer_token" }, 401);
    }
    const token = authHeader.slice(7);
    const principal = await verifyApiKeyToken(deps.apiKeys, token);
    if (!principal) {
      return c.json({ error: "invalid_or_expired_token" }, 401);
    }
    // A key bound to a disabled user is refused like an invalid one; an
    // unreadable user status fails closed.
    let userAllowed;
    try {
      userAllowed = await keyUserAllowed(deps.userStatus, principal.userId);
    } catch {
      return c.json({ error: "auth_unavailable" }, 503);
    }
    if (!userAllowed) {
      return c.json({ error: "invalid_or_expired_token" }, 401);
    }
    if (!principal.scopes.includes("memory:admin")) {
      return c.json({ error: "insufficient_scope", required: "memory:admin" }, 403);
    }

    // ── B2.4 30s in-process cache ──────────────────────────────────────────
    const now = Date.now();
    if (deepHealthCache && deepHealthCache.expiresAt > now) {
      return c.json(deepHealthCache.body as Record<string, unknown>, 200);
    }

    const adapters = deps.healthAdapters;
    const startMs = Date.now();

    const [pgResult, vectorResult, cacheResult] = await Promise.allSettled([
      bounded(() => adapters?.storage?.healthCheck() ?? pingStorage(deps), probeTimeoutMs),
      bounded(
        () =>
          adapters?.vector?.healthCheck() ??
          Promise.resolve({ status: "unknown", latencyMs: 0 } as const),
        probeTimeoutMs
      ),
      bounded(
        () =>
          adapters?.cache?.healthCheck() ??
          Promise.resolve({ status: "unknown", latencyMs: 0 } as const),
        probeTimeoutMs
      ),
    ]);

    const pg = pgResult.status === "fulfilled" ? pgResult.value : { status: "down", latencyMs: 0 };
    const vector =
      vectorResult.status === "fulfilled" ? vectorResult.value : { status: "down", latencyMs: 0 };
    const cache =
      cacheResult.status === "fulfilled" ? cacheResult.value : { status: "down", latencyMs: 0 };

    const overallStatus =
      pg.status === "down"
        ? "down"
        : vector.status !== "ok" || cache.status !== "ok"
          ? "degraded"
          : "ok";

    const body = {
      status: overallStatus,
      latencyMs: Date.now() - startMs,
      checks: {
        postgres: { status: pg.status, latencyMs: pg.latencyMs ?? 0 },
        vector: { status: vector.status, latencyMs: vector.latencyMs ?? 0 },
        cache: { status: cache.status, latencyMs: cache.latencyMs ?? 0 },
      },
      version: process.env["npm_package_version"] ?? "unknown",
      uptime: Math.round(process.uptime()),
      // ── Deep diagnostic blocks (§ observability) ────────────────────────────
      // Each block is sourced from what's reachable on `deps` at this
      // authenticated, instance-wide endpoint. Blocks whose source isn't
      // reachable here are emitted with an explicit `available:false` + reason
      // rather than omitted, so dashboards can tell "healthy & empty" from
      // "we can't see it from here".
      ...buildDeepDiagnostics(deps),
      // Each loaded plugin's onHealthCheck(). Informational: an unhealthy
      // plugin never changes `status`, since the server serves without it.
      plugins: await pluginHealthBlock(deps),
    };

    // Populate cache; don't cache 503 (down state can recover quickly)
    if (overallStatus !== "down") {
      deepHealthCache = { body, expiresAt: Date.now() + 30_000 };
    }

    return c.json(body, overallStatus === "down" ? 503 : 200);
  });
}

/**
 * Each plugin's onHealthCheck(), reduced to fixed fields: a plugin's answer is
 * untrusted, so only `healthy` (as a boolean) and `detail` (a string, PII and
 * credentials redacted, at most 200 characters) are kept. `/health/deep` needs
 * a `memory:admin` key, so the redacted detail stays for the operator.
 */
async function pluginHealthBlock(deps: ServerDeps) {
  if (!deps.pluginLoader) return { available: false as const, reason: "no plugin loader" };
  const checks = await deps.pluginLoader.runHealthChecks();
  return {
    available: true as const,
    checks: checks.map(({ id, health }) => ({
      id,
      healthy: health?.healthy === true,
      ...(typeof health?.detail === "string"
        ? { detail: redactPII(health.detail).slice(0, 200) }
        : {}),
    })),
  };
}

/**
 * Assemble the deep-diagnostic blocks for `/health/deep`: `slos`, `cognitive`,
 * `queues`, `hot_tier`, `federation`, `mode`. Pure + synchronous — every value
 * comes from already-resolved `deps` shape, env, or process state, so this adds
 * no latency to the probe.
 */
function buildDeepDiagnostics(deps: ServerDeps): {
  mode: ReturnType<typeof buildModeBlock>;
  slos: ReturnType<typeof buildSloBlock>;
  cognitive: { available: false; reason: string };
  queues: { available: false; reason: string };
  hot_tier: ReturnType<typeof buildHotTierBlock>;
  federation: ReturnType<typeof buildFederationBlock>;
} {
  return {
    mode: buildModeBlock(deps),
    slos: buildSloBlock(),
    // cognitive vitals are workspace-scoped (worth convergence, ROI, …) and
    // this probe is unauthenticated + instance-wide, so there is no workspace
    // to compute against here. The per-workspace snapshot lives at the auth'd
    // GET /health/cognitive (see buildCognitiveHealthSnapshot below).
    cognitive: {
      available: false,
      reason: "workspace-scoped; use authenticated GET /health/cognitive",
    },
    // Queue depth/lag is tracked in-process by the backpressure gauges
    // (metrics/backpressure.ts) and surfaced via GET /metrics; federation sync
    // jobs live in a JobStore with no enumeration API. Neither
    // exposes a value accessor reachable from this handler, so we point callers
    // at the Prometheus scrape rather than emit a misleading zero.
    queues: {
      available: false,
      reason: "see Prometheus GET /metrics (mnemo_queue_depth, mnemo_queue_lag_seconds)",
    },
    hot_tier: buildHotTierBlock(deps),
    federation: buildFederationBlock(deps),
  };
}

/**
 * Deployment `mode` — derived from NODE_ENV plus which optional subsystems are
 * wired. There is no first-class "deployment mode" config in the server, so we
 * report the env and the wiring fingerprint (federation/cache/cognitive presence),
 * which is what an operator actually needs to disambiguate a deployment.
 */
function buildModeBlock(deps: ServerDeps): {
  env: string;
  federation: "enabled" | "disabled";
  cache: "enabled" | "disabled";
} {
  return {
    env: process.env["NODE_ENV"] ?? "development",
    federation: deps.federation ? "enabled" : "disabled",
    cache: deps.cache ? "enabled" : "disabled",
  };
}

/**
 * SLO block — the canonical §22 objective table ({@link MnemoSLOs}). Live
 * attainment/burn-rate is derived by Prometheus recording rules over the
 * request/recall/write histograms; those histogram internals aren't readable
 * in-process, so `liveAttainment` is reported null with a pointer to /metrics.
 */
function buildSloBlock(): {
  targets: Array<{
    name: string;
    metric: string;
    objective: number;
    windowDays: number;
    latencyP99Seconds: number | null;
  }>;
  liveAttainment: null;
  reason: string;
} {
  return {
    targets: MnemoSLOs.map((s) => ({
      name: s.name,
      metric: s.metric,
      objective: s.objective,
      windowDays: s.windowDays,
      latencyP99Seconds: s.latencyP99Seconds,
    })),
    liveAttainment: null,
    reason: "computed by Prometheus recording rules over GET /metrics histograms",
  };
}

/**
 * Hot-tier block — reports whether the L1/activation cache is wired and its
 * health. The live entry count lives in the in-process hot-tier cache, which
 * is not exposed on ServerDeps (same limitation as the mnemo_hot_tier_size
 * gauge), so `size` is null with a reason.
 */
function buildHotTierBlock(deps: ServerDeps): {
  available: boolean;
  cache: "enabled" | "disabled";
  workingMemory: "enabled" | "disabled";
  size: number | null;
  reason?: string;
} {
  const available = Boolean(deps.cache);
  return {
    available,
    cache: deps.cache ? "enabled" : "disabled",
    workingMemory: deps.workingMemory ? "enabled" : "disabled",
    size: null,
    reason: "live cache occupancy not exposed on ServerDeps",
  };
}

/**
 * Federation block — fully reachable from `deps.federation`: whether the
 * runtime is wired and which sub-components (sync engine, serve crypto,
 * service-JWT replay store) are present.
 */
function buildFederationBlock(deps: ServerDeps): {
  available: boolean;
  status: "enabled" | "disabled";
  syncEngine: "wired" | "absent";
  serveCrypto: "wired" | "absent";
  jtiReplayStore: "wired" | "absent";
} {
  const fed = deps.federation;
  return {
    available: Boolean(fed),
    status: fed ? "enabled" : "disabled",
    syncEngine: fed?.syncEngine ? "wired" : "absent",
    serveCrypto: fed?.serveCrypto ? "wired" : "absent",
    jtiReplayStore: fed?.jtiStore ? "wired" : "absent",
  };
}

/**
 * Mount the authenticated /health on the OpenAPI router. Scoped to
 * the requester's workspace — this is metrics, not infra.
 */
export function mountVitals(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/health",
      tags: ["health"],
      summary: "Cognitive vitals for the authenticated workspace.",
      responses: {
        200: {
          description: "Vitals snapshot.",
          content: { "application/json": { schema: VitalsSchema } },
        },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      // flatten-legacy-dual-core PR6: ported off the legacy core's vitals() onto the
      // v3 StorageAdapter port (packages/types/src/ports.ts's
      // getWorkspaceVitals) — same aggregate query, now implemented in
      // adapter-postgres's FactRepository. Response shape unchanged (pinned
      // by parity/health.parity.test.ts before this swap).
      if (!deps.storage) {
        throw new Error("[health] deps.storage is required — no storage adapter wired.");
      }
      const vitals = await deps.storage.getWorkspaceVitals(workspaceId);
      return c.json(vitals, 200);
    }
  );
}

// ── Zod schema for CognitiveHealthSnapshot ────────────────────────────────────

const UnitEconomicsSchema = z.object({
  roiMultiplier: z.number().nullable(),
  costUsdThisMonth: z.number(),
  recallCount: z.number().int(),
});

const CognitiveHealthSnapshotSchema = z
  .object({
    workspaceId: z.string(),
    computedAt: z.iso.datetime(),
    worthConvergenceRate: z.number().min(0).max(1).nullable(),
    compositionUtilization: z.number().min(0).max(1).nullable(),
    knowledgeTypeBalance: z.number().nullable(),
    proceduralEvolutionDelta: z.number().nullable(),
    unitEconomics: UnitEconomicsSchema,
    // B2.2: 7 additional optional fields (spec §AC2)
    sessionCollapseRate: z.number().nullable().optional(),
    reasoningCacheHitRate: z.number().min(0).max(1).nullable().optional(),
    avgMemoryWorth: z.number().min(0).max(1).nullable().optional(),
    hotTierHitRate: z.number().min(0).max(1).nullable().optional(),
    anticipationAccuracy: z.number().min(0).max(1).nullable().optional(),
    consolidationGateRate: z.number().min(0).max(1).nullable().optional(),
    consolidationRollbackRate: z.number().min(0).max(1).nullable().optional(),
  })
  .openapi("CognitiveHealthSnapshot");

/**
 * Mount GET /health/cognitive — AC2 cognitive health snapshot.
 *
 * Returns a CognitiveHealthSnapshot with real aggregates pulled from the
 * storage adapter. Gracefully returns null for any aggregate that cannot
 * be computed (workspace with no facts, no composition rules, etc.).
 *
 * Called from the server boot's authenticated router (same one as /health).
 */
export function mountCognitiveHealth(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/health/cognitive",
      tags: ["health"],
      summary: "Cognitive health snapshot — worth convergence, composition utilisation, etc.",
      responses: {
        200: {
          description: "Snapshot of key cognitive health metrics.",
          content: { "application/json": { schema: CognitiveHealthSnapshotSchema } },
        },
        401: { description: "Missing or invalid bearer token." },
      },
    }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      const snapshot = await buildCognitiveHealthSnapshot(workspaceId, deps);
      return c.json(snapshot, 200);
    }
  );
}

/**
 * Sum all Counter samples whose labels contain every key-value pair in
 * `matchLabels`. Used by buildCognitiveHealthSnapshot to derive rates
 * from in-process Prometheus counters.
 *
 * @example
 *   sumCounterByLabel(reasoningResolve, { result: "cache_hit" })
 *   // → total value across all samples where result === "cache_hit"
 */
function sumCounterByLabel(
  counter: { read(): IterableIterator<{ labels: Record<string, string>; value: number }> },
  matchLabels: Record<string, string>
): number {
  let total = 0;
  for (const sample of counter.read()) {
    const matches = Object.entries(matchLabels).every(([k, v]) => sample.labels[k] === v);
    if (matches) total += sample.value;
  }
  return total;
}

/**
 * Build a CognitiveHealthSnapshot by aggregating over the storage adapter.
 * Each metric degrades gracefully — a storage method that throws or returns
 * nothing results in null for that field rather than a 500.
 */
async function buildCognitiveHealthSnapshot(
  workspaceId: string,
  deps: ServerDeps
): Promise<CognitiveHealthSnapshot> {
  const computedAt = new Date().toISOString();

  const storage = deps.storage;

  // ── worthConvergenceRate ──────────────────────────────────────────────────
  // fraction of facts where |α/(α+β) - 0.5| > 0.1  (i.e. worth has diverged
  // from neutral). "Converged" ≈ strongly positive or negative signal.
  let worthConvergenceRate: number | null = null;
  try {
    if (storage) {
      const factsPage = await storage.queryFacts({
        workspaceId,
        status: "active",
        limit: 500,
      });
      const facts = factsPage.items;
      if (facts.length > 0) {
        const converged = facts.filter((f) => {
          const a = f.worthAlpha ?? 2;
          const b = f.worthBeta ?? 2;
          const worth = a / (a + b);
          return Math.abs(worth - 0.5) > 0.1;
        }).length;
        worthConvergenceRate = converged / facts.length;
      }
    }
  } catch {
    // storage not available — leave null
  }

  // ── compositionUtilization ────────────────────────────────────────────────
  // fraction of active composition rules that fired in last 7 days.
  let compositionUtilization: number | null = null;
  try {
    if (storage) {
      const rulesPage = await storage.queryCompositionRules({
        workspaceId,
        isActive: true,
        limit: 500,
      });
      const rules = rulesPage.items;
      if (rules.length > 0) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
        const firedRecently = rules.filter((r) => {
          const lastFired = (r as unknown as { lastFiredAt?: Date | null }).lastFiredAt;
          return lastFired != null && new Date(lastFired) >= sevenDaysAgo;
        }).length;
        compositionUtilization = firedRecently / rules.length;
      }
    }
  } catch {
    // leave null
  }

  // ── knowledgeTypeBalance ──────────────────────────────────────────────────
  // Shannon entropy over {facts, episodes, decisions, entities} counts.
  let knowledgeTypeBalance: number | null = null;
  try {
    if (storage) {
      const [factsPage, episodesPage, decisionsPage, entitiesPage] = await Promise.allSettled([
        storage.queryFacts({ workspaceId, status: "active", limit: 1 }),
        storage.queryEpisodes({ workspaceId, limit: 1 }),
        storage.queryDecisions({ workspaceId, limit: 1 }),
        storage.queryEntities({ workspaceId, limit: 1 }),
      ]);
      const counts = [
        factsPage.status === "fulfilled" ? factsPage.value.total : 0,
        episodesPage.status === "fulfilled" ? episodesPage.value.total : 0,
        decisionsPage.status === "fulfilled" ? decisionsPage.value.total : 0,
        entitiesPage.status === "fulfilled" ? entitiesPage.value.total : 0,
      ];
      const total = counts.reduce((a, b) => a + b, 0);
      if (total > 0) {
        knowledgeTypeBalance = counts.reduce((entropy, count) => {
          if (count === 0) return entropy;
          const p = count / total;
          return entropy - p * Math.log2(p);
        }, 0);
      }
    }
  } catch {
    // leave null
  }

  // ── proceduralEvolutionDelta ──────────────────────────────────────────────
  // mean score delta of the last activated prompt version (workspace-wide).
  let proceduralEvolutionDelta: number | null = null;
  try {
    if (storage) {
      const pv = await storage.getLatestActivatedPromptVersion?.(workspaceId);
      if (pv && pv.avgScoreBefore != null && pv.avgScoreAfter != null) {
        proceduralEvolutionDelta = pv.avgScoreAfter - pv.avgScoreBefore;
      }
    }
  } catch {
    // leave null
  }

  // ── unitEconomics ─────────────────────────────────────────────────────────
  let costUsdThisMonth = 0;
  let recallCount = 0;
  // APP-015: nothing measures what a recall is worth in dollars, so there is no
  // ratio to report. The measured context economy is GET /admin/stats → context.
  const roiMultiplier: number | null = null;
  try {
    if (storage) {
      costUsdThisMonth = await (storage.getWorkspaceMonthlySpendUsd?.(workspaceId) ??
        Promise.resolve(0));
    }
  } catch {
    // leave 0
  }
  try {
    if (storage) {
      recallCount = await (storage.getWorkspaceMonthlyRecallCount?.(workspaceId) ??
        Promise.resolve(0));
    }
  } catch {
    // leave 0
  }

  // B2.3: compute the 7 new fields from in-process counters ─────────────────

  // sessionCollapseRate: collapsed / started
  // sumCounterByLabel with {} matches ALL samples (empty matchLabels → every() vacuously true).
  const totalStarted = sumCounterByLabel(sessionsStartedTotal, {});
  const totalCollapsed = sumCounterByLabel(sessionsCollapsedTotal, {});
  const sessionCollapseRate: number | null =
    totalStarted > 0 ? totalCollapsed / totalStarted : null;

  // reasoningCacheHitRate: cache_hit / (cache_hit + execute)
  const rCacheHit = sumCounterByLabel(reasoningResolve, { result: "cache_hit" });
  const rExecute = sumCounterByLabel(reasoningResolve, { result: "execute" });
  const rTotal = rCacheHit + rExecute;
  const reasoningCacheHitRate: number | null = rTotal > 0 ? rCacheHit / rTotal : null;

  // avgMemoryWorth: mean α/(α+β) over already-fetched facts from worthConvergenceRate section.
  // We re-fetch a compact page (shared with worthConvergenceRate above) — facts are already available
  // in the outer scope through worthConvergenceRate. For correctness and independence, compute here.
  let avgMemoryWorth: number | null = null;
  try {
    if (storage) {
      const factsForWorth = await storage.queryFacts({
        workspaceId,
        status: "active",
        limit: 500,
      });
      const worthFacts = factsForWorth.items;
      if (worthFacts.length > 0) {
        const sumWorth = worthFacts.reduce((acc, f) => {
          const a = f.worthAlpha ?? 2;
          const b = f.worthBeta ?? 2;
          return acc + a / (a + b);
        }, 0);
        avgMemoryWorth = sumWorth / worthFacts.length;
      }
    }
  } catch {
    // leave null
  }

  // hotTierHitRate: hot / (hot + cold + unified + miss)
  const hotHits = sumCounterByLabel(recallTierHits, { tier: "hot" });
  const coldHits = sumCounterByLabel(recallTierHits, { tier: "cold" });
  const unifiedHits = sumCounterByLabel(recallTierHits, { tier: "unified" });
  const missHits = sumCounterByLabel(recallTierHits, { tier: "miss" });
  const tierTotal = hotHits + coldHits + unifiedHits + missHits;
  const hotTierHitRate: number | null = tierTotal > 0 ? hotHits / tierTotal : null;

  // anticipationAccuracy: read from per-workspace gauge updated at session collapse.
  // null when no session for this workspace has collapsed yet.
  const anticipationAccuracy: number | null = getAnticipationAccuracy(workspaceId);

  // consolidationGateRate: skipped / (merged + skipped + failed)
  const cMerged = sumCounterByLabel(consolidationDecisionsTotal, { decision: "merged" });
  const cSkipped = sumCounterByLabel(consolidationDecisionsTotal, { decision: "skipped" });
  const cFailed = sumCounterByLabel(consolidationDecisionsTotal, { decision: "failed" });
  const cTotal = cMerged + cSkipped + cFailed;
  const consolidationGateRate: number | null = cTotal > 0 ? cSkipped / cTotal : null;

  // consolidationRollbackRate: failed / total
  // FIXME: failed is a superset of rolled_back until a dedicated rolled_back outcome is emitted.
  const consolidationRollbackRate: number | null = cTotal > 0 ? cFailed / cTotal : null;

  return {
    workspaceId,
    computedAt,
    worthConvergenceRate,
    compositionUtilization,
    knowledgeTypeBalance,
    proceduralEvolutionDelta,
    unitEconomics: { roiMultiplier, costUsdThisMonth, recallCount },
    sessionCollapseRate,
    reasoningCacheHitRate,
    avgMemoryWorth,
    hotTierHitRate,
    anticipationAccuracy,
    consolidationGateRate,
    consolidationRollbackRate,
  };
}

// ── /health/history (authenticated) ────────────────────────────────────────

const HealthEntrySchema = z.object({
  checkedAt: z.string(),
  status: z.string(),
  degraded: z.boolean(),
  checks: z.object({ postgres: z.string(), vector: z.string(), cache: z.string() }),
});

export function mountHealthHistory(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  _deps: ServerDeps
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/health/history",
      tags: ["health"],
      summary: "Recent readiness check results (ring buffer, newest first, capped at 200).",
      description: "Requires memory:admin.",
      responses: {
        200: {
          description: "Health check history.",
          content: {
            "application/json": {
              schema: z.object({ items: z.array(HealthEntrySchema) }).openapi("HealthHistory"),
            },
          },
        },
        401: { description: "Missing or invalid bearer token." },
        403: { description: "memory:admin scope required." },
      },
    }),
    async (c) => {
      return c.json({ items: [...healthHistory].reverse() }, 200);
    }
  );
}
