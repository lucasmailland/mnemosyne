import {
  StorageConflictError,
  StorageNotFoundError,
  StorageValidationError,
} from "@mnemo-ai/types";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";

/**
 * Run a storage call and turn the typed failures an adapter throws for client
 * mistakes into their HTTP errors (409 / 404 / 400). Anything else is left
 * alone so a real fault is still a 500.
 */
export async function withStorageErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StorageConflictError) throw new ConflictError(err.message);
    if (err instanceof StorageNotFoundError) throw new NotFoundError(err.message);
    if (err instanceof StorageValidationError) throw new BadRequestError(err.message);
    throw err;
  }
}
