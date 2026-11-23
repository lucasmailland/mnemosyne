# Mnemosyne v3 — Redis Conventions

Redis is an **optional** layer in Mnemosyne. The system is fully functional without it; Redis adds
speed (sub-5 ms hot-tier recall, shared session buffers, cross-pod cache coherence) but nothing in
the critical path depends on it. All Redis access goes through the `CacheAdapter` interface so
Redis can be swapped for the built-in in-memory fallback without touching business logic.

---

## 1. Key Naming Convention

### Universal Format

```
mnemo:{workspace_id}:{domain}:{subkey}
```

| Segment | Type | Description |
|---|---|---|
| `mnemo` | literal | Global namespace prefix — never omit |
| `{workspace_id}` | UUID v4 | Workspace identifier (never a human-readable name) |
| `{domain}` | literal | One of the domain codes below |
| `{subkey}` | domain-specific | Structured key segment(s) for the domain |

**Hash-tag rule for Redis Cluster**: the `{workspace_id}` segment is already surrounded by `:`
separators. Add explicit hash tags (`{...}`) only when using Redis Cluster to ensure all keys for
a workspace land on the same shard:

```
mnemo:{e3b0c442}:hot:facts      ← hash tag is the workspace UUID
```

See Section 9 for the full cluster discussion.

### Domain Codes

| Domain | Purpose |
|---|---|
| `sess` | Session turn buffer and active-session index; scratch is PostgreSQL-authoritative |
| `hot` | ACT-R hot tier — activation sorted sets, cached fact results |
| `work` | Working memory L0 — tool outputs, workflow checkpoints |
| `cache` | Recall result cache L1 and fact-count counters |
| `rate` | Rate-limit token buckets and concurrent-request counters |
| `idem` | Idempotency keys — request deduplication |
| `pub` | Pub/Sub channels (not stored keys — channel name convention) |
| `ws` | WebSocket backpressure ring buffers |
| `lock` | Distributed locks |
| `actr` | ACT-R activation sorted sets (used in hot tier, kept separate for clarity) |
| `_keys` | Workspace key index set (optional; see Section 5) |

### Key Examples

```bash
# Session buffer
mnemo:e3b0c442:sess:7f2a1b3c:turns                   # session turns list
mnemo:e3b0c442:sess:active                           # active sessions sorted set
mnemo:e3b0c442:sess:7f2a1b3c                         # legacy session/scratch hash; deletion only

# ACT-R hot tier
mnemo:e3b0c442:actr:a9f3d2e1                         # per-agent activation sorted set
mnemo:e3b0c442:hot:fact:fact_a1b2c3                  # cached full RecallHit

# Working memory
mnemo:e3b0c442:work:agent_xyz:current_file           # tool output checkpoint
mnemo:e3b0c442:work:agent_xyz:step_3_result          # multi-step workflow state

# Recall cache
mnemo:e3b0c442:cache:recall:sha256hex                # cached RecallHit[]
mnemo:e3b0c442:cache:count:e3b0c442                  # workspace fact count

# Rate limiting
mnemo:e3b0c442:rate:key_abc123:1m                    # 1-minute window bucket
mnemo:e3b0c442:rate:concurrent:key_abc123            # concurrent request counter

# Idempotency
mnemo:e3b0c442:idem:01J4X9ZG3P4Y7M8N2Q5R6S7T8U      # idempotency key (ULID/UUID)

# WebSocket
mnemo:e3b0c442:ws:buffer:channel_live_facts          # ring buffer for live feed

# Distributed lock
mnemo:e3b0c442:lock:collapse:7f2a1b3c                # collapse lock for session
mnemo:e3b0c442:lock:hot_rebuild                      # hot-tier rebuild mutex

# Workspace key index (optional)
mnemo:e3b0c442:_keys                                 # Set of all active keys
```

---

## 2. Data Structures Per Domain

### 2.1 Session Buffer (`sess`)

| Key | Redis Type | Value | TTL |
|---|---|---|---|
| `mnemo:{ws}:sess:{id}:turns` | List | JSON turn objects | 24 h |
| `mnemo:{ws}:sess:active` | Sorted Set | member=session_id, score=lastActivityAt (Unix ms) | no TTL — managed by members |

