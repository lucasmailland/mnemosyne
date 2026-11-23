/**
 * WP-6 route-level lifecycle contracts for strategies, decisions and
 * workflows, driven through the real routes over the in-memory adapter:
 * PRIM-11 (supersedesId closes the predecessor), PRIM-18 (decision supersede
 * validation), PRIM-16 (lists show current rows by default) and AGENTSIM-6
 * (GET /decisions/:id returns the complete body, which WP-8 points
 * memory_fact at).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountStrategies } from "../../routes/strategies.js";
import { mountDecisions } from "../../routes/decisions.js";
import { mountWorkflows } from "../../routes/workflows.js";

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER_WS = "22222222-2222-2222-2222-222222222222";

function makeApp(storage: InMemoryStorageAdapter, maxSensitivity?: string) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "key:test");
    c.set("actorType", "user");
    c.set("userId", "user-1");
    c.set("scopes", []);
    if (maxSensitivity) c.set("maxSensitivity", maxSensitivity as never);
    await next();
  });
  const deps = { storage, apiKeys: {}, core: {} } as unknown as ServerDeps;
  mountStrategies(app, deps);
  mountDecisions(app, deps);
  mountWorkflows(app, deps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  const request = app.request.bind(app);
  const send = (method: string, path: string, body?: unknown) =>
    request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { send };
}

describe("PRIM-11 / PRIM-16: strategies", () => {
  let storage: InMemoryStorageAdapter;
  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  it("supersedesId closes the predecessor; the list shows only the successor", async () => {
    const { send } = makeApp(storage);
    const old = await (
      await send("POST", "/strategies", { trigger: "when A", action: "do 1" })
    ).json();
    const res = await send("POST", "/strategies", {
      trigger: "when A",
      action: "do 2",
      supersedesId: old.id,
    });
    expect(res.status).toBe(201);
    const next = await res.json();

    const closed = await (await send("GET", `/strategies/${old.id}`)).json();
    expect(closed.status).toBe("superseded");
    expect(closed.validTo).not.toBeNull();

    const current = await (await send("GET", "/strategies")).json();
    expect(current.items.map((s: { id: string }) => s.id)).toEqual([next.id]);

    const all = await (await send("GET", "/strategies?includeClosed=true")).json();
    expect(all.items.map((s: { id: string }) => s.id).sort()).toEqual([old.id, next.id].sort());
  });

  it("a missing predecessor is 404, an already superseded one is 409", async () => {
    const { send } = makeApp(storage);
    const missing = await send("POST", "/strategies", {
      trigger: "t",
      action: "a",
      supersedesId: "no-such-strategy",
    });
    expect(missing.status).toBe(404);

    const old = await (await send("POST", "/strategies", { trigger: "t", action: "a" })).json();
    await send("POST", "/strategies", { trigger: "t", action: "b", supersedesId: old.id });
    const again = await send("POST", "/strategies", {
      trigger: "t",
      action: "c",
      supersedesId: old.id,
    });
    expect(again.status).toBe(409);
    const live = await (await send("GET", "/strategies")).json();
    expect(live.items).toHaveLength(1);
  });

  it("a predecessor from another workspace answers the same 404", async () => {
    const foreign = await storage.createStrategy({
      workspaceId: OTHER_WS,
      trigger: "x",
      action: "y",
    });
    const { send } = makeApp(storage);
    const res = await send("POST", "/strategies", {
      trigger: "t",
      action: "a",
      supersedesId: foreign.id,
    });
    expect(res.status).toBe(404);
    expect((await storage.getStrategy(foreign.id, OTHER_WS))?.status).toBe("active");
  });
});

describe("PRIM-18 / PRIM-16 / AGENTSIM-6: decisions", () => {
  let storage: InMemoryStorageAdapter;
  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  const create = async (
    send: ReturnType<typeof makeApp>["send"],
    title: string,
    body = `body ${title}`
  ) =>
    (await (await send("POST", "/decisions", { kind: "decision", title, body })).json()) as {
      id: string;
    };

  it("PATCH supersedes: closes validTo, records lineage, hides it from the default list", async () => {
    const { send } = makeApp(storage);
    const old = await create(send, "old");
    const next = await create(send, "new");
    const res = await send("PATCH", `/decisions/${old.id}`, { supersededById: next.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("superseded");
    expect(body.validTo).not.toBeNull();

    const edges = await storage.getRelations({
      workspaceId: WS,
      sourceId: next.id,
      verb: "supersedes",
    });
    expect(edges.map((r) => r.targetId)).toEqual([old.id]);

    const current = await (await send("GET", "/decisions")).json();
    expect(current.items.map((d: { id: string }) => d.id)).toEqual([next.id]);
    const all = await (await send("GET", "/decisions?includeClosed=true")).json();
    expect(all.items).toHaveLength(2);
    const onlySuperseded = await (await send("GET", "/decisions?status=superseded")).json();
    expect(onlySuperseded.items.map((d: { id: string }) => d.id)).toEqual([old.id]);
  });

  it("self-supersede is 400, a nonexistent successor is 404, a repeat is idempotent", async () => {
    const { send } = makeApp(storage);
    const a = await create(send, "a");
    const b = await create(send, "b");
    expect((await send("PATCH", `/decisions/${a.id}`, { supersededById: a.id })).status).toBe(400);
    expect((await send("PATCH", `/decisions/${a.id}`, { supersededById: "ghost" })).status).toBe(
      404
    );
    expect((await send("PATCH", `/decisions/${a.id}`, { supersededById: b.id })).status).toBe(200);
    expect((await send("PATCH", `/decisions/${a.id}`, { supersededById: b.id })).status).toBe(200);
    const edges = await storage.getRelations({
      workspaceId: WS,
      sourceId: b.id,
      verb: "supersedes",
    });
    expect(edges).toHaveLength(1);
  });

  it("superseding with a different successor than the recorded one is 409", async () => {
    const { send } = makeApp(storage);
    const a = await create(send, "a");
    const b = await create(send, "b");
    const c = await create(send, "c");
    await send("PATCH", `/decisions/${a.id}`, { supersededById: b.id });
    expect((await send("PATCH", `/decisions/${a.id}`, { supersededById: c.id })).status).toBe(409);
  });

  it("GET /decisions/:id returns the COMPLETE body, not the 300-character recall excerpt (AGENTSIM-6)", async () => {
    const { send } = makeApp(storage);
    const long = "rationale ".repeat(120).trim(); // 1,199 characters
    const d = await create(send, "long rationale", long);
    const res = await send("GET", `/decisions/${d.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).body).toBe(long);
  });

  it("GET /decisions/:id is a 404 for another workspace's decision and above the caller's ceiling", async () => {
    const foreign = await storage.createDecision({
      workspaceId: OTHER_WS,
      title: "foreign",
      body: "x",
      kind: "decision",
    });
    const secret = await storage.createDecision({
      workspaceId: WS,
      title: "secret",
      body: "x",
      kind: "decision",
      sensitivity: "restricted",
    });
    const { send } = makeApp(storage, "internal");
    expect((await send("GET", `/decisions/${foreign.id}`)).status).toBe(404);
    expect((await send("GET", `/decisions/${secret.id}`)).status).toBe(404);
    expect((await send("GET", "/decisions/no-such-decision")).status).toBe(404);
  });
});

describe("PRIM-16: workflows", () => {
  it("an archived workflow leaves the default list and returns with includeClosed=true", async () => {
    const storage = new InMemoryStorageAdapter();
    const { send } = makeApp(storage);
    const mk = async (name: string) =>
      (await (
        await send("POST", "/workflows", {
          name,
          steps: [{ order: 1, action: "do", expectedDurationMs: 1000 }],
        })
      ).json()) as { id: string };
    const keep = await mk("keep");
    const drop = await mk("drop");
    await storage.archiveWorkflow(drop.id, WS);

    const current = await (await send("GET", "/workflows")).json();
    expect(current.items.map((w: { id: string }) => w.id)).toEqual([keep.id]);
    // An explicit status still reaches archived (deprecated) workflows.
    const deprecated = await (await send("GET", "/workflows?status=deprecated")).json();
    expect(deprecated.items.map((w: { id: string }) => w.id)).toEqual([drop.id]);
    const all = await (await send("GET", "/workflows?includeClosed=true")).json();
    expect(all.items).toHaveLength(2);
  });
});
