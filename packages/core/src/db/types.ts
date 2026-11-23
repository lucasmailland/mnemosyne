// packages/core/src/db/types.ts
//
// `DbClient` — the structural type every internal call accepts.
//
// We deliberately do NOT pin a concrete driver (postgres-js, node-pg,
// pglite, neon-http…). The library is portable across any Drizzle
// backend; the host application picks the driver. This type captures
// the smallest surface mnemosyne needs: a Drizzle DB instance over our
// schema, with `transaction(...)` and `.execute(sql)`.
//
// Why a union rather than `NodePgDatabase<typeof schema>`: it gives
// consumers freedom (a Vercel-edge user with `drizzle-orm/neon-http`
// would not have `NodePgDatabase` in scope).
//
// flatten-legacy-dual-core Phase 9 (task 9.4, Requirement 8): `Schema` is
// now the empty object type — NOT a re-export of `packages/core/src/
// db/schema/*`, which is physically deleted (18 files). Investigated, not
// assumed: a full-repo search (this package, `packages/server`, every
// adapter, MCP, CLI, client-ts, and every test file) for either (a) any
// import of an individual table object by name (`mnemoFacts`,
// `mnemoDecisions`, etc.) or (b) any use of Drizzle's relational `.query.*`
// API against a `@mnemo-ai/core`-registered `DbClient` found ZERO hits.
// Every one of this package's live DB consumers — `tx.ts`, `api-key-
// lookup.ts` — and every external one (`packages/server/src/index.ts`'s
// boot wiring, integration test harnesses) exclusively uses raw `sql`
// template execution via `.execute()`/`.transaction()`, which does not
// depend on `TSchema` at runtime OR at the type level. The 17 legacy v1.x
// table files were only ever consumed by the v1.x modules PR19/PR20 already
// confirmed dead and deleted (entity/, episode/, citation/, primitives/
// decision.ts, etc.) — once those were gone, `Schema` itself became
// vestigial. The physical `mnemo_*` Postgres tables are entirely
// unaffected: they are created by `packages/core/migrations/*.sql`, a
// completely separate artifact from this TypeScript-only typing layer, and
// RLS is enforced by Postgres policies, never by the Drizzle schema object.
// See apply-progress.md Phase 9 for the full investigation trail.
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * Empty by design — see the file header. `db/index.ts`'s `schema` export
 * is the runtime value (`{}`) that satisfies this type.
 */
export type Schema = Record<string, never>;

/**
 * Structural DB client type accepted by every mnemosyne call.
 *
 * Add other Drizzle driver flavors to this union as the ecosystem
 * grows. Each member shares the `.transaction()` and `.execute()`
 * methods we rely on, so library code only references the shared
 * subset and never the driver-specific shape.
 */
export type DbClient = NodePgDatabase<Schema> | PostgresJsDatabase<Schema>;

/**
 * Drizzle transaction handle — derived from `DbClient` so it stays in
 * lock-step with the union above. Library functions accept this so
 * callers can either pass a top-level `DbClient` (we open a tx) or an
 * already-open tx (we participate in the caller's tx).
 */
export type Tx = DbClient | Parameters<Parameters<DbClient["transaction"]>[0]>[0];
