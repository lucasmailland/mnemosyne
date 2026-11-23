# @mnemo-ai/adapter-redis

**English** · [Español](README.es.md)

> **AI pointer:** Implements CacheAdapter port via Redis/ioredis. Used for hot-tier recall (last N turns) and session caching.
>
> **Depends on:** @mnemo-ai/types, ioredis
>
> **Exposes:** RedisCacheAdapter
>
> **Status:** STABLE
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/internals/ALGORITHMS.md](../../docs/internals/ALGORITHMS.md)

Redis / Valkey cache adapter implementing the `CacheAdapter` port from
`@mnemo-ai/types`. Provides the hot-tier recall cache, embedding cache,
and session state storage for Mnemosyne v3.

---

## Architecture Position

```
@mnemo-ai/core  (CacheAdapter port)
       ↑
@mnemo-ai/adapter-redis  (RedisCacheAdapter)
       ↓
Redis / Valkey  (hot-tier, in-memory)
```

Redis sits in front of Postgres as the hot-tier store. Frequently recalled facts
are kept in a sorted set ranked by ACT-R activation score, so repeat queries are
served without hitting Postgres or pgvector.

---

## Implementation Status

| Component | Status | Notes |
|---|---|---|
| `CacheAdapter` interface | Done | Defined in `@mnemo-ai/types` |
| `RedisCacheAdapter` class | Done | Redis/Valkey-backed; covered by unit tests |
| `get` / `set` / `delete` / `deletePattern` | Done | Implemented |
| `zadd` / `zrangeByScore` | Done | ACT-R hot-tier sorted set |
| TTL | Done | Via `set` options (`CacheSetOpts`) |
| Wired to live server | Done | Injected into v3 core at server boot when `MNEMO_REDIS_URL` is set (`packages/server/src/index.ts`); recall falls through to the cold cascade when unset. |

---

## Port Interface

```typescript
interface CacheAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, opts?: CacheSetOpts): Promise<void>;
  delete(key: string): Promise<void>;
  deletePattern(pattern: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zrangeByScore(key: string, min: number, max: number, opts?: { limit?: number; offset?: number }): Promise<string[]>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  info(): Promise<CacheInfo>;
}
```

---

## Installation

```bash
pnpm add @mnemo-ai/adapter-redis
```

Peer dependency: `ioredis` (^5)

Compatible with Redis >= 6.2 and Valkey >= 7.2.

---

## Key Namespacing Convention

All cache keys follow a structured namespace to prevent collisions across
workspaces and key types:

```
mnemo:{workspaceId}:{type}:{id}
```

Examples:

| Key | Description |
|---|---|
| `mnemo:ws_abc:session:sess_xyz` | Session state for active session |
| `mnemo:ws_abc:embed:sha256_of_text` | Cached embedding vector |
| `mnemo:ws_abc:hottier:facts` | ACT-R sorted set for hot facts |
| `mnemo:ws_abc:fact:fact_123` | Single fact read-through cache entry |

---

## TTL Tiers

| Tier | TTL | Rationale |
|---|---|---|
| Session keys | 24 hours | Sessions expire after a day of inactivity |
| Embedding cache | 7 days | Embeddings are expensive; text rarely changes |
| Hot-tier sorted set | 24 hours | Refreshed on each recall hit |
| API key validation cache | 5 minutes | Short-lived to pick up revocations quickly |

---

## Eviction Policy

Set `maxmemory-policy allkeys-lru` in your Redis / Valkey config.
This ensures that under memory pressure the least-recently-used keys are evicted
first, preserving the hottest facts in the sorted set.

```conf
maxmemory 512mb
maxmemory-policy allkeys-lru
```

---

## Quick Init (once wired)

```typescript
import { RedisCacheAdapter } from "@mnemo-ai/adapter-redis";

// Connect by URL
const cache = new RedisCacheAdapter({ url: process.env.REDIS_URL! });

// Or by host/port
const cache2 = new RedisCacheAdapter({ host: "127.0.0.1", port: 6379 });

// Hot-tier recall sorted set
await cache.zadd("mnemo:ws_abc:hottier:facts", 0.92, "fact_123");
const hotFacts = await cache.zrangeByScore("mnemo:ws_abc:hottier:facts", 0, 1.0);
```

---

## Notes

- `publish` / `subscribe` are used for real-time invalidation signals when a
  fact is updated or deleted, so sibling server instances can flush stale cache
  entries without a full restart.
- The embedding cache key is the SHA-256 hash of the input text; identical text
  never re-embeds within the TTL window.
- The adapter owns its own ioredis connection; pass `{ url }` or `{ host, port }` in
  the config and let it manage the lifecycle. Call `close()` on shutdown.