`mnemo:{ws}:sess:{id}` is a legacy session/scratch hash. Current code never
reads or writes scratch there. A successful PostgreSQL scratch replacement
deletes this key best-effort to prevent stale legacy data from surviving.

**Turn list element (each RPUSH):**
```json
{
  "role": "user",
  "content": "...",
  "turnIndex": 3,
  "timestamp": 1749430800000,
  "pinned": false,
  "hint": null
}
```

**Redis CLI examples:**
```bash
# Add a turn
RPUSH mnemo:e3b0c442:sess:7f2a1b3c:turns '{"role":"user","content":"hello","turnIndex":0,"timestamp":1749430800000,"pinned":false}'
EXPIRE mnemo:e3b0c442:sess:7f2a1b3c:turns 86400

# Read all turns (for collapse)
LRANGE mnemo:e3b0c442:sess:7f2a1b3c:turns 0 -1

# Register session as active
ZADD mnemo:e3b0c442:sess:active 1749430800000 "7f2a1b3c"

# Post-collapse cleanup
DEL mnemo:e3b0c442:sess:7f2a1b3c:turns
DEL mnemo:e3b0c442:sess:7f2a1b3c  # legacy hash, if present
ZREM mnemo:e3b0c442:sess:active "7f2a1b3c"
```

### 2.2 ACT-R Hot Tier (`actr` + `hot`)

| Key | Redis Type | Value | TTL |
|---|---|---|---|
| `mnemo:{ws}:actr:{agentId}` | Sorted Set | member=fact_id, score=ACT-R activation (float) | no TTL — managed by rebuild cron |
| `mnemo:{ws}:hot:fact:{factId}` | String | JSON-serialized `RecallHit` | 5 min (configurable) |

**ACT-R score**: See COGNITIVE_ALGORITHMS.md §12.2 for the canonical Petrov (2006) formula.
  A ≈ ln(hit_count + 1) - 0.5 × ln(age_seconds + 1) + W
The hot tier sorted set stores this pre-computed score. It is updated incrementally
on each recall event (not via nightly rebuild — see §12.5).

**RecallHit value format (hot:fact:{id}):**
```json
{
  "id": "fact_a1b2c3",
  "content": "Redis version is 7.2",
  "confidence": 0.95,
  "activationScore": 1.73,
  "lastRecalledAt": 1749430800000,
  "entityIds": ["ent_redis", "ent_version"],
  "workspaceId": "e3b0c442"
}
```

**Redis CLI examples:**
```bash
# Query hot tier: get top-K facts above activation threshold
ZRANGEBYSCORE mnemo:e3b0c442:actr:a9f3d2e1 0.5 +inf WITHSCORES LIMIT 0 20

# Promote a fact after recall (+0.3 recency boost)
ZINCRBY mnemo:e3b0c442:actr:a9f3d2e1 0.3 "fact_a1b2c3"

# Boost newly created fact on collapse
ZINCRBY mnemo:e3b0c442:actr:a9f3d2e1 0.5 "fact_a1b2c3"

# Keep only top-500 per agent (trim after rebuild)
ZREMRANGEBYRANK mnemo:e3b0c442:actr:a9f3d2e1 0 -501

# Full hot-tier rebuild (pipeline)
DEL mnemo:e3b0c442:actr:a9f3d2e1
ZADD mnemo:e3b0c442:actr:a9f3d2e1 1.73 "fact_a1b2c3" 1.51 "fact_b4c5d6" ...

# Cache full RecallHit
SET mnemo:e3b0c442:hot:fact:fact_a1b2c3 '{"id":"fact_a1b2c3",...}' EX 300
```

### 2.3 Working Memory L0 (`work`)

| Key | Redis Type | Value | TTL |
|---|---|---|---|
| `mnemo:{ws}:work:{agentId}:{key}` | String | JSON — tool output or checkpoint | 1–60 min |

The `{key}` segment is agent-defined — use snake_case, dot-separated steps, or opaque keys.
Examples: `current_file`, `step_3_result`, `dedup_bloom_v2`, `rate_tokens_remaining`.

**Redis CLI examples:**
```bash
SET mnemo:e3b0c442:work:a9f3d2e1:current_file '{"path":"/src/index.ts","linesRead":120}' EX 600
GET mnemo:e3b0c442:work:a9f3d2e1:current_file
DEL mnemo:e3b0c442:work:a9f3d2e1:current_file   # manual cleanup after step completes
```

