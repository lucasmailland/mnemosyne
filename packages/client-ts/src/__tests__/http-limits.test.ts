/**
 * Audit 2026-11-22 — how long a call may take, and what a failure says.
 *
 * APP-014: the MCP server built one client with a 15 s budget, and a session
 * collapse takes ~50 s, so it always reported a timeout. `withTimeout()` gives
 * one call a longer budget without touching the shared client.
 * APP-023: a 429 slept its Retry-After uncapped (60 s by default, twice) inside
 * the call. Past MAX_RETRY_AFTER the 429 is surfaced instead.
 * A transport failure said only "fetch failed": it now names the cause code and
 * the host:port it tried, never the key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MnemosyneAPIError,
  MnemosyneClient,
  MnemosyneNetworkError,
  MnemosyneTimeoutError,
} from "../index.js";
import { HttpClient } from "../http.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A fetch that never answers until its signal aborts. */
const hangingFetch = (async (_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) =>
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  )) as unknown as typeof fetch;

function rateLimited(retryAfter: string): Response {
  return new Response(JSON.stringify({ error: { code: "rate_limited", message: "wait" } }), {
    status: 429,
    headers: { "Retry-After": retryAfter, "content-type": "application/json" },
  });
}

describe("withTimeout (APP-014)", () => {
  it("gives the clone its own budget and leaves the original untouched", async () => {
    vi.useFakeTimers();
    const client = new MnemosyneClient({
      url: "https://memory.test",
      apiKey: "test-key",
      timeout: 1_000,
      retry: { attempts: 1 },
      fetch: hangingFetch,
    });
    const slow = client.withTimeout(120_000);

    const fast = client.health().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await fast).toBeInstanceOf(MnemosyneTimeoutError);

    let settled = false;
    const long = slow.health().then(
      () => (settled = true),
      (e: unknown) => ((settled = true), e)
    );
    await vi.advanceTimersByTimeAsync(119_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await long).toMatchObject({ timeoutMs: 120_000 });
  });
});

describe("Retry-After cap (APP-023)", () => {
  it("surfaces a 429 whose Retry-After exceeds 5 s instead of sleeping it", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => rateLimited("60"));
    const http = new HttpClient({
      baseUrl: "https://memory.test",
      apiKey: "test-key",
      timeoutMs: 10_000,
      retry: { attempts: 3 },
      userAgent: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // No timer is advanced: a sleep of 60 s would leave this pending forever.
    const error = await http.request({ method: "GET", path: "/health" }).catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(MnemosyneAPIError);
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 60 });
  });

  it("still waits out a Retry-After of 5 s or less and retries", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimited("3"))
      .mockResolvedValueOnce(Response.json({ status: "ok" }));
    const http = new HttpClient({
      baseUrl: "https://memory.test",
      apiKey: "test-key",
      timeoutMs: 10_000,
      retry: { attempts: 3 },
      userAgent: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const pending = http.request({ method: "GET", path: "/health" });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ status: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("network failure message", () => {
  it("names the cause code and host:port, never the key", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3939"), {
      code: "ECONNREFUSED",
    });
    const http = new HttpClient({
      baseUrl: "http://user:pw@localhost:3939",
      apiKey: "mns_live_secret",
      timeoutMs: 1_000,
      retry: { attempts: 1 },
      userAgent: "test",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed", { cause });
      }) as typeof fetch,
    });
    const error = await http.request({ method: "GET", path: "/health" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MnemosyneNetworkError);
    const message = (error as Error).message;
    expect(message).toContain("fetch failed");
    expect(message).toContain("ECONNREFUSED");
    expect(message).toContain("localhost:3939");
    expect(message).not.toContain("mns_live_secret");
    expect(message).not.toContain("pw");
  });

  it("fills in the default port and reads the code from an AggregateError", async () => {
    const cause = new AggregateError([Object.assign(new Error("x"), { code: "ENOTFOUND" })]);
    const http = new HttpClient({
      baseUrl: "https://memory.test",
      apiKey: "k",
      timeoutMs: 1_000,
      retry: { attempts: 1 },
      userAgent: "test",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed", { cause });
      }) as typeof fetch,
    });
    const error = await http.request({ method: "GET", path: "/health" }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("fetch failed (ENOTFOUND, memory.test:443)");
  });
});
