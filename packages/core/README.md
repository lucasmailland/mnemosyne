# @mnemo-ai/core

**English** · [Español](README.es.md)

> **AI pointer:** Pure cognitive engine — no I/O, no infrastructure imports in src/v3/. All I/O via port interfaces injected through CoreContext.
>
> **Depends on:** @mnemo-ai/types only (in src/v3/). Legacy v2 code outside v3/ has documented drizzle debt.
>
> **Exposes:** recallCold, recallHot, remember, forget, withMnemoTx, collapseSession, mnemo-migrate CLI
>
> **Status:** STABLE (v3 zone); ALPHA (session extraction, consolidation not wired)
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/internals/ALGORITHMS.md](../../docs/internals/ALGORITHMS.md)

The cornerstone of the Mnemosyne stack. Everything else (`@mnemo-ai/server`, `@mnemo-ai/mcp`, `@mnemo-ai/client-ts`) is built on top.

## What this package contains

- **`createCore(deps, config?)`** (`@mnemo-ai/core/cognitive`) — the main factory. Takes injected ports (`storage`, `vector`, `embed`, `outbox`, `logger`, `telemetry`, …) and returns a `MnemoCore` object with `remember`/`recall`/`forget`/`collapseSession`/etc.
- **Cognitive primitives** — `mnemo_fact`, `mnemo_decision`, `mnemo_entity`, `mnemo_episode`, `mnemo_relation`, `mnemo_citation`, `mnemo_strategy` — each with its own decay class and graph role.
- **7-stage hybrid recall** — full-text (`ts_rank_cd`) lexical + dense `halfvec(1536)` cosine + Memory-Graph BFS + optional LLM-based rerank. HyDE query expansion. Hot tier via ACT-R sorted set.
- **Session pipeline** — `startSession`, `appendTurn`, `collapseSession` — conversations become structured memories.
- **Bitemporal facts** — every fact carries `valid_time` (a range — when it's true in the world) and `transaction_time` (when the system learned it). `forget()` closes validity ranges; history is never destroyed.
- **RLS isolation** — `withMnemoTx(workspaceId, fn)` opens a transaction that sets `app.workspace_id` and downgrades the role to `app_user`. Postgres `FORCE ROW LEVEL SECURITY` guarantees isolation at the database layer.
- **PII detection + redaction** — regex gate before any data reaches the embedding pipeline.
- **Poisoning detection** — pre-embedding ingest gate.
- **Memory Graph** — `buildGraphData()` / `buildGraphQuery()` to materialize the typed entity/episode/decision graph for a workspace.
- **`mnemo-migrate` CLI** — applies the bundled SQL migrations against any Postgres database.

## Key Exports

```typescript
// Cognitive engine (primary entry point — @mnemo-ai/core/cognitive)
export { createCore } from "@mnemo-ai/core/cognitive";
export type { MnemoCore, CoreDeps, CoreConfig } from "@mnemo-ai/core/cognitive";

// Auth bootstrap (@mnemo-ai/core)
export { createApiKeyLookup, assertSafeDbRole } from "@mnemo-ai/core";

// RLS transaction helper
export { withMnemoTx } from "@mnemo-ai/core";

// Legacy v1/v2 modules (entity/episode/citation/graph/review/consolidation/
// primitives/…) remain exported from the package root for backward
// compatibility but have no in-repo caller as of flatten-legacy-dual-core
// Phase 7 — @mnemo-ai/server's HTTP routes are 100% on the cognitive engine
// + @mnemo-ai/adapter-postgres's StorageAdapter.
```

## Install

```bash
pnpm add @mnemo-ai/core
```

Peer deps (only if you use the Drizzle/postgres.js surface directly):

```bash
pnpm add drizzle-orm postgres
```

## Quick start

`createCore` takes injected ports rather than a bare `databaseUrl` — see
`@mnemo-ai/adapter-postgres`, `@mnemo-ai/adapter-vector`, and
`@mnemo-ai/server/src/index.ts` for the real wiring. Minimal shape:

```ts
import { createCore } from "@mnemo-ai/core/cognitive";
import { DrizzleStorageAdapter, createDrizzleClient } from "@mnemo-ai/adapter-postgres";
import { PgVectorAdapter } from "@mnemo-ai/adapter-vector";

const { db, pgClient } = createDrizzleClient(process.env.DATABASE_URL!);
const storage = new DrizzleStorageAdapter(db, pgClient);
const vector = new PgVectorAdapter({ connectionString: process.env.DATABASE_URL! });

const cognitive = createCore({
  storage,
  vector,
  embed: myEmbedAdapter,
  outbox: myOutboxAdapter,
  logger: myLogger,
  telemetry: myTelemetry,
});

const auth = {
  workspaceId: "ws_acme",
  actorId: "agent:support",
  actorType: "agent",
  scopes: ["memory:write", "memory:read"],
};

// Remember something
const result = await cognitive.remember(
  {
    statement: "Acme Corp prefers communication in Spanish.",
    subject: "client:acme",
    kind: "preference",
    confidence: 0.9,
    sensitivity: "internal",
  },
  auth
);

// Recall with the 7-stage hybrid pipeline
const { hits } = await cognitive.recall(
  { text: "what language should we use with Acme?", limit: 10 },
  auth
);

// Session pipeline — collapse a session's turns into durable knowledge
const outcome = await cognitive.collapseSession({ sessionId, workspaceId: "ws_acme" }, auth);
```

## API — `MnemoCore` interface

| Method                                                  | Returns                           | Description                                                        |
| ------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `remember(req, auth)`                                   | `Promise<RememberResponse>`       | Store a fact/decision/strategy with the §33 conflict/surprise gate |
| `recall(query, auth)`                                   | `Promise<RecallResponse>`         | 7-stage hybrid search cascade                                      |
| `recallHot(workspaceId, auth, limit?)`                  | `Promise<RecallHit[]>`            | Hot tier (ACT-R) lookup only                                       |
| `forget(id, kind, mode, auth, reason?)`                 | `Promise<void>`                   | Bitemporal soft/hard delete                                        |
| `updateWorth(id, kind, delta, auth)`                    | `Promise<void>`                   | Beta-Bernoulli worth signal update                                 |
| `updateRelationStrength(relationId, reinforced, auth)`  | `Promise<void>`                   | Hebbian co-recall weight update                                    |
| `collapseSession(args, auth)`                           | `Promise<CollapseSessionOutcome>` | Collapse session → extract facts (8-step pipeline)                 |
| `propagateGovernanceForSession(workspaceId, sessionId)` | `Promise<void>`                   | §11 governance credit propagation                                  |

## Auth bootstrap

```ts
import { createApiKeyLookup, assertSafeDbRole } from "@mnemo-ai/core";

// API-key lookup (used by @mnemo-ai/server's auth middleware)
const apiKeys = createApiKeyLookup({ databaseUrl: "postgres://..." });

// Safety check — rejects superuser / bypassrls connections
await assertSafeDbRole({ databaseUrl: "postgres://..." });
```

## RLS transactions

For callers that access Postgres directly (custom queries, migrations, admin tooling):

```ts
import { withMnemoTx } from "@mnemo-ai/core";

const result = await withMnemoTx("workspace_123", async (tx) => {
  // `tx` is a Drizzle transaction with:
  //   SET LOCAL app.workspace_id = 'workspace_123'
  //   SET LOCAL ROLE app_user
  // All RLS policies are now enforced — even for superuser connections.
  return tx.select().from(schema.mnemo_fact);
});
```

## Sensitivity tiers

Every fact carries a `sensitivity` level. The numeric order is:

| Level          | Numeric | Meaning                |
| -------------- | ------- | ---------------------- |
| `public`       | 0       | Visible to all agents  |
| `internal`     | 1       | Workspace members only |
| `confidential` | 2       | Explicitly granted     |
| `restricted`   | 3       | Strict allowlist       |

Ceiling checks always use numeric comparison — never string equality. A ceiling violation returns 404 (not 403) to prevent tenant-probing.

## PII detection

```ts
import { detectPII, redactPII } from "@mnemo-ai/core";

const result = detectPII("Call me at 555-0100 or john@example.com");
// { hasPII: true, categories: ["phone", "email"], matches: [...] }

const redacted = redactPII("Call me at 555-0100 or john@example.com");
// "Call me at [PHONE] or [EMAIL]"
```

## Migrate

Apply the bundled migrations to any Postgres database:

```bash
DATABASE_URL=postgres://... pnpx mnemo-migrate
```

## Design principles

- **Hexagonal boundary** — `packages/core/src/cognitive/` has zero imports from `drizzle-orm`, `pg`, `redis`, or any infrastructure package. All I/O flows through injected ports. Enforced by a CI test (`v3-purity.test.ts`); a small, documented, permanent allowlist (`tx.ts`, `api-key-lookup.ts`) covers the two files that legitimately own RLS/auth infrastructure.
- **TypeScript strict + `noUncheckedIndexedAccess`** — no `any` in the public types.
- **No deep imports from consumers** — everything goes through `src/index.ts` or documented subpath exports.
- **RLS is structural, not advisory** — `FORCE ROW LEVEL SECURITY` + `withMnemoTx` means isolation holds even against a superuser connection or a missing `WHERE` clause.

## License

Apache-2.0 — see [LICENSE](../../LICENSE).
