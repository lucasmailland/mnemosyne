import { sql, type SQL } from "drizzle-orm";

/**
 * P118 — width predicates for cosine queries over dimensionless vector columns.
 *
 * Every `mnemo_*` embedding column is a bare `halfvec` with no declared
 * dimension. That is deliberate (migration 0009, "multi-dimension support —
 * Bedrock/Titan 1024, OpenAI 1536, future 2048/4096"), and it has a consequence
 * nobody wired for: rows of DIFFERENT widths can coexist in one column, and
 * pgvector cannot compare two vectors of different widths. It does not return a
 * poor score — it raises `different halfvec dimensions 1024 and 768` and the
 * whole query dies.
 *
 * So the moment a workspace changes embedding model, every similarity query over
 * that column throws until the entire corpus has been re-embedded. Measured on a
 * live stack: the episodic collapse lost its episode outright that way (P109).
 *
 * `PgVectorAdapter` already solved this for the fact-vector search path with a
 * `vector_dims(embedding) = N` predicate, and its comment describes this exact
 * failure. The six repository-level cosine queries never got it. Same shape as
 * P111: the mechanism exists, correct and documented, in one of seven places.
 *
 * Semantics of the fix, worth being explicit about: rows at another width are
 * EXCLUDED, not down-ranked. They belong to a different embedding space — their
 * coordinates mean nothing in this one — so they are not weak candidates, they
 * are not candidates. A partial result beats a thrown query, and re-embedding
 * (`embedMigration.ts`, B4.7) is what brings them back.
 */

/**
 * `vector_dims(<column>) = <width of the query vector>`.
 *
 * Both operands are safe to splice: `column` is a compile-time literal at every
 * call site (never request input), and the width is derived from
 * `embedding.length` and validated as a positive integer here.
 *
 * Spliced rather than bound, following PgVectorAdapter: postgres.js prepares
 * statements, and under `plan_cache_mode=auto` a repeatedly-executed statement
 * can switch to a generic plan, which cannot prove a parameterized comparand
 * against a partial index's WHERE clause. A bound comparand would quietly
 * regress those queries to a sequential scan after ~5 executions.
 */
export function sameWidthAsQuery(column: string, embedding: readonly number[]): SQL {
  const width = embedding.length;
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error(`sameWidthAsQuery: refusing to build a predicate for width ${width}`);
  }
  assertPlainIdentifier(column);
  return sql.raw(`vector_dims(${column}) = ${width}`);
}

/**
 * `vector_dims(<a>) = vector_dims(<b>)` — for the joins that compare two STORED
 * columns rather than a column against a query vector (fact↔fact semantic
 * neighbours). Same failure, different shape: with mixed widths in one table the
 * self-join hits the first mismatched pair and takes the statement down.
 */
export function sameWidthAsEachOther(columnA: string, columnB: string): SQL {
  assertPlainIdentifier(columnA);
  assertPlainIdentifier(columnB);
  return sql.raw(`vector_dims(${columnA}) = vector_dims(${columnB})`);
}

/**
 * These fragments are spliced raw, so the guard is not decoration: it keeps a
 * future refactor from turning a literal into an interpolated value without
 * anyone noticing. Only `name` and `alias.name` are ever legitimate here.
 */
function assertPlainIdentifier(column: string): void {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column)) {
    throw new Error(`embedding width predicate: unsafe column reference ${JSON.stringify(column)}`);
  }
}
