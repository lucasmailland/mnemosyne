/**
 * Unit tests for self-editing routes (spec §13 — Wave M2):
 *   POST /self/edit, POST /self/reflect, GET /self/profile
 *
 * Uses the same pattern as reasoning-cache-routes.test.ts:
 * minimal OpenAPIHono app with fake auth middleware + InMemoryStorageAdapter.
 * No real HTTP socket, no DB.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountSelf } from "../../routes/self.js";

const WS = "11111111-1111-1111-1111-111111111111";

function makeApp(storage: InMemoryStorageAdapter) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "test-key-id");
    c.set("actorType", "user");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage,
    core: {} as unknown,
    embedModel: "text-embedding-3-small",
  } as unknown as ServerDeps;

  mountSelf(app, fakeDeps);

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { request: app.request.bind(app) };
}

describe("self routes (spec §13)", () => {
  let storage: InMemoryStorageAdapter;
  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  it("strengthen a fact returns applied=true", async () => {
    const { request } = makeApp(storage);
    const f = await storage.createFact({
      workspaceId: WS,
      statement: "S",
      kind: "fact",
      subject: "x",
      attribution: "user_stated",
      scope: "global",
    } as any);
    const res = await request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "strengthen", target: f.id, reason: "useful" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toBe(true);
  });

  it("rejects when reason is missing (requireReason)", async () => {
    const { request } = makeApp(storage);
    const res = await request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "strengthen", target: "fact-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /self/profile returns the (empty) profile", async () => {
    const { request } = makeApp(storage);
    const res = await request("/self/profile");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ agentId: "default", summary: "" });
  });

  it("POST /self/reflect runs the cycle and returns an episode_id", async () => {
    const { request } = makeApp(storage);
    const res = await request("/self/reflect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).episode_id).toBeTruthy();
  });

  it("enforces maxEditsPerSession across edits", async () => {
    const { request } = makeApp(storage);
    const f = await storage.createFact({
      workspaceId: WS,
      statement: "S",
      kind: "fact",
      subject: "x",
      attribution: "user_stated",
      scope: "global",
    } as any);
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await request("/self/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "strengthen",
          target: f.id,
          reason: "r",
          sessionId: "sess-1",
        }),
      });
    }
    expect(last!.status).toBe(429);
  });

  // PRIM-1: a contentless replace used to close the fact and leave an empty
  // active successor. Now it is a 400 that touches neither the fact nor the
  // edit budget/cooldown, so the corrected retry goes through.
  it.each([
    ["replace", undefined],
    ["replace", "   "],
    ["append", undefined],
    ["append", ""],
  ])("rejects %s with content=%j as 400 without side effects", async (action, content) => {
    const { request } = makeApp(storage);
    const f = await storage.createFact({
      workspaceId: WS,
      statement: "original statement",
      kind: "other",
      subject: "x",
      attribution: "user_stated",
      scope: "global",
    } as any);
    const res = await request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        target: f.id,
        reason: "fix",
        ...(content !== undefined ? { content } : {}),
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("self_edit_content_required");

    const after = await storage.getFact(f.id, WS);
    expect(after).toMatchObject({ statement: "original statement", status: "active" });
    expect(after?.validTo ?? null).toBeNull();
    const page = await storage.queryFacts({ workspaceId: WS, limit: 50 } as any);
    expect(page.items).toHaveLength(1);

    // Nothing was charged: the corrected request is not blocked by a cooldown.
    const retry = await request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, target: f.id, reason: "fix", content: "corrected" }),
    });
    expect(retry.status).toBe(200);
  });
});
