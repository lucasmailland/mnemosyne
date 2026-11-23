# How to Add a New StorageAdapter

**English** · [Español](ADD_A_STORAGE_ADAPTER.es.md)

## 1. When to Write a New Adapter

Write a new adapter when you need a **fundamentally different storage backend** — for example:

- **SQLite** for edge/embedded deployments (no Postgres available)
- **In-memory** for unit tests that must run without a database

Do NOT write a new adapter just to point at a different Postgres instance. Pass a different `DATABASE_URL` to `createDrizzleClient` in `DrizzleStorageAdapter` instead — that is exactly what it is designed for.

---

## 2. The StorageAdapter Interface

Defined in `packages/types/src/ports.ts` at `export type StorageAdapter`. As of the
`segregate-storage-ports` change, `StorageAdapter` is declared as an intersection of 43 named
domain sub-ports (`SessionPort`, `FactPort`, `RelationPort`, `WebhookPort`, `LifecyclePort`, …) —
the flat member set is unchanged, so implementing `StorageAdapter` still means implementing every
method below exactly as before. Each sub-port is exported individually from `@mnemo-ai/types`
and is the **supported dependency type for new consumers** that only need part of the storage
surface — e.g. a route that only reads facts can depend on `FactPort` instead of the full
`StorageAdapter`, narrowing what it needs to mock in tests and what it can break by accident.
Existing consumers (adapters, core dispatchers, routes already typed against `StorageAdapter`)
require **zero change** — the intersection resolves to the identical structural type, so
`implements StorageAdapter` and `storage: StorageAdapter` keep compiling unmodified.

**Capabilities** (declare what your backend supports):

| Field            | Meaning                                      |
| ---------------- | -------------------------------------------- |
| `vectorSearch`   | Can search by embedding vectors              |
| `ftsSearch`      | Full-text search support                     |
| `bitemporal`     | Tracks `valid_from` / `valid_to` intervals   |
| `graphExpansion` | Can traverse relations                       |
| `transactions`   | Supports atomic multi-write transactions     |
| `rls`            | Enforces workspace isolation at the DB layer |

**Required methods** (grouped):

- **Session**: `createSession`, `appendTurn`, `listTurns`, `closeSession`, `getSession`
- **Facts**: `createFact`, `getFact`, `updateFact`, `archiveFact`, `queryFacts`
- **Decisions / Episodes / Entities / Strategies / Workflows / Skills / Tasks / Events / Reasoning** — each has the same four-method pattern: `create`, `get`, `update/archive`, `query`
- **Relations**: `createRelation`, `getRelations`, `updateRelationStrength`, `deleteRelation`
- **Worth governance**: `updateWorth`, `recordRecall` — TD(λ) bookkeeping
- **Audit** (append-only): `appendAuditEntry`
- **Outbox** (transactional side-effects): `appendOutbox`, `claimOutbox`, `markOutboxProcessed`, `markOutboxFailed`, `reapDeadLetters`, `purgeOutbox`
- **Lifecycle**: `healthCheck`, `close`

**Contract invariants** every adapter must uphold:

- `getFact(id, workspaceA)` returns `null` when the fact belongs to `workspaceB`
- Sensitivity defaults to `"internal"` when not set
- Decimal `confidence` must not be truncated (store as REAL/NUMERIC, not INTEGER)
- Outbox entries must be observable immediately after `createFact` (same transaction)
- `healthCheck()` must never throw

---

## 3. Step-by-Step: Implement the Adapter

### 3a. Create the package (or a single file)

For a self-contained adapter, a single file is fine:

```
packages/adapter-sqlite/src/SqliteStorageAdapter.ts
```

### 3b. Skeleton

