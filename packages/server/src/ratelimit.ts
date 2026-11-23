import type { MiddlewareHandler } from "hono";
import { RateLimitedError } from "./errors.js";
import { logger } from "./logging.js";

/** Per-plan request-rate + concurrency limits (spec §35 lines 3979–3993). */
export const PLAN_LIMITS = {
  free: { rps: 10, burst: 20, concurrency: 5 },
  pro: { rps: 100, burst: 200, concurrency: 25 },
  enterprise: { rps: 1000, burst: 2000, concurrency: 100 },
} as const;
export type Plan = keyof typeof PLAN_LIMITS;

/**
 * §19/§478-485 per-operation rate-limit matrix. Distinct from the coarse
 * per-plan {@link PLAN_LIMITS}: a single noisy operation class (e.g. bulk
 * export) must not be able to starve the hot recall path, so each class gets
 * its own token bucket keyed by (workspace, actor, operationClass).
 *
 * `perMinute`/`perDay` are the *base* (free-plan) budgets straight from the
 * spec; they are scaled by the per-plan multiplier (see `planMultiplier`).
 * Exactly one of `perMinute`/`perDay` is set per class — the window differs:
 * minute-windowed classes refill continuously; `export` is a hard daily cap.
 *
 * The base recall budget (600/min = 10 rps) is deliberately equal to
 * `PLAN_LIMITS.free.rps`, so the advertised `X-RateLimit-Limit` for recall on
 * the free plan stays 10 and on enterprise stays 1000 (== free × 100).
 */
export type OperationClass =
  "recall" | "write" | "turn" | "export" | "admin" | "federation" | "other";

interface OperationLimit {
  /** Minute-windowed budget (continuous token-bucket refill). */
  perMinute?: number;
  /** Day-windowed hard cap (fixed 24h window). */
  perDay?: number;
}

export const OPERATION_LIMITS: Record<OperationClass, OperationLimit> = {
  recall: { perMinute: 600 }, // hot read path — spec §478
  write: { perMinute: 120 }, // remember/forget/patch — spec §479
  // LIFECYCLE-16: transcript turns (POST /session/:id/turn) are many, small and
  // arrive in bursts (a harness flushing a session at its end). In the write
  // bucket a 55-turn flush took 35 × 429 and starved the caller's real writes.
  turn: { perMinute: 600 },
  export: { perDay: 10 }, // bulk dump — spec §480 (DAY window)
  admin: { perMinute: 30 }, // management ops — spec §481
  federation: { perMinute: 60 }, // peer sync — spec §482
  // Fallback for everything else (non-recall GETs, misc). Mirrors the legacy
  // single-bucket free-plan rps so unclassified traffic keeps its old budget.
  other: { perMinute: 600 },
};

/** §478-485 session-concurrency cap (10 concurrent per actor). */
export const SESSION_CONCURRENCY_LIMIT = 10;

/** A slot frees as soon as one in-flight request finishes: retry after 1 s. */
export const CONCURRENCY_RETRY_AFTER_SECONDS = 1;

/**
 * §478-485 per-operation burst ceiling from the spec. Applied to minute-windowed
 * classes so a single key cannot absorb an entire plan's burst in one shot.
 * recall: 50 req burst; write: 20 req burst. Unspecified classes fall back to
 * the per-minute budget (i.e. no additional ceiling beyond perMinute).
 */
export const SPEC_BURST: Partial<Record<OperationClass, number>> = {
  recall: 50,
  write: 20,
  // LIFECYCLE-16: room for one long session flushed at once, still bounded.
  turn: 100,
};

/**
 * Plan multiplier applied to every per-operation base budget. Anchored to the
 * free-plan rps so the existing per-plan ladder (10 / 100 / 1000 rps) is
 * preserved exactly: free = 1×, pro = 10×, enterprise = 100×.
 */
function planMultiplier(plan: Plan): number {
  return PLAN_LIMITS[plan].rps / PLAN_LIMITS.free.rps;
}

/**
 * Map a request path+method to its rate-limit {@link OperationClass}, by
 * anchored path segments: the route's own prefix decides, never a word that
 * appears later in the path (an id or parameter equal to "recall" must not
 * move an admin route into the never-shed class).
 */
