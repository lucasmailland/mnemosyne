/**
 * APP-024 (audit 2026-11-22): /memory/ws sits behind the HTTP bearer
 * middleware, which only read the Authorization header, so the SDK's
 * `?token=` upgrade got 401 before the socket handler ever ran. On that one
 * path the middleware now takes the key from `?token=` when no header is sent;
 * nowhere else does a query-string key authenticate.
 */
import bcrypt from "bcrypt";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { BCRYPT_COST, createAuthMiddleware, type ApiKeyLookup } from "../../auth.js";
import { toErrorBody } from "../../errors.js";

const KEY = "mns_live_wsquerytoken0123456789";

async function app() {
  const keyHash = await bcrypt.hash(KEY, BCRYPT_COST);
  const lookup = {
    listActive: async () => [
      { id: "key-ws", keyHash, workspaceId: "11111111-1111-4111-8111-111111111111", scopes: ["memory:subscribe", "memory:read"] },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const a = new Hono();
  a.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as 401);
  });
  a.use("*", createAuthMiddleware(lookup));
  a.get("/memory/ws", (c) => c.text("upgrade"));
  a.get("/facts", (c) => c.text("facts"));
  return a;
}

describe("bearer middleware and the WebSocket path", () => {
  it("accepts ?token= on /memory/ws", async () => {
    const res = await (await app()).request(`/memory/ws?token=${KEY}`);
    expect(res.status).toBe(200);
  });

  it("still accepts the Authorization header there", async () => {
    const res = await (await app()).request("/memory/ws", { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(200);
  });

  it("does not accept a query-string key anywhere else", async () => {
    const res = await (await app()).request(`/facts?token=${KEY}`);
    expect(res.status).toBe(401);
  });

  it("refuses a wrong ?token= on /memory/ws", async () => {
    const res = await (await app()).request("/memory/ws?token=mns_live_notthekey000000000000");
    expect(res.status).toBe(401);
  });
});