### 2.4 Recall Cache L1 (`cache`)

| Key | Redis Type | Value | TTL |
|---|---|---|---|
| `mnemo:{ws}:cache:recall:{queryHash}` | String | JSON array of `RecallHit` | 60 s (configurable) |
| `mnemo:{ws}:cache:count:{workspaceId}` | String | Integer string | 5 min |

`{queryHash}` is a SHA-256 hex digest of `(workspaceId + agentId + normalizedQuery)`.

**Redis CLI examples:**
```bash
# Write cache entry
SET mnemo:e3b0c442:cache:recall:a1b2c3d4 '[{"id":"fact_abc",...}]' EX 60

# Read cache entry
GET mnemo:e3b0c442:cache:recall:a1b2c3d4

# Workspace fact count
SET mnemo:e3b0c442:cache:count:e3b0c442 "1042" EX 300
GET mnemo:e3b0c442:cache:count:e3b0c442
```

### 2.5 Rate Limiting (`rate`)

| Key | Redis Type | Value | TTL |
|---|---|---|---|
| `mnemo:{ws}:rate:{keyId}:{window}` | String | Integer (token bucket counter) | window duration |
| `mnemo:{ws}:rate:concurrent:{keyId}` | String | Integer (in-flight count) | 30 s |

`{keyId}` is the API key ID (not the raw key). `{window}` is `1s`, `1m`, or `1h`.

**Redis CLI examples:**
```bash
# Increment and check in one atomic operation (Lua or INCR + EXPIRE)
INCR mnemo:e3b0c442:rate:key_abc123:1m
EXPIRE mnemo:e3b0c442:rate:key_abc123:1m 60

# Concurrent request tracking
INCR mnemo:e3b0c442:rate:concurrent:key_abc123
EXPIRE mnemo:e3b0c442:rate:concurrent:key_abc123 30
# After request completes:
DECR mnemo:e3b0c442:rate:concurrent:key_abc123
```

### 2.6 Idempotency (`idem`)

| Key | Redis Type | Value | TTL |
|---|---|---|---|
| `mnemo:{ws}:idem:{idempotencyKey}` | String | JSON `{status, body, created_at}` | 24 h |

**Redis CLI examples:**
```bash
# Write idempotency record (NX = only if not exists → detect duplicate)
SET mnemo:e3b0c442:idem:01J4X9ZG '{"status":201,"body":{"id":"fact_abc"},"created_at":1749430800000}' EX 86400 NX

# Read cached response
GET mnemo:e3b0c442:idem:01J4X9ZG
```

### 2.7 Pub/Sub (`pub`)

Pub/Sub channels are not stored keys; they are addressed by name at `PUBLISH`/`SUBSCRIBE` time.

| Channel | Direction | Purpose |
|---|---|---|
| `mnemo:{ws}:pub:invalidate` | Server → all pods | Cache invalidation events |
| `mnemo:{ws}:pub:events` | Server → WebSocket layer | Fact/task/session events for live clients |

**Message format for `pub:invalidate`:**
```json
{ "type": "fact", "id": "fact_a1b2c3", "action": "created" }
{ "type": "fact", "id": "fact_a1b2c3", "action": "updated" }
{ "type": "fact", "id": "fact_a1b2c3", "action": "deleted" }
{ "type": "session", "id": "sess_xyz", "action": "collapsed" }
```

**Message format for `pub:events`:**
```json
{ "event": "fact.created", "workspaceId": "e3b0c442", "payload": { "id": "fact_abc", ... } }
{ "event": "task.updated", "workspaceId": "e3b0c442", "payload": { "id": "task_xyz", ... } }
```

**Redis CLI examples:**
```bash
# Publish invalidation
PUBLISH mnemo:e3b0c442:pub:invalidate '{"type":"fact","id":"fact_abc","action":"updated"}'

# Subscribe (application code pattern — one persistent connection per pod)
SUBSCRIBE mnemo:e3b0c442:pub:invalidate
```

### 2.8 WebSocket Ring Buffer (`ws`)

| Key | Redis Type | Value | TTL |
|---|---|---|---|
| `mnemo:{ws}:ws:buffer:{channel}` | List | JSON event objects (capped at 1000) | 1 h |

