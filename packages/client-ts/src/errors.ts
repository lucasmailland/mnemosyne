/**
 * Typed error hierarchy for the Mnemosyne client SDK.
 *
 * Why a class hierarchy instead of plain Error objects:
 *   - Consumers want to `catch` and branch on cause (timeout vs. server
 *     500 vs. validation 4xx). Discriminating by string-matching `.message`
 *     is brittle across versions.
 *   - We surface the server's `requestId` so support tickets are
 *     immediately greppable in server logs.
 *   - `code` mirrors the server's machine-readable error code (e.g.
 *     "FACT_NOT_FOUND", "RATE_LIMITED") so retry/auth recovery logic
 *     can be written without parsing English prose.
 *
 * All three errors extend `MnemosyneError` so `catch (e) { if (e
 * instanceof MnemosyneError) ... }` covers the whole surface.
 */
export class MnemosyneError extends Error {
  /** A failed mutation may already have committed; inspect before replaying it. */
  outcomeUnknown = false;
  constructor(message: string) {
    super(message);
    this.name = "MnemosyneError";
    // Restore prototype chain (necessary when compiling to ES5/CJS).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the server responded with a non-2xx HTTP status.
 *
 * Includes the parsed error body (status, code, message, requestId)
 * so the caller can:
 *   - Decide whether to retry (5xx vs 4xx)
 *   - Show a useful error to the end-user (message)
 *   - File a bug with the operator (requestId)
 */
export class MnemosyneAPIError extends MnemosyneError {
  /** HTTP status code returned by the server (e.g. 404, 429, 500). */
  readonly status: number;
  /** Machine-readable error code from the server, when present. */
  readonly code: string | undefined;
  /** Server-generated request id for log correlation, when present. */
  readonly requestId: string | undefined;
  /** Raw parsed JSON body, in case callers need details we didn't surface. */
  readonly body: unknown;
  readonly details: unknown;
  readonly retryable: boolean | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(opts: {
    status: number;
    message: string;
    code?: string | undefined;
    requestId?: string | undefined;
    body?: unknown;
    details?: unknown;
    retryable?: boolean;
    retryAfterSeconds?: number;
  }) {
    super(opts.message);
    this.name = "MnemosyneAPIError";
    this.status = opts.status;
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.body = opts.body;
    this.details = opts.details;
    this.retryable = opts.retryable;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    Object.setPrototypeOf(this, MnemosyneAPIError.prototype);
  }
}

/**
 * Thrown when the underlying fetch failed at the transport layer (DNS,
 * connection refused, TLS error, etc.). NOT thrown for HTTP error
 * statuses — those are MnemosyneAPIError.
 *
 * The retry layer treats this as retryable by default.
 */
export class MnemosyneNetworkError extends MnemosyneError {
  /** The original error from fetch (or wherever the failure surfaced). */
  override readonly cause: unknown;
  readonly retryable: boolean;

  constructor(message: string, cause: unknown, retryable = true) {
    super(message);
    this.name = "MnemosyneNetworkError";
    this.cause = cause;
    this.retryable = retryable;
    Object.setPrototypeOf(this, MnemosyneNetworkError.prototype);
  }
}

/**
 * Thrown when a request exceeded its timeout budget.
 *
 * Distinct from MnemosyneNetworkError because timeouts often indicate
 * the server IS working but slow — the retry policy may want to back
 * off more aggressively rather than hammering with rapid retries.
 */
export class MnemosyneTimeoutError extends MnemosyneError {
  /** Configured timeout in milliseconds when the request was abandoned. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Mnemosyne request exceeded ${timeoutMs}ms timeout`);
    this.name = "MnemosyneTimeoutError";
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, MnemosyneTimeoutError.prototype);
  }
}
