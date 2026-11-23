/**
 * p45 Slice A2 — core fact-create facade widening.
 *
 * Covers spec scenario "Episode/reasoning/capture write carries real
 * provenance" for capture.ts and "Conflict-resolution createFact carries
 * real provenance" for conflicts.ts's merge branch.
 *
 * Pattern mirrors provenance-a1.test.ts: a minimal OpenAPIHono app + fake
 * auth middleware that sets actorId/userId/actorType directly on context,
 * driven via app.request() — no socket, no DB. `deps.core.createFact` is
 * a spy asserting it receives resolveProvenance(c)'s triple.
 *
 * flatten-legacy-dual-core PR8: removed the "POST /facts — carries real
 * provenance" describe blocks (both non-plugin and plugin branches) — that
 * route was DELETED in this PR (D2 step 2); its provenance-forwarding
 * behavior was already ported to and proven against `POST /remember` in
 * PR7 (see `routes/__tests__/remember-plugin-write-hooks.test.ts` and
 * `remember.ts`'s `auth: AuthContext` construction from
 * `resolveProvenance(c)`).
 *
 * flatten-legacy-dual-core PR11 (B5): the "POST /conflicts/{id}/resolve
 * (merge branch)" block below now asserts against
 * `deps.storage.resolveConflict`'s forwarded `actorId`/`userId`/`actorType`
 * instead of the legacy core's createFact — the atomic v3 port collapsed
 * the 6 chained legacy calls (closeFact/patchRelation/createFact/
 * createRelation) into one composite call (see `ResolveConflictInput`'s
 * doc comment, ports.ts). The provenance triple still flows through
 * unchanged.
 *
 * flatten-legacy-dual-core PR12: the "POST /capture — carries real
 * provenance" block below now asserts against `deps.cognitive.remember`'s
 * second (`auth`) argument instead of the legacy core's createFact —
 * capture.ts ported to the same `remember()` write path `remember.ts`/
 * `anticipation.ts` already use. The provenance triple still flows through
 * unchanged.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountCapture } from "../capture.js";
import { mountConflicts } from "../conflicts.js";

const WS = "22222222-2222-2222-2222-222222222222";
const RAW_ACTOR_ID = "key-a2-test-id";
const USER_ID = "user-a2-test";

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

function makeFact(overrides: Record<string, unknown> = {}) {
  return {
    id: "fact_test",
    workspaceId: WS,
    content: "test",
    attribution: {},
    tags: [],
    pinned: false,
    validFrom: new Date().toISOString(), // determinism-ok: filler timestamp on a fixture builder, never asserted
    validTo: null,
    createdAt: new Date().toISOString(), // determinism-ok: filler timestamp on a fixture builder, never asserted
    ...overrides,
  };
}

describe("POST /capture — carries real provenance", () => {
  it("passes resolveProvenance(c)'s actorId/userId/actorType into deps.cognitive.remember", async () => {
    const remember = vi.fn(async () => ({
      id: "mfact_test",
      kind: "fact" as const,
      staged: false,
    }));
    const deps = { cognitive: { remember } } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountCapture(app, deps);
    withErrors(app);

    const res = await app.request("/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "We decided to use Turborepo for the monorepo build.",
        source: "subagent-stop",
      }),
    });

    expect(res.status).toBe(200);
    expect(remember).toHaveBeenCalledTimes(1);
    const auth = remember.mock.calls[0]![1] as Record<string, unknown>;
    expect(auth.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(auth.userId).toBe(USER_ID);
    expect(auth.actorType).toBe("user");
  });
});

describe("POST /conflicts/{id}/resolve (merge branch) — carries real provenance", () => {
  it("passes resolveProvenance(c)'s triple into deps.storage.resolveConflict", async () => {
    const relationId = "mrel_test0000000000000000000";
    const relation = {
      id: relationId,
      workspaceId: WS,
      sourceId: "mfact_a",
      sourceType: "fact",
      targetId: "mfact_b",
      targetType: "fact",
      verb: "conflicts_with",
      weight: 1,
      confidence: null,
      validTo: undefined,
    };

    const resolveConflict = vi.fn(async () => ({ mergedFactId: "mfact_merged" }));

    const deps = {
      storage: {
        getRelations: vi.fn(async () => [relation]),
        // The route reads both facts for the read-ceiling check.
        getFact: vi.fn(async () => null),
        resolveConflict,
      },
    } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountConflicts(app, deps);
    withErrors(app);

    const res = await app.request(`/conflicts/${relationId}/resolve`, {
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