Used for replaying recent events to reconnecting clients. Maintained as a bounded ring buffer:
push to the left, trim from the right to enforce the cap.

**Redis CLI examples:**
```bash
# Push event + cap the buffer atomically (Lua or pipeline)
LPUSH mnemo:e3b0c442:ws:buffer:live_facts '{"event":"fact.created","id":"fact_abc"}'
LTRIM mnemo:e3b0c442:ws:buffer:live_facts 0 999
EXPIRE mnemo:e3b0c442:ws:buffer:live_facts 3600

# Replay last N events to a reconnecting client
LRANGE mnemo:e3b0c442:ws:buffer:live_facts 0 49
```

### 2.9 Distributed Locks (`lock`)

| Key | Redis Type | Value | TTL |
|---|---|---|---|
| `mnemo:{ws}:lock:{resource}` | String | Lock holder ID (UUID) | lock timeout |

Use `SET ... NX EX` for atomic acquire. Never `SETNX` + `EXPIRE` (not atomic).

**Common resources:**
- `collapse:{sessionId}` — prevents duplicate collapse runs for the same session
- `hot_rebuild` — prevents concurrent full hot-tier rebuilds per workspace

**Redis CLI examples:**
```bash
# Acquire lock (returns OK on success, nil on failure)
SET mnemo:e3b0c442:lock:collapse:7f2a1b3c "holder_uuid_here" NX EX 30

# Release lock (only if we own it — Lua script in production)
# Lua: if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end
EVAL "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end" 1 mnemo:e3b0c442:lock:collapse:7f2a1b3c "holder_uuid_here"
```

---

## 3. TTL Policy Table

| Key Pattern | Default TTL | Configurable? | Config Key | Eviction |
|---|---|---|---|---|
| `sess:{id}:turns` (list) | 24 h | Yes | `MNEMO_SESSION_TTL_SECONDS` | TTL expiry |
| `sess:active` (sorted set) | No TTL | — | — | Manual ZREM on collapse |
| `actr:{agentId}` (sorted set) | No TTL | — | — | Manual ZREMRANGEBYRANK (top-500 cap) |
| `hot:fact:{id}` | 5 min | Yes | `MNEMO_HOT_FACT_TTL_SECONDS` | TTL expiry |
| `work:{agentId}:{key}` | 10 min | Yes (per write) | `MNEMO_WORK_TTL_SECONDS` | TTL expiry |
| `cache:recall:{hash}` | 60 s | Yes | `MNEMO_CACHE_RECALL_TTL_SECONDS` | TTL expiry |
| `cache:count:{wsId}` | 5 min | No | — | TTL expiry |
| `rate:{keyId}:{window}` | Window duration | No | — | TTL expiry (sliding) |
| `rate:concurrent:{keyId}` | 30 s | No | — | TTL expiry (safety net) |
| `idem:{key}` | 24 h | No | — | TTL expiry |
| `ws:buffer:{channel}` | 1 h | No | — | TTL expiry + LTRIM cap |
| `lock:{resource}` | 30 s | Yes (per acquire) | caller-controlled | TTL expiry (auto-release) |
| `_keys` (index set) | No TTL | — | — | Manual DEL on workspace flush |

**Eviction policy configuration** (Redis `maxmemory-policy`):
- Default: `volatile-lru` — evict keys with TTL set using LRU approximation.
- Working memory (`work:*`) uses TTL and should not be LRU-evicted early. If memory pressure is
  high, increase `maxmemory` rather than switching to `allkeys-lru`.
- Session turns (`sess:*:turns`) are NEVER LRU-evicted by design (information loss on eviction).
  Enforce this via Redis 7 ACL: workspace prefix with `NOEVICT` if available, or ensure
  `maxmemory` headroom is maintained.

---

## 4. Memory Budget Per Domain

### Per-Workspace Estimation

