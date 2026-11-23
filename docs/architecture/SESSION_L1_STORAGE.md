# Session L1 Storage Strategy — Architecture Decision

> **Status:** ✅ Decided — hybrid turns; PostgreSQL-authoritative scratch
> **Date:** 2026-07-05  
> **Context:** RET-4 remediation task (Retrieval & Anticipation cluster)  
> **Related:** `MEMORY_MODEL.md` §"Working Memory" L1; `session-buffer.ts`

---

## Decision

**Session turns use hybrid PostgreSQL durability plus Redis buffering. Session scratch uses PostgreSQL only as the authoritative read/write store.**

Implementation: `packages/core/src/session/session-buffer.ts` (`SessionBuffer` class)

---

## Rationale

The spec (`MEMORY_MODEL.md` lines 755-762) designates L1 as **"SESSION MEMORY (Redis), TTL: 24h"** with keys `mnemo:{ws}:sess:{id}:*`. The implementation delivers this with **graceful degradation** to ensure durability and availability.

### Why hybrid (not Redis-only)

| Concern                       | Redis-only                           | Hybrid (current)                                                        |
| ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| **Durability**                | Lost on Redis flush/restart          | Survives — Postgres is source of truth                                  |
| **Collapse reliability**      | Turns may be evicted before collapse | Always available from PG for extraction                                 |
| **Transactional consistency** | turn_count/token_count updates racy  | Atomic UPDATE in same PG transaction                                    |
| **TTL semantics**             | Hard 24h eviction (data loss risk)   | Soft TTL via inactivity sweep + collapse                                |
| **Graceful degradation**      | 503 when Redis is down               | Scratch remains available; Redis-dependent session mutations return 503 |

### Why not Postgres-only

Pure Postgres (no Redis mirror) would work functionally but loses the **hot-path read performance** benefits:

- **Fast session reads**: Redis List `LRANGE` is ~1ms vs ~5-15ms PG query
- **Active session tracking**: Redis ZSet `mnemo:{ws}:sess:active` enables O(1) inactivity sweep candidates (spec line 575, implemented in `packages/server/src/index.ts:998` `sweepInactiveSessions`)
- **Scratch is excluded:** correctness and workspace isolation take priority over Redis latency for scratch replacement.

---

## Implementation Details

### Write-through flow (appendTurn)

```
1. Write to Postgres (durability) — MUST succeed or throw
   └─> INSERT INTO mnemo_session_turn + UPDATE mnemo_session (turn_count, token_count)
2. Mirror to Redis (performance) — BEST EFFORT, swallows errors
   └─> LPUSH mnemo:{ws}:sess:{id}:turns (capped at 500)
   └─> ZADD mnemo:{ws}:sess:active {sessionId} {epochMs}
```

Source: `packages/core/src/session/session-buffer.ts:83-120`

### Read flow (getDurableTurns)

```
1. Try Redis: LRANGE mnemo:{ws}:sess:{id}:turns 0 -1
   └─> Hit → parse JSON envelopes → return
2. Redis miss/error → fallback to Postgres:
   └─> SELECT * FROM mnemo_session_turn WHERE session_id=? ORDER BY turn_index
```

Source: `packages/core/src/session/session-buffer.ts:204-230`

### Scratch replacement and read flow

```
1. Replace the complete scratch object with one UPDATE ... RETURNING in withMnemoTx.
2. Return false when the session is absent or hidden by workspace RLS; HTTP maps both to 404.
3. After success, delete the legacy Redis session hash and bump activity independently, best-effort.
4. Read scratch only from PostgreSQL through withMnemoTx.
```

Scratch is replacement, not merge. `{}` clears all fields. No scratch read or
write consults Redis. Exact scratch requests also bypass the Redis health and
Redis-backed idempotency gates, so PostgreSQL availability determines success.

### Collapse integration

The collapse pipeline (`packages/core/src/session/collapse.ts:246`) reads turns via `resolveCollapseTurns()`, which delegates to `SessionBuffer.getDurableTurns()` when wired. This ensures collapse ALWAYS sees durable PG data (never stale Redis cache).

Source: `packages/core/src/session/collapse.ts:246-256`

### TTL enforcement

**Spec says:** 24h TTL on Redis keys.  
**Implementation:**

