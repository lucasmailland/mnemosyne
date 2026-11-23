/**
 * Unit test for POST /entities — entity-provenance R1 scenario:
 * "Entity created via HTTP carries real provenance".
 *
 * routes/entities.ts already resolves resolveProvenance(c) but used to
 * forward only actorId to deps.core.createEntity, silently dropping
 * userId/actorType. This asserts the route forwards the EXACT triple
 * resolveProvenance(c) produces — see CLAUDE.md "Provenance identity" and
 * docs/archive/openspec/flatten-legacy-dual-core/spec.md's entity-provenance capability,
 * Requirement 1.
 *
 * Uses the same minimal-app pattern as entities-link-user.test.ts: a
 * fake auth middleware + a mocked deps.storage (no real DB / no real
 * @mnemo-ai/core needed — this test only asserts the forwarding
 * contract at the HTTP boundary).
 *
 * flatten-legacy-dual-core PR8: `createEntityRoute` was ported from
 * `deps.core.createEntity` to `deps.storage.createEntity` — updated the
 * fixture wiring here to match (Date fields, not ISO strings, since the
 * route now runs the mock's return value through `entityToWire()`).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import { formatActorRef } from "@mnemo-ai/types";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountEntities } from "../../routes/entities.js";

const WS = "11111111-1111-1111-1111-111111111111";

function makeApp(
  createEntityMock: ReturnType<typeof vi.fn>,
  auth: { actorId: string; userId: string | null; actorType: "user" | "agent" | "system" }
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", auth.actorId);
    c.set("actorType", auth.actorType);
    c.set("userId", auth.userId);
    c.set("scopes", ["memory:write"]);
    await next();
  });

  const fakeDeps = {
    storage: {
      createEntity: createEntityMock,
      countEntityMentions: vi.fn().mockResolvedValue({}),
    } as unknown,
    apiKeys: {} as unknown,
    core: {} as unknown,
  } as unknown as ServerDeps;
  mountEntities(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app.request.bind(app);
}

describe("POST /entities — provenance forwarding (entity-provenance R1)", () => {
  it("forwards actorId/userId/actorType to createEntity matching resolveProvenance(c) exactly", async () => {
    const created = {
      id: "ment_test1",
      workspaceId: WS,
      name: "Ada Lovelace",
      kind: "person",
      aliases: [],
      canonicalId: null,
      description: null,
      sensitivity: "internal",
      metadata: {},
      firstSeenAt: new Date(), // determinism-ok: fixture timestamp, not asserted
      lastSeenAt: new Date(), // determinism-ok: fixture timestamp, not asserted
      mentionCount: 1,
      // P120: the response schema now projects the bitemporal interval.
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validTo: null,
      createdAt: new Date(), // determinism-ok: fixture timestamp, not asserted
      updatedAt: new Date(), // determinism-ok: fixture timestamp, not asserted
    };
    const createEntityMock = vi.fn().mockResolvedValue(created);
    const request = makeApp(createEntityMock, {
      actorId: "key-record-id",
      userId: "user-42",
      actorType: "user",
    });

    const res = await request("/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada Lovelace", kind: "person", aliases: [] }),
    });

    expect(res.status).toBe(201);
    expect(createEntityMock).toHaveBeenCalledOnce();
    const forwarded = createEntityMock.mock.calls[0]?.[0] as Record<string, unknown>;

    // Exact match against what resolveProvenance(c) would produce for this
    // auth context — namespaced actorId, real userId, resolved actorType.
    expect(forwarded.actorId).toBe(formatActorRef("key", "key-record-id"));
    expect(forwarded.userId).toBe("user-42");
    expect(forwarded.actorType).toBe("user");
    // None silently dropped or nulled.
    expect(forwarded.actorId).not.toBeNull();
    expect(forwarded.userId).not.toBeNull();
    expect(forwarded.actorType).not.toBeNull();
  });

  it("forwards a null userId as null (agent caller, no platform account) rather than dropping the key", async () => {
    const created = {
      id: "ment_test2",
      workspaceId: WS,
      name: "Agent-created entity",
      kind: "concept",
      aliases: [],
      canonicalId: null,
      description: null,
      sensitivity: "internal",
      metadata: {},
      firstSeenAt: new Date(), // determinism-ok: fixture timestamp, not asserted
      lastSeenAt: new Date(), // determinism-ok: fixture timestamp, not asserted
      mentionCount: 1,
      // P120: the response schema now projects the bitemporal interval.
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validTo: null,
      createdAt: new Date(), // determinism-ok: fixture timestamp, not asserted
      updatedAt: new Date(), // determinism-ok: fixture timestamp, not asserted
    };
    const createEntityMock = vi.fn().mockResolvedValue(created);
    const request = makeApp(createEntityMock, {
      actorId: "key-record-id-2",
      userId: null,
      actorType: "agent",
    });

    const res = await request("/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Agent-created entity", kind: "concept", aliases: [] }),
    });

    expect(res.status).toBe(201);
    const forwarded = createEntityMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(forwarded.actorId).toBe(formatActorRef("key", "key-record-id-2"));
    expect(forwarded.userId).toBeNull();
    expect(forwarded.actorType).toBe("agent");
  });
});
