/**
 * Regression companion to `entities-uuid-id.test.ts`.
 *
 * `GET /graph?focus=<id>` documents `focus` as "an optional `mnemo_entity.id`"
 * and then validates it against the same `ment_<slug>` pattern the entity
 * routes used — a shape no adapter has ever minted. Passing a real entity id
 * (a uuid, which is what `POST /entities` returns) was rejected before the
 * handler ran, so the focused 1-hop view was unreachable for every entity.
 *
 * Same defect, second location. The validator now lives in one module
 * (`../../entity-id.js`) so a third copy cannot drift away from the first two.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountGraph } from "../../routes/graph.js";

const WS = "11111111-1111-1111-1111-111111111111";

function makeApp(storage: InMemoryStorageAdapter) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "key-record-id");
    c.set("actorType", "user");
    c.set("userId", "user-self");
    c.set("scopes", ["memory:read"]);
    await next();
  });

  const apiKeys = {
    listActive: vi.fn().mockResolvedValue([]),
    touch: vi.fn(),
    getWorkspaceMemberRole: vi.fn(async () => "admin"),
  };

  const fakeDeps = { storage, apiKeys, core: {} as unknown } as unknown as ServerDeps;
  mountGraph(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app.request.bind(app);
}

describe("GET /graph focus accepts the uuid ids entities actually have", () => {
  let storage: InMemoryStorageAdapter;
  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  it("accepts a focus that is the id of a real entity", async () => {
    const entity = await storage.createEntity({
      workspaceId: WS,
      name: "ollama",
      kind: "concept",
      aliases: [],
      sensitivity: "internal",
    } as never);
    const request = makeApp(storage);

    const res = await request(`/graph?focus=${entity.id}`);

    expect(res.status).toBe(200);
  });

  it("still accepts the legacy ment_ shape", async () => {
    const request = makeApp(storage);

    const res = await request("/graph?focus=ment_legacyseed01");

    expect(res.status).toBe(200);
  });

  it("still rejects a focus that is neither shape", async () => {
    const request = makeApp(storage);

    const res = await request("/graph?focus=not a valid id");

    expect(res.status).toBe(400);
  });
});
