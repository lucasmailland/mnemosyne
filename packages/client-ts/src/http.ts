import { MnemosyneAPIError, MnemosyneNetworkError, MnemosyneTimeoutError } from "./errors.js";
import type { RequestObservation, RetryConfig } from "./types.js";

/**
 * Internal fetch wrapper for the Mnemosyne client.
 *
 * Responsibilities (intentionally narrow):
 *   - Inject `Authorization` and `Content-Type` headers
 *   - Enforce a per-request timeout via AbortController
 *   - Retry safe reads after transient failures and 429 responses, honoring
 *     Retry-After before falling back to exponential jitter
 *   - Normalize errors into the typed Mnemosyne* hierarchy
 *
 * Why a hand-rolled fetch instead of axios/got/ky:
 *   - Zero runtime dependencies — the entire SDK installs as ~10kB.
 *   - Native fetch works in Node 20+, Bun, Deno, Cloudflare Workers,
 *     and browsers without a polyfill.
 *   - Retry/timeout policies are simple enough that pulling in a
 *     library would cost more than it saves.
 */

const DEFAULT_RETRY: Required<Omit<RetryConfig, "shouldRetry">> = {
  attempts: 3,
  initialDelayMs: 200,
};

/**
 * APP-023: the longest Retry-After slept inside one call. The server's default
 * is 60 s; sleeping that (twice) inside a tool call looks like a hang. Past
 * this the 429 is surfaced, with `retryAfterSeconds`, for the caller to decide.
 */
const MAX_RETRY_AFTER_MS = 5_000;

interface HttpRequestOptions {
  // PATCH joined the list when /entities/:id landed (tramo 2), PUT with the
  // agent-policy upsert (PUT /admin/agent-policy).
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Per-request abort signal from the caller, merged with timeout signal. */
  signal?: AbortSignal;
  /**
   * §34.9 — Extra headers to merge into the outgoing request.
   * Primary use: forward the `Idempotency-Key` header supplied by the
   * MCP tool caller, enabling the server-side idempotency store to
   * deduplicate retried mutations.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Per-request observation fields (request id, caller, versions). Turned into
   * headers once per logical request, so every retry reuses the same values.
   */
  observation?: RequestObservation;
  /**
   * Per-request override of the `X-Workspace-Id` header — wins over
   * `HttpClientConfig.workspaceId` when both are set. Only meaningful
   * against a `uk_live_*` user token (see auth.ts's multi-workspace
   * resolution); a plain workspace key gets a 403 Forbidden from the
   * server, not a silent ignore.
   */
  workspaceId?: string;
}

export interface HttpClientConfig {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  retry: RetryConfig;
  userAgent: string;
  /**
   * Default `X-Workspace-Id` sent on every request when the client is
   * bound to a `uk_live_*` user token that should operate against a
   * workspace other than its own home workspace. Overridden per-call by
   * `HttpRequestOptions.workspaceId`. See `MnemosyneClient.forWorkspace()`.
   */
  workspaceId?: string;
  /** Default observation metadata for every request. See `withObservation()`. */
  observation?: RequestObservation;
  /**
   * Optional locale tag, sent verbatim as `Accept-Language` on every request
   * so the server can localize error messages. Not validated here.
   */
  locale?: string;
}

export class HttpClient {
  private readonly config: HttpClientConfig;

  constructor(config: HttpClientConfig) {
    this.config = config;
  }

  /**
   * Return a NEW HttpClient bound to a different default `X-Workspace-Id`,
   * without mutating this instance — required so the one shared
   * MnemosyneClient inside an MCP server process (long-lived, concurrent
   * tool calls) can't have its workspace context leak between calls.
   */
  withWorkspace(workspaceId: string): HttpClient {
    return new HttpClient({ ...this.config, workspaceId });
  }

  /** Return a NEW HttpClient that sends `observation` headers on every request. */
  withObservation(observation: RequestObservation): HttpClient {
    return new HttpClient({ ...this.config, observation });
  }

  /** Return a NEW HttpClient whose requests time out after `timeoutMs`. */
  withTimeout(timeoutMs: number): HttpClient {
    return new HttpClient({ ...this.config, timeoutMs });
  }

  async request<T>(opts: HttpRequestOptions): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    const retryCfg = {
      ...DEFAULT_RETRY,
      ...this.config.retry,
    };
    const attempts = retryCfg.attempts ?? DEFAULT_RETRY.attempts;
    const shouldRetry = this.config.retry.shouldRetry ?? defaultShouldRetry;

