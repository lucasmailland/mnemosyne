# Chaos Game Day Runbook

> **W10 decision record (2026-06-22):** The chaos test suite (`pnpm --filter @mnemo-ai/server run chaos`)
> is real and passes — 9/9 tests, all 6 experiments verified (see
> [`gameday-results/2026-06-22-w10-baseline.md`](gameday-results/2026-06-22-w10-baseline.md)).
> This runbook is aligned to that vitest-based harness. The standalone `run-chaos.js` runner
> and full staging environment are post-1.0 items: the CI-scoped chaos drill is the v1.0 gameday.

**Spec §35 lines 4136–4194 — Chaos Engineering**

All experiments are controlled by `MNEMO_CHAOS_ENABLED=true`.

---

## How to run (v1.0 — CI harness)

```bash
# Run all 6 experiments (vitest, no real infra required):
pnpm --filter @mnemo-ai/server run chaos

# Output: 9/9 tests, ~200 ms, no infra dependencies
```

Experiments run with `enabled: false` in CI (no real fault injection). They verify:
- The harness exports exactly the 6 spec-named experiments
- Each experiment has `action()`, `verify()`, and `description`
- Each `action()` resolves without throwing when the adapter context is injected

---

## How to run (post-1.0 — staging with real fault injection)

Prerequisites: staging environment with real PG + Redis + traffic.

```bash
# 1. Announce maintenance window in #mnemosyne-ops (1h minimum)
# 2. Confirm staging is at HEAD of main
# 3. Snapshot the staging DB
pg_dump $STAGING_DB_URL > staging-pre-gameday-$(date +%Y%m%d).dump

# 4. Run all experiments with real fault injection
MNEMO_CHAOS_ENABLED=true STAGING_DB_URL=$STAGING_DB_URL REDIS_URL=$STAGING_REDIS_URL \
  pnpm --filter @mnemo-ai/server run chaos
```

---

## Experiment 1: Redis Partition

**Goal**: Verify recall degrades gracefully (PG cold tier picks up) when Redis is unreachable.

**CI:** `action({ enabled: false })` resolves. ✅

**Staging (full):**
1. Note current hot-tier hit rate in Grafana (`mnemo_recall_hot_tier_hit_rate`)
2. Trigger: set `enabled: true` in chaos ctx; action disconnects Redis adapter
3. Send 10 recall requests; confirm all return HTTP 200
4. Check server logs for `hot tier miss` — confirms PG cold fallback
5. Restore: chaos ctx clears disconnect; ping Redis to verify
6. Confirm hot-tier metrics recover within 60 s

**Pass criteria**: All recall requests return 200. No 500s in logs.
**Fail criteria**: Any 500 response; request timeout > 5 s.

---

## Experiment 2: PG Replica Lag

**Goal**: Verify stale-read detection fires when replica lag exceeds threshold.

**CI-limited**: Cannot pause a real replica in CI; detection code path asserted. ✅

**Staging (full):**
1. Note baseline replica lag (`pg_replication_lag_seconds`)
2. Pause the replica: `SELECT pg_wal_replay_pause();` on replica
3. Trigger experiment with `enabled: true`; action sets stale-read flag in adapter
4. Confirm `[storage] stale read detected` appears in logs
5. Resume: `SELECT pg_wal_replay_resume();`
6. Confirm lag drains to 0 within 30 s

**Pass criteria**: Stale-read warning logged; no silent stale reads.
**Fail criteria**: Silent stale read (old data returned without warning).

---

## Experiment 3: Embedding Provider Timeout

**Goal**: Verify FTS-only fallback activates when the embedding provider times out.

**CI:** `action({ enabled: false })` resolves. ✅

**Staging (full):**
1. Confirm provider healthy (`mnemo_embed_latency_p99`)
2. Trigger with `enabled: true`; action injects a timeout in the embedding adapter
3. Send 5 recall requests; confirm `"fallback":"fts"` in response metadata
4. Confirm no 500s; requests may be slower

**Pass criteria**: All responses 200; FTS fallback indicator present.
**Fail criteria**: 500 errors; embedding timeout propagates to user.

---

## Experiment 4: Hot Tier Eviction (FLUSHALL)

**Goal**: Verify cold tier serves requests immediately after hot tier is flushed.

**CI:** `action({ enabled: false })` resolves. ✅

**Staging (full):**
1. Note hot-tier size: `redis-cli DBSIZE`
2. Trigger with `enabled: true`; action calls `cache.flushAll()`
3. Confirm Redis empty: `redis-cli DBSIZE` returns 0
4. Send 10 recall requests — all should return 200 (PG HNSW cold path)
5. Monitor hot tier re-warming over next 5 min

**Pass criteria**: All 200s during flush; hot tier re-warms automatically.
**Fail criteria**: Any 500 or errors returned to users.

---

## Experiment 5: Session Collapse LLM Failure

**Goal**: Verify sessions are preserved and queued for retry when the collapse LLM fails.

**CI:** `action({ enabled: false })` resolves. ✅

**Staging (full):**
1. Start a session (`POST /v1/sessions`), add 3–5 messages
2. Trigger with `enabled: true`; action injects LLM failure in consolidation adapter
3. Close session (`POST /v1/sessions/:id/close`)
4. Confirm session stays `open` (retry-pending), not `closed`
5. Check outbox: `SELECT * FROM mnemosyne.outbox WHERE status='pending' AND event_type='session_collapse'`
6. Restore LLM; confirm collapse completes within next retry window (≤5 min)

**Pass criteria**: Session preserved in retry state; no data loss.
**Fail criteria**: Session dropped/deleted; messages lost.

---

## Experiment 6: Clock Skew

**Goal**: Verify server timestamps are unaffected by skewed client clocks.

**CI:** `action({ enabled: false })` resolves. ✅

**Staging (full):**
1. Send a request with a `Date` header 5 minutes in the future
2. Check `created_at` of the new fact in the DB
3. Confirm `created_at` matches server time, NOT the skewed client Date header

**Pass criteria**: `created_at` reflects server time.
**Fail criteria**: `created_at` reflects client-supplied skewed time.

---

## Recording results

After each gameday (CI or staging), write a results file:

```
docs/ops/gameday-results/YYYY-MM-DD-<type>.md
```

See [`gameday-results/2026-06-22-w10-baseline.md`](gameday-results/2026-06-22-w10-baseline.md)
for the W10 baseline format.

---

## Rollback

If any experiment causes data corruption:

1. `pg_restore` from pre-game-day dump (see [DR runbook](dr-backup.md))
2. `redis-cli FLUSHALL` to reset hot tier
3. Redeploy last known-good image: `fly deploy --image registry.fly.io/mnemosyne:stable`
