/**
 * APP-018 — a turn stores role and content. `POST /session/:id/turn` used to
 * accept `turnId` and `metadata` and drop them (the turn row has no column for
 * either: the id is generated, there is no metadata), so a caller believed
 * they were kept. They are refused with 400 now. `POST /session/:id/pin`
 * compared any `turnId` string to a uuid column, and a non-uuid answered 500
 * (Postgres 22P02): it is validated as a uuid first.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountRoutes } from "../index.js";

function createApp() {
  const appendTurn = vi.fn(async () => undefined);
  const pinSessionTurn = vi.fn(async () => true);
  const deps = {
    storage: {
      getSession: vi.fn(async () => ({
        id: "s-1",
        workspaceId: "ws",
        status: "active",
        sourceHost: null,
      })),
      appendTurn,
      pinSessionTurn,
    },
  } as unknown as ServerDeps;
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err, undefined);
    return c.json(body, status as 400 | 404 | 409 | 500);
  });
  app.use("*", async (c, next) => {
    c.set("workspaceId", "ws");
    c.set("actorId", "tester");
    await next();
  });
  mountRoutes(app, deps);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, appendTurn, pinSessionTurn };
}

describe("POST /session/:id/turn — fields a turn cannot store (APP-018)", () => {
  it.each([
    ["turnId", { turnId: "turn-1" }],
    ["metadata", { metadata: { model: "x" } }],
  ])("refuses %s with 400 and stores nothing", async (field, extra) => {
    const { post, appendTurn } = createApp();
    const res = await post("/session/s-1/turn", { role: "user", content: "hi", ...extra });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(field);
    expect(appendTurn).not.toHaveBeenCalled();
  });

  it("still appends a plain turn", async () => {
    const { post, appendTurn } = createApp();
    expect((await post("/session/s-1/turn", { role: "user", content: "hi" })).status).toBe(204);
    expect(appendTurn).toHaveBeenCalledOnce();
  });
});

describe("POST /session/:id/pin — turnId is a uuid (APP-018)", () => {
  it("a turnId that is not a uuid is a 400, never reaching storage", async () => {
    const { post, pinSessionTurn } = createApp();
    const res = await post("/session/s-1/pin", { turnId: "1", pinned: true });
    expect(res.status).toBe(400);
    expect(pinSessionTurn).not.toHaveBeenCalled();
  });

  it("a uuid turnId reaches storage", async () => {
    const { post, pinSessionTurn } = createApp();
    const res = await post("/session/s-1/pin", {
      turnId: "3f0c2a4e-8b1d-4c6a-9e2f-1a2b3c4d5e6f",
      pinned: true,
    });
    expect(res.status).toBe(204);
    expect(pinSessionTurn).toHaveBeenCalledOnce();
  });
});
