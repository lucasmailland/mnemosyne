import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { ConflictError, UnprocessableEntityError } from "./errors.js";

/**
 * Result of attempting to claim an idempotency key.
 *  - "new"      → first request; caller executes and complete()s.
 *  - "replay"   → a completed response exists; return it verbatim.
 *  - "in_flight"→ a concurrent request holds the key (SERIALIZABLE collision) → 409.
 *  - "mismatch" → key reused with a different request hash → 422.
 */
export type BeginResult =
  | { state: "new" }
  | { state: "replay"; responseCode: number; responseBody: string }
  | { state: "in_flight" }
  | { state: "mismatch" };

/**
 * Stripe-pattern recovery points for multi-phase mutating ops (spec §Idempotency
 * RDD9 lines 3954-3964). Kept structurally identical to the @mnemo-ai/types copy
 * so DrizzleIdempotencyStore (which implements the types port) is assignable here.
 */
export const RECOVERY_POINTS = [
  "started",
  "session_locked",
  "llm_called",
  "facts_persisted",
  "completed",
] as const;
export type RecoveryPoint = (typeof RECOVERY_POINTS)[number];

export interface IdempotencyStore {
  /** Atomically claim the key. MUST run under SERIALIZABLE so concurrent dupes collide. */
  begin(workspaceId: string, key: string, requestHash: string): Promise<BeginResult>;
  /** Persist the final response for future replays. Sets recovery_point='completed'. */
  complete(workspaceId: string, key: string, responseCode: number, responseBody: string): Promise<void>;
  /** Advance the recovery point for an in-flight key (idempotent; no-op if absent). */
  recordPhase(workspaceId: string, key: string, phase: RecoveryPoint): Promise<void>;
  /** Read the current recovery point, or null if the key is unknown. */
  getRecoveryPoint(workspaceId: string, key: string): Promise<RecoveryPoint | null>;
}

export interface IdempotencyOptions {
  store: IdempotencyStore;
  /** Override the request-hash function (used in tests). */
  hashRequest?: (method: string, path: string, body: string) => string;
}

/** Only these methods are protected. GET/HEAD/OPTIONS are naturally idempotent. */
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function createIdempotencyMiddleware(opts: IdempotencyOptions): MiddlewareHandler {
  const { store } = opts;
  const hashRequest =
    opts.hashRequest ??
    ((method: string, path: string, body: string) =>
      createHash("sha256").update(`${method}\n${path}\n${body}`).digest("hex"));

  return async (c, next) => {
    const key = c.req.header("Idempotency-Key");
    if (!key || !MUTATING.has(c.req.method)) return next();

    const workspaceId = c.get("workspaceId" as never) as string | undefined;
    if (!workspaceId) return next(); // no workspace yet → idempotency is meaningless

    // Read the raw body once; Hono caches the clone so the route can re-read it.
    const body = await c.req.raw.clone().text();
    const requestHash = hashRequest(c.req.method, c.req.path, body);

    const begun = await store.begin(workspaceId, key, requestHash);
    if (begun.state === "replay") {
      c.header("Idempotent-Replayed", "true");
      return c.body(begun.responseBody, begun.responseCode as 200, {
        "Content-Type": "application/json",
      });
    }
    if (begun.state === "in_flight") {
      throw new ConflictError("A request with this Idempotency-Key is already in progress");
    }
    if (begun.state === "mismatch") {
      throw new UnprocessableEntityError("Idempotency-Key reused with a different request");
    }

    // state === "new". Expose the key, the current recovery point, and a phase
    // recorder on the context so multi-phase route handlers (e.g. session
    // collapse) can mark progress (spec §RDD9 lines 3954-3966) and resume a
    // crashed-then-retried op from its last completed phase. GET/HEAD never
    // reach here (MUTATING guard above), so these vars are only set for the
    // long mutating ops that need them.
    const recoveryPoint = await store.getRecoveryPoint(workspaceId, key);
    c.set("idempotencyKey" as never, key as never);
    c.set("idempotencyRecoveryPoint" as never, (recoveryPoint ?? "started") as never);
    c.set(
      "idempotencyRecordPhase" as never,
      ((phase: RecoveryPoint) => store.recordPhase(workspaceId, key, phase)) as never,
    );

    // Execute, then record the response for future replays (sets recovery_point='completed').
    await next();
    const resBody = await c.res.clone().text();
    await store.complete(workspaceId, key, c.res.status, resBody);
  };
}