| Domain | Per-Workspace Formula | Typical (100 facts, 5 sessions) | Cap |
|---|---|---|---|
| `actr` sorted set | `num_agents × top500_facts × 40 bytes` | ~200 KB | 500 facts/agent |
| `hot:fact:{id}` | `cached_facts × avg_hit_size (2 KB)` | ~500 KB | 1000 cached facts |
| `sess:{id}:turns` | `sessions × avg_turns × turn_size (500 B)` | ~500 KB | policy.maxTurns=50 |
| `cache:recall:{hash}` | `cached_queries × avg_result (10 KB)` | ~100 KB | 5000 entries LRU |
| `work:{agentId}:{key}` | `agents × work_keys × value_size (varies)` | ~50 KB | bounded by TTL |
| `idem:{key}` | `requests/24h × avg_body (1 KB)` | ~1 MB | 24 h TTL auto-reap |
| `rate:*` | `api_keys × 3 windows × 8 bytes` | ~10 KB | negligible |
| `ws:buffer:{channel}` | `channels × 1000 events × 200 B` | ~200 KB | LTRIM cap |

### Total Budget Targets

```
Per-workspace default cap:   50 MB  (MNEMO_REDIS_PER_WORKSPACE_MAX_MB)
Team mode total:             256 MB – 1 GB
Cloud mode total:            1 GB – 4 GB
```

### Redis Memory Breakdown (reference: 10 workspaces, 50 active agents, 5000 cached queries)

```
Component                    Memory     Notes
──────────────────────────────────────────────────────
L1 recall cache              100–500 MB  5k entries/workspace × N workspaces
Hot tier (ACT-R scores)       50–200 MB  Sorted sets, top-500 facts/workspace
Session buffers (L1)          50–200 MB  Active sessions × turns
Rate limit counters               10 MB  Per-key token buckets
Idempotency keys                  20 MB  24 h TTL, UUID → response body
Working memory (L0)            20–100 MB  Tool outputs, checkpoints
──────────────────────────────────────────────────────
Total (team):                 250 MB – 1 GB
Total (cloud):                  1 GB – 4 GB
```

### Node.js Process Memory (Redis client side)

```
Redis connection pool    5 MB    20 connections
```

---

## 5. Workspace Flush Protocol

Two strategies; choose based on scale.

### Strategy A — SCAN (no extra storage, O(N) scan)

Suitable for workspaces with < 10 000 keys.

```bash
# Flush all keys for workspace e3b0c442
cursor=0
while true; do
  result=$(redis-cli SCAN $cursor MATCH "mnemo:e3b0c442:*" COUNT 1000)
  cursor=$(echo "$result" | head -1)
  keys=$(echo "$result" | tail -n +2)
  
  if [ -n "$keys" ]; then
    echo "$keys" | xargs redis-cli DEL
  fi
  
  if [ "$cursor" = "0" ]; then break; fi
done
```

Pseudocode:
```
cursor = 0
REPEAT:
  cursor, keys = SCAN cursor MATCH mnemo:{ws}:* COUNT 1000
  if len(keys) > 0: DEL ...keys (pipeline in batches of 100)
UNTIL cursor == 0
```

### Strategy B — Key Index Set (O(1) lookup, extra ~1 MB overhead)

On every Redis write, register the key in the workspace index:

```bash
# On write
SADD mnemo:e3b0c442:_keys "mnemo:e3b0c442:cache:recall:a1b2c3"

# Flush workspace
keys=$(redis-cli SMEMBERS mnemo:e3b0c442:_keys)
echo "$keys" | xargs redis-cli DEL
redis-cli DEL mnemo:e3b0c442:_keys
```

### Tradeoff Analysis

| Factor | SCAN | Key Index Set |
|---|---|---|
| Extra storage | None | ~1 MB/workspace (Set overhead) |
| Flush time | O(N) — scans entire keyspace | O(1) lookup + O(K) bulk DEL |
| Write overhead | None | One extra SADD per write |
| Correctness | Always complete | Leaks if SADD is skipped or key TTL fires |
| Cross-shard (Cluster) | Needs fan-out to all shards | All keys co-located via hash tag |

**Recommendation:** Use SCAN for team mode. Use the key index for cloud mode where workspaces can
have millions of keys and flush performance matters.

---

## 6. Invalidation Strategy

### Trigger: Fact Write / Update / Delete

```
1. Write fact to PostgreSQL (primary write).
2. DEL matching hot-tier key (if exists):
     DEL mnemo:{ws}:hot:fact:{factId}
3. Publish invalidation event:
     PUBLISH mnemo:{ws}:pub:invalidate
       '{"type":"fact","id":"fact_abc","action":"created"}'
4. Subscribers on all pods receive the message.
5. Each pod deletes its own matching recall cache keys.
```

