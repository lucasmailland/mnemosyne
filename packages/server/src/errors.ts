/**
 * Typed error hierarchy for the server.
 *
 * Why a hierarchy instead of `throw new Error(...)`:
 *  - Route handlers can throw semantically (`throw new NotFoundError(...)`)
 *    and a single error middleware maps each subclass to the right HTTP
 *    status — no per-route status code juggling.
 *  - Status code + machine-readable `code` means clients can branch on
 *    `error.code` instead of regex-matching strings.
 *  - `cause` is preserved so logs still show the underlying failure.
 */
import { HTTPException } from "hono/http-exception";
import { isSemanticSearchUnavailableError } from "@mnemo-ai/core";
import {
  isBreakerTimeoutError,
  isTransientDbError,
  StorageConflictError,
  StorageNotFoundError,
  StorageValidationError,
} from "@mnemo-ai/types";

/**
 * Derive a Stripe-style `type` string from an HTTP status code.
 * Spec §35 lines 4301–4315.
 */
export function errorTypeFromStatus(status: number): string {
  if (status === 400 || status === 422) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 409) return "conflict_error";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}

export class HttpError extends Error {
  /** HTTP status code returned to the client. */
  public readonly status: number;
  /** Machine-readable error code, snake_case. Stable contract. */
  public readonly code: string;
  /** Optional structured detail bag — included in the JSON body. */
  public readonly details?: Record<string, unknown>;
  /**
   * Stripe-style type string derived from status (spec §35 lines 4301–4315).
   * invalid_request_error | authentication_error | permission_error |
   * not_found_error | conflict_error | rate_limit_error | api_error
   */
  public readonly type: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.type = errorTypeFromStatus(status);
  }
}

export class BadRequestError extends HttpError {
  /** The name of the field or parameter that caused the error, if applicable. */
  public readonly param?: string;

