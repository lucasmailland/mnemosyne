import { sql } from "drizzle-orm";
import {
  pgSessionTimeoutParams,
  resolvePgMaintenanceTimeoutMs,
  resolvePgSessionTimeouts,
} from "@mnemo-ai/types";
import type { DrizzleClient } from "./repositories/types.js";

/**
 * PG-TIMEOUTS: the `connection` startup parameters every runtime pool sends —
 * `search_path` plus `statement_timeout`, `lock_timeout` and
 * `idle_in_transaction_session_timeout` resolved from the environment
 * (`MNEMO_PG_*_TIMEOUT_MS`, see `@mnemo-ai/types` `pg-session.ts`).
 *
 * Throws on an invalid value, so a misconfigured server fails at boot.
 * Migrations (`migrate.ts`) build their own client and never use this.
 */
export function runtimeConnectionParams(
  env: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  return {
    search_path: "mnemosyne,public",
    ...pgSessionTimeoutParams(resolvePgSessionTimeouts(env)),
  };
}

type Tx = Parameters<Parameters<DrizzleClient["transaction"]>[0]>[0];

/**
 * Run `fn` in a transaction whose statement and lock limits are raised to the
 * maintenance budget (`MNEMO_PG_MAINTENANCE_STATEMENT_TIMEOUT_MS`, 0 = no
 * limit, the default). For long whole-database maintenance statements, such as
 * matview refreshes, that the request-sized runtime limits must not cut.
 * `SET LOCAL` semantics: the session limits are back once it commits.
 */
export async function withMaintenanceBudget<T>(
  db: DrizzleClient,
  fn: (tx: Tx) => Promise<T>,
  budgetMs: number = resolvePgMaintenanceTimeoutMs(process.env)
): Promise<T> {
  const budget = String(budgetMs);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${budget}, true),
                 set_config('lock_timeout', ${budget}, true)`
    );
    return fn(tx);
  });
}
