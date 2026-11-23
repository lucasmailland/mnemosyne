import { StorageConflictError } from "@mnemo-ai/types";

interface PgErrorLike {
  code?: string;
  constraint_name?: string;
  message?: string;
  cause?: unknown;
}

/** Drizzle wraps driver errors (`DrizzleQueryError.cause`); postgres.js puts SQLSTATE on `code`. */
function unwrap(err: unknown): PgErrorLike[] {
  const chain: PgErrorLike[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    chain.push(cur as PgErrorLike);
    cur = (cur as PgErrorLike).cause;
  }
  return chain;
}

/** The unique-violation (23505) in the error chain, if any: the violated constraint/index name. */
export function uniqueViolation(err: unknown): { constraint: string } | null {
  for (const e of unwrap(err)) {
    if (e.code === "23505") return { constraint: e.constraint_name ?? "" };
  }
  return null;
}

/**
 * Turn a unique violation on one of `knownConstraints` into a typed
 * {@link StorageConflictError} (the client asked for something taken), and
 * leave every other failure untouched so a real fault is still a 500.
 */
export function rethrowAsConflict(err: unknown, knownConstraints: Record<string, string>): never {
  const v = uniqueViolation(err);
  if (v) {
    const message = knownConstraints[v.constraint];
    if (message) throw new StorageConflictError(message);
  }
  throw err;
}
