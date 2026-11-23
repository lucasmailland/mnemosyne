// Session buffer — spec §7/§9 L1 session memory.
//
// Redis buffers ephemeral turn and activity data over durable Postgres sessions:
//   - turns        → Redis List   mnemo:{ws}:sess:{id}:turns  (capped, 24h TTL)
//   - last-activity→ Redis ZSet   mnemo:{ws}:sess:active      (score = epoch ms)
//
// Scratch is PostgreSQL-authoritative through SessionScratchStore. Successful
// replacement invalidates the legacy Redis scratch hash best-effort.
// Graceful degradation: ANY Redis error falls back to the PG path (NEVER throws,
// NEVER 503) — exactly the WP6 mandate (see WP6 RECONCILE for the spec edit).
//
// Hexagonal: this file imports ONLY @mnemo-ai/types ports. No drizzle/pg/ioredis.

import type { CacheAdapter, StorageAdapter, SessionTurn, Logger } from "@mnemo-ai/types";

/** 24 hours in seconds — spec §9 L1 TTL. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;
/** Cap the Redis turns List so a runaway session cannot blow Redis memory. */
export const MAX_BUFFERED_TURNS = 500;

export interface SessionScratchStore {
  replaceSessionScratch(input: {
    workspaceId: string;
    sessionId: string;
    scratch: Record<string, unknown>;
  }): Promise<boolean>;

  getSessionScratch(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<Record<string, unknown> | null>;
}

export function sessTurnsKey(ws: string, sessionId: string): string {
  return `mnemo:${ws}:sess:${sessionId}:turns`;
}
export function sessScratchKey(ws: string, sessionId: string): string {
  // Spec §7: Hash key is mnemo:{ws}:sess:{id} (the scratch hash IS the session hash).
  return `mnemo:${ws}:sess:${sessionId}`;
}
export function sessActiveKey(ws: string): string {
  return `mnemo:${ws}:sess:active`;
}

/** JSON envelope stored per turn in the Redis List. */
interface BufferedTurn {
  workspaceId: string;
  sessionId: string;
  turnIndex: number;
  role: SessionTurn["role"];
  content: string;
  tokenCount?: number;
  pinned?: boolean;
  hint?: string;
  turnOrigin?: SessionTurn["turnOrigin"];
  turnOriginEvidence?: string;
  sourceMessageId?: string;
  ts: number;
}

/** Marks a turns List as an incomplete mirror: listTurns must read Postgres. */
interface DurableOnlySentinel {
  durableOnly: true;
}
const DURABLE_ONLY_SENTINEL: DurableOnlySentinel = { durableOnly: true };

export class SessionBuffer {
  /**
   * @param cache   Redis cache adapter (null → PG-only mode; e.g. no Redis configured).
   * @param storage durable Postgres storage port — always required (durability source of truth).
   * @param scratchStore workspace-scoped PostgreSQL scratch operations.
   * @param logger optional; Redis-degradation events are logged at debug/warn.
   */
  constructor(
    private readonly cache: CacheAdapter | null,
    private readonly storage: StorageAdapter,
    private readonly scratchStore: SessionScratchStore,
    private readonly logger?: Logger
  ) {}

  /** True when a usable Redis cache with the ops we need is wired. */
  private get redisReady(): boolean {
    return !!(
      this.cache &&
      this.cache.capabilities.hashes &&
      this.cache.lpush &&
      this.cache.lrange &&
      this.cache.lpushCapped &&
      this.cache.hSetWithTtl &&
      this.cache.hGetAll &&
      this.cache.zadd &&
      this.cache.zrangeByScore &&
      this.cache.zrem
    );
  }

