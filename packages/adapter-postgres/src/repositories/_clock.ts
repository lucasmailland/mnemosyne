import { sql, type AnyColumn } from "drizzle-orm";

/**
 * "Now" for a validity stamp (`valid_from`, `valid_to`): the database's
 * transaction time, the clock `DEFAULT now()` already stamps every created row
 * with. Never `new Date()`: the server's clock and the database's drift apart
 * by milliseconds (tens, with Docker on a Mac), so a close stamped by the
 * server could land before the row's own `valid_from` — a 500 from the
 * `tstzrange(valid_from, valid_to)` indexes on facts, decisions and relations,
 * and a negative interval everywhere else. Same for any stamp the schema
 * orders against a `DEFAULT now()` column (`mnemo_actor_dek.destroyed_at >=
 * created_at`, a webhook's `updated_at` against its `created_at`).
 *
 * Safe for a row addressed by id: the caller only learned the id after the
 * creating transaction committed. Not safe for a row resolved under a lock or
 * by topic: a transaction that waited can start before that row's
 * `valid_from` — use `GREATEST(transaction_timestamp(), valid_from)` there
 * (FactRepository's supersede path), or {@link closeAt} for a given instant.
 */
export const dbNow = () => sql<Date>`transaction_timestamp()`;

/**
 * A caller-given close instant (`valid_to`) that never lands before the row's
 * own `valid_from`: the server's clock, or a client's, can trail the database's
 * by more than the gap between the row's creation and its close.
 */
export const closeAt = (validTo: Date, validFrom: AnyColumn) =>
  sql<Date>`GREATEST(${validTo.toISOString()}::timestamptz, ${validFrom})`;