  constructor(message = "Bad request", details?: Record<string, unknown>, param?: string) {
    super(400, "bad_request", message, details);
    this.name = "BadRequestError";
    this.param = param;
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized", details?: Record<string, unknown>) {
    super(401, "unauthorized", message, details);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden", details?: Record<string, unknown>) {
    super(403, "forbidden", message, details);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found", details?: Record<string, unknown>) {
    super(404, "not_found", message, details);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends HttpError {
  constructor(message = "Conflict", details?: Record<string, unknown>) {
    super(409, "conflict", message, details);
    this.name = "ConflictError";
  }
}

export class RateLimitedError extends HttpError {
  constructor(message = "Too many requests", details?: Record<string, unknown>) {
    super(429, "rate_limited", message, details);
    this.name = "RateLimitedError";
  }
}

export class UnprocessableEntityError extends HttpError {
  constructor(message = "Unprocessable entity", details?: Record<string, unknown>) {
    super(422, "unprocessable_entity", message, details);
    this.name = "UnprocessableEntityError";
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message = "Service unavailable", details?: Record<string, unknown>) {
    super(503, "service_unavailable", message, details);
    this.name = "ServiceUnavailableError";
  }
}

export class InternalServerError extends HttpError {
  constructor(
    message = "Internal server error",
    details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(500, "internal_error", message, details, { cause });
    this.name = "InternalServerError";
  }
}

/**
 * Thrown when a code path is stubbed pending wiring of a dependency
 * (e.g. LLM provider). Returns 501 so callers can distinguish "not
 * implemented yet" from "you sent garbage" or "we exploded".
 */
export class NotImplementedError extends HttpError {
  constructor(message = "Not implemented", details?: Record<string, unknown>) {
    super(501, "not_implemented", message, details);
    this.name = "NotImplementedError";
  }
}

/**
 * Thrown by AuthAdapters when authorization fails.
 * Middleware catches this and maps it to ForbiddenError (403).
 */
export class MnemoAuthError extends Error {
  public readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = "MnemoAuthError";
    this.errorCode = errorCode;
  }
}

/**
 * Shape returned in JSON error bodies. Public contract — change carefully.
 *
 * `type` is a Stripe-style category (spec §35 lines 4301–4315):
 *   invalid_request_error | authentication_error | permission_error |
 *   not_found_error | conflict_error | rate_limit_error | api_error
 *
 * `param` is the name of the field/parameter that caused a 400 error, if known.
 */
export interface ErrorBody {
  error: {
    type: string;
    code: string;
    message: string;
    param?: string;
    details?: Record<string, unknown>;
    request_id?: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  };
}

/** How long a client should wait after a transient database failure. */
export const TRANSIENT_RETRY_AFTER_SECONDS = 5;
/** An open storage breaker half-opens after its resetTimeout (30 s). */
export const BREAKER_OPEN_RETRY_AFTER_SECONDS = 30;

/** opossum's own error codes: breaker open, bulkhead full. Its timeout is ETIMEDOUT. */
const BREAKER_REJECTION_CODES = new Set(["EOPENBREAKER", "ESEMLOCKED"]);

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

/**
 * The typed failures that reach the error handler from core, the adapters and
 * the circuit breakers, as their HTTP errors. `undefined` for anything else.
 * Matched by `code` as well as by class, because a second copy of a package
 * (a dist next to a source build) defeats `instanceof`.
 */
function mapDomainError(err: unknown): HttpError | undefined {
  if (err instanceof HttpError) return undefined;
  const code = errorCode(err);

  // SEC-7: the JSON is valid and it is the content that is refused, so 422.
  // The categories say what to fix; the matched evidence never leaves the
  // server (it can itself be the sensitive or hostile text).
  if (code === "poisoning_rejected") {
    const categories = (err as { categories?: unknown }).categories;
    return new HttpError(422, "poisoning_rejected", "Content rejected by the poisoning gate", {
      categories: Array.isArray(categories) ? categories.filter((c) => typeof c === "string") : [],
    });
  }

  // APP-073: a confidential/restricted write on a server without
  // MNEMO_MASTER_KEY. Still refused (never stored as plaintext); 422 because a
  // retry cannot help — a lower tier or the operator's key can.
  if (code === "encryption_not_configured") {
    return new HttpError(
      422,
      "encryption_not_configured",
      "This server has no MNEMO_MASTER_KEY, so it cannot store confidential or restricted memories. Use public or internal, or ask the operator to set the key."
    );
  }

  // CHAOS-5 (WP-3): strict semantic recall with no embedder answering.
  if (isSemanticSearchUnavailableError(err)) {
    return new HttpError(
      503,
      "semantic_search_unavailable",
      "Semantic search is temporarily unavailable",
      { retryAfterSeconds: TRANSIENT_RETRY_AFTER_SECONDS }
    );
  }

  // WP-6: the graph adapters' typed client mistakes, wherever a route did not
  // map them itself (routes/_storage-errors.ts does the same per route).
  if (err instanceof StorageConflictError) return new ConflictError(err.message);
  if (err instanceof StorageNotFoundError) return new NotFoundError(err.message);
  if (err instanceof StorageValidationError) return new BadRequestError(err.message);

  // APP-018 safety net: Postgres could not parse a value for its column
  // (22P02 — "invalid input syntax for type uuid"): malformed input, not a
  // server fault. Routes validate first; this keeps a missed one off 500.
  // The database's text echoes the value and is not passed on.
  if (code === "22P02" || errorCode((err as { cause?: unknown } | null)?.cause) === "22P02") {
    return new HttpError(
      400,
      "invalid_input_syntax",
      "A value in the request has the wrong format for its field (for example an id that is not a UUID)."
    );
  }

  // CHAOS-10 (WP-2): a breaker that refuses the call, or a database that is
  // down or too slow right now. Retrying later can succeed; retrying now
  // cannot. A timed-out write is not proof that nothing was written.
  if (typeof code === "string" && BREAKER_REJECTION_CODES.has(code)) {
    return new ServiceUnavailableError(
      "A dependency is temporarily unavailable. Retry later; the request was not attempted.",
      { retryAfterSeconds: BREAKER_OPEN_RETRY_AFTER_SECONDS }
    );
  }
  // V-1: opossum's timeout has code ETIMEDOUT like a socket timeout, but it only
  // says that something inside the breaker ran long (a recall with an LLM
  // rerank, say). Do not blame the database for it.
  if (isBreakerTimeoutError(err)) {
    return new ServiceUnavailableError(
      "A dependency did not answer in time. Retry later; if this was a write, it may or may not have been applied, so retry it idempotently.",
      { retryAfterSeconds: TRANSIENT_RETRY_AFTER_SECONDS }
    );
  }
  if (isTransientDbError(err)) {
    return new ServiceUnavailableError(
      "The database is temporarily unavailable. A write may or may not have been applied; retry it idempotently.",
      { retryAfterSeconds: TRANSIENT_RETRY_AFTER_SECONDS }
    );
  }
  return undefined;
}

/**
 * Convert any thrown value into the wire-format error body + status.
 * Unknown errors are coerced to 500 with a generic message so we never
 * leak internal stack traces to API consumers.
 */
export function toErrorBody(err: unknown, requestId?: string): { status: number; body: ErrorBody } {
  const mapped = mapDomainError(err);
  if (mapped) return toErrorBody(mapped, requestId);
  if (err instanceof HttpError) {
    const param = err instanceof BadRequestError ? err.param : undefined;
    const retryAfterSeconds = err.details?.retryAfterSeconds;
    return {
      status: err.status,
      body: {
        error: {
          type: err.type,
          code: err.code,
          message: err.message,
          ...(param ? { param } : {}),
          ...(err.details ? { details: err.details } : {}),
          ...(requestId ? { request_id: requestId } : {}),
          retryable: err.status === 429 || err.status === 503,
          ...(typeof retryAfterSeconds === "number" ? { retryAfterSeconds } : {}),
        },
      },
    };
  }
  if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
    const status = err.status;
    return {
      status,
      body: {
        error: {
          type: errorTypeFromStatus(status),
          code: status === 400 ? "bad_request" : "http_error",
          message: err.message,
          retryable: status === 429,
          ...(requestId ? { request_id: requestId } : {}),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        type: "api_error",
        code: "internal_error",
        message: "Internal server error",
        retryable: false,
        ...(requestId ? { request_id: requestId } : {}),
      },
    },
  };
}