  /**
   * Append a turn: ALWAYS write-through to Postgres (durable), then best-effort
   * mirror into the Redis List and bump the sess:active SortedSet. A Redis failure
   * is swallowed — the PG write already happened.
   */
  async appendTurn(
    workspaceId: string,
    sessionId: string,
    turn: Omit<SessionTurn, "id" | "createdAt">
  ): Promise<void> {
    // 1) Durable write-through (source of truth). Let storage errors propagate.
    const storedTurnIndex = await this.storage.appendTurn(sessionId, turn);

    // Replayed occurrence may live in a predecessor. Never mirror a second copy
    // into this segment or return a partial cache after an idempotent append.
    // Deleting the list alone is not enough: the next ordinary append would
    // recreate it holding only itself, and listTurns would serve that as the
    // whole session. A sentinel keeps the segment durable-only for the list's
    // lifetime, whatever is pushed after it.
    if (turn.sourceMessageId) {
      if (!this.cache) return;
      const key = sessTurnsKey(workspaceId, sessionId);
      try {
        if (!this.redisReady) throw new Error("redis list ops unavailable");
        await this.cache.lpushCapped!(
          key,
          JSON.stringify(DURABLE_ONLY_SENTINEL),
          MAX_BUFFERED_TURNS,
          SESSION_TTL_SECONDS
        );
      } catch {
        await this.cache.delete(key).catch(() => undefined);
      }
      return;
    }
    // 2) Best-effort Redis mirror + activity bump.
    if (!this.redisReady) return;
    const now = Date.now();
    const envelope: BufferedTurn = {
      workspaceId: turn.workspaceId,
      sessionId: turn.sessionId,
      turnIndex: storedTurnIndex,
      role: turn.role,
      content: turn.content,
      tokenCount: turn.tokenCount,
      pinned: turn.pinned,
      hint: turn.hint,
      turnOrigin: turn.turnOrigin ?? (turn.role === "assistant" ? "assistant" : "unknown"),
      turnOriginEvidence: turn.turnOriginEvidence ?? "unclassified",
      sourceMessageId: turn.sourceMessageId,
      ts: now,
    };
    try {
      // RPUSH-equivalent ordering: the List stores newest-first (lpushCapped uses
      // LPUSH+LTRIM). listTurns() reverses to chronological order on read.
      await this.cache!.lpushCapped!(
        sessTurnsKey(workspaceId, sessionId),
        JSON.stringify(envelope),
        MAX_BUFFERED_TURNS,
        SESSION_TTL_SECONDS
      );
      await this.cache!.zadd!(sessActiveKey(workspaceId), now, sessionId);
    } catch (err) {
      this.logger?.warn?.("session-buffer: redis append degraded — PG write already durable", {
        operation: "session_buffer.append_degraded",
        sessionId,
        workspaceId,
        err,
      });
    }
  }

  /**
   * List a session's turns in chronological (turnIndex-ascending) order.
   * Prefers the Redis List; on miss or Redis failure, falls back to PG.
   */
  async listTurns(workspaceId: string, sessionId: string): Promise<SessionTurn[]> {
    if (this.redisReady) {
      try {
        const raw = await this.cache!.lrange!(sessTurnsKey(workspaceId, sessionId), 0, -1);
        const envelopes = raw.map((s) => JSON.parse(s) as BufferedTurn | DurableOnlySentinel);
        const durableOnly = envelopes.some((e) => "durableOnly" in e && e.durableOnly === true);
        if (envelopes.length > 0 && !durableOnly) {
          const parsed = (envelopes as BufferedTurn[]).sort((a, b) => a.turnIndex - b.turnIndex);
          return parsed.map((e, i) => ({
            id: `buf-${sessionId}-${e.turnIndex}-${i}`,
            workspaceId: e.workspaceId,
            sessionId: e.sessionId,
            turnIndex: e.turnIndex,
            role: e.role,
            content: e.content,
            tokenCount: e.tokenCount,
            pinned: e.pinned,
            hint: e.hint,
            turnOrigin: e.turnOrigin ?? "unknown",
            turnOriginEvidence: e.turnOriginEvidence ?? "unclassified",
            sourceMessageId: e.sourceMessageId,
            createdAt: new Date(e.ts),
          }));
        }
      } catch (err) {
        this.logger?.debug?.("session-buffer: redis listTurns degraded — falling back to PG", {
          operation: "session_buffer.list_degraded",
          sessionId,
          err,
        });
      }
    }
    // Cache miss or Redis down → durable PG read.
    return this.storage.listTurns(sessionId, workspaceId);
  }

