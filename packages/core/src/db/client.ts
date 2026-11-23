// packages/core/src/db/client.ts
//
// Dependency-injection registry for the singleton `DbClient`.
//
// v2.0 cuts the cord with `@mnemo-ai/core/db`: this package no longer
// owns the database connection. The HOST APPLICATION is expected to
// build its own Drizzle client (pinned to whatever driver it likes)
// and register it via `setDb(db)` once at boot. From that point on,
// internal helpers — most importantly `withMnemoTx` — call `getDb()`
// to retrieve it.
//
// Why a registry instead of "always pass `db` as the first arg":
//   • Backward compatibility. The v1 API of `withMnemoTx(workspaceId,
//     fn)` is unchanged for every legacy caller.
//   • HMR-survival for Next.js dev. The host's own client is stashed
//     on `globalThis`; this module just remembers the reference.
//
// If `getDb()` is called before `setDb()` (or its env-var fallback
// can't find a connection string), we throw — failing fast at the
// boundary is safer than letting the caller hit a `Cannot read
// properties of undefined` later in the call stack.

import type { DbClient } from "./types";

const globalForMnemo = globalThis as unknown as {
  __mnemoCoreDb?: DbClient;
};

/**
 * Register the host's Drizzle client for use by every mnemosyne
 * internal call. Call this once at boot.
 *
 * C2: registering twice used to SILENTLY clobber the existing client — a
 * footgun when two code paths both call `createCore()` (e.g. an app plus a
 * background worker in the same process), since the second pool would
 * orphan the first. We now THROW on a second registration. This is the
 * least-surprising default: a double-register is almost always a bug, and
 * failing loud at boot beats a silent connection leak discovered in prod.
 *
 * Pass `{ force: true }` to deliberately replace an existing client (e.g.
 * reconnect after a pool teardown). `__resetDbForTests()` remains the
 * clean-slate path for test suites.
 *
 * @param db A Drizzle DB instance backed by the host's pg driver, bound to
 *           `@mnemo-ai/core/db`'s `schema` export (empty by design as of
 *           flatten-legacy-dual-core Phase 9 — see `./types.ts`; every
 *           internal call uses raw SQL execution, not Drizzle's `.query.*`
 *           relational API, so no table definitions are needed here).
 * @param opts.force Replace an already-registered client instead of throwing.
 */
export function setDb(db: DbClient, opts?: { force?: boolean }): void {
  if (globalForMnemo.__mnemoCoreDb && !opts?.force) {
    throw new Error(
      "[@mnemo-ai/core] setDb() called twice. A DB client is already " +
        "registered — registering another would orphan the first pool. " +
        "Pass setDb(db, { force: true }) to replace it deliberately, or " +
        "call __resetDbForTests() first in test code."
    );
  }
  globalForMnemo.__mnemoCoreDb = db;
}

/**
 * Retrieve the DB client registered by the host application.
 *
 * Throws if no client has been registered — fail fast at the boundary
 * rather than letting an undefined leak into a transaction body.
 */
export function getDb(): DbClient {
  const db = globalForMnemo.__mnemoCoreDb;
  if (!db) {
    throw new Error(
      "[@mnemo-ai/core] No DB client registered. Call setDb(db) at boot " +
        "with a Drizzle instance bound to the package's schema. See README."
    );
  }
  return db;
}

/**
 * Test/dev helper — clears the registered client. NOT for production.
 * Useful in vitest suites that want to swap clients between tests.
 */
export function __resetDbForTests(): void {
  globalForMnemo.__mnemoCoreDb = undefined;
}
