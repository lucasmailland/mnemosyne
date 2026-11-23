import type { MiddlewareHandler } from "hono";
import { LRUCache } from "lru-cache";
import { evaluateAccess, type AccessRequest } from "@mnemo-ai/core";
import type {
  AccessPolicyStore,
  ApprovalStore,
  BreakGlassStore,
  AccessPolicyRecord,
  ApprovalTrigger,
  CacheAdapter,
  SpecScope,
} from "@mnemo-ai/types";
import { APPROVAL_PENDING_TTL_MS } from "@mnemo-ai/types";
import { ForbiddenError, RateLimitedError } from "../errors.js";
import { logger } from "../logging.js";
import type { AuthVariables } from "../auth.js";

export interface RbacDeps {
  accessPolicies: AccessPolicyStore;
  approvals: ApprovalStore;
  /**
   * WP8 (F10) SOC2 break-glass two-person approval. When present, a privileged
   * mk_admin_ operation (scope ≠ memory:read) requires a prior approved,
   * unexpired, unused break-glass grant filed by this admin and approved by a
   * DIFFERENT admin. Absent → mk_admin_ privileged ops fail CLOSED (403) so a
   * misconfigured deployment cannot silently bypass dual control. Non-admin
   * keys and read ops are never gated by break-glass.
   */
  breakGlass?: BreakGlassStore;
  policyTtlMs?: number;
  /**
   * §19 per-agent rate limits (policy.limits.*). A fixed-window counter store
   * (Redis INCR+EXPIRE). When absent, per-agent limits are NOT enforced
   * (fail-open) — the per-plan token-bucket limiter still protects the service.
   */
  rateCounter?: { incrWithTtl(key: string, ttlSeconds: number): Promise<number> };
  /**
   * §19 concurrent-session probe. When absent, maxSessionsConcurrent is NOT
   * enforced (fail-open). Injected by the server bootstrap for Redis-backed
   * session stores; absent in tests unless explicitly provided.
   */
  activeSessions?: { countActive(workspaceId: string, actorId: string): Promise<number> };
  /** Injectable clock (ms) for deterministic tests; defaults to Date.now. */
  now?: () => number;
  /**
   * When true, agents with no explicit policy are DENIED instead of allowed.
   * Set via env MNEMO_RBAC_DEFAULT_DENY=true for zero-trust deployments.
   * Default: false (open — agents without a policy pass through unrestricted).
   */
  defaultDeny?: boolean;
}