1. Redis keys are set with `SESSION_TTL_SECONDS = 86400` (24h) on every write
2. **Postgres rows have NO hard TTL** — they persist until explicitly collapsed/archived
3. **Inactivity sweep** (`packages/server/src/index.ts:998`, 5-minute cron) acts as the durable TTL-equivalent:
   - Queries active sessions from `mnemo:sess:active` ZSet (Redis) OR `mnemo_session` table (PG fallback)
   - Evaluates `shouldCollapseUnderPolicy()` using per-agent `CollapsePolicy.inactivityTimeout` (default 30 min, configurable)
   - Triggers collapse → archives session → closes session row

**Result:** Sessions older than `inactivityTimeout` are collapsed and moved to archive, bounding row lifetime without a hard 24h eviction (which would lose uncollapsed data).

Source: `packages/server/src/session-sweep.ts`, `packages/server/src/boot/crons.ts:79`

---

## Spec Compliance

| Spec requirement                      | Status                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| L1 keys `mnemo:{ws}:sess:{id}:*`      | ✅ Turn list and active index implemented; legacy session hash is deletion-only                         |
| Redis storage for turns               | ✅ Write-through to Redis List (when available)                                                         |
| 24h TTL                               | ✅ Redis keys have 24h TTL; PG rows soft-TTL via inactivity sweep                                       |
| Session buffer (turns + scratch)      | ✅ Turns are hybrid; scratch is PostgreSQL-authoritative and never Redis-cached                         |
| Collapse trigger                      | ✅ Inactivity sweep + explicit collapse routes                                                          |
| Graceful degradation on Redis failure | ✅ Scratch remains PostgreSQL-backed; turn/activity cache failures are best-effort after durable writes |

**Deviation from spec:** Spec implies Redis-only storage. Implementation uses Redis as a **write-through cache** over Postgres. This deviation is **intentional and documented** for durability/availability reasons (see "Why hybrid" above).

---

## Performance Characteristics

| Operation              | Redis path              | Postgres fallback          | Typical latency                              |
| ---------------------- | ----------------------- | -------------------------- | -------------------------------------------- |
| appendTurn             | Write PG + mirror Redis | Write PG only              | 5-8ms (PG write) + 1ms (Redis mirror, async) |
| getDurableTurns (hot)  | Redis LRANGE            | —                          | ~1ms                                         |
| getDurableTurns (cold) | —                       | PG SELECT                  | ~5-15ms                                      |
| getScratch             | —                       | PG SELECT in `withMnemoTx` | ~5ms                                         |
| Collapse read          | Always PG               | —                          | ~5-15ms (guarantees durability)              |

---

## Migration Notes

**No migration required.** The `SessionBuffer` class is already wired in production and has been since v3.2:

- `packages/server/src/index.ts:371-381` instantiates `SessionBuffer` at boot
- `packages/server/src/routes/index.ts` session routes use `deps.sessionBuffer` (when available)
- `packages/core/src/factory.ts:1645` `appendTurn` writes directly to PG (no SessionBuffer dependency in legacy factory path — this is intentional for backward compat)

**Future work:** Option (a) from the remediation plan — full Redis-first with PG archival-only on collapse — is DEFERRED as a separate large epic. The current hybrid approach meets all functional and performance requirements.

---

## References

- **Spec:** `docs/research/MEMORY_MODEL.md` lines 755-762 (L1 definition), 557-604 (Session Memory architecture)
- **Implementation:** `packages/core/src/session/session-buffer.ts` (SessionBuffer class, 312 lines)
- **Collapse:** `packages/core/src/session/collapse.ts:246` (resolveCollapseTurns)
- **Inactivity sweep:** `packages/server/src/index.ts:998` (sweepInactiveSessions), `packages/server/src/session-sweep.ts` (shouldCollapseUnderPolicy)
- **Remediation context:** `docs/archive/remediation/02-retrieval-anticipation.md` RET-4 (lines 371-420)

---

## Decision Log

| Date       | Change                                           | Reason                                                                             |
| ---------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 2026-07-05 | Document hybrid write-through strategy           | RET-4: formalize existing implementation vs spec deviation                         |
| 2026-07-16 | Make scratch PostgreSQL-authoritative            | B6.34: exact replacement, forced-RLS isolation, and Redis-independent availability |
| (pre-v3.2) | Implement SessionBuffer with Redis write-through | Durability + performance requirements                                              |