    let lastError: unknown;
    // Resolve observation headers once so retries of THIS request reuse the
    // same X-Request-Id; nothing is stored on the shared client.
    const observed = observationHeaders(opts.observation ?? this.config.observation);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.executeOnce<T>(url, opts, observed);
      } catch (err) {
        if (
          !isReadOnly(opts) &&
          (err instanceof MnemosyneNetworkError ||
            err instanceof MnemosyneTimeoutError ||
            (err instanceof MnemosyneAPIError && err.status >= 500))
        )
          err.outcomeUnknown = true;
        lastError = err;
        // No more retries left — surface the error.
        if (attempt >= attempts) break;
        // Custom predicate decides whether to retry. By default we
        // retry 5xx + network errors; we do NOT retry 4xx (client
        // bug — retrying won't help) or timeouts (server is alive
        // but slow; let the caller decide).
        if (
          opts.signal?.aborted ||
          !isReplaySafe(opts) ||
          (err instanceof MnemosyneAPIError && err.retryable === false) ||
          !shouldRetry(err, attempt)
        )
          break;
        const delay =
          err instanceof MnemosyneAPIError && err.retryAfterSeconds !== undefined
            ? err.retryAfterSeconds * 1000
            : backoffMs(attempt, retryCfg.initialDelayMs ?? DEFAULT_RETRY.initialDelayMs);
        if (delay > MAX_RETRY_AFTER_MS) break;
        await sleep(delay, opts.signal);
      }
    }
    throw lastError;
  }

  private buildUrl(path: string, query?: HttpRequestOptions["query"]): string {
    // Defensive: callers pass bare paths like "/recall" (the v1 router is
    // mounted at root server-side, so there is no "/v1" prefix on the wire).
    // baseUrl may or may not have a trailing slash — normalize via URL.
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${base}${cleanPath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async executeOnce<T>(
    url: string,
    opts: HttpRequestOptions,
    observed: Record<string, string>
  ): Promise<T> {
    // Merge caller's AbortSignal with our timeout signal so EITHER can
    // cancel the request. We can't use AbortSignal.any directly because
    // Node 20.3 ships without it; emulate by listening on the caller's
    // signal and forwarding to our controller.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(timeoutReason), this.config.timeoutMs);

    const onExternalAbort = () => controller.abort(opts.signal?.reason);
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timeoutId);
        throw new MnemosyneNetworkError("aborted", opts.signal.reason, false);
      }
      opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const workspaceId = opts.workspaceId ?? this.config.workspaceId;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "User-Agent": this.config.userAgent,
      Accept: "application/json",
      ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
      ...(this.config.locale ? { "Accept-Language": this.config.locale } : {}),
      // §34.9 — merge extra headers (e.g. Idempotency-Key) after base
      // headers so callers cannot accidentally override Authorization.
      ...withoutProtectedHeaders(opts.extraHeaders),
      ...observed,
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await this.config.fetchImpl(url, {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
      // Was the abort our timeout or the caller's signal?
      if (controller.signal.aborted && controller.signal.reason === timeoutReason) {
        throw new MnemosyneTimeoutError(this.config.timeoutMs);
      }
      if (opts.signal?.aborted) {
        throw new MnemosyneNetworkError("aborted by caller", opts.signal.reason, false);
      }
      throw new MnemosyneNetworkError(describeFetchFailure(err, url), err);
    }

    try {
      if (!response.ok) throw await parseErrorResponse(response);
      // 204 No Content is legal — return undefined-as-T.
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason === timeoutReason) {
        throw new MnemosyneTimeoutError(this.config.timeoutMs);
      }
      if (opts.signal?.aborted)
        throw new MnemosyneNetworkError("aborted by caller", opts.signal.reason, false);
      if (err instanceof MnemosyneAPIError) throw err;
      throw new MnemosyneNetworkError("malformed JSON in successful response", err, false);
    } finally {
      clearTimeout(timeoutId);
      if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * "fetch failed" says nothing an operator can act on. Name the cause code
 * (ECONNREFUSED, ENOTFOUND, ...) and the host:port that was tried. `URL.host`
 * leaves out user:password, and the key travels in a header, never the URL.
 */
function describeFetchFailure(err: unknown, url: string): string {
  const message = err instanceof Error ? err.message : "fetch failed";
  const cause = (err as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } })?.cause;
  const code = cause?.code ?? cause?.errors?.find((e) => e?.code)?.code;
  const { hostname, port, protocol } = new URL(url);
  const where = `${hostname}:${port || (protocol === "https:" ? "443" : "80")}`;
  return `${message} (${typeof code === "string" ? `${code}, ` : ""}${where})`;
}

// Symbol used to distinguish "we aborted because of timeout" from
// "caller aborted". A symbol is cheaper than string-matching reasons.
const timeoutReason = Symbol("mnemosyne:timeout");

