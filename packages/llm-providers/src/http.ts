/**
 * Shared HTTP helper used by every provider.
 *
 * Why a shared helper instead of each provider rolling its own fetch?
 * Because timeout, error classification, and Retry-After parsing are
 * non-trivial and must be uniform across providers — otherwise the
 * router cannot reason about errors generically. Keeping this in one
 * place also makes it trivial to mock with MSW in tests.
 */

import { LLMProviderError, RateLimitedError, ContextOverflowError } from "./errors.js";

export interface HttpJsonOpts {
  provider: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * POST/GET a JSON request and return the parsed JSON response.
 *
 * Classifies non-2xx responses into the typed error hierarchy. This is
 * the only function in the package that touches the network directly.
 */
export async function httpJson<T = unknown>(opts: HttpJsonOpts): Promise<T> {
  const { provider, url, method = "POST", headers = {}, body, timeoutMs = 60_000 } = opts;

  // AbortController is the only portable way to enforce a timeout on
  // fetch() — there is no native `timeout` option in WHATWG fetch.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new LLMProviderError(`Network error calling ${provider}: ${(err as Error).message}`, {
      provider,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  // Read the body once. We need both the JSON-parsed shape on success
  // and the raw text on error for diagnostic logging.
  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON response. Leave parsed undefined; surface as raw text.
    }
  }

  if (response.ok) {
    return parsed as T;
  }

  // --- Error classification -------------------------------------------------

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    // Retry-After can be "<seconds>" or an HTTP-date. We only handle seconds —
    // HTTP-date is rare in practice and the cost of falling back to a default
    // retry delay is low.
    const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
    throw new RateLimitedError(`${provider} rate limited (HTTP 429)`, {
      provider,
      status: 429,
      body: parsed ?? text,
      retryAfterMs,
    });
  }

  // Context overflow is reported with different error codes by every vendor.
  // The most reliable signal is a 400 with a body message mentioning
  // "context" or "too long" or "maximum context length". We look in the
  // stringified body for any of those.
  if (response.status === 400) {
    const bodyText = typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? text);
    if (/context|too long|maximum.*length|token.*limit/i.test(bodyText)) {
      throw new ContextOverflowError(`${provider} context overflow`, {
        provider,
        status: 400,
        body: parsed ?? text,
      });
    }
  }

  throw new LLMProviderError(`${provider} HTTP ${response.status}: ${text.slice(0, 500)}`, {
    provider,
    status: response.status,
    body: parsed ?? text,
  });
}
