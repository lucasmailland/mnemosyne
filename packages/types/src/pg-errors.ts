/**
 * CHAOS-10: tell a database that is unavailable or too slow right now from a
 * request that can never succeed.
 *
 * With Postgres stopped, writes answered 500 `internal_error`, which tells a
 * client nothing about retrying. An error this function accepts means "the
 * dependency failed, retry later" (503 + Retry-After in the server's error
 * handler); anything else — constraint, privilege, syntax — is not fixed by
 * retrying. A timeout after the statement was sent does NOT prove that nothing
 * was written; callers that retry writes still need idempotency.
 *
 * Pure: reads only `err.code` (postgres.js / Node socket codes and SQLSTATEs),
 * so it lives here, next to the PG-TIMEOUTS limits whose errors it classifies.
 */

/** postgres.js and Node socket errors (`err.code`) for a lost or refused connection. */
const TRANSIENT_DRIVER_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

/** SQLSTATEs for an unavailable server or a PG-TIMEOUTS limit that fired. */
const TRANSIENT_SQLSTATES = new Set([
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (starting up / recovery)
  "57014", // query_canceled — statement_timeout
  "55P03", // lock_not_available — lock_timeout
  "25P03", // idle_in_transaction_session_timeout
]);

function codeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * opossum's own timeout: code `ETIMEDOUT` (the same string as a socket timeout)
 * and the message "Timed out after Nms". It says a breaker-wrapped call ran
 * long, whatever that call was (a recall that includes an LLM rerank, an
 * embed), so it is not evidence about the database.
 */
export function isBreakerTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    codeOf(err) === "ETIMEDOUT" &&
    /^Timed out after \d+ms$/.test(err.message)
  );
}

/** True when `err` (or an error in its `cause` chain) is a transient database failure. */
export function isTransientDbError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = isBreakerTimeoutError(current) ? undefined : codeOf(current);
    if (code !== undefined) {
      if (TRANSIENT_DRIVER_CODES.has(code) || TRANSIENT_SQLSTATES.has(code)) return true;
      // SQLSTATE class 08: connection exception.
      if (/^08[0-9A-Z]{3}$/.test(code)) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
