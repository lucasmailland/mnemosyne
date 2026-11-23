import { managedCollapseOperationId, formatActorRef } from "@mnemo-ai/types";
import type { AuditLogEntry } from "@mnemo-ai/types";
import { buildCollapseAuditDetail } from "./routes/_collapsePhases.js";
import { sessTurnsKey, sessScratchKey, sessActiveKey } from "@mnemo-ai/core";
import type {
  CacheAdapter,
  MnemoBusEvent,
  MnemoEventType,
  OutboxAdapter,
  StorageAdapter,
} from "@mnemo-ai/types";
import type {
  AuthContext,
  ManagedCollapsePlan,
  ManagedCollapseCommitResult,
  ManagedEffectClaim,
  ManagedSessionLifecyclePort,
  MnemoSession,
} from "@mnemo-ai/types";
import type { PrepareManagedCollapseInput } from "@mnemo-ai/core";
import { redactForEgress } from "./webhookDispatch.js";

// Re-exported, not redeclared: a local copy silently narrowed effectKind back to
// the plan's kinds and dropped the claim-only ones the queue actually carries.
export type { ManagedEffectClaim } from "@mnemo-ai/types";
export interface ManagedWorkerStorage extends Pick<
  ManagedSessionLifecyclePort,
  "claimManagedSessions" | "listManagedCollapseTurns" | "markManagedCollapseRetry"