  /**
   * Replace the PostgreSQL-authoritative scratch pad, then invalidate the legacy
   * Redis hash and bump activity independently on a best-effort basis.
   */
  async setScratch(
    workspaceId: string,
    sessionId: string,
    scratch: Record<string, unknown>
  ): Promise<boolean> {
    const updated = await this.scratchStore.replaceSessionScratch({
      workspaceId,
      sessionId,
      scratch,
    });
    if (!updated) return false;

    if (this.cache) {
      try {
        await this.cache.delete(sessScratchKey(workspaceId, sessionId));
      } catch (err) {
        this.logger?.warn?.("session-buffer: scratch cache invalidation degraded", {
          operation: "session_buffer.scratch_invalidation_degraded",
          sessionId,
          err,
        });
      }

      if (this.cache.zadd) {
        try {
          await this.cache.zadd(sessActiveKey(workspaceId), Date.now(), sessionId);
        } catch (err) {
          this.logger?.warn?.("session-buffer: scratch activity update degraded", {
            operation: "session_buffer.scratch_activity_degraded",
            sessionId,
            err,
          });
        }
      }
    }
    return true;
  }

  /** Read the PostgreSQL-authoritative scratch pad without consulting Redis. */
  async getScratch(workspaceId: string, sessionId: string): Promise<Record<string, unknown>> {
    const value = await this.scratchStore.getSessionScratch({ workspaceId, sessionId });
    return value ?? {};
  }

  /** Pin/unpin a turn (durable PG write). Bumps activity. Redis turn copies are
   *  immutable envelopes, so we do not patch them — the next listTurns PG fallback
   *  (after collapse reads via getDurableTurns) reflects the pin. */
  async pinTurn(
    workspaceId: string,
    sessionId: string,
    selector: { turnId?: string; turnIndex?: number },
    pinned: boolean
  ): Promise<boolean> {
    const matched = await this.storage.pinSessionTurn({
      sessionId,
      workspaceId,
      ...selector,
      pinned,
    });
    if (!this.redisReady) return matched;
    try {
      await this.cache!.zadd!(sessActiveKey(workspaceId), Date.now(), sessionId);
    } catch (err) {
      this.logger?.debug?.("session-buffer: redis pin activity bump degraded", {
        operation: "session_buffer.pin_degraded",
        sessionId,
        err,
      });
    }
    return matched;
  }

  /**
   * Return session ids whose last-activity score is within [minMs, maxMs].
   * Used by the inactivity sweep to find candidates WITHOUT an N+1 PG scan.
   * On Redis failure returns [] (caller falls back to its PG scan).
   */
  async listActiveSessions(
    workspaceId: string,
    minMs: number,
    maxMs: number,
    limit?: number
  ): Promise<string[]> {
    if (!this.redisReady) return [];
    try {
      return await this.cache!.zrangeByScore!(sessActiveKey(workspaceId), minMs, maxMs, limit);
    } catch (err) {
      this.logger?.debug?.("session-buffer: redis listActiveSessions degraded", {
        operation: "session_buffer.active_degraded",
        workspaceId,
        err,
      });
      return [];
    }
  }

  /**
   * Authoritative durable turns for the collapse pipeline — ALWAYS reads from PG
   * so pin flags + token counts are exact (Redis envelopes are append-time
   * snapshots). Collapse correctness must not depend on Redis being up.
   */
  async getDurableTurns(workspaceId: string, sessionId: string): Promise<SessionTurn[]> {
    return this.storage.listTurns(sessionId, workspaceId);
  }

  /**
   * Drop a session's Redis footprint (turns List, scratch Hash, sess:active entry).
   * Called after collapse/discard. PG rows are untouched. Best-effort.
   */
  async clear(workspaceId: string, sessionId: string): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.delete(sessTurnsKey(workspaceId, sessionId));
      await this.cache.delete(sessScratchKey(workspaceId, sessionId));
      if (this.cache.zrem) {
        await this.cache.zrem(sessActiveKey(workspaceId), sessionId);
      }
    } catch (err) {
      this.logger?.debug?.("session-buffer: redis clear degraded (ttl will reap)", {
        operation: "session_buffer.clear_degraded",
        sessionId,
        err,
      });
    }
  }
}
