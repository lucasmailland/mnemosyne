/**
 * Unit tests for POST/DELETE /entities/:id/link-user (P44-adjacent —
 * provenance-identity Phase 3 step 4).
 *
 * Uses the same pattern as self-routes.test.ts: a minimal OpenAPIHono app
 * with fake auth middleware + InMemoryStorageAdapter (real bitemporal /
 * relation logic, no DB).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountEntities } from "../../routes/entities.js";

const WS = "11111111-1111-1111-1111-111111111111";
const SELF_USER = "user-self";
const OTHER_USER = "user-other";
const ADMIN_USER = "user-admin";

function makeApp(
  storage: InMemoryStorageAdapter,
  auth: { userId?: string | null; scopes?: string[] } = {},
  roleByUser: Record<string, string | null> = {}
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "key-record-id");
    c.set("actorType", "user");
    c.set("userId", auth.userId ?? SELF_USER);
    c.set("scopes", auth.scopes ?? []);
    await next();
  });

  const apiKeys = {
    listActive: vi.fn().mockResolvedValue([]),
    touch: vi.fn(),
    getWorkspaceMemberRole: vi.fn(async (userId: string) => roleByUser[userId] ?? null),
  };

  const fakeDeps = { storage, apiKeys, core: {} as unknown } as unknown as ServerDeps;
  mountEntities(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app.request.bind(app);
}

// These tests used to re-key each freshly-created entity to a synthetic
// "ment_test<n>" id before making a request, on the stated grounds that
// "EntityIdParamSchema requires the ment_<slug> id format the real (Postgres)
// id generator produces ... a test-double gap, not a production concern."
//
// That premise was backwards. No adapter has ever minted a `ment_` id — the
// real generator produces uuid(), exactly like the in-memory double — so the
// re-keying was not closing a test-double gap, it was the only reason these
// tests passed while every one of these routes 400'd in production. The id
// validator now accepts what the system actually stores (../../entity-id.ts),
// and these tests use the adapter's own id, unmodified, so they would catch
// the regression instead of hiding it.
async function makePersonEntity(
  storage: InMemoryStorageAdapter,
  sensitivity: "public" | "internal" = "public"
) {
  return storage.createEntity({
    workspaceId: WS,
    name: "Ada Lovelace",
    kind: "person",
    aliases: [],
    sensitivity,
  } as never);
}

describe("POST /entities/:id/link-user", () => {
  let storage: InMemoryStorageAdapter;
  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  it("allows self-link and bumps public sensitivity to internal", async () => {
    const entity = await makePersonEntity(storage, "public");
    const request = makeApp(storage, { userId: SELF_USER }, { [SELF_USER]: "read" });

    const res = await request(`/entities/${entity.id}/link-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: SELF_USER }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.linkedUserId).toBe(SELF_USER);
    expect(body.sensitivity).toBe("internal");
  });

  it("rejects linking a different user without memory:admin (403)", async () => {
    const entity = await makePersonEntity(storage, "internal");
    const request = makeApp(storage, { userId: SELF_USER });

    const res = await request(`/entities/${entity.id}/link-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: OTHER_USER }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects an admin-scoped caller who is not owner/admin of this workspace (403)", async () => {
    const entity = await makePersonEntity(storage, "internal");
    const request = makeApp(
      storage,
      { userId: ADMIN_USER, scopes: ["memory:admin"] },
      { [ADMIN_USER]: "write", [OTHER_USER]: "read" }
    );

    const res = await request(`/entities/${entity.id}/link-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: OTHER_USER }),
    });

    expect(res.status).toBe(403);
  });

  it("allows an admin-scoped workspace owner to link a different (member) user", async () => {
    const entity = await makePersonEntity(storage, "internal");
    const request = makeApp(
      storage,
      { userId: ADMIN_USER, scopes: ["memory:admin"] },
      { [ADMIN_USER]: "owner", [OTHER_USER]: "read" }
    );

    const res = await request(`/entities/${entity.id}/link-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: OTHER_USER }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).linkedUserId).toBe(OTHER_USER);
  });

  it("returns 404 when the target user is not a workspace member", async () => {
    const entity = await makePersonEntity(storage, "internal");
    const request = makeApp(
      storage,
      { userId: ADMIN_USER, scopes: ["memory:admin"] },
      { [ADMIN_USER]: "owner" } // OTHER_USER intentionally absent → not a member
    );

    const res = await request(`/entities/${entity.id}/link-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: OTHER_USER }),
    });

    expect(res.status).toBe(404);
  });

  it("rejects linking a non-person entity (400)", async () => {
    const entity = await storage.createEntity({
      workspaceId: WS,
      name: "Acme Corp",
      kind: "organization",
      aliases: [],
      sensitivity: "internal",
    } as never);
    const request = makeApp(storage, { userId: SELF_USER });

    const res = await request(`/entities/${entity.id}/link-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: SELF_USER }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 404 for a well-formed but nonexistent entity id", async () => {
    const request = makeApp(storage, { userId: SELF_USER });
    const missingRes = await request(`/entities/ment_doesnotexist/link-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: SELF_USER }),
    });
    expect(missingRes.status).toBe(404);
  });

  // SEC regression: self-link alone must not be enough to silently hijack an
  // entity already linked to a DIFFERENT user just by naming yourself as the
  // new target — reassignment requires the same admin+role permission over
  // the CURRENT link-holder that linking a stranger would require.
  it("rejects a non-admin caller self-linking an entity already linked to someone else (403)", async () => {
    const entity = await makePersonEntity(storage, "internal");
    const linked = await storage.updateEntity(entity.id, {
      workspaceId: WS,
      linkedUserId: SELF_USER,
    });
    const request = makeApp(storage, { userId: OTHER_USER }); // no memory:admin

    const res = await request(`/entities/${linked.id}/link-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: OTHER_USER }), // "self"-linking, but hijacking SELF_USER's link
    });

    expect(res.status).toBe(403);
    // The original link must be untouched.
    const unchanged = await storage.getEntity(linked.id, WS);
    expect(unchanged?.linkedUserId).toBe(SELF_USER);
    expect(unchanged?.validTo).toBeFalsy();
  });

  it("allows an admin-scoped workspace owner to reassign an entity already linked to a different user, bitemporally", async () => {
    const entity = await makePersonEntity(storage, "internal");
    const linked = await storage.updateEntity(entity.id, {
      workspaceId: WS,
      linkedUserId: SELF_USER,
    });
    const request = makeApp(
      storage,
      { userId: ADMIN_USER, scopes: ["memory:admin"] },
      { [ADMIN_USER]: "owner", [SELF_USER]: "read", [OTHER_USER]: "read" }
    );

    const res = await request(`/entities/${linked.id}/link-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: OTHER_USER }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.linkedUserId).toBe(OTHER_USER);
    expect(body.id).not.toBe(linked.id);

    // Old row closed, not blanked in place.
    const original = await storage.getEntity(linked.id, WS);
    expect(original?.validTo).toBeTruthy();
    expect(original?.linkedUserId).toBe(SELF_USER);

    // Lineage recorded via supersedes, same convention as unlink.
    const relations = await storage.getRelations({ workspaceId: WS, sourceId: body.id });
    const supersedes = relations.find((r) => r.verb === "supersedes" && r.targetId === linked.id);
    expect(supersedes).toBeTruthy();
  });
});

describe("DELETE /entities/:id/link-user", () => {
  let storage: InMemoryStorageAdapter;
  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  async function linkedEntity() {
    const entity = await makePersonEntity(storage, "internal");
    const linked = await storage.updateEntity(entity.id, {
      workspaceId: WS,
      linkedUserId: SELF_USER,
    });
    return linked;
  }

  it("closes the linked row and creates an unlinked successor via a supersedes relation", async () => {
    const entity = await linkedEntity();
    const request = makeApp(storage, { userId: SELF_USER });

    const res = await request(`/entities/${entity.id}/link-user`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.linkedUserId).toBeFalsy();
    expect(body.id).not.toBe(entity.id);

    // Original row is closed (validTo set), not deleted.
    const original = await storage.getEntity(entity.id, WS);
    expect(original?.validTo).toBeTruthy();

    // A supersedes relation links successor -> predecessor.
    const relations = await storage.getRelations({ workspaceId: WS, sourceId: body.id });
    const supersedes = relations.find((r) => r.verb === "supersedes" && r.targetId === entity.id);
    expect(supersedes).toBeTruthy();
  });

  it("returns 404 when the entity is not currently linked", async () => {
    const entity = await makePersonEntity(storage, "internal");
    const request = makeApp(storage, { userId: SELF_USER });

    const res = await request(`/entities/${entity.id}/link-user`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("rejects unlinking someone else's entity without memory:admin (403)", async () => {
    const entity = await linkedEntity();
    const request = makeApp(storage, { userId: OTHER_USER });

    const res = await request(`/entities/${entity.id}/link-user`, { method: "DELETE" });
    expect(res.status).toBe(403);
  });
});

describe("PRIM-2 / PRIM-16: entity lifecycle over HTTP", () => {
  let storage: InMemoryStorageAdapter;
  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  const post = (request: ReturnType<typeof makeApp>, path: string, body: unknown) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("a duplicate create is a 409, not a 500", async () => {
    const request = makeApp(storage);
    const first = await post(request, "/entities", { name: "Acme", kind: "organization" });
    expect(first.status).toBe(201);
    const dup = await post(request, "/entities", { name: "Acme", kind: "organization" });
    expect(dup.status).toBe(409);
  });

  it("a closed entity's name can be created again", async () => {
    const request = makeApp(storage);
    const first = await (
      await post(request, "/entities", { name: "Gone", kind: "concept" })
    ).json();
    await storage.archiveEntity(first.id, WS);
    const again = await post(request, "/entities", { name: "Gone", kind: "concept" });
    expect(again.status).toBe(201);
  });

  it("unlinking twice: the second call conflicts instead of losing the entity", async () => {
    const entity = await makePersonEntity(storage, "internal");
    await storage.updateEntity(entity.id, { workspaceId: WS, linkedUserId: SELF_USER });
    const request = makeApp(storage, { userId: SELF_USER });
    const first = await request(`/entities/${entity.id}/link-user`, { method: "DELETE" });
    expect(first.status).toBe(200);
    const second = await request(`/entities/${entity.id}/link-user`, { method: "DELETE" });
    expect(second.status).toBe(409);
    const live = await storage.queryEntities({
      workspaceId: WS,
      name: "Ada Lovelace",
      openOnly: true,
    });
    expect(live.items).toHaveLength(1);
  });

  it("lists only current entities unless includeClosed=true", async () => {
    const request = makeApp(storage);
    const keep = await (await post(request, "/entities", { name: "Keep", kind: "concept" })).json();
    const drop = await (await post(request, "/entities", { name: "Drop", kind: "concept" })).json();
    await storage.archiveEntity(drop.id, WS);

    const current = await (await request("/entities")).json();
    expect(current.items.map((e: { id: string }) => e.id)).toEqual([keep.id]);

    const all = await (await request("/entities?includeClosed=true")).json();
    expect(all.items.map((e: { id: string }) => e.id).sort()).toEqual([keep.id, drop.id].sort());
  });
});
