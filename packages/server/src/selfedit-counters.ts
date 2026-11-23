/**
 * Shared RDD-7 (§34.7) self-edit worth-operation counters.
 *
 * Hexagonal purity: this module touches ONLY the CacheAdapter port
 * (via ServerDeps["cache"]). It never imports drizzle-orm / pg / redis or any
 * adapter package. When no cache adapter is wired the readers return 0 and the
 * bumpers are no-ops — degraded mode, identical semantics to the existing gRPC
 * edits/deletes helpers in grpc.ts.
 *
 * Key namespace is IDENTICAL to routes/self.ts so the per-day caps are shared
 * per-agent across the HTTP and gRPC transports:
 *   strengthens        → mnemo:selfedit:strengthens:{day}:{workspaceId}:{agentId}
 *   weakens            → mnemo:selfedit:weakens:{day}:{workspaceId}:{agentId}
 *   strengthens/target → mnemo:selfedit:strengthens_target:{day}:{workspaceId}:{agentId}:{factId}
 *
 * TTL is 48h (172_800s) so a counter survives until the calendar day rolls over
 * and is then naturally superseded by the new day's key.
 */
import { parseTarget } from "@mnemo-ai/core/cognitive";
import type { ServerDeps } from "./deps.js";

type Cache = ServerDeps["cache"];

const WORTH_OP_TTL_SECONDS = 172_800; // 48h
const EDITS_TTL_SECONDS = 86_400; // 24h — the session edit budget's window
const LAST_EDIT_TTL_MS = 86_400_000; // 24h — far longer than any cooldown

/**
 * PRIM-6 / RECALL-12 / CLIENTS-6 — the shared identity of the self-edit budget.
 *
 * The budget used to be one per WORKSPACE for every caller without a
 * sessionId (`edits:{ws}:__anonymous__`, which is every MCP `memory_update`),
 * and the cooldown one per (workspace, body `agentId`) for any target: every
 * agent in a workspace shared five corrections a day and one edit per five
 * minutes, and a new `agentId` in the body reset both. Every key now carries
 * the AUTHENTICATED actor (`key:<id>`, from provenance — never the body), the
 * cooldown also carries the canonical target, and HTTP and gRPC build the
 * keys here so they share one budget.
 */
export const SELF_EDIT_SESSIONLESS = "__anonymous__";

/** Canonical target for keys: `fact:<id>`, `strategy:<id>` or `profile`. */
export function selfEditTargetKey(target: string): string {
  const parsed = parseTarget(target);
  return parsed.kind === "profile" ? "profile" : `${parsed.kind}:${parsed.id}`;
}

/** Session edit budget: per workspace, actor and (validated) session. */
export function selfEditEditsKey(workspaceId: string, actor: string, session: string): string {
  return `mnemo:selfedit:edits:${workspaceId}:${actor}:${session}`;
}

/** Daily delete budget: per workspace and actor. */
export function selfEditDeletesKey(workspaceId: string, actor: string): string {
  return `mnemo:selfedit:deletes:${selfEditDay()}:${workspaceId}:${actor}`;
}

/** Cooldown clock: per workspace, actor and target (§13 "on the SAME target"). */
export function selfEditLastEditKey(workspaceId: string, actor: string, target: string): string {
  return `mnemo:selfedit:lastedit:${workspaceId}:${actor}:${selfEditTargetKey(target)}`;
}