/**
 * Default retry predicate: retry on network errors and 5xx server
 * errors; never retry 4xx (caller bug) or timeouts (server is alive
 * but slow — let the caller decide).
 */
function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof MnemosyneNetworkError) return err.retryable;
  if (err instanceof MnemosyneAPIError)
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  return false;
}

const PROTECTED_HEADERS = new Set(["authorization", "x-workspace-id"]);

/** Drop caller-supplied headers that could override credentials or workspace. */
function withoutProtectedHeaders(headers?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => !PROTECTED_HEADERS.has(name.toLowerCase()))
  );
}

function observationHeaders(obs?: RequestObservation): Record<string, string> {
  if (!obs) return {};
  return {
    "X-Request-Id": obs.requestId ?? globalThis.crypto.randomUUID(),
    ...(obs.caller ? { "X-Mnemo-Caller": obs.caller } : {}),
    ...(obs.clientVersion ? { "X-Mnemo-Client-Version": obs.clientVersion } : {}),
    ...(obs.pluginVersion ? { "X-Mnemo-Plugin-Version": obs.pluginVersion } : {}),
  };
}

/** Reads never change state, so a failure leaves nothing uncertain. */
function isReadOnly(opts: HttpRequestOptions): boolean {
  return opts.method === "GET" || (opts.method === "POST" && opts.path === "/recall");
}

function isReplaySafe(opts: HttpRequestOptions): boolean {
  // A mutation carrying an Idempotency-Key is safe to replay: the server dedups it.
  // Replay eligibility is separate from outcome uncertainty (see isReadOnly).
  const keyed = Object.keys(opts.extraHeaders ?? {}).some(
    (h) => h.toLowerCase() === "idempotency-key"
  );
  return keyed || isReadOnly(opts);
}

/** Exponential backoff with full jitter: 200ms, 400ms, 800ms (± random). */
function backoffMs(attempt: number, initialDelayMs: number): number {
  const exp = initialDelayMs * Math.pow(2, attempt - 1);
  // Full jitter dampens thundering-herd on coordinated retries.
  return Math.floor(Math.random() * exp);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new MnemosyneNetworkError("aborted by caller", signal.reason, false));
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new MnemosyneNetworkError("aborted by caller", signal?.reason, false));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function parseErrorResponse(response: Response): Promise<MnemosyneAPIError> {
  // Servers return JSON `{ error: { code, message }, requestId }` per
  // the OpenAPI spec, but defensively handle plaintext + truncation.
  let body: unknown = undefined;
  let message = `HTTP ${response.status}`;
  let code: string | undefined;
  let requestId: string | undefined = response.headers.get("x-request-id") ?? undefined;
  let details: unknown;
  let retryable: boolean | undefined;
  let retryAfterSeconds: number | undefined = parseRetryAfter(response.headers.get("retry-after"));

  try {
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
        if (isErrorBody(body)) {
          if (typeof body.error.message === "string") message = body.error.message;
          if (typeof body.error.code === "string") code = body.error.code;
          if (typeof body.error.request_id === "string") requestId = body.error.request_id;
          details =
            body.error.details ?? (body.error.issues ? { issues: body.error.issues } : undefined);
          if (typeof body.error.retryable === "boolean") retryable = body.error.retryable;
          if (retryAfterSeconds === undefined && typeof body.error.retryAfterSeconds === "number")
            retryAfterSeconds = body.error.retryAfterSeconds;
          if (typeof body.requestId === "string") requestId = body.requestId;
        } else if (typeof body === "object" && body !== null) {
          const b = body as Record<string, unknown>;
          if (typeof b["message"] === "string") message = b["message"];
          else if (typeof b["error"] === "string") message = b["error"];
          if (typeof b["code"] === "string") code = b["code"];
          if (typeof b["requestId"] === "string") requestId = b["requestId"];
        } else if (typeof body === "string") {
          message = body;
        }
      } catch {
        // Plaintext body — use it directly.
        message = text.slice(0, 500);
      }
    }
  } catch {
    // Couldn't even read the body. Stick with default message.
  }

  return new MnemosyneAPIError({
    status: response.status,
    message,
    code,
    requestId,
    body,
    details,
    retryable,
    retryAfterSeconds,
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

function isErrorBody(v: unknown): v is {
  error: {
    code?: unknown;
    message?: unknown;
    request_id?: unknown;
    details?: unknown;
    issues?: unknown;
    retryable?: unknown;
    retryAfterSeconds?: unknown;
  };
  requestId?: unknown;
} {
  return (
    typeof v === "object" &&
    v !== null &&
    "error" in v &&
    typeof (v as { error: unknown }).error === "object" &&
    (v as { error: unknown }).error !== null
  );
}
