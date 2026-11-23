/**
 * Process exit codes (CLIENTS-18). Documented in README "Exit codes" and in
 * `mnemo help`. 0 and 1 keep their historical meaning, so a script that only
 * checks for non-zero keeps working.
 */
import {
  MnemosyneAPIError,
  MnemosyneNetworkError,
  MnemosyneTimeoutError,
} from "@mnemo-ai/client-ts";

export const EXIT = {
  /** Success (including an operation the server reports as skipped). */
  OK: 0,
  /** Generic failure: anything not covered below. */
  GENERIC: 1,
  /** Usage error: unknown command or flag, missing or invalid argument. */
  USAGE: 2,
  /** Authentication or authorization failure: no config, HTTP 401 / 403. */
  AUTH: 3,
  /** The requested resource does not exist: HTTP 404. */
  NOT_FOUND: 4,
  /** Transient transport or service failure worth retrying: network, timeout, 408 / 429 / 5xx. */
  TRANSIENT: 5,
} as const;

/** Exit code for a bare HTTP status (for the few routes that call fetch directly). */
export function exitCodeForStatus(status: number): number {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 408 || status === 429 || status >= 500) return EXIT.TRANSIENT;
  return EXIT.GENERIC;
}

export function exitCodeForError(err: unknown): number {
  if (err instanceof MnemosyneAPIError) return exitCodeForStatus(err.status);
  if (err instanceof MnemosyneNetworkError || err instanceof MnemosyneTimeoutError) {
    return EXIT.TRANSIENT;
  }
  return EXIT.GENERIC;
}
