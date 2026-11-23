/**
 * WP-5 — PRIM-6 / RECALL-12 / CLIENTS-6: who shares a self-edit budget.
 *
 * Measured: every MCP `memory_update` (no sessionId) drew from ONE budget per
 * workspace — five corrections a day for every agent together — and the 300 s
 * cooldown applied per workspace + body `agentId` to ANY target, so an agent
 * that learned two facts changed could fix one. A fresh `agentId` or
 * `sessionId` string reset either. Now: budgets belong to the authenticated
 * actor, the cooldown to actor + target, and only a real session opens a
 * separate session budget.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { CacheAdapter } from "@mnemo-ai/types";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { toErrorBody } from "../errors.js";
import { mountSelf } from "../routes/self.js";

const WS = "11111111-1111-1111-1111-111111111111";

function makeCache(): CacheAdapter {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async incrWithTtl(key: string): Promise<number> {
      const next = ((store.get(key) as number) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
  } as unknown as CacheAdapter;
}

function makeApp(storage: InMemoryStorageAdapter, cache: CacheAdapter) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", c.req.header("x-test-actor") ?? "key-a");
    c.set("actorType", "agent");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });
  mountSelf(app, { storage, cache } as unknown as ServerDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return (body: Record<string, unknown>, actor = "key-a") =>
    app.request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": actor },
      body: JSON.stringify({ reason: "correction", ...body }),
    });
}

async function fact(storage: InMemoryStorageAdapter, statement: string) {
  return storage.createFact({
    workspaceId: WS,
    statement,
    kind: "other",
    subject: "x",
    attribution: "user_stated",
    scope: "global",
  } as never);
}

describe("PRIM-6 — self-edit budgets are per actor, cooldowns per target", () => {
  let storage: InMemoryStorageAdapter;
  let edit: ReturnType<typeof makeApp>;
  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
    edit = makeApp(storage, makeCache());
  });

  it("corrects two different facts back to back (the cooldown is per target)", async () => {
    const a = await fact(storage, "the api runs node 18");
    const b = await fact(storage, "the db is postgres 14");
    expect((await edit({ action: "replace", target: a.id, content: "node 22" })).status).toBe(200);
    expect((await edit({ action: "replace", target: b.id, content: "postgres 16" })).status).toBe(
      200
    );
  });

  it("still holds the cooldown on the SAME target", async () => {
    const a = await fact(storage, "appended fact");
    expect((await edit({ action: "append", target: a.id, content: "one" })).status).toBe(200);
    const again = await edit({ action: "append", target: a.id, content: "two" });
    expect(again.status).toBe(429);
    expect((await again.json()).error.message).toMatch(/cooldown/);
  });

  it("does not let a new body agentId reset the actor's daily caps", async () => {
    const facts = await Promise.all([1, 2, 3, 4].map((i) => fact(storage, `strengthen ${i}`)));
    for (let i = 0; i < 3; i++) {
      const res = await edit({ action: "strengthen", target: facts[i]!.id, agentId: `agent-${i}` });
      expect(res.status).toBe(200);
    }
    const fourth = await edit({ action: "strengthen", target: facts[3]!.id, agentId: "agent-new" });
    expect(fourth.status).toBe(429);
    expect((await fourth.json()).error.message).toMatch(/maxStrengthensPerDay/);
  });

  it("gives every actor its own sessionless budget", async () => {
    const facts = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((i) => fact(storage, `f${i}`)));
    const actions = ["strengthen", "strengthen", "strengthen", "weaken", "weaken"];
    for (let i = 0; i < 5; i++) {
      expect((await edit({ action: actions[i], target: facts[i]!.id })).status).toBe(200);
    }
    expect((await edit({ action: "weaken", target: facts[5]!.id })).status).toBe(429);
    // Another credential in the same workspace is unaffected.
    expect((await edit({ action: "weaken", target: facts[6]!.id }, "key-b")).status).toBe(200);
  });

  it("does not open a new budget for a sessionId that names no session", async () => {
    const facts = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => fact(storage, `g${i}`)));
    const actions = ["strengthen", "strengthen", "strengthen", "weaken", "weaken", "weaken"];
    for (let i = 0; i < 6; i++) {
      const res = await edit({
        action: actions[i],
        target: facts[i]!.id,
        sessionId: `made-up-${i}`,
      });
      expect(res.status, `edit ${i + 1}`).toBe(i < 5 ? 200 : 429);
    }
  });

  it("gives a real session its own budget", async () => {
    const facts = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => fact(storage, `h${i}`)));
    const actions = ["strengthen", "strengthen", "strengthen", "weaken", "weaken"];
    for (let i = 0; i < 5; i++) {
      expect((await edit({ action: actions[i], target: facts[i]!.id })).status).toBe(200);
    }
    const session = await storage.createSession({ workspaceId: WS });
    const res = await edit({ action: "weaken", target: facts[5]!.id, sessionId: session.id });
    expect(res.status).toBe(200);
  });
});
