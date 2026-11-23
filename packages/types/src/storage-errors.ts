/**
 * Typed storage failures that a caller is expected to turn into a 4xx instead
 * of a 500. Adapters throw these for conditions the CLIENT caused (a name that
 * is already taken, a lineage target that does not exist), so the HTTP layer
 * never has to parse driver error text.
 */

/** A referenced row does not exist in this workspace (or is not visible to the caller). */
export class StorageNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor(message: string) {
    super(message);
    this.name = "StorageNotFoundError";
  }
}

/** The write conflicts with the current state: a live row already owns the key, or the row was already closed. */
export class StorageConflictError extends Error {
  readonly code = "conflict" as const;
  constructor(message: string) {
    super(message);
    this.name = "StorageConflictError";
  }
}

/** The input is structurally invalid for the graph (self-loop, repeated member, wrong kind). */
export class StorageValidationError extends Error {
  readonly code = "invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "StorageValidationError";
  }
}
