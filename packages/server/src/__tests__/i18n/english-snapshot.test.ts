/**
 * P2-1: with no locale chosen, error bodies are byte-identical to before the
 * localization layer. Written and run against the unchanged app first (R3);
 * the same snapshots must pass after the post-filter exists.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { authed, buildApp, reqId } from "./_app.js";

let app: Hono;
beforeAll(async () => {
  app = await buildApp();
});

async function raw(path: string, init: RequestInit = {}) {
  const res = await app.request(path, { ...init, headers: { ...reqId, ...(init.headers ?? {}) } });
  return { status: res.status, body: await res.text() };
}

describe("English error bodies, byte for byte", () => {
  it("one error per class (defaults)", async () => {
    const out: Record<string, unknown> = {};
    for (const name of [
      "bad",
      "unauthorized",
      "forbidden",
      "notfound",
      "conflict",
      "ratelimited",
      "unprocessable",
      "unavailable",
      "internal",
      "notimpl",
      "custom",
      "storage",
      "breaker",
    ])
      out[name] = await raw(`/__t/${name}`, { headers: authed });
    expect(out).toMatchInlineSnapshot(`
      {
        "bad": {
          "body": "{"error":{"type":"invalid_request_error","code":"bad_request","message":"Bad request","param":"x","details":{"field":"x"},"request_id":"req-i18n-1","retryable":false}}",
          "status": 400,
        },
        "breaker": {
          "body": "{"error":{"type":"api_error","code":"service_unavailable","message":"A dependency is temporarily unavailable. Retry later; the request was not attempted.","details":{"retryAfterSeconds":30},"request_id":"req-i18n-1","retryable":true,"retryAfterSeconds":30}}",
          "status": 503,
        },
        "conflict": {
          "body": "{"error":{"type":"conflict_error","code":"conflict","message":"Conflict","request_id":"req-i18n-1","retryable":false}}",
          "status": 409,
        },
        "custom": {
          "body": "{"error":{"type":"invalid_request_error","code":"custom","message":"A message nobody translated","request_id":"req-i18n-1","retryable":false}}",
          "status": 400,
        },
        "forbidden": {
          "body": "{"error":{"type":"permission_error","code":"forbidden","message":"Forbidden","request_id":"req-i18n-1","retryable":false}}",
          "status": 403,
        },
        "internal": {
          "body": "{"error":{"type":"api_error","code":"internal_error","message":"Internal server error","request_id":"req-i18n-1","retryable":false}}",
          "status": 500,
        },
        "notfound": {
          "body": "{"error":{"type":"not_found_error","code":"not_found","message":"Not found","request_id":"req-i18n-1","retryable":false}}",
          "status": 404,
        },
        "notimpl": {
          "body": "{"error":{"type":"api_error","code":"not_implemented","message":"Not implemented","request_id":"req-i18n-1","retryable":false}}",
          "status": 501,
        },
        "ratelimited": {
          "body": "{"error":{"type":"rate_limit_error","code":"rate_limited","message":"Too many requests","request_id":"req-i18n-1","retryable":true,"retryAfterSeconds":60}}",
          "status": 429,
        },
        "storage": {
          "body": "{"error":{"type":"conflict_error","code":"conflict","message":"Entity e-1 is already closed","request_id":"req-i18n-1","retryable":false}}",
          "status": 409,
        },
        "unauthorized": {
          "body": "{"error":{"type":"authentication_error","code":"unauthorized","message":"Unauthorized","request_id":"req-i18n-1","retryable":false}}",
          "status": 401,
        },
        "unavailable": {
          "body": "{"error":{"type":"api_error","code":"service_unavailable","message":"Service unavailable","request_id":"req-i18n-1","retryable":true}}",
          "status": 503,
        },
        "unprocessable": {
          "body": "{"error":{"type":"invalid_request_error","code":"unprocessable_entity","message":"Unprocessable entity","request_id":"req-i18n-1","retryable":false}}",
          "status": 422,
        },
      }
    `);
  });

  it("a zod validation error", async () => {
    const r = await raw("/conflicts/not-a-uuid/resolve", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({}),
    });
    expect(r).toMatchInlineSnapshot(`
      {
        "body": "{"error":{"type":"invalid_request_error","code":"validation_error","message":"action: Invalid option: expected one of \\"supersede_a\\"|\\"supersede_b\\"|\\"keep_both\\"|\\"merge\\"","details":{"issues":[{"path":"action","message":"Invalid option: expected one of \\"supersede_a\\"|\\"supersede_b\\"|\\"keep_both\\"|\\"merge\\"","code":"invalid_value"}]},"request_id":"req-i18n-1","retryable":false}}",
        "status": 400,
      }
    `);
  });

  it("a flat dashboard-auth body", async () => {
    const r = await raw("/dashboard/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(r).toMatchInlineSnapshot(`
      {
        "body": "{"error":"invalid_json","message":"Request body must be valid JSON"}",
        "status": 400,
      }
    `);
  });

  it("the 413 body limit", async () => {
    const r = await raw("/conflicts/x/resolve", {
      method: "POST",
      headers: { ...authed, "content-length": String(2 * 1024 * 1024) },
      body: "{}",
    });
    expect(r).toMatchInlineSnapshot(`
      {
        "body": "{"error":{"type":"api_error","code":"payload_too_large","message":"Request body exceeds 1 MB limit","retryable":false}}",
        "status": 413,
      }
    `);
  });

  it("the 401 from the bearer middleware", async () => {
    expect(await raw("/facts")).toMatchInlineSnapshot(`
      {
        "body": "{"error":{"type":"authentication_error","code":"unauthorized","message":"Missing bearer token","request_id":"req-i18n-1","retryable":false}}",
        "status": 401,
      }
    `);
  });
});
