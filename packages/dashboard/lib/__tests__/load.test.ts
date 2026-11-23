/**
 * APP-043: a browser-side load that the server never answers ends, and says why.
 */
import { afterEach, expect, it, vi } from "vitest";

import { en } from "@/lib/i18n/messages/en";
import { es } from "@/lib/i18n/messages/es";

import { LOAD_TIMEOUT_MS, loadFailure, loadSignal } from "../load";

afterEach(() => vi.restoreAllMocks());

const t = (key: string) => key;

it("times out after LOAD_TIMEOUT_MS: the signal is AbortSignal.timeout's", () => {
  // AbortSignal.timeout runs on the platform's own clock, out of reach of fake timers.
  const timed = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timed.signal);
  const signal = loadSignal();
  expect(timeout).toHaveBeenCalledWith(LOAD_TIMEOUT_MS);
  expect(LOAD_TIMEOUT_MS).toBe(15_000);
  timed.abort(new DOMException("timed out", "TimeoutError"));
  expect(signal.aborted).toBe(true);
  expect((signal.reason as Error).name).toBe("TimeoutError");
});

it("keeps the caller's own cancel: an outer abort aborts the load at once", () => {
  const outer = new AbortController();
  const signal = loadSignal(outer.signal);
  outer.abort();
  expect(signal.aborted).toBe(true);
});

it("tells a timeout apart from a network failure", () => {
  expect(loadFailure(t as never, new DOMException("timed out", "TimeoutError"))).toBe(
    "errors.timeout"
  );
  expect(loadFailure(t as never, new TypeError("fetch failed"))).toBe("errors.network");
});

it("says the timeout in both languages", () => {
  expect(en.errors.timeout).toMatch(/too long/);
  expect(es.errors.timeout).toMatch(/demasiado/);
});
