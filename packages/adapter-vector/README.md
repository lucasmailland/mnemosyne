# @mnemo-ai/adapter-vector

**English** · [Español](README.es.md)

> **AI pointer:** Implements VectorAdapter port via pgvector HNSW index. Handles embedding storage and similarity search.
>
> **Depends on:** @mnemo-ai/types, postgres
>
> **Exposes:** PgVectorAdapter
>
> **Status:** STABLE
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/internals/ALGORITHMS.md](../../docs/internals/ALGORITHMS.md)

pgvector adapter implementing the `VectorAdapter` port from `@mnemo-ai/types`.
Provides dense-vector nearest-neighbor search for semantic recall, storing
embeddings in PostgreSQL's `pgvector` extension alongside the relational data
managed by `@mnemo-ai/adapter-postgres`.

---

## Architecture Position

```
@mnemo-ai/core  (VectorAdapter port)
       ↑
@mnemo-ai/adapter-vector  (PgVectorAdapter)
       ↓
PostgreSQL + pgvector extension
       (same Postgres instance as adapter-postgres)
```

This adapter shares the same Postgres connection as `@mnemo-ai/adapter-postgres`.
There is no separate vector database — pgvector runs as an extension in the same
instance, which keeps the operational footprint small and eliminates the need to
synchronize two separate data stores.

---

## Implementation Status

| Component                       | Status | Notes                                                                         |
| ------------------------------- | ------ | ----------------------------------------------------------------------------- |
| `VectorAdapter` interface       | Done   | Defined in `@mnemo-ai/types`                                                  |
| `PgVectorAdapter` class         | Done   | `halfvec(1536)` cosine over pgvector                                          |
| Upsert / search / delete / bulk | Done   | Implemented; covered by unit tests                                            |
| HNSW index + query              | Done   | `m=16`, `ef_construction=64`                                                  |
| Wired to live server            | Done   | Injected into the v3 core at server boot (`packages/server/src/index.ts:249`) |

---

## HNSW Index Parameters

The vector index is tuned for OpenAI `text-embedding-3-small` and Voyage AI
embeddings, both of which produce 1536-dimensional vectors stored as `halfvec`
to halve storage without meaningful accuracy loss.

```sql
CREATE INDEX mnemo_fact_embedding_idx
  ON mnemo_fact
  USING hnsw (embedding halfvec_ip_ops)
  WITH (m = 16, ef_construction = 64);
```

| Parameter         | Value                 | Rationale                                    |
| ----------------- | --------------------- | -------------------------------------------- |
| `m`               | 16                    | Balanced graph connectivity vs. index size   |
| `ef_construction` | 64                    | Build-time recall quality vs. indexing speed |
| Type              | `halfvec(1536)`       | Half-precision float, halves storage         |
| Distance          | Inner product (`<#>`) | Matches normalized embedding conventions     |

For higher-recall workloads, increase `ef_search` at query time without
rebuilding the index: `SET hnsw.ef_search = 200;`

### Shared databases: pgvector >= 0.8 required in production

The HNSW index is global, while every search is filtered by workspace (RLS plus
an explicit predicate), owner and kind **after** the index returned its
`ef_search` candidates. In a database shared by many workspaces, a workspace
whose vectors are not the nearest to the query could get fewer than `topK` hits,
or none.

On every search the adapter therefore runs, inside the query's transaction,
`SET LOCAL hnsw.iterative_scan = strict_order` and
`SET LOCAL hnsw.max_scan_tuples = 20000` (`maxScanTuples` option). `strict_order`
keeps the ranking exact; `relaxed_order` is no faster here and may reorder rows.
The scan stops at `max_scan_tuples`, so a very sparse workspace in a huge
database can still come back short: raise `maxScanTuples` for that case.

Iterative scans need **pgvector >= 0.8** (`SELECT extversion FROM pg_extension
WHERE extname = 'vector'`). The adapter detects the version once (call `init()`
at boot to log it early). On older versions it logs a warning and falls back to
`ef_search = 1000` for every search, which only narrows the problem. Run
pgvector >= 0.8 in production. `iterativeScan: false` forces the fallback.

---

## Port Interface

```typescript
interface VectorAdapter {
  search(input: VectorSearchInput): Promise<VectorSearchHit[]>;
  upsert(id: string, vector: Float32Array, metadata?: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByFilter(filter: VectorFilter): Promise<number>;
  healthCheck(): Promise<HealthStatus>;
}
```

---

## Installation

```bash
pnpm add @mnemo-ai/adapter-vector
```

Peer dependency: `postgres` (postgres.js)
Requires: PostgreSQL >= 15 with `pgvector` extension enabled

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

---

## Quick Init (once wired)

```typescript
import { PgVectorAdapter } from "@mnemo-ai/adapter-vector";

const vector = new PgVectorAdapter({
  connectionString: process.env.DATABASE_URL!,
  efSearch: 100, // optional — HNSW ef_search parameter
});

// Upsert an embedding
await vector.upsert("fact_abc123", new Float32Array(embeddingArray));

// Semantic search
const hits = await vector.search({
  vector: new Float32Array(queryEmbedding),
  workspaceId: "ws_abc123",
  limit: 10,
});
```

---

## Notes

- This adapter does **not** generate embeddings — that is the `EmbedAdapter`'s
  responsibility. Call `EmbedAdapter.embed()` first, then pass the resulting
  vector to `VectorAdapter.upsert()`.
- Vectors are stored per-fact. Fact deletion cascades to embedding deletion via
  the `deleteByFilter` method (not via a DB foreign key).
- pgvector's HNSW index does not support partial indexing by workspace; the
  `workspaceId` filter is applied as a post-scan predicate.
