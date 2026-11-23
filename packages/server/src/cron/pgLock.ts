import type { Sql } from "postgres";
import type { CronLock } from "./registry.js";

/**
 * Cron lock on Postgres transaction-scoped advisory locks. Each run opens its
 * own transaction, takes the lock in it and holds the transaction for the run
 * (plus `holdMs`); commit, rollback or a dropped connection releases it. A
 * transaction, not a session lock, because production reaches Postgres through
 * pgBouncer in transaction pooling: a session lock could be taken on one
 * server connection and never released, while a transaction stays on one
 * server connection until it ends. Keyed by job, so a run that outlasts its
 * period also keeps other replicas from overlapping it.
 */
export function createPgCronLock(sql: Sql): CronLock {
  return {
    async runExclusive(jobKey, holdMs, fn) {
      const lockKey = `mnemo_cron:${jobKey}`;
      let ran = false;
      await sql.begin(async (tx) => {
        const [row] = await tx<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS locked
        `;
        if (!row?.locked) return;
        ran = true;
        // The app role ends a transaction idle for 60 s (provision-app-role),
        // which would drop the lock under a longer job. Only for this one.
        await tx`SET LOCAL idle_in_transaction_session_timeout = 0`;
        const start = Date.now();
        try {
          await fn();
        } finally {
          const wait = holdMs - (Date.now() - start);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
      });
      return ran;
    },
  };
}
