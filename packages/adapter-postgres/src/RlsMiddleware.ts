// RLS enforcement wrapper (TASK-10003, SECURITY.md §4).
//
// Every Drizzle DB operation that touches workspace-scoped data MUST go through
// withWorkspace(). It opens a transaction and sets the mnemosyne.workspace_id GUC
// before any query, ensuring PostgreSQL's RLS policies fire with the correct context.
//
// Canonical GUC: `current_setting('mnemosyne.workspace_id', true)::uuid`
//
// Direct db.* calls outside this wrapper are forbidden for workspace-scoped tables.
// Admin/schema-level operations (migrations, index builds) are the only valid
// exceptions — they run as the superuser role that bypasses RLS entirely.

import { sql } from "drizzle-orm";
import type { DrizzleClient } from "./DrizzleStorageAdapter.js";

// ─── Transaction type ──────────────────────────────────────────────────────────

// Derive the transaction type from DrizzleClient to stay in sync with the
// drizzle-orm version without importing internal types directly.
type DrizzleTransaction = Parameters<DrizzleClient["transaction"]>[0] extends (
  tx: infer T
) => Promise<unknown>
  ? T
  : never;

// ─── Core wrapper ──────────────────────────────────────────────────────────────

/**
 * Execute `fn` inside a Drizzle transaction with the workspace GUC pre-set.
 *
 * @param db          - The DrizzleClient instance.
 * @param workspaceId - UUID of the workspace — becomes `mnemosyne.workspace_id`.
 * @param fn          - Callback that receives the transaction object.
 * @returns           - Whatever `fn` returns.
 *
 * @example
 * const fact = await withWorkspace(db, workspaceId, async (tx) => {
 *   return tx.insert(schema.factTable).values(input).returning();
 * });
 */
export async function withWorkspace<T>(
  db: DrizzleClient,
  workspaceId: string,
  fn: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await (tx as DrizzleTransaction).execute(sql`SELECT mnemo_set_workspace(${workspaceId}::uuid)`);
    return fn(tx as DrizzleTransaction);
  });
}

/**
 * Assert that the calling code is inside a withWorkspace transaction.
 * Use in helper functions that must not be called from outside a transaction.
 * This is a compile-time documentation aid — it accepts a tx and returns it.
 */
export function requireWorkspace(tx: DrizzleTransaction): DrizzleTransaction {
  return tx;
}