### Subscriber Cache Invalidation (per pod)

```
ON MESSAGE { type: "fact", id, action }:
  // Targeted: delete only recall caches that could include this fact
  // Nuclear option (simpler, higher eviction rate):
  SCAN 0 MATCH mnemo:{ws}:cache:recall:* COUNT 500
  → batch DEL all matching keys

  // Targeted option (requires query hash registry — higher complexity):
  DEL mnemo:{ws}:cache:recall:{knownHash1}
  DEL mnemo:{ws}:cache:recall:{knownHash2}
  ...
```

**Recommendation:** Use the nuclear option (scan + delete all `cache:recall:*` for the workspace)
unless query volume is very high and the recall cache hit rate is measurable. The nuclear approach
is simpler and correct; targeted invalidation requires a secondary index of query hashes to fact
IDs.

### Write-Through Flow

```
Client WRITE request
       │
       ▼
  Write to PG (primary)
       │
       ├── DEL mnemo:{ws}:hot:fact:{id}       (immediate)
       │
       └── PUBLISH mnemo:{ws}:pub:invalidate  (immediate, fire-and-forget)
                  │
                  ├── Pod A subscriber → DEL cache:recall:* for workspace
                  ├── Pod B subscriber → DEL cache:recall:* for workspace
                  └── Pod C subscriber → DEL cache:recall:* for workspace
```

The `actr` sorted set is updated asynchronously: either via the hourly decay cron
(`mnemo.actr.decay`) or on the collapse hot-promotion step (+0.5 boost). It is NOT invalidated on
individual fact writes — the activation score is a derived metric, not a read-through cache.

---

## 7. Pub/Sub Channel Conventions

| Channel | Message Format | Subscribers | Purpose |
|---|---|---|---|
| `mnemo:{ws}:pub:invalidate` | `{type, id, action}` | All server pods for this workspace | Evict stale recall cache and hot fact entries |
| `mnemo:{ws}:pub:events` | `{event, workspaceId, payload}` | WebSocket gateway pods | Broadcast live fact/task/session events to connected clients |

### Full Message Schemas

**`pub:invalidate` message:**
```typescript
interface InvalidationMessage {
  type: "fact" | "session" | "task" | "strategy" | "decision";
  id: string;          // entity ID
  action: "created" | "updated" | "deleted" | "collapsed";
}
```

**`pub:events` message:**
```typescript
interface LiveEvent {
  event: string;       // e.g. "fact.created", "task.updated", "session.collapsed"
  workspaceId: string;
  timestamp: number;   // Unix ms
  payload: Record<string, unknown>;
}
```

### Subscriber Lifecycle

- Each server pod maintains **one persistent SUBSCRIBE connection** for each workspace it is
  actively serving. Subscriptions are registered on first request for a workspace and torn down
  when the pod sheds that workspace (or on graceful shutdown).
- The SUBSCRIBE connection is separate from the command pool — never mix SUBSCRIBE with GET/SET on
  the same connection.
- On reconnect, the pod re-subscribes to all active workspace channels.

---

## 8. Graceful Degradation Without Redis

When `REDIS_URL` is unset or Redis becomes unreachable, each domain falls back independently.
No domain crashes the server.

| Domain | Redis Healthy | Redis Unavailable | Degraded Behavior |
|---|---|---|---|
| Working memory L0 | Redis STRING | In-process `Map` | Bounded 10 MB; TTL enforced via `setTimeout` |
| Recall cache L1 | Redis STRING | In-process LRU | `lru-cache` (5000 entries max) |
| Hot tier (ACT-R) | Redis ZSET | **Disabled** | Tier 1 queries fall through to Tier 2/3 (~15–200 ms vs ~5 ms) |
| Session turns/activity | Redis LIST/ZSET | **503 for Redis-dependent mutations** | Start/turn/pin/collapse/discard remain gated; exact scratch is exempt |
| Session scratch | Legacy hash deletion only | PostgreSQL unchanged | Exact replacement/read remains available; no Redis scratch read/write or idempotency access |
| Rate limiting | Redis STRING | In-process bucket | Token bucket per process; not shared across pods |
| Pub/Sub | Redis PUBLISH | In-process EventEmitter | Cache invalidation is local only; cross-pod staleness possible |
| Idempotency | Redis STRING | PG fallback table | `mnemo_idempotency` PG table (correct, ~2 ms slower) |
| Distributed locks | Redis NX | In-process `AsyncMutex` | Single-process safe; cross-pod duplicate execution possible |
| WebSocket buffer | Redis LIST | In-process RingBuffer | Not shared; reconnecting clients get empty replay |