export function triggerFor(method: string, path: string): ApprovalTrigger | undefined {
  // Crypto-erasure destroys every key of a subject: at least the gate of a single delete.
  if (path.includes("/admin/erasure")) return "delete_fact";
  // APP-031: /forget/:kind/:id is the delete the SDK and MCP use.
  if (method === "DELETE" && (path.includes("/facts") || /\/forget\//.test(path))) return "delete_fact";
  if (method === "PUT" && path.includes("/decisions")) return "overwrite_decision";
  if ((method === "POST" || method === "PATCH") && path.includes("/entities"))
    return "write_entity";
  if (path.includes("/export")) return "bulk_export";
  if (path.includes("/federation")) return "federation_share";
  if (path.includes("/procedural") || path.includes("/self-edit") || path.includes("/self/edit"))
    return "procedural_evolution";
  if (path.includes("/delegate")) return "task_delegation";
  return undefined;
}

/**
 * WP8 (F10): a mk_admin_ request is "privileged" (and therefore subject to the
 * break-glass two-person gate) when its §6 scope is anything other than a pure
 * read. Reads are never gated — break-glass is about destructive / governance /
 * export elevation, not lookups. Single tuning point for the privileged-op
 * boundary; forward reference to scopeFor is safe because JS hoists function
 * declarations.
 */
export function isPrivilegedBreakGlassOp(method: string, path: string): boolean {
  return scopeFor(method, path) !== "memory:read";
}

export function scopeFor(method: string, path: string): SpecScope {
  if (path.includes("/admin/harness/")) return "memory:admin";
  if (path.includes("/admin/erasure")) return "memory:hard_delete";
  if (path.includes("/recall")) return "memory:read";
  // APP-005: same rule as app-scope.ts. Changing a webhook endpoint is an operator decision.
  if (method !== "GET" && /\/webhooks(\/|$)/.test(path)) return "memory:admin";
  if (method === "DELETE")
    return path.endsWith("/hard") || path.includes("/hard")
      ? "memory:hard_delete"
      : "memory:delete";

  // Granular write families (checked before the GET→read / generic write fallbacks).
  // export is read-or-write but is its own scope; check it regardless of method.
  if (path.includes("/export")) return "memory:export";
  if (path.includes("/harness/v1/")) return "memory:session";
  if (path.includes("/tasks")) return "memory:task";
  if (path.includes("/events")) return "memory:event";
  if (path.includes("/self/edit") || path.includes("/self-edit")) return "memory:self_edit";
  if (
    path.includes("/procedural") ||
    path.includes("/workflows") ||
    path.includes("/skills") ||
    path.includes("/strategies")
  )
    return "memory:procedural";
  if (path.includes("/reasoning")) return "memory:reasoning";
  if (path.includes("/sessions")) return "memory:session";
  // APP-076: the session routes are /session/* (singular); /sessions is an alias.
  if (method !== "GET" && SESSION_ROUTE.test(path)) return "memory:session";
  if (path.includes("/governance")) return "memory:governance";
  if (path.includes("/federation")) return "memory:federation";
  if (path.includes("/subscribe") || path.includes("/watch") || path.includes("/stream"))
    return "memory:subscribe";

  if (method === "GET") return "memory:read";
  return "memory:write";
}

const SESSION_ROUTE = /\/session(\/|$)/;

/**
 * The scopes a policy may grant for this request, any one sufficing: the same
 * any-of app-scope.ts applies to the key's scopes. A /session/* write accepts
 * memory:session, or memory:write for policies written before that scope
 * decided those routes (re-audit 2026-11-22).
 */
export function policyScopesFor(method: string, path: string): SpecScope[] {
  const scope = scopeFor(method, path);
  return scope === "memory:session" && SESSION_ROUTE.test(path)
    ? ["memory:session", "memory:write"]
    : [scope];
}

// ── gRPC parity helpers (pure) ──────────────────────────────────────────────
// The Connect transport has no HTTP method/path, so it cannot reuse
// scopeFor/triggerFor. These map an RPC method name onto the same §6 scope and
// §19 approval-trigger vocabulary the HTTP path enforces, so the gRPC
// interceptor can run the identical evaluateAccess() decision. Kept as pure
// functions (no Connect/Hono imports) so grpc.ts can import them without a
// cycle. Method names are the proto RPC names (HandlerContext/req.method.name).

/**
 * §6 scope an RPC requires for the §19 policy decision. This is the RBAC
 * action-scope (read vs write/delete), distinct from the coarse API-key scope
 * gate; the two agree by construction (e.g. Forget → memory:delete in both).
 */
export function rpcScopeFor(method: string): SpecScope {
  switch (method) {
    case "Recall":
    case "GetHealth":
      return "memory:read";
    case "ResolveReasoning":
    case "RecordReasoning":
      return "memory:reasoning";
    case "WatchMemory":
    case "WatchTasks":
    case "StreamHealth":
      return "memory:subscribe";
    case "Forget":
      return "memory:delete";
    case "CreateTask":
    case "UpdateTask":
      return "memory:task";
    case "RecordEvent":
      return "memory:event";
    case "SelfEdit":
      return "memory:self_edit";
    case "Session":
      return "memory:session";
    case "IngestBatch":
    case "ImportMemory":
      return "memory:export";
    case "FederationSync":
      return "memory:federation";
    default:
      return "memory:write";
  }
}

/** RBAC action ("read" | "write") for an RPC — read RPCs map to "read". */
export function rpcActionFor(method: string): "read" | "write" {
  return rpcScopeFor(method) === "memory:read" ? "read" : "write";
}

/**
 * §19 approval trigger for an RPC, or undefined when none applies. Mirrors
 * triggerFor(): destructive deletes, bulk imports/exports, and federation
 * sync are the operations the HTTP path gates behind human approval.
 */
export function rpcTriggerFor(method: string): ApprovalTrigger | undefined {
  switch (method) {
    case "Forget":
      return "delete_fact";
    // IngestBatch / ImportMemory are the gRPC bulk-write surface — same class
    // as the HTTP /export gate (bulk_export trigger).
    case "IngestBatch":
    case "ImportMemory":
      return "bulk_export";
    case "FederationSync":
      return "federation_share";
    default:
      return undefined;
  }
}

/** True for RPCs that cross the federation boundary (FederationSync). */
export function rpcIsFederation(method: string): boolean {
  return method === "FederationSync";
}

// Every live policy cache in this process, so a write through the admin
// routes takes effect here at once.
const policyCaches = new Set<LRUCache<string, { policy: AccessPolicyRecord | null }>>();

/**
 * Redis pub/sub channel that carries policy invalidations between replicas.
 * The message is JSON `{ workspaceId, actorId }`; it is a wire contract across
 * replicas of different versions during a rolling deploy, so keep it stable.
 */
export const POLICY_INVALIDATION_CHANNEL = "mnemo:rbac:policy-invalidate";

type PolicyChannel = Required<Pick<CacheAdapter, "publish" | "subscribe">>;
let policyChannel: PolicyChannel | undefined;

function dropLocalPolicy(workspaceId: string, actorId: string): void {
  for (const cache of policyCaches) cache.delete(`${workspaceId}::${actorId}`);
}

/**
 * Join the cross-replica invalidation channel: from now on every
 * invalidateAgentPolicy() here is published, and every one published by
 * another replica drops the cached policy here. Without Redis the other
 * replicas learn of the write from pollPolicyChanges within about a second.
 */
export async function connectPolicyInvalidation(channel: PolicyChannel): Promise<void> {
  await channel.subscribe(POLICY_INVALIDATION_CHANNEL, (message) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    const { workspaceId, actorId } = (parsed ?? {}) as Record<string, unknown>;
    if (typeof workspaceId === "string" && typeof actorId === "string") {
      dropLocalPolicy(workspaceId, actorId);
    }
  });
  policyChannel = channel;
}

/**
 * Drop one agent's cached policy in this process and, when the replicas share
 * a channel, in every other one (called after an admin write). A publish
 * failure is logged, not thrown: the write is already committed, and the
 * other replicas fall back to the cache TTL.
 */
export async function invalidateAgentPolicy(workspaceId: string, actorId: string): Promise<void> {
  dropLocalPolicy(workspaceId, actorId);
  if (!policyChannel) return;
  try {
    await policyChannel.publish(
      POLICY_INVALIDATION_CHANNEL,
      JSON.stringify({ workspaceId, actorId })
    );
  } catch (err) {
    logger.warn({ err, workspaceId, actorId }, "rbac.policy_invalidation_publish_failed");
  }
}

/** A policy write as the database records it (migration 0067). */
export interface PolicyChange {
  seq: number;
  workspaceId: string;
  agentId: string;
}

/**
 * Poll the policy change log and drop each changed policy here: the channel
 * that works without Redis, and through pgBouncer in transaction mode, where
 * LISTEN/NOTIFY does not. `readChanges(cursor)` returns the rows after the
 * cursor plus the last few seconds again (a lower seq can commit after a
 * higher one was read); a row already handled is not dropped twice. It runs
 * with Redis too: pub/sub is at-most-once, so a replica that was reconnecting
 * when a write was published still drops the policy within a poll.
 * A failed poll is retried on the next tick; the cache TTL still bounds staleness.
 */
export function pollPolicyChanges(
  readChanges: (afterSeq: number) => Promise<PolicyChange[]>,
  intervalMs = 1_000
): { stop(): void; tick(): Promise<void> } {
  let cursor = 0;
  let seen = new Set<number>();
  let running = false;
  let failing = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const rows = await readChanges(cursor);
      for (const r of rows) {
        if (!seen.has(r.seq)) dropLocalPolicy(r.workspaceId, r.agentId);
        cursor = Math.max(cursor, r.seq);
      }
      seen = new Set(rows.map((r) => r.seq));
      failing = false;
    } catch (err) {
      // Once per outage, not once a second.
      if (!failing) logger.warn({ err }, "rbac.policy_change_poll_failed");
      failing = true;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}

/**
 * What an approval is bound to: the path plus its query string, parameters
 * sorted. The bare path let a soft DELETE /forget/fact/X approval redeem
 * ?mode=hard (re-audit 2026-11-22). An approval stored before this carries the
 * bare path, which still equals the target of the same request without a query
 * and of nothing else: it stays usable for what it most likely approved, never
 * for a request with parameters it did not see.
 */
export function approvalTarget(url: string): string {
  const { pathname, searchParams } = new URL(url);
  searchParams.sort();
  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function createRbacMiddleware(
  deps: RbacDeps
): MiddlewareHandler<{ Variables: AuthVariables }> {
  // Wrap nullable policy in an object so lru-cache (which requires non-null values) can cache "no policy" results.
  const cache = new LRUCache<string, { policy: AccessPolicyRecord | null }>({
    max: 10_000,
    ttl: deps.policyTtlMs ?? 60_000,
  });
  policyCaches.add(cache);

  return async (c, next) => {
    const workspaceId = c.get("workspaceId");
    const actorId = c.get("actorId") ?? "unknown";
    const userId = c.get("userId" as never) as string | null | undefined;
    const method = c.req.method;
    const path = c.req.path;

    // Approval meta-requests are exempt from RBAC (they are control-plane, not data-plane)
    if (path.includes("/approvals/")) return next();
    // Break-glass meta-requests (file/approve) are control-plane too.
    if (path.includes("/break-glass")) return next();

    // ── WP8 (F10) SOC2 break-glass two-person gate ───────────────────────────
    // A mk_admin_ break-glass key may NOT perform a privileged op alone: a
    // second, distinct admin must have approved a still-valid grant first.
    // Dual control is keyed on the HUMAN (userId), never the credential
    // (actorId) — see routes/break-glass.ts for the matching fix on the
    // request/approve side. An unbound mk_admin_ key fails closed here too.
    const keyPrefix = c.get("apiKeyPrefix");
    if (keyPrefix === "mk_admin_" && isPrivilegedBreakGlassOp(method, path)) {
      // Fail CLOSED when the store is not wired — never silently bypass dual control.
      if (!deps.breakGlass) {
        throw new ForbiddenError(
          "break-glass approval unavailable: mk_admin_ privileged operations require a two-person grant"
        );
      }
      if (!userId) {
        throw new ForbiddenError("break-glass requires a user-bound mk_admin_ key");
      }
      const grant = await deps.breakGlass.getActiveApproved(workspaceId, userId);
      if (!grant) {
        // 202 when a request is pending (awaiting a second admin); 403 otherwise.
        const pendingId = c.req.header("x-mnemo-break-glass-id") ?? "";
        const pending = pendingId ? await deps.breakGlass.get(workspaceId, pendingId) : null;
        if (pending && pending.status === "pending" && pending.requestedBy === userId) {
          return c.json(
            {
              status: "pending_second_admin_approval",
              break_glass_request_id: pending.id,
              poll: `/break-glass/${pending.id}`,
            },
            202
          );
        }
        throw new ForbiddenError(
          "break-glass: a second admin must approve before this privileged operation is permitted"
        );
      }
      // Single-use: consume the grant so it cannot be replayed for a later op.
      await deps.breakGlass.markUsed(workspaceId, grant.id);
      return next();
    }

    const cacheKey = `${workspaceId}::${actorId}`;
    let cached = cache.get(cacheKey);
    if (cached === undefined) {
      const policy = await deps.accessPolicies.getPolicy(workspaceId, actorId);
      cached = { policy };
      cache.set(cacheKey, cached);
    }
    const policy = cached.policy;
    // No policy for this agent → allow (default) or deny (MNEMO_RBAC_DEFAULT_DENY)
    if (!policy) {
      if (deps.defaultDeny)
        throw new ForbiddenError("No RBAC policy found for this agent (default-deny mode active).");
      return next();
    }

    const trigger = triggerFor(method, path);
    const isRead = method === "GET" || path.includes("/recall");
    const targetAgent = c.req.header("x-mnemo-target-agent");
    const effectiveTrigger: ApprovalTrigger | undefined =
      isRead && targetAgent && targetAgent !== actorId ? "cross_agent_read" : trigger;
    // §19 namespace policies: the agent declares the namespace it is acting in via
    // the x-mnemo-namespace header (or ?namespace=). evaluateAccess enforces the
    // policy's namespace allow-list only when req.namespace is set — previously it
    // was never populated, so namespace allow-lists were a no-op.
    const namespace = c.req.header("x-mnemo-namespace") ?? c.req.query("namespace") ?? undefined;
    const accepted = policyScopesFor(method, path);
    const granted = isRead ? policy.readScopes : policy.writeScopes;
    const scope = accepted.find((s) => granted.includes(s)) ?? accepted[0]!;
    const req: AccessRequest = {
      scope,
      action: isRead ? "read" : "write",
      trigger: effectiveTrigger,
      federation: path.includes("/federation"),
      ...(namespace ? { namespace } : {}),
    };

    // §19 per-agent rate limits: a fixed 60s-window counter keyed by
    // (workspace, actor, metric). maxRecallsPerMinute gates reads;
    // maxWritesPerMinute gates writes. limit <= 0 means "unlimited". The
    // counter is best-effort: any store outage fails open (spec §35 line 4010),
    // never hard-blocking traffic on a limiter hiccup.
    const limits = policy.limits;
    const limit = req.action === "read" ? limits?.maxRecallsPerMinute : limits?.maxWritesPerMinute;
    if (deps.rateCounter && typeof limit === "number" && limit > 0) {
      const metric = req.action === "read" ? "recall" : "write";
      const nowMs = deps.now ? deps.now() : Date.now();
      const windowKey = `mnemo:rl:agent:${workspaceId}:${actorId}:${metric}:${Math.floor(nowMs / 60_000)}`;
      let count: number | undefined;
      try {
        count = await deps.rateCounter.incrWithTtl(windowKey, 60);
      } catch {
        count = undefined; // counter unavailable → fail open
      }
      if (count !== undefined) {
        const resetSeconds = Math.max(1, 60 - Math.floor((nowMs % 60_000) / 1000));
        c.header("X-RateLimit-Limit", String(limit));
        c.header("X-RateLimit-Remaining", String(Math.max(0, limit - count)));
        c.header("X-RateLimit-Reset", String(resetSeconds));
        if (count > limit) {
          c.header("Retry-After", String(resetSeconds));
          c.header("Mnemosyne-Rate-Limited-Reason", `agent_${metric}_per_minute`);
          throw new RateLimitedError(`Per-agent ${metric} rate limit exceeded (${limit}/min)`);
        }
      }
    }

    // §19 maxSelfEditsPerSession: per-session self-edit counter (24 h window).
    if (
      deps.rateCounter &&
      (method === "POST" || method === "PATCH") &&
      path.includes("/self/edit")
    ) {
      const sessionId = c.req.header("x-mnemo-session-id") ?? c.req.query("sessionId");
      const editLimit = limits?.maxSelfEditsPerSession;
      if (sessionId && typeof editLimit === "number" && editLimit > 0) {
        const key = `mnemo:rl:selfedit:${workspaceId}:${actorId}:${sessionId}`;
        let count: number | undefined;
        try {
          count = await deps.rateCounter.incrWithTtl(key, 86_400);
        } catch {
          count = undefined; // counter unavailable → fail open
        }
        if (count !== undefined && count > editLimit) {
          c.header("Mnemosyne-Rate-Limited-Reason", "agent_self_edits_per_session");
          throw new RateLimitedError(`Per-session self-edit limit exceeded (${editLimit}/session)`);
        }
      }
    }

    // §19 maxSessionsConcurrent: gate new session creation.
    // POST /sessions is an alias of POST /session/start, the route that creates one.
    if (deps.activeSessions && method === "POST" && /\/(sessions\/?|session\/start)$/.test(path)) {
      const sessLimit = limits?.maxSessionsConcurrent;
      if (typeof sessLimit === "number" && sessLimit > 0) {
        let active: number | undefined;
        try {
          active = await deps.activeSessions.countActive(workspaceId, actorId);
        } catch {
          active = undefined; // probe unavailable → fail open
        }
        if (active !== undefined && active >= sessLimit) {
          c.header("Mnemosyne-Rate-Limited-Reason", "agent_sessions_concurrent");
          throw new RateLimitedError(`Concurrent session limit exceeded (${sessLimit})`);
        }
      }
    }

    // APP-007: the policy's own deny comes first; an approval never overrides it.
    const decision = evaluateAccess(policy, req);
    if (decision.decision === "deny") throw new ForbiddenError(decision.reason);

    const approvalId = c.req.header("x-mnemo-approval-id");
    if (approvalId) {
      const ar = await deps.approvals.get(workspaceId, approvalId);
      if (ar && ar.status === "denied") throw new ForbiddenError("approval denied");
      if (ar && ar.status !== "pending") {
        // An approval lets through the one request it was granted for: same
        // trigger, same user, same method and path, before it expires, once.
        // It used to be accepted for any matching trigger, by anyone, forever.
        const spent =
          ar.status === "approved" &&
          ar.trigger === effectiveTrigger &&
          !!userId &&
          (await deps.approvals.consume(workspaceId, approvalId, {
            requestedBy: userId,
            method,
            path: approvalTarget(c.req.url),
          }));
        if (!spent) {
          throw new ForbiddenError(
            "this approval does not cover this request: it was already used, has expired, or was granted for another request or user"
          );
        }
        return next();
      }
    }
    if (decision.decision === "approval_required") {
      // requestedBy must match the userId space that /approvals/:id/resolve
      // compares against (see routes/approvals.ts) — an actorId here would
      // make the self-approval guard permanently blind (the requester's
      // credential id would never equal the resolver's userId).
      if (!userId) {
        throw new ForbiddenError("this action requires approval, which requires a user-bound key");
      }
      const ar = await deps.approvals.create({
        workspaceId,
        requestedBy: userId,
        trigger: decision.trigger,
        resource: path.split("/").filter(Boolean)[1] ?? "unknown",
        payload: { method, path: approvalTarget(c.req.url) },
        expiresAt: new Date(Date.now() + APPROVAL_PENDING_TTL_MS),
      });
      return c.json(
        { approval_request_id: ar.id, status: "pending", poll: `/approvals/${ar.id}` },
        202
      );
    }
    return next();
  };
}
