# Redis Primary Down Runbook

## Symptoms
- Hot tier misses (all recalls fall through to cold PG tier)
- `PING` to Redis times out
- Latency spike on recall (still 200, but slower)
- `mnemo:hot:*` keys unavailable

## Affected Systems
- Hot tier (ACT-R recall — degrades to cold, not down)
- Session working memory (L0)
- Rate limiting (falls back to in-memory shedder)

## Immediate Mitigation

```bash
# 1. Test Redis connectivity
redis-cli -u $REDIS_URL PING

# 2. Check Redis memory usage
redis-cli -u $REDIS_URL INFO memory | grep used_memory_human

# 3. Check connected clients
redis-cli -u $REDIS_URL CLIENT LIST | wc -l

# 4. If Upstash/managed Redis: check provider dashboard for failover status
# The API degrades gracefully (hot-tier miss → cold tier) — no 5xx

# 5. Clear corrupted data if needed
redis-cli -u $REDIS_URL FLUSHDB ASYNC

# 6. Restart the hot tier by re-warming from PG:
#    The ACT-R hot tier refills automatically as recalls occur.
#    No manual step needed — just wait for traffic to warm it.
```

## Root Cause Analysis

1. **Memory pressure / eviction**: Check `INFO stats | grep evicted_keys`; increase maxmemory or upgrade instance.
2. **Network partition**: Check VPC routing between app nodes and Redis.
3. **Persistence corruption**: Check `INFO persistence | grep rdb_last_bgsave_status`; restore from RDB if needed.

## Escalation
- SEV3: Redis down but API degraded (not down) — recall latency increases
- Escalate to SEV2 if session data loss exceeds 1% of active sessions
- Page: On-call engineer

## Related
- [Chaos experiment hot_tier_eviction](../gameday.md#experiment-4-hot-tier-eviction-flushall)
- [Chaos experiment redis_partition](../gameday.md#experiment-1-redis-partition)
