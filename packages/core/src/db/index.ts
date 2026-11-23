// packages/core/src/db/index.ts
//
// Public entry for everything DB-shaped this package exposes.
//
// Consumers can import the (now-empty) Drizzle schema object, the
// `DbClient` structural type for wiring helpers, and `setDb` / `getDb`
// for the DI registry.
//
// flatten-legacy-dual-core Phase 9 (task 9.4, Requirement 8): `schema` used
// to re-export `./schema`'s 17-table barrel (`packages/core/src/db/
// schema/*`, now physically deleted). It is `{}` now — see `./types.ts`'s
// header comment for the full investigation proving no consumer, internal
// or external, ever used it for anything beyond `drizzle(pool, { schema
// })`'s generic type parameter. Kept as a named export (rather than removed
// outright) so `packages/server/src/index.ts`'s boot wiring and every
// integration test harness that does `drizzlePgForSetDb(client, { schema:
// mod.schema })` keep compiling unchanged — only the VALUE behind the name
// shrank, not the shape of the contract.

export const schema = {} as const;
export type { DbClient, Schema, Tx } from "./types";
export { setDb, getDb, __resetDbForTests } from "./client";
