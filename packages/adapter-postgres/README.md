# @mnemo-ai/adapter-postgres

**English** · [Español](README.es.md)

> **AI pointer:** Implements StorageAdapter port via DrizzleORM + Postgres. Also owns the v3 migration stream (migrations/baseline/).
>
> **Depends on:** @mnemo-ai/types, drizzle-orm, postgres
>
> **Exposes:** DrizzleStorageAdapter, OutboxWorker, withWorkspace, requireWorkspace, DrizzleApiKeyStore
>
> **Status:** STABLE
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/architecture/DATA_MODEL.md](../../docs/architecture/DATA_MODEL.md)

PostgreSQL + Drizzle ORM storage adapter implementing the `StorageAdapter` port
from `@mnemo-ai/types`. This is the primary relational persistence layer for
Mnemosyne v3 — sessions, turns, facts, entities, decisions, episodes, and all
related tables live here.

---

## Architecture Position

```
@mnemo-ai/core  (StorageAdapter port)
       ↑
@mnemo-ai/adapter-postgres  (DrizzleStorageAdapter)
       ↓
PostgreSQL  (with pgvector extension, RLS enabled)
```

This adapter is the hexagonal boundary between the Mnemosyne core domain and the
Postgres database. The core never imports Drizzle or `postgres-js` directly —
it calls the `StorageAdapter` interface, and this package provides the wiring.

---

## Implementation Status

| Component                     | Status   | Notes                                                        |
| ----------------------------- | -------- | ------------------------------------------------------------ |
| `DrizzleStorageAdapter` class | Done     | All 6 core methods implemented                               |
| `createSession`               | Done     | Creates mnemo_session row with workspace isolation           |
| `appendTurn`                  | Done     | Inserts into mnemo_session_turn                              |
| `listTurns`                   | Done     | Paginated query on mnemo_session_turn                        |
| `closeSession`                | Done     | Sets closed_at on mnemo_session                              |
| `getSession`                  | Done     | Fetches single session by ID                                 |
| `updateFact`                  | Done     | Upsert on mnemo_fact with worth/sensitivity fields           |
| Drizzle schema                | Done     | All mnemo_* tables with correct column types                 |
| v3 migrations                 | Done     | 75 migration files under `migrations/baseline/`              |
| Wired to live server          | **Done** | Instantiated at server boot (`packages/server/src/index.ts`) |

---

## Installation

```bash
pnpm add @mnemo-ai/adapter-postgres
```

Peer dependencies: `postgres`, `drizzle-orm`

---

## Quick Init

```typescript
import { DrizzleStorageAdapter } from "@mnemo-ai/adapter-postgres";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql);

const storage = new DrizzleStorageAdapter(db);

// Use via the StorageAdapter interface
const session = await storage.createSession({
  workspaceId: "ws_abc123",
  agentId: "agent_xyz",
  metadata: {},
});
```

---

## Running Migrations

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname pnpm migrate
```

The CLI and programmatic `migrate({ databaseUrl })` API require an explicitly
supplied direct PostgreSQL or session-pooled connection. Transaction-mode
poolers cannot preserve ownership of the session advisory migration lock.

Or programmatically:

```typescript
import { migrate } from "@mnemo-ai/adapter-postgres/migrate";
await migrate({ databaseUrl: process.env.DATABASE_URL! });
```

Migration files live in `migrations/baseline/` (0001–0062, ordered). Applied migrations are tracked in `mnemosyne.schema_migrations`, with a checksum of each file. The runner is idempotent — re-running is safe.

**Never edit a migration once it is pushed.** The runner refuses to start when an applied file's checksum no longer matches ("modified after being applied"). To change what a pushed migration did, add the next number with the correction. `0060_instance_metrics.sql` was edited in place once (see the CHANGELOG); that is the exception that set this rule.

---

## Database Tables

All tables are prefixed `mnemo_` and scoped by `workspace_id`.

| Table                | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `mnemo_fact`         | Core memory primitives (all 10 PrimitiveKind values) |
| `mnemo_entity`       | Named entities extracted from fact content           |
| `mnemo_session`      | Conversation/context window records                  |
| `mnemo_session_turn` | Individual turns within a session                    |
| `mnemo_decision`     | Decision records with rationale and outcome          |
| `mnemo_relation`     | Typed edges between entities and facts               |
| `mnemo_citation`     | Source attribution for facts                         |
| `mnemo_episode`      | Episodic memory containers                           |
| `mnemo_api_keys`     | Hashed API keys for workspace auth                   |
| `mnemo_review_queue` | Facts flagged for human or automated review          |

---

## Row-Level Security

All tenant-scoped tables have `ENABLE ROW LEVEL SECURITY` and
`FORCE ROW LEVEL SECURITY` applied. Queries must set the `app.workspace_id`
session variable before executing, or they will return zero rows. The adapter
handles this automatically via a Drizzle middleware that sets the variable from
the resolved `AuthContext`.

This means even a compromised query cannot leak cross-tenant data as long as the
Postgres role does not have `BYPASSRLS`.

---

## Key Exports

```typescript
export { DrizzleStorageAdapter } from "./DrizzleStorageAdapter.js";
export { OutboxWorker } from "./OutboxWorker.js";
export { withWorkspace, requireWorkspace } from "./RlsMiddleware.js";
export { DrizzleApiKeyStore } from "./DrizzleApiKeyStore.js";
export * from "./schema/index.js";
```

---