```typescript
import type {
  StorageAdapter,
  StorageCapabilities,
  CreateFactInput,
  // ... all other Input / Filter types
} from "@mnemo-ai/types";

export class SqliteStorageAdapter implements StorageAdapter {
  readonly capabilities: StorageCapabilities = {
    vectorSearch: false,
    ftsSearch: false,
    bitemporal: false,
    graphExpansion: false,
    transactions: true,
    rls: false, // enforce isolation in application code instead
  };

  // ── Facts ────────────────────────────────────────────────────────────────────
  async createFact(input: CreateFactInput) {
    // 1. Generate a cuid2 id (import { createId } from "@paralleldrive/cuid2")
    // 2. Default input.sensitivity to "internal" if not set
    // 3. Insert the row, atomically append an outbox entry in the same tx
    // 4. Return the full MnemoFact object
    throw new Error("not implemented");
  }

  async getFact(id: string, workspaceId: string) {
    // Return null — not throw — when the row is missing OR belongs to a different workspace
    throw new Error("not implemented");
  }

  // ... implement all remaining methods following the same pattern ...

  async healthCheck() {
    try {
      // run a trivial no-op query
      return { status: "ok" as const, latencyMs: 0 };
    } catch {
      return { status: "down" as const, latencyMs: -1 };
    }
  }

  async close() {
    /* close DB connection */
  }
}
```

**Tip**: copy `InMemoryStorageAdapter` from `packages/types/src/testing/InMemoryStorageAdapter.ts` as a starting skeleton — it implements every method and handles the tricky edge cases (pagination, workspace isolation without DB-level RLS, outbox capture).

---

## 4. Run the Contract Test Suite

The contract tests live in `packages/types/src/testing/StorageAdapterContract.ts`. They verify every invariant listed in §2 above.

In your adapter's test file:

```typescript
// packages/adapter-sqlite/src/__tests__/SqliteStorageAdapter.contract.test.ts
import { runStorageAdapterContractTests } from "@mnemo-ai/types/testing";
import { SqliteStorageAdapter } from "../SqliteStorageAdapter.js";

runStorageAdapterContractTests(() => new SqliteStorageAdapter(":memory:"));
```

Run:

```bash
pnpm --filter @mnemo-ai/adapter-sqlite test
```

All tests must pass before the adapter is considered complete. The most common failures are:

- Cross-workspace isolation (`RLS: workspace A cannot read workspace B facts`)
- Decimal truncation (`worth is a decimal`)
- Missing outbox entry on `createFact`

---

## 5. Wire the Adapter in

The composition root is `packages/server/src/deps.ts` — but it composes a `CoreLike`, not `StorageAdapter` directly. The `StorageAdapter` is consumed by `@mnemo-ai/core` via `CoreContext.storage`.

In your server bootstrap (e.g. `server.ts` or `main.ts`):

```typescript
import { SqliteStorageAdapter } from "@mnemo-ai/adapter-sqlite";
import { createCore } from "@mnemo-ai/core";

const storage = new SqliteStorageAdapter("./mnemosyne.db");

const core = createCore({
  storage,
  // ... vector, embed, outbox, logger, telemetry, config
});

const server = createServer({ core, apiKeys, embedModel: "..." });
```

The `CoreContext` type (defined in `packages/core/src/v3/context.ts`) accepts any value that satisfies the `StorageAdapter` interface — there is no concrete class import required.

---

## 6. What NOT to Do

- **Do not import from `drizzle-orm/postgres-js` or `redis` inside your adapter** — those are implementation details of the Postgres and Redis adapters. Your adapter must only depend on `@mnemo-ai/types` plus your chosen DB driver.
- **Do not import `DrizzleStorageAdapter` and extend it** — the Drizzle schema is Postgres-specific (pgvector, JSONB, GENERATE ALWAYS columns). Extending it for a different DB will break.
- **Do not bypass `workspaceId` checks** — every `get*` and `query*` method must filter by `workspaceId`. The contract test `RLS: workspace A cannot read workspace B facts` will catch a missing check, but a missed predicate on a `query*` path leaks data silently in production.
- **Do not skip the outbox** — the transactional outbox is how downstream indexers (vector, FTS, consolidation) learn about new facts. An adapter that creates facts without appending to the outbox will silently break recall.