export function operationClass(path: string, method: string): OperationClass {
  const [first, second, third, ...rest] = path.split("/").filter(Boolean);
  if (first === "recall") return "recall";
  if (first === "session" && third === "collapse" && rest.length === 0) return "recall";
  // POST /session/:id/turn only.
  if (method === "POST" && first === "session" && third === "turn" && rest.length === 0)
    return "turn";
  if (first === "export" || (first === "admin" && second === "export")) return "export";
  if (first === "admin") return "admin";
  if (first === "federation" || (first === "memory" && second === "federation"))
    return "federation";
  if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE")
    return "write";
  return "other"; // non-recall GETs
}

/** Route classes for the fleet shedder (spec lines 3995–4001), from {@link operationClass}. */
type RouteClass = "critical" | "important" | "normal";
function classify(path: string, method: string): RouteClass {
  const op = operationClass(path, method);
  if (op === "recall") return "critical";
  if (op === "export" || op === "admin" || op === "federation") return "normal";
  return "important";
}
/** Fleet utilization thresholds above which a class is shed. critical is never shed. */
const FLEET_SHED_THRESHOLD: Record<RouteClass, number> = {
  critical: 1.01,
  important: 0.85,
  normal: 0.7,
};

export interface RateLimitBackend {
  /** Layer 1: token bucket. Atomic in Redis (Lua). */
  consumeToken(
    key: string,
    rps: number,
    burst: number
  ): Promise<{ allowed: boolean; remaining: number; resetSeconds: number }>;
  /** Layer 2: concurrency slot. */
  acquireSlot(key: string, max: number): Promise<{ acquired: boolean; inFlight: number }>;
  releaseSlot(key: string): Promise<void>;
  /** False when Redis is unreachable → middleware fails OPEN. */
  healthy: boolean;
}

export interface RateLimitOptions {
  backend: RateLimitBackend;
  /**
   * Returns current fleet utilization [0,1]. Defaults to 0 (never shed). The
   * server passes `deps.fleetUtil`, the cluster-wide Postgres busy-connection
   * share (index.ts). Server-side signal only: V-2 removed the client-supplied
   * `x-mnemo-fleet-util` header, which let a caller shed its own requests.
   */
  fleetUtil?: (c: { req: { header(n: string): string | undefined } }) => number;
}