### Degradation Matrix

```
PG healthy + Redis healthy    → Full stack (L0–L5)
PG healthy + Redis degraded   → L0/L1 fall to in-process Maps (10 MB cap)
                                L2 hot tier disabled; recall uses L3+L4 (~100 ms)
PG healthy + Redis gone       → Same as above + Redis-dependent session mutations return 503;
                                exact scratch replacement remains available
PG degraded + Redis healthy   → Stale reads possible; writes go to primary only
PG gone                       → 503 on everything (fatal; Redis cannot substitute PG)
```

### Feature Flags Controlled by Redis Availability

These flags are computed at startup and re-evaluated on each health check:

```
MNEMO_REDIS_ENABLED       true  if REDIS_URL set and Redis ping succeeds
MNEMO_HOT_TIER_ENABLED    true  if MNEMO_REDIS_ENABLED = true
MNEMO_SESSIONS_ENABLED    true  if MNEMO_REDIS_ENABLED = true
```

---

## 9. Cluster Mode Considerations

Redis Cluster is relevant when total Redis memory exceeds ~4 GB (typically cloud mode with many
workspaces).

### Hash Tag Requirement

In Redis Cluster, keys are distributed across shards by hashing the key. Multi-key commands
(`MGET`, `DEL` with multiple keys, Lua scripts, `MULTI/EXEC`) only work when all keys are on the
same shard.

Mnemosyne keys naturally include the workspace UUID in the second segment. Wrap it in `{}` to
force it as the hash tag:

```
# Without cluster hash tag (default, standalone mode):
mnemo:e3b0c442:sess:7f2a1b3c

# With cluster hash tag (cluster mode — all workspace keys on same shard):
mnemo:{e3b0c442}:sess:7f2a1b3c
mnemo:{e3b0c442}:actr:a9f3d2e1
mnemo:{e3b0c442}:hot:fact:fact_abc
```

When `REDIS_CLUSTER_MODE=true`, the `CacheAdapter` prefixes all keys with the hash-tagged form.

### Cross-Workspace (Admin) Operations

Flushing all workspaces or global metrics requires fan-out across all shards:

```bash
# Get all cluster nodes
redis-cli CLUSTER NODES | awk '{print $2}' | cut -d@ -f1

# Run SCAN on each shard
for node in $nodes; do
  redis-cli -h $host -p $port SCAN 0 MATCH "mnemo:*" COUNT 1000
done
```

Application code for admin flush-all uses the cluster client's built-in shard enumeration rather
than `SCAN` against a single node.

### MULTI/EXEC in Cluster Mode

With hash tags, all keys for a single workspace are on the same shard, so `MULTI/EXEC` works for
workspace-scoped operations (session create, hot-tier rebuild). It does NOT work across workspaces.

---

## 10. Security

### Authentication

```bash
# Required in team and cloud mode
REDIS_PASSWORD=<strong-random-password>

# Connection string with auth
redis://:${REDIS_PASSWORD}@redis:6379/0
redis-sentinel://:${REDIS_PASSWORD}@sentinel-0:26379,sentinel-1:26379,sentinel-2:26379/mnemosyne-master
```

### TLS In-Transit (Redis 7 Native TLS)

```yaml
# Redis server config
tls-port 6380
tls-cert-file /certs/redis.crt
tls-key-file  /certs/redis.key
tls-ca-cert-file /certs/ca.crt
tls-auth-clients yes   # require client cert (mTLS)
```

Redis client connection (Node.js `ioredis`):
```typescript
const redis = new Redis({
  tls: {
    cert: fs.readFileSync("/certs/client.crt"),
    key:  fs.readFileSync("/certs/client.key"),
    ca:   fs.readFileSync("/certs/ca.crt"),
  }
});
```

### ACL Per Workspace Prefix (Redis 7 ACLs)

Each application account is scoped to its workspace prefix:

