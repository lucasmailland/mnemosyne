/**
 * Regression: the entity read/write routes must accept the ids the system
 * actually mints.
 *
 * `EntityIdParamSchema` gates every `/entities/{id}` route on
 * `/^ment_[a-z0-9_]{1,64}$/`. Nothing in production has ever produced that
 * shape: `mnemo_entity.id` is a bare `text` column with no default, every
 * adapter fills it with `uuid()`, and a grep for a `ment_` generator outside
 * the test tree returns only OpenAPI `example:` strings. Measured against a
 * live stack: 2 of 2 rows in `mnemo_entity` are UUIDs, 0 match `ment_`.
 *
 * So `POST /entities` answered 201 with an id that its own `GET` rejected as
 * "Malformed entity id" — five of the seven actions `memory_entity` exposes
 * (get, linked_facts, update, link_user, unlink_user) were unreachable for
 * every entity in existence.
 *
 * This went unnoticed because the existing suite works around it:
 * `entities-link-user.test.ts` re-keys each freshly-created row to a
 * `ment_test<n>` id "so the route's param validation doesn't 400 before the
 * handler even runs — a test-double gap, not a production concern." The
 * premise is inverted. The uuid IS what production stores, and re-keying past
 * the validator is precisely what hid the bug.
 *
 * These tests therefore use the id the adapter returns, unmodified.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountEntities } from "../../routes/entities.js";

const WS = "11111111-1111-1111-1111-111111111111";

function makeApp(storage: InMemoryStorageAdapter) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "key-record-id");
    c.set("actorType", "user");
    c.set("userId", "user-self");
    c.set("scopes", ["memory:read", "memory:write", "memory:admin"]);
    await next();
  });

  const apiKeys = {
    listActive: vi.fn().mockResolvedValue([]),
    touch: vi.fn(),
    getWorkspaceMemberRole: vi.fn(async () => "admin"),
  };

  const fakeDeps = { storage, apiKeys, core: {} as unknown } as unknown as ServerDeps;
  mountEntities(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app.request.bind(app);
}

async function seedEntity(storage: InMemoryStorageAdapter) {
  return storage.createEntity({
    workspaceId: WS,
    name: "ollama",
    kind: "concept",
    aliases: [],
    sensitivity: "internal",
  } as never);
}

describe("entity routes accept the uuid ids the adapter mints", () => {
  let storage: InMemoryStorageAdapter;
  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  it("createEntity mints a uuid, not a ment_ id", async () => {
    const entity = await seedEntity(storage);
    expect(entity.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(entity.id.startsWith("ment_")).toBe(false);
  });

  it("GET /entities/:id resolves an entity by its minted id", async () => {
    const entity = await seedEntity(storage);
    const request = makeApp(storage);

    const res = await request(`/entities/${entity.id}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { entity: { id: string; name: string } };
    expect(body.entity.id).toBe(entity.id);
    expect(body.entity.name).toBe("ollama");
  });

  it("GET /entities/:id/facts resolves linked facts by the minted id", async () => {
    const entity = await seedEntity(storage);
    const request = makeApp(storage);

    const res = await request(`/entities/${entity.id}/facts`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { facts: unknown[] };
    expect(Array.isArray(body.facts)).toBe(true);
  });

  it("PATCH /entities/:id updates an entity by its minted id", async () => {
    const entity = await seedEntity(storage);
    const request = makeApp(storage);

    const res = await request(`/entities/${entity.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "runs natively on the host" }),
    });

    expect(res.status).toBe(200);
  });

  it("still rejects an id that is neither a uuid nor a ment_ slug", async () => {
    const request = makeApp(storage);

    const res = await request("/entities/not a valid id");

    expect(res.status).toBe(400);
  });

  it("still accepts the legacy ment_ shape", async () => {
    const entity = await seedEntity(storage);
    const store = (storage as unknown as { entities: Map<string, unknown> }).entities;
    const legacy = { ...(entity as object), id: "ment_legacyseed01" };
    store.delete(entity.id);
    store.set("ment_legacyseed01", legacy);
    const request = makeApp(storage);

    const res = await request("/entities/ment_legacyseed01");

    expect(res.status).toBe(200);
  });
});
