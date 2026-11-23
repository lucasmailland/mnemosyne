/**
 * PG-TIMEOUTS: server-side time limits for every runtime Postgres pool.
 *
 * Without them a stuck connection stays stuck: on the chaos stack an
 * `idle in transaction` audit append held an advisory lock forever while nine
 * other connections waited on it (`SHOW statement_timeout` etc. all `0`), and
 * the instance never recovered (CHAOS-1). These limits are sent as startup
 * parameters on each connection, so they need no migration and no role change.
 *
 * - `statement_timeout` cancels one statement that runs too long.
 * - `lock_timeout` cancels a statement waiting too long for a lock (advisory
 *   locks included). It must be shorter than `statement_timeout`, or it never
 *   fires first.
 * - `idle_in_transaction_session_timeout` ends a session that holds a
 *   transaction open while the application does nothing on it.
 *
 * Migrations open their own connections and never get these limits; long
 * maintenance statements raise them per transaction (see
 * {@link resolvePgMaintenanceTimeoutMs}).
 *
 * Pure: takes the environment as an argument (no `process` access here).
 */

/** Each limit in ms. 0 means "not set here": the role or server default applies. */
export interface PgSessionTimeouts {
  /** `statement_timeout`, in ms. */
  statementTimeoutMs: number;
  /** `lock_timeout`, in ms. */
  lockTimeoutMs: number;
  /** `idle_in_transaction_session_timeout`, in ms. */
  idleInTransactionTimeoutMs: number;
}

export const DEFAULT_PG_SESSION_TIMEOUTS: Readonly<PgSessionTimeouts> = Object.freeze({
  statementTimeoutMs: 60_000,
  lockTimeoutMs: 15_000,
  idleInTransactionTimeoutMs: 60_000,
});

/** Env var → field. Values are milliseconds; `0` leaves that limit to the role/server. */
export const PG_SESSION_TIMEOUT_ENV = Object.freeze({
  statementTimeoutMs: "MNEMO_PG_STATEMENT_TIMEOUT_MS",
  lockTimeoutMs: "MNEMO_PG_LOCK_TIMEOUT_MS",
  idleInTransactionTimeoutMs: "MNEMO_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS",
} as const);

/** Statement budget for long maintenance work (matview refreshes). 0 = no limit. */
export const PG_MAINTENANCE_TIMEOUT_ENV = "MNEMO_PG_MAINTENANCE_STATEMENT_TIMEOUT_MS";

type Env = Readonly<Record<string, string | undefined>>;

function readMs(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${name} must be a whole number of milliseconds >= 0, got "${raw}"`);
  }
  return n;
}

/**
 * Resolve the runtime pool limits from the environment. Throws on a value
 * that is not a non-negative integer, and when `lock_timeout` is not shorter
 * than `statement_timeout` (both set): a misconfiguration should stop the
 * boot, not surface as the next outage.
 */
export function resolvePgSessionTimeouts(env: Env): PgSessionTimeouts {
  const t: PgSessionTimeouts = {
    statementTimeoutMs: readMs(
      env,
      PG_SESSION_TIMEOUT_ENV.statementTimeoutMs,
      DEFAULT_PG_SESSION_TIMEOUTS.statementTimeoutMs
    ),
    lockTimeoutMs: readMs(
      env,
      PG_SESSION_TIMEOUT_ENV.lockTimeoutMs,
      DEFAULT_PG_SESSION_TIMEOUTS.lockTimeoutMs
    ),
    idleInTransactionTimeoutMs: readMs(
      env,
      PG_SESSION_TIMEOUT_ENV.idleInTransactionTimeoutMs,
      DEFAULT_PG_SESSION_TIMEOUTS.idleInTransactionTimeoutMs
    ),
  };
  if (t.statementTimeoutMs > 0 && t.lockTimeoutMs >= t.statementTimeoutMs) {
    throw new Error(
      `${PG_SESSION_TIMEOUT_ENV.lockTimeoutMs} (${t.lockTimeoutMs}) must be shorter than ` +
        `${PG_SESSION_TIMEOUT_ENV.statementTimeoutMs} (${t.statementTimeoutMs})`
    );
  }
  return t;
}

/**
 * The startup parameters for a postgres.js `connection` option. Postgres
 * applies them to the session as if set with `SET`; a transaction can still
 * override them with `SET LOCAL`. A limit of 0 is left out, so a role-level
 * setting (`ALTER ROLE … SET`) still applies and a pooler that rejects unknown
 * startup parameters can be served by setting all three to 0.
 */
export function pgSessionTimeoutParams(t: PgSessionTimeouts): Record<string, string> {
  const params: Record<string, string> = {};
  if (t.statementTimeoutMs > 0) params["statement_timeout"] = String(t.statementTimeoutMs);
  if (t.lockTimeoutMs > 0) params["lock_timeout"] = String(t.lockTimeoutMs);
  if (t.idleInTransactionTimeoutMs > 0) {
    params["idle_in_transaction_session_timeout"] = String(t.idleInTransactionTimeoutMs);
  }
  return params;
}

/** Statement and lock budget for long maintenance statements, in ms (0 = no limit). */
export function resolvePgMaintenanceTimeoutMs(env: Env): number {
  return readMs(env, PG_MAINTENANCE_TIMEOUT_ENV, 0);
}