```bash
# Create ACL rule for workspace e3b0c442
ACL SETUSER mnemo-e3b0c442 on >password \
  ~mnemo:e3b0c442:* \
  +GET +SET +DEL +EXPIRE +TTL +HGET +HSET +HGETALL +HDEL \
  +RPUSH +LRANGE +LTRIM \
  +ZADD +ZRANGEBYSCORE +ZINCRBY +ZREM +ZREMRANGEBYRANK \
  +SADD +SMEMBERS \
  +PUBLISH +SUBSCRIBE \
  +SCAN

# Admin account (ops / flush / rebuild jobs)
ACL SETUSER mnemo-admin on >admin-password \
  ~mnemo:* \
  +@all
```

### Key Content Rules

- Workspace IDs in keys are always UUIDs (e.g. `e3b0c442-...`) — never human-readable workspace
  names that could leak tenant identity via key inspection.
- Session turn content (the `turns` list) is sensitive. If `encryption.enabled = true`, each
  turn's `content` field is encrypted using the workspace DEK (AES-256-GCM) before `RPUSH`. The
  DEK is derived from the master KEK (`ENCRYPTION_MASTER_KEY`) + workspace ID.
- Redis keys themselves contain no PII — only opaque IDs.

### Network Isolation

- Redis must not be exposed to the public internet. Bind to internal network only (`bind 127.0.0.1`
  or private VPC subnet).
- In Docker Compose, Redis is on the internal `mnemo_net` network only.
- In Kubernetes, Redis pods have no `NodePort` or `LoadBalancer` service — `ClusterIP` only.

---

## 11. Operational Reference

### Key Health Check

```bash
# Ping
redis-cli -a $REDIS_PASSWORD PING

# Memory usage
redis-cli -a $REDIS_PASSWORD INFO memory | grep used_memory_human

# Workspace key count (approximate)
redis-cli -a $REDIS_PASSWORD DBSIZE

# Inspect specific workspace
redis-cli -a $REDIS_PASSWORD SCAN 0 MATCH "mnemo:e3b0c442:*" COUNT 100
```

### Hot-Tier Rebuild (Manual)

Run when Redis hot tier is empty after a Redis restart and the `mnemo-hot-rebuild` CronJob has not
fired yet:

```bash
# Trigger rebuild CronJob immediately (Kubernetes)
kubectl create job --from=cronjob/mnemo-hot-rebuild mnemo-hot-rebuild-manual

# Or hit the admin endpoint
curl -X POST https://api.example.com/admin/hot-tier/rebuild \
  -H "Authorization: Bearer $MNEMO_ADMIN_KEY" \
  -d '{"workspaceId":"e3b0c442"}'
```

### Idempotency Key Reap (Manual)

Keys auto-expire after 24 h via Redis TTL. The `mnemo-idempotency-reap` CronJob handles the PG
fallback table (not Redis). No manual Redis cleanup is required for idempotency keys.

### Connection Pool Configuration

```typescript
// Team mode
{
  maxConnections: 10,
  connectTimeout: 3000,     // ms
  commandTimeout: 2000,     // ms
  lazyConnect: true,        // do not fail on boot if Redis is down
  retryStrategy: "exponential",  // 100ms → 200ms → 400ms, max 5s
}

// Cloud mode (Sentinel)
{
  sentinels: [
    { host: "sentinel-0", port: 26379 },
    { host: "sentinel-1", port: 26379 },
    { host: "sentinel-2", port: 26379 },
  ],
  name: "mnemosyne-master",
  maxConnections: 50,
  pipelining: true,
  enableReadyCheck: true,
  enableOfflineQueue: true,  // queue commands during reconnect window
}
```

### Backup and Recovery

| Layer | Backup | Recovery |
|---|---|---|
| RDB snapshot | Every 1 h | `redis-server --dbfilename dump.rdb` |
| AOF | Enabled, `appendfsync everysec` | Replay AOF on restart |
| Hot tier loss | Acceptable | `mnemo-hot-rebuild` CronJob restores from PG |
| Session Redis loss | Acceptable for durability | Turns and scratch remain in PostgreSQL; Redis buffers/activity can rebuild or expire |
| Sentinel failover | < 5 s detection, < 10 s promotion | Automatic; app reconnects via `enableOfflineQueue` |
