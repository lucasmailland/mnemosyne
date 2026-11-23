/**
 * Re-audit 2026-11-22: the caller's X-Request-Id was taken as given, logged on
 * every line of the request and echoed back, at any length and with any bytes.
 * A usable id (at most 128 characters of [A-Za-z0-9._:-]) is kept for
 * correlation; anything else is replaced by a minted UUID.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { requestIdFrom } from "../../app.js";
import { authed, buildApp } from "../i18n/_app.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("requestIdFrom", () => {
  it.each(["req-1", "a".repeat(128), "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", "svc.v1:42_x"])(
    "keeps %s",
    (id) => {
      expect(requestIdFrom(id)).toBe(id);
    }
  );

  it.each([undefined, "", "a".repeat(129), "id with spaces", "id‮evil", "{\"json\":1}"])(
    "mints a UUID for %j",
    (id) => {
      expect(requestIdFrom(id)).toMatch(UUID);
    }
  );
});

describe("the request-id middleware", () => {
  let app: Hono;
  beforeAll(async () => {
    app = await buildApp();
  });

  it("does not echo an oversized id", async () => {
    const res = await app.request("/__t/notfound", { headers: { ...authed, "x-request-id": "x".repeat(10_000) } });
    expect(res.headers.get("x-request-id")).toMatch(UUID);
  });

  it("echoes a well-formed id", async () => {
    const res = await app.request("/__t/notfound", { headers: { ...authed, "x-request-id": "req-ok-1" } });
    expect(res.headers.get("x-request-id")).toBe("req-ok-1");
  });
});
