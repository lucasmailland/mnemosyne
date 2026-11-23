/**
 * A0/A1 — full-path request assertion helper.
 *
 * The bug class this guards against: `expect(url).toContain("/export/jsonl")`
 * passes against a BROKEN URL still carrying the stale version-prefixed path
 * segment (the exact defect Req 1/A1 fixed) just as readily as against the
 * real root-mounted `/export/jsonl` path. A substring match can never fail
 * on a stray version prefix.
 *
 * `expectRequest` parses the URL and asserts exact `pathname` equality
 * instead — base-URL-agnostic and query-agnostic, so it survives config
 * changes while still failing loudly if a stale prefix is reintroduced.
 */
import { expect } from "vitest";

export interface RecordedCall {
  url: string;
  opts?: RequestInit;
}

export interface ExpectedRequest {
  method?: string;
  pathname: string;
  search?: Record<string, string>;
}

export function expectRequest(call: RecordedCall, expected: ExpectedRequest): void {
  const u = new URL(call.url);
  expect(u.pathname).toBe(expected.pathname);
  if (expected.method) {
    expect(call.opts?.method ?? "GET").toBe(expected.method);
  }
  if (expected.search) {
    expect(Object.fromEntries(u.searchParams)).toEqual(expected.search);
  }
}