> {
  heartbeatManagedCollapseLease(input: {
    workspaceId: string;
    sessionId: string;
    operationId: string;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<boolean>;
  commitManagedCollapse(input: {
    workspaceId: string;
    sessionId: string;
    operationId: string;
    generation: number;
    leaseOwner: string;
    plan: ManagedCollapsePlan;
  }): Promise<ManagedCollapseCommitResult>;
}
export interface ManagedEffectsStorage {
  claimManagedCollapseEffects(input: {
    workspaceId: string;
    leaseOwner: string;
    limit: number;
    leaseMs: number;
  }): Promise<ManagedEffectClaim[]>;
  completeManagedCollapseEffect(input: {
    workspaceId: string;
    id: string;
    leaseOwner: string;
  }): Promise<boolean>;
  retryManagedCollapseEffect(input: {
    workspaceId: string;
    id: string;
    leaseOwner: string;
    error: string;
    baseRetryMs: number;
    maxRetryMs: number;
  }): Promise<boolean>;
}
export interface ManagedWorkerOptions {
  workspaceId: string;
  leaseOwner: string;
  limit: number;
  leaseMs: number;
  inactivityMs: number;
  provisionalGraceMs: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
}
export type ManagedWorkerTally = {
  claimed: number;
  collapsed: number;
  archived: number;
  retryable: number;
  stale: number;
};

export type CollapseAuditSink = (entry: Omit<AuditLogEntry, "id" | "createdAt">) => unknown;
type AuditInput = Parameters<typeof buildCollapseAuditDetail>[0];
export type CollapseAttemptOutcome = Pick<AuditInput, "outcome" | "result" | "error">;

export async function emitCollapseAttemptAudit(
  sink: CollapseAuditSink | undefined,
  i: AuditInput & { workspaceId: string; sessionId: string }
): Promise<void> {
  if (!sink) return;
  await Promise.resolve()
    .then(() =>
      sink({
        workspaceId: i.workspaceId,
        actorId: formatActorRef("system", "collapse"),
        actorType: "system",
        action: "session_close",
        resourceKind: "session",
        resourceId: i.sessionId,
        isTerminal: false,
        detail: buildCollapseAuditDetail(i),
      })
    )
    .catch(() => undefined);
}

function capturedAuth(session: MnemoSession): AuthContext {
  // Preparation validates these fields. Never replace them with worker identity.
  return {
    workspaceId: session.workspaceId,
    actorId: session.originActorId ?? "",
    actorType: session.originActorType!,
    userId: session.originUserId ?? null,
    maxSensitivity: session.originSensitivityCeiling ?? undefined,
    scopes: ["memory:read", "memory:write", "memory:session"],
    sessionId: session.id,
  };
}

/** One bounded tick. Claim/heartbeat/commit/retry own their short transactions;
 * prepare is deliberately invoked after claim resolves, with no transaction held. */
export async function runManagedSessionWorker(
  options: ManagedWorkerOptions,
  deps: {
    storage: ManagedWorkerStorage;
    prepare(input: PrepareManagedCollapseInput, auth: AuthContext): Promise<ManagedCollapsePlan>;
    audit?: CollapseAuditSink;
  }
): Promise<ManagedWorkerTally> {
  const tally: ManagedWorkerTally = {
    claimed: 0,
    collapsed: 0,
    archived: 0,
    retryable: 0,
    stale: 0,
  };
  const claims = await deps.storage.claimManagedSessions({
    ...options,
    limit: Math.min(25, Math.max(1, options.limit)),
  });
  tally.claimed = claims.length;
  await Promise.all(
    claims.map(async ({ session, leaseOwner }) => {
      const fence = {
        workspaceId: options.workspaceId,
        sessionId: session.id,
        operationId: managedCollapseOperationId(session),
        leaseOwner,
        leaseMs: options.leaseMs,
      };
      const startedAt = Date.now();
      let audit: CollapseAttemptOutcome = { outcome: "failed", error: "attempt_unfinished" };
      const stale = (): void => {
        tally.stale++;
        audit = { outcome: "failed", error: "lease_lost" };
      };
      let leaseLost = false;
      let pendingHeartbeat: Promise<boolean> | undefined;
      const heartbeat = async (): Promise<boolean> => {
        if (leaseLost) return false;
        if (pendingHeartbeat) return pendingHeartbeat;
        pendingHeartbeat = deps.storage.heartbeatManagedCollapseLease(fence).catch(() => false);
        const valid = await pendingHeartbeat;
        pendingHeartbeat = undefined;
        if (!valid) leaseLost = true;
        return valid;
      };
      const timer = setInterval(
        () => {
          void heartbeat();
        },
        Math.max(100, Math.floor(options.leaseMs / 3))
      );
      timer.unref?.();
      try {
        const turns = await deps.storage.listManagedCollapseTurns(session.id, options.workspaceId);
        let plan: ManagedCollapsePlan;
        try {
          plan = await deps.prepare({ session, turns }, capturedAuth(session));
        } catch {
          plan = {
            status: "retryable",
            reason: "preparation_unavailable",
            operationId: fence.operationId,
            workspaceId: options.workspaceId,
            sessionId: session.id,
            generation: session.sourceGeneration ?? -1,
            sourceMessageIds: [],
          };
        }
        // Heartbeat is also a fence after slow preparation. A takeover must prevent
        // BOTH commit and retry metadata from the stale process.
        if (!(await heartbeat())) {
          stale();
          return;
        }
        if (plan.status === "retryable") {
          const marked = await deps.storage.markManagedCollapseRetry({
            workspaceId: options.workspaceId,
            sessionId: session.id,
            leaseOwner,
            error: plan.reason,
            baseRetryMs: options.baseRetryMs ?? 1000,
            maxRetryMs: options.maxRetryMs ?? 300_000,
          });
          if (marked) {
            tally.retryable++;
            audit = { outcome: "failed", error: plan.reason };
          } else stale();
          return;
        }
        const result = await deps.storage.commitManagedCollapse({
          workspaceId: options.workspaceId,
          sessionId: session.id,
          operationId: fence.operationId,
          generation: session.sourceGeneration!,
          leaseOwner,
          plan,
        });
        if (result.status === "collapsed") {
          tally.collapsed++;
          audit = { outcome: "completed", result: { episodeId: result.episodeId } };
        } else {
          tally.archived++;
          audit = { outcome: "skipped", result: { skipReason: result.reason } };
        }
      } catch {
        // An expired/reclaimed lease cannot turn into a fresh retry write.
        if (!(await heartbeat())) {
          stale();
          return;
        }
        try {
          const marked = await deps.storage.markManagedCollapseRetry({
            workspaceId: options.workspaceId,
            sessionId: session.id,
            leaseOwner,
            error: "commit_unavailable",
            baseRetryMs: options.baseRetryMs ?? 1000,
            maxRetryMs: options.maxRetryMs ?? 300_000,
          });
          if (marked) {
            tally.retryable++;
            audit = { outcome: "failed", error: "commit_unavailable" };
          } else stale();
        } catch {
          stale();
        }
      } finally {
        clearInterval(timer);
        if (pendingHeartbeat) await pendingHeartbeat;
        await emitCollapseAttemptAudit(deps.audit, {
          workspaceId: options.workspaceId,
          sessionId: session.id,
          operationId: fence.operationId,
          attempt: (session.collapseAttempts ?? 0) + 1,
          reason: "managed",
          startedAt,
          ...audit,
        });
      }
    })
  );
  return tally;
}

/** An external executor MUST honor idempotencyKey at the effect destination.
 * Transactional executors atomically apply domain changes and mark completion,
 * returning `atomic`; they must never hide a non-transactional side effect. */
export async function drainManagedCollapseEffects(
  options: { workspaceId: string; leaseOwner: string; limit: number; leaseMs: number },
  deps: {
    storage: ManagedEffectsStorage;
    execute(
      effect: ManagedEffectClaim,
      options: { idempotencyKey: string }
    ): Promise<"atomic" | "external">;
  }
): Promise<{ completed: number; retryable: number; stale: number }> {
  const result = { completed: 0, retryable: 0, stale: 0 };
  const effects = await deps.storage.claimManagedCollapseEffects({
    ...options,
    limit: Math.min(100, Math.max(1, options.limit)),
  });
  for (const effect of effects) {
    try {
      const completion = await deps.execute(effect, { idempotencyKey: effect.id });
      const complete =
        completion === "atomic" ||
        (await deps.storage.completeManagedCollapseEffect({
          workspaceId: effect.workspaceId,
          id: effect.id,
          leaseOwner: effect.leaseOwner,
        }));
      if (complete) result.completed++;
      else result.stale++;
    } catch {
      const retried = await deps.storage
        .retryManagedCollapseEffect({
          workspaceId: effect.workspaceId,
          id: effect.id,
          leaseOwner: effect.leaseOwner,
          error: "effect_unavailable",
          baseRetryMs: 1000,
          maxRetryMs: 300_000,
        })
        .catch(() => false);
      if (retried) result.retryable++;
      else result.stale++;
    }
  }
  return result;
}

/** Ports the production executor needs. Everything is optional: a degraded server
 * (no Redis, no bus) must still drain effects rather than wedge the queue. */
export interface ManagedEffectExecutorDeps {
  context: { cache?: CacheAdapter; config?: { maxHotTierSize?: number } };
  storage: {
    runManagedCollapseEffect?(
      input: { workspaceId: string; id: string; leaseOwner: string },
      apply: (ports: { storage: StorageAdapter; outbox: OutboxAdapter }) => Promise<void>
    ): Promise<boolean>;
  };
  bus?: { emit(event: MnemoBusEvent): void };
  replay?: { record(workspaceId: string, event: MnemoBusEvent & { id: string }): Promise<void> };
  webhookSecretCipher?: { decrypt(workspaceId: string, value: string): string };
  /** Fired at most once per effect id, for terminal-state metrics. */
  onTerminal?(effect: ManagedEffectClaim): void;
}

/** `session.<status>` — the plan's terminal status is the event's subtype, so an
 * archived session is never announced as collapsed. */
function terminalEventType(effect: ManagedEffectClaim): MnemoEventType {
  const status = typeof effect.payload["status"] === "string" ? effect.payload["status"] : "closed";
  return `session.${status}` as MnemoEventType;
}

function terminalPayload(effect: ManagedEffectClaim): Record<string, unknown> {
  // eventId is the effect id: it is the durable, replayable identity a receiver
  // deduplicates on, and it survives redelivery of the same claim.
  return {
    ...effect.payload,
    eventId: effect.id,
    workspaceId: effect.workspaceId,
    sessionId: effect.targetId,
    operationId: effect.operationId,
  };
}

/**
 * The real side-effect executor behind `drainManagedCollapseEffects`.
 *
 * Returns "atomic" only when the effect and its completion were committed in the
 * same transaction; anything else returns "external" so the caller marks the row
 * complete separately. Throwing is how an effect asks to be retried — never
 * swallow a failure here, because the caller reads a normal return as success.
 */
export function createManagedEffectExecutor(deps: ManagedEffectExecutorDeps) {
  const terminalsSeen = new Set<string>();

  return async function executeManagedEffect(
    effect: ManagedEffectClaim,
    _options: { idempotencyKey: string }
  ): Promise<"atomic" | "external"> {
    switch (effect.effectKind) {
      case "session_buffer_cleanup":
      case "redis_cleanup": {
        const cache = deps.context.cache;
        if (!cache) return "external";
        // Deliberately not SessionBuffer.clear: that swallows Redis errors so a
        // live request never fails on cache trouble. Here a swallowed error would
        // acknowledge a cleanup that never happened, so the failure must surface.
        await cache.delete(sessTurnsKey(effect.workspaceId, effect.targetId));
        await cache.delete(sessScratchKey(effect.workspaceId, effect.targetId));
        if (cache.zrem) await cache.zrem(sessActiveKey(effect.workspaceId), effect.targetId);
        return "external";
      }

      case "hot_tier_promotion": {
        const cache = deps.context.cache;
        if (!cache?.applyManagedHotPromotion) return "external";
        // The adapter dedupes on effectId, so a redelivered claim promotes once.
        await cache.applyManagedHotPromotion({
          workspaceId: effect.workspaceId,
          factId: effect.targetId,
          effectId: effect.id,
          maxSize: deps.context.config?.maxHotTierSize ?? 1000,
        });
        return "external";
      }

      case "webhook_delivery": {
        if (typeof deps.storage.runManagedCollapseEffect !== "function") return "external";
        const eventType = terminalEventType(effect);
        const payload = terminalPayload(effect);
        // Fan-out and completion commit together: a webhook_fire row can never
        // outlive a rolled-back completion, nor a completion hide a lost fan-out.
        const committed = await deps.storage.runManagedCollapseEffect(
          { workspaceId: effect.workspaceId, id: effect.id, leaseOwner: effect.leaseOwner },
          async ({ storage, outbox }) => {
            const endpoints = await storage.listWebhookEndpoints(effect.workspaceId);
            for (const endpoint of endpoints) {
              if (!endpoint.isActive) continue;
              if (!endpoint.events.includes(eventType) && !endpoint.events.includes("*")) continue;
              // APP-030 (final review): no secret in the outbox row — the
              // delivery cron resolves it from the endpoint at send time — and
              // the payload leaves through the same egress redaction as
              // webhookDispatch.
              await outbox.append({
                workspaceId: effect.workspaceId,
                eventType: "webhook_fire",
                payload: {
                  webhookId: endpoint.id,
                  workspaceId: effect.workspaceId,
                  url: endpoint.url,
                  eventType,
                  payload: redactForEgress(payload as Record<string, unknown>),
                },
              });
            }
          }
        );
        return committed ? "atomic" : "external";
      }

      case "bus_delivery":
      case "lifecycle_event": {
        const type = terminalEventType(effect);
        // The effect id is the event id: redelivery re-emits the SAME id so a
        // subscriber can discard the duplicate instead of double-counting.
        const event: MnemoBusEvent & { id: string } = {
          id: effect.id,
          channel: type,
          type,
          payload: terminalPayload(effect),
          timestamp: new Date().toISOString(),
          traceId: effect.operationId,
        };
        deps.bus?.emit(event);
        await deps.replay?.record(effect.workspaceId, event).catch(() => undefined);
        // Metrics must not double-count a redelivered claim, even though the
        // event itself is deliberately re-emitted.
        if (!terminalsSeen.has(effect.id)) {
          terminalsSeen.add(effect.id);
          deps.onTerminal?.(effect);
        }
        return "external";
      }

      default:
        // Unknown kinds are drained, not retried forever. Adding a kind means
        // adding a case here.
        return "external";
    }
  };
}

/**
 * Fair, bounded rotation over workspaces for the managed recovery tick.
 *
 * A cron tick must not try every workspace at once, but it also must not always
 * start at the first one, or a deployment with more workspaces than a slice would
 * never reach the tail. The cursor advances by the slice it just served and wraps
 * only after the last workspace, so every workspace is reached in a bounded number
 * of ticks.
 *
 * One failing workspace never blocks the rest: recovery is precisely the path that
 * has to keep running while something is broken.
 */
export function createManagedWorkspaceRotation(deps: {
  listWorkspaceIds(): Promise<string[]>;
  runWorkspace(workspaceId: string): Promise<void>;
  drainWorkspace(workspaceId: string): Promise<void>;
  sliceSize?: number;
  onWorkspaceError?(workspaceId: string, error: unknown): void;
}): () => Promise<void> {
  let cursor = 0;
  const sliceSize = Math.max(1, deps.sliceSize ?? 50);

  return async function runManagedRotation(): Promise<void> {
    const workspaceIds = (await deps.listWorkspaceIds()).slice().sort();
    if (workspaceIds.length === 0) {
      cursor = 0;
      return;
    }
    // A shrinking list must not leave the cursor past the end.
    if (cursor >= workspaceIds.length) cursor = 0;
    const slice = workspaceIds.slice(cursor, cursor + sliceSize);
    cursor = cursor + slice.length >= workspaceIds.length ? 0 : cursor + slice.length;

    for (const workspaceId of slice) {
      try {
        await deps.runWorkspace(workspaceId);
        await deps.drainWorkspace(workspaceId);
      } catch (error) {
        // Never rethrow: the next workspace, and the next tick, still have to run.
        deps.onWorkspaceError?.(workspaceId, error);
      }
    }
  };
}
