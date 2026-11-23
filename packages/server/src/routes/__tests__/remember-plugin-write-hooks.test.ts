/**
 * flatten-legacy-dual-core D2 step 1 (PR 7 / tasks 5.3-5.4).
 *
 * `POST /remember` is not a rename of `POST /facts` — historically only
 * `/facts` ran the §21 plugin `onBeforeWrite`/`onAfterWrite` hooks and fired
 * `fact.created` (bus event + webhook fan-out). This test proves those three
 * behaviors now also fire from `POST /remember`, matching `/facts`, without
 * touching `/facts` itself (still covered by
 * `routes/__tests__/provenance-a2.test.ts`'s plugin-branch test and
 * `__tests__/webhook-event-coverage.test.ts`).
 *
 * Pattern mirrors `provenance-a2.test.ts`: a minimal OpenAPIHono app + fake
 * auth middleware setting actorId/userId/actorType directly on context,
 * driven via app.request() — no socket, no DB.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import { toErrorBody } from "../../errors.js";
import { mountRemember } from "../remember.js";

const WS = "33333333-3333-3333-3333-333333333333";
const RAW_ACTOR_ID = "key-remember-plugin-test";
const USER_ID = "user-remember-plugin-test";

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

function makeRememberResult(overrides: Record<string, unknown> = {}) {
  return { id: "mfact_remember_test", kind: "fact", staged: false, ...overrides };
}

async function flush() {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe("POST /remember — §21 plugin write-path hooks (D2 step 1)", () => {
  it("runs onBeforeWrite/onAfterWrite via pluginLoader and forwards the mutated statement/tags to cognitive.remember", async () => {
    const remember = vi.fn(async () => makeRememberResult());
    const runBeforeWrite = vi.fn(async (unit: { content: string; tags?: string[] }) => ({
      ...unit,
      content: "mutated by plugin",
      tags: [...(unit.tags ?? []), "plugin-tag"],
    }));
    const runAfterWrite = vi.fn(async () => {});
    const deps = {
      cognitive: { remember },
      pluginLoader: { runBeforeWrite, runAfterWrite },
    } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountRemember(app, deps);
    withErrors(app);

    const res = await app.request("/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "original statement", tags: ["orig"] }),
    });

    expect(res.status).toBe(201);
    expect(runBeforeWrite).toHaveBeenCalledTimes(1);
    const beforeUnit = runBeforeWrite.mock.calls[0]![0] as { content: string; tags?: string[] };
    expect(beforeUnit.content).toBe("original statement");
    expect(beforeUnit.tags).toEqual(["orig"]);

    // The mutated content/tags — not the original body — reach cognitive.remember().
    expect(remember).toHaveBeenCalledTimes(1);
    const rememberArgs = remember.mock.calls[0]![0] as { content: string; tags: string[] };
    expect(rememberArgs.content).toBe("mutated by plugin");
    expect(rememberArgs.tags).toEqual(["orig", "plugin-tag"]);

    // The HTTP response also reflects the plugin mutation.
    const body = (await res.json()) as { statement: string; tags: string[] };
    expect(body.statement).toBe("mutated by plugin");
    expect(body.tags).toEqual(["orig", "plugin-tag"]);

    // runAfterWrite fires once the write committed, with the mutated unit.
    expect(runAfterWrite).toHaveBeenCalledTimes(1);
    const afterUnit = runAfterWrite.mock.calls[0]![0] as { content: string; tags?: string[] };
    expect(afterUnit.content).toBe("mutated by plugin");
    expect(afterUnit.tags).toEqual(["orig", "plugin-tag"]);
  });

  it("rejects the write with 400 when a plugin's onBeforeWrite returns null", async () => {
    const remember = vi.fn(async () => makeRememberResult());
    const runBeforeWrite = vi.fn(async () => null);
    const runAfterWrite = vi.fn(async () => {});
    const deps = {
      cognitive: { remember },
      pluginLoader: { runBeforeWrite, runAfterWrite },
    } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountRemember(app, deps);
    withErrors(app);

    const res = await app.request("/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "should be rejected" }),
    });

    expect(res.status).toBe(400);
    expect(remember).not.toHaveBeenCalled();
    expect(runAfterWrite).not.toHaveBeenCalled();
  });

  it("does not touch pluginLoader when none is configured (backward compatible)", async () => {
    const remember = vi.fn(async () => makeRememberResult());
    const deps = { cognitive: { remember } } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountRemember(app, deps);
    withErrors(app);

    const res = await app.request("/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "no plugin configured" }),
    });

    expect(res.status).toBe(201);
    const rememberArgs = remember.mock.calls[0]![0] as { content: string };
    expect(rememberArgs.content).toBe("no plugin configured");
  });
});

describe("POST /remember — fact.created event + webhook fan-out (D2 step 1)", () => {
  it("emits fact.created on the bus", async () => {
    const remember = vi.fn(async () => makeRememberResult());
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const bus = {
      subscribe: vi.fn(() => () => {}),
      emit: (event: { type: string; payload: unknown }) => {
        emitted.push(event);
      },
      patternCount: vi.fn(() => 0),
    };
    const deps = { cognitive: { remember }, bus } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountRemember(app, deps);
    withErrors(app);

    const res = await app.request("/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "emits an event" }),
    });

    expect(res.status).toBe(201);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe("fact.created");
    expect((emitted[0]!.payload as { statement: string }).statement).toBe("emits an event");
  });

  it("dispatches a fact.created webhook_fire outbox entry", async () => {
    const remember = vi.fn(async () => makeRememberResult());
    const appendOutbox = vi.fn().mockResolvedValue(undefined);
    const storage = {
      listWebhookEndpoints: async () => [
        { id: "w1", url: "http://hook", events: ["*"], isActive: true, secretHash: "s1" },
      ],
      appendOutbox,
    } as unknown as StorageAdapter;
    const deps = { cognitive: { remember }, storage } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountRemember(app, deps);
    withErrors(app);

    const res = await app.request("/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "dispatches a webhook" }),
    });

    expect(res.status).toBe(201);
    await flush();

    expect(appendOutbox).toHaveBeenCalledTimes(1);
    const call = appendOutbox.mock.calls[0]![0] as {
      eventType: string;
      payload: { eventType: string };
    };
    expect(call.eventType).toBe("webhook_fire");
    expect(call.payload.eventType).toBe("fact.created");
  });

  it("does NOT fire plugin hooks, event, or webhook for a non-fact kind (e.g. 'decision')", async () => {
    const remember = vi.fn(async () => makeRememberResult({ kind: "decision" }));
    const runBeforeWrite = vi.fn(async (unit: unknown) => unit);
    const runAfterWrite = vi.fn(async () => {});
    const appendOutbox = vi.fn().mockResolvedValue(undefined);
    const emitted: Array<{ type: string }> = [];
    const bus = {
      subscribe: vi.fn(() => () => {}),
      emit: (event: { type: string }) => {
        emitted.push(event);
      },
      patternCount: vi.fn(() => 0),
    };
    const storage = {
      listWebhookEndpoints: async () => [
        { id: "w1", url: "http://hook", events: ["*"], isActive: true, secretHash: "s1" },
      ],
      appendOutbox,
    } as unknown as StorageAdapter;
    const deps = {
      cognitive: { remember },
      pluginLoader: { runBeforeWrite, runAfterWrite },
      bus,
      storage,
    } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountRemember(app, deps);
    withErrors(app);

    const res = await app.request("/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "a decision, not a fact", kind: "decision" }),
    });

    expect(res.status).toBe(201);
    await flush();

    expect(runBeforeWrite).not.toHaveBeenCalled();
    expect(runAfterWrite).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
    expect(appendOutbox).not.toHaveBeenCalled();
  });
});
