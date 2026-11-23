import type { T } from "./i18n/core";

/**
 * How long a browser-side load waits for the bridge (APP-043). A stalled API server would
 * otherwise leave the page saying "Loading…" forever; past this the load fails and the
 * page offers to try again. Loads only: a write that times out has an unknown outcome,
 * and aborting it in the browser does not stop the server.
 */
export const LOAD_TIMEOUT_MS = 15_000;

/** The signal for a load: times out on its own, and still follows the caller's cancel. */
export function loadSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(LOAD_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** By name, not `instanceof`: a DOMException from another realm (jsdom, a worker) is one too. */
export const isTimeout = (e: unknown): boolean =>
  (e as { name?: unknown } | null)?.name === "TimeoutError";

/** What a failed load says: the server took too long, or could not be reached. */
export const loadFailure = (t: T, e: unknown): string =>
  t(isTimeout(e) ? "errors.timeout" : "errors.network");