export function createRateLimitMiddleware(opts: RateLimitOptions): MiddlewareHandler {
  const { backend } = opts;
  const fleetUtil = opts.fleetUtil ?? (() => 0);

  return async (c, next) => {
    const plan = ((c.get("plan" as never) as string | undefined) ?? "free") as Plan;
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
    const mult = planMultiplier(plan);
    const workspaceId = (c.get("workspaceId" as never) as string | undefined) ?? "anon";
    // §5/§19 "Per-Key": bucket per API key (actorId), not per workspace, so one
    // noisy key can't exhaust the limit for its siblings. Falls back to the
    // workspace when no actor is resolved (e.g. unauthenticated probes).
    const actorId = (c.get("actorId" as never) as string | undefined) ?? workspaceId;

    // §19/§478-485 per-operation matrix: bucket key is scoped by operation
    // class so recall, write, export, admin and federation each draw from an
    // independent budget. One class exhausting its bucket can't shed another.
    const opClass = operationClass(c.req.path, c.req.method);
    const opLimit = OPERATION_LIMITS[opClass];
    const key = `rl:${workspaceId}:${actorId}:${opClass}`;

    // Layer 3 (+ Layer 4 via the same util signal): fleet/worker shedder — in-process, cheap.
    const cls = classify(c.req.path, c.req.method);
    if (fleetUtil(c) >= FLEET_SHED_THRESHOLD[cls]) {
      c.header("Mnemosyne-Rate-Limited-Reason", "fleet_shed");
      c.header("Retry-After", "5");
      return c.json(
        { error: { code: "fleet_shed", message: "Service shedding load; retry shortly" } },
        503
      );
    }

    // FAIL-OPEN: if the Redis backend is known-down, allow everything (spec line 4010).
    if (!backend.healthy) return next();

    // Effective per-operation budget for this plan. Minute-windowed classes map
    // to a continuous token bucket (rps + burst); the day-windowed `export`
    // class maps to a single bucket whose refill rate is the daily cap spread
    // across 86 400s, with burst == the full daily allowance (so a client may
    // spend the whole budget at once, then wait out the day).
    let effRps: number;
    let effBurst: number;
    if (opLimit.perDay !== undefined) {
      const perDay = Math.max(1, Math.round(opLimit.perDay * mult));
      effRps = perDay / 86_400; // tokens regenerate over a 24h window
      effBurst = perDay;
    } else {
      // perMinute is always set when perDay is not (see OPERATION_LIMITS).
      const perMinute = Math.max(1, Math.round((opLimit.perMinute ?? 0) * mult));
      effRps = perMinute / 60;
      // §478-485: spec burst ceiling per operation class. Clients relying on
      // the old perMinute-sized burst are capped at SPEC_BURST for recall (50)
      // and write (20). Unspecified classes keep the full perMinute headroom.
      effBurst = Math.max(1, Math.round((SPEC_BURST[opClass] ?? perMinute) * mult));
    }
    // Advertised limit: rps for minute-windowed classes (back-compat — recall on
    // free plan stays 10, enterprise 1000), the daily cap for export.
    const advertisedLimit =
      opLimit.perDay !== undefined
        ? Math.max(1, Math.round(opLimit.perDay * mult))
        : Math.round(effRps);

    // CHAOS-13: the concurrency slot is taken BEFORE the rate token. In the
    // other order, every request turned away for concurrency had already spent
    // a token, so a burst of concurrency 429s was followed by rate 429s.
    //
    // Layer 2: concurrency slot. Still keyed per (workspace, actor) — this is
    // the §478-485 session-concurrency cap (10 concurrent), an actor-wide limit
    // independent of operation class, so the slot key omits opClass.
    // DEFERRED: a *separate* session-scoped concurrency window (per sessionId
    // rather than per actor) is not implementable here — no per-session
    // in-flight state is exposed to this middleware. Tracked for the session
    // runtime; the actor-wide concurrency cap below is the closest reachable
    // approximation and matches the prior behaviour.
    const concurrencyKey = `rl:${workspaceId}:${actorId}`;
    const concurrencyMax = Math.max(limits.concurrency, SESSION_CONCURRENCY_LIMIT);
    let slot: { acquired: boolean; inFlight: number };
    try {
      slot = await backend.acquireSlot(concurrencyKey, concurrencyMax);
    } catch (err) {
      logger.warn({ err }, "ratelimit.concurrency_slot_error — fail-open, request allowed");
      return next();
    }
    if (!slot.acquired) {
      c.header("Retry-After", String(CONCURRENCY_RETRY_AFTER_SECONDS));
      c.header("Mnemosyne-Rate-Limited-Reason", "concurrency");
      throw new RateLimitedError("Concurrent request limit exceeded", {
        retryAfterSeconds: CONCURRENCY_RETRY_AFTER_SECONDS,
        reason: "concurrency",
      });
    }

    // From here on the slot is ours: every path out releases it, once.
    try {
      // Layer 1: request-rate token bucket (per operation class).
      let token: { allowed: boolean; remaining: number; resetSeconds: number } | null;
      try {
        token = await backend.consumeToken(key, effRps, effBurst);
      } catch (err) {
        logger.warn({ err }, "ratelimit.token_bucket_error — fail-open, request allowed");
        token = null;
      }
      if (token) {
        c.header("X-RateLimit-Limit", String(advertisedLimit));
        c.header("X-RateLimit-Remaining", String(Math.max(0, token.remaining)));
        c.header("X-RateLimit-Reset", String(token.resetSeconds));
        c.header("Mnemosyne-Rate-Limit-Operation", opClass);
        if (!token.allowed) {
          // CLIENTS-7: the wait is the bucket's own refill time. It travels on
          // the error too, so the error handler can keep it (instead of a flat
          // 60 s) and put it in the error envelope.
          c.header("Retry-After", String(token.resetSeconds));
          c.header("Mnemosyne-Rate-Limited-Reason", "request_rate");
          throw new RateLimitedError("Request rate limit exceeded", {
            retryAfterSeconds: token.resetSeconds,
            reason: "request_rate",
          });
        }
      }
      await next();
    } finally {
      backend.releaseSlot(concurrencyKey).catch(() => undefined);
    }
  };
}
