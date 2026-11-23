/**
 * p45 Slice D — relation/hyperedge provenance (unblocked by p46,
 * commit 50412a6a).
 *
 * Covers spec scenario family "resolveProvenance() carries into relation
 * and hyperedge writes": `relations.ts` POST /relations,
 * `hyperedges.ts` POST /hyperedges, and `conflicts.ts`'s 4
 * `createRelation` call sites (supersede_a, supersede_b, merge x2).
 *
 * Pattern mirrors provenance-a1.test.ts / provenance-a2.test.ts: a
 * minimal OpenAPIHono app + fake auth middleware that sets
 * actorId/userId/actorType directly on context, driven via
 * app.request() — no socket, no DB. `deps.storage.{createRelation,
 * createHyperedge}` are spies asserting they receive resolveProvenance(c)'s
 * triple.
 *
 * flatten-legacy-dual-core PR11 (B5): the "POST /conflicts/{id}/resolve"
 * describe block below now asserts against
 * `deps.storage.resolveConflict`'s forwarded `actorId`/`userId`/`actorType`
 * instead of the legacy `CoreLike.createRelation`'s 1-2 call sites — the
 * atomic v3 port collapsed conflicts.ts's chained legacy calls into one
 * composite call (see `ResolveConflictInput`'s doc comment, ports.ts).
 *
 * flatten-legacy-dual-core PR9d: the "POST /relations" describe block below
 * now asserts against `deps.storage.createRelation` (v3 `StorageAdapter`,
 * `sourceType`/`targetType`/`verb` field names) instead of the legacy
 * `CoreLike.createRelation` (`sourceKind`/`targetKind`/`relation`) — same
 * port PR9c (D6.4) unblocked. The `POST /hyperedges` block is unaffected
 * (out of this PR's scope) and unchanged.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountRelations } from "../relations.js";
import { mountHyperedges } from "../hyperedges.js";
import { mountConflicts } from "../conflicts.js";

const WS = "33333333-3333-3333-3333-333333333333";
const RAW_ACTOR_ID = "key-d-test-id";
const USER_ID = "user-d-test";

function withAuth(app: OpenAPIHono<{ Variables: AuthVariables }>): void {
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", RAW_ACTOR_ID);
    c.set("actorType", "user");
    c.set("userId", USER_ID);
    c.set("scopes", ["memory:write"]);
    await next();
  });
}

function withErrors(app: OpenAPIHono<{ Variables: AuthVariables }>): void {
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
}

// flatten-legacy-dual-core PR9d: domain (`MnemoRelation`) shape — real Date
// fields (relationToWire() calls .toISOString() on them) and
// sourceType/targetType/verb field names, not the legacy wire shape.
function makeRelation(overrides: Record<string, unknown> = {}) {
  return {
    id: "mrel_test",
    workspaceId: WS,
    sourceType: "fact",
    sourceId: "mfact_a",
    targetType: "fact",
    targetId: "mfact_b",
    verb: "related",
    weight: 1,
    coRecallCount: 0,
    directionality: 0,
    judgmentStatus: "pending",
    reason: null,
    evidence: null,
    confidence: null,
    markedByUserId: null,
    markedByKind: "agent",
    markedByModel: null,
    markedByPromptVersion: null,
    provenance: null,
    conversationId: null,
    supersededByRelationId: null,
    validFrom: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
    validTo: null,
    createdAt: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
    updatedAt: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
    ...overrides,
  };
}

describe("POST /relations — carries real provenance", () => {
  it("passes resolveProvenance(c)'s actorId/userId/actorType into deps.storage.createRelation", async () => {
    const createRelation = vi.fn(async (input: Record<string, unknown>) => makeRelation(input));
    const getFact = vi.fn(async () => ({ sensitivity: "internal" }));
    const deps = { storage: { createRelation, getFact } } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountRelations(app, deps);
    withErrors(app);

    const res = await app.request("/relations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceKind: "fact",
        sourceId: "mfact_a",
        targetKind: "fact",
        targetId: "mfact_b",
        relation: "related",
        markedByKind: "agent",
      }),
    });

    expect(res.status).toBe(201);
    expect(createRelation).toHaveBeenCalledTimes(1);
    const call = createRelation.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(call.userId).toBe(USER_ID);
    expect(call.actorType).toBe("user");
  });
});

describe("POST /hyperedges — carries real provenance", () => {
  it("passes resolveProvenance(c)'s actorId/userId/actorType into deps.storage.createHyperedge", async () => {
    const createHyperedge = vi.fn(async (input: Record<string, unknown>) => ({
      id: "mhyp_test",
      workspaceId: WS,
      memberIds: input.memberIds,
      label: input.label,
      description: input.description,
      contextQuery: input.contextQuery,
      activationCount: 0,
      worth: 0.5,
      validFrom: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      validTo: null,
      createdAt: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
    }));
    const deps = { storage: { createHyperedge } } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountHyperedges(app, deps);
    withErrors(app);

    const res = await app.request("/hyperedges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        memberIds: ["mfact_a", "mfact_b", "mfact_c"],
        label: "test hyperedge",
      }),
    });

    expect(res.status).toBe(201);
    expect(createHyperedge).toHaveBeenCalledTimes(1);
    const call = createHyperedge.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(call.userId).toBe(USER_ID);
    expect(call.actorType).toBe("user");
  });
});

describe("POST /conflicts/{id}/resolve — resolveConflict carries real provenance", () => {
  function makeConflictDeps(resolveConflict: ReturnType<typeof vi.fn>) {
    return {
      storage: {
        getRelations: vi.fn(async () => [
          {
            id: "mrel_conflict",
            workspaceId: WS,
            sourceId: "mfact_a",
            sourceType: "fact",
            targetId: "mfact_b",
            targetType: "fact",
            verb: "conflicts_with",
            weight: 1,
            confidence: null,
            validTo: undefined,
          },
        ]),
        // The route reads both facts for the read-ceiling check.
        getFact: vi.fn(async () => null),
        resolveConflict,
      },
    } as unknown as ServerDeps;
  }

  it("supersede_a: passes the actor triple into deps.storage.resolveConflict", async () => {
    const resolveConflict = vi.fn(async () => ({ mergedFactId: null }));
    const deps = makeConflictDeps(resolveConflict);

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountConflicts(app, deps);
    withErrors(app);

    const res = await app.request("/conflicts/mrel_conflict/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "supersede_a" }),
    });

    expect(res.status).toBe(200);
    expect(resolveConflict).toHaveBeenCalledTimes(1);
    const call = resolveConflict.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(call.userId).toBe(USER_ID);
    expect(call.actorType).toBe("user");
  });

  it("supersede_b: passes the actor triple into deps.storage.resolveConflict", async () => {
    const resolveConflict = vi.fn(async () => ({ mergedFactId: null }));
    const deps = makeConflictDeps(resolveConflict);

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountConflicts(app, deps);
    withErrors(app);

    const res = await app.request("/conflicts/mrel_conflict/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "supersede_b" }),
    });

    expect(res.status).toBe(200);
    expect(resolveConflict).toHaveBeenCalledTimes(1);
    const call = resolveConflict.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(call.userId).toBe(USER_ID);
    expect(call.actorType).toBe("user");
  });

  it("merge: passes the actor triple into deps.storage.resolveConflict", async () => {
    const resolveConflict = vi.fn(async () => ({ mergedFactId: "mfact_merged" }));
    const deps = makeConflictDeps(resolveConflict);

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountConflicts(app, deps);
    withErrors(app);

    const res = await app.request("/conflicts/mrel_conflict/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "merge", mergedStatement: "The merged truth." }),
    });

    expect(res.status).toBe(200);
    expect(resolveConflict).toHaveBeenCalledTimes(1);
    const call = resolveConflict.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(call.userId).toBe(USER_ID);
    expect(call.actorType).toBe("user");
  });
});