/** Edits in this budget so far. 0 without a cache; fail-closed on a cache error. */
export async function readSelfEditEdits(
  cache: Cache,
  workspaceId: string,
  actor: string,
  session: string
): Promise<number> {
  if (!cache) return 0;
  try {
    return (await cache.get<number>(selfEditEditsKey(workspaceId, actor, session))) ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Deletes today. 0 without a cache; fail-closed on a cache error. */
export async function readSelfEditDeletes(
  cache: Cache,
  workspaceId: string,
  actor: string
): Promise<number> {
  if (!cache) return 0;
  try {
    return (await cache.get<number>(selfEditDeletesKey(workspaceId, actor))) ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Epoch-ms of this actor's last edit of this target; null when none (or no
 * cache). `Date.now()` on a cache error — fail-closed: the cooldown applies.
 */
export async function readSelfEditLastEdit(
  cache: Cache,
  workspaceId: string,
  actor: string,
  target: string
): Promise<number | null> {
  if (!cache) return null;
  try {
    return (await cache.get<number>(selfEditLastEditKey(workspaceId, actor, target))) ?? null;
  } catch {
    return Date.now();
  }
}

/** Count one edit against the session budget. No-op without `incrWithTtl`. */
export async function bumpSelfEditEdits(
  cache: Cache,
  workspaceId: string,
  actor: string,
  session: string
): Promise<void> {
  if (!cache?.incrWithTtl) return;
  await cache.incrWithTtl(selfEditEditsKey(workspaceId, actor, session), EDITS_TTL_SECONDS);
}

/** Count one delete against today's budget. No-op without `incrWithTtl`. */
export async function bumpSelfEditDeletes(
  cache: Cache,
  workspaceId: string,
  actor: string
): Promise<void> {
  if (!cache?.incrWithTtl) return;
  await cache.incrWithTtl(selfEditDeletesKey(workspaceId, actor), WORTH_OP_TTL_SECONDS);
}

/** Start the cooldown for this actor and target. No-op without a cache. */
export async function bumpSelfEditLastEdit(
  cache: Cache,
  workspaceId: string,
  actor: string,
  target: string,
  now: number
): Promise<void> {
  if (!cache) return;
  await cache.set(selfEditLastEditKey(workspaceId, actor, target), now, {
    ttlMs: LAST_EDIT_TTL_MS,
  });
}

function selfEditDay(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export function selfEditStrengthensKey(workspaceId: string, agentId: string): string {
  return `mnemo:selfedit:strengthens:${selfEditDay()}:${workspaceId}:${agentId}`;
}

export function selfEditWeakensKey(workspaceId: string, agentId: string): string {
  return `mnemo:selfedit:weakens:${selfEditDay()}:${workspaceId}:${agentId}`;
}

export function selfEditStrengthensTargetKey(
  workspaceId: string,
  agentId: string,
  factId: string
): string {
  return `mnemo:selfedit:strengthens_target:${selfEditDay()}:${workspaceId}:${agentId}:${factId}`;
}

/**
 * Number of strengthen ops performed by this agent today.
 * Returns 0 when no cache is wired (dev/test intentional degraded mode).
 * Returns Number.MAX_SAFE_INTEGER when the cache throws — fail-closed: the
 * caller's evaluateSelfEdit will see "already at cap" and deny the operation
 * rather than silently treating a Redis outage as "no edits today".
 */
export async function readSelfEditStrengthens(
  cache: Cache,
  workspaceId: string,
  agentId: string
): Promise<number> {
  if (!cache) return 0;
  try {
    return (await cache.get<number>(selfEditStrengthensKey(workspaceId, agentId))) ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Number of weaken ops performed by this agent today.
 * Fail-closed on cache error (returns MAX_SAFE_INTEGER, not 0).
 */
export async function readSelfEditWeakens(
  cache: Cache,
  workspaceId: string,
  agentId: string
): Promise<number> {
  if (!cache) return 0;
  try {
    return (await cache.get<number>(selfEditWeakensKey(workspaceId, agentId))) ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Number of strengthen ops for this specific fact today.
 * Fail-closed on cache error (returns MAX_SAFE_INTEGER, not 0).
 */
export async function readSelfEditStrengthensForTarget(
  cache: Cache,
  workspaceId: string,
  agentId: string,
  factId: string
): Promise<number> {
  if (!cache) return 0;
  try {
    return (
      (await cache.get<number>(selfEditStrengthensTargetKey(workspaceId, agentId, factId))) ?? 0
    );
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Atomically bump BOTH the per-agent daily strengthen counter and the per-fact
 * daily strengthen counter. No-op when the cache lacks incrWithTtl (degraded).
 */
export async function bumpSelfEditStrengthens(
  cache: Cache,
  workspaceId: string,
  agentId: string,
  factId: string
): Promise<void> {
  if (!cache?.incrWithTtl) return;
  await Promise.all([
    cache.incrWithTtl(selfEditStrengthensKey(workspaceId, agentId), WORTH_OP_TTL_SECONDS),
    cache.incrWithTtl(
      selfEditStrengthensTargetKey(workspaceId, agentId, factId),
      WORTH_OP_TTL_SECONDS
    ),
  ]);
}

/** Atomically bump the per-agent daily weaken counter. No-op without incrWithTtl. */
export async function bumpSelfEditWeakens(
  cache: Cache,
  workspaceId: string,
  agentId: string
): Promise<void> {
  if (!cache?.incrWithTtl) return;
  await cache.incrWithTtl(selfEditWeakensKey(workspaceId, agentId), WORTH_OP_TTL_SECONDS);
}
