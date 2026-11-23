/**
 * RSN-4: Durable self-edit budget counters + approval scopes.
 *
 * Tests verify:
 *   1. Budget counters survive across instances via Redis (durable keys)
 *   2. Approval gates block destructive actions (forget→delete_fact, replace→edit_entity)
 *   3. Fallback to in-process Map when no cache adapter is wired (dev mode)
 *
 * Uses the same pattern as unit/self-routes.test.ts:
 * minimal OpenAPIHono app with fake auth middleware + InMemoryStorageAdapter.
 * No real HTTP socket, no DB, no real auth.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryStorageAdapter, InMemoryApprovalStore } from "@mnemo-ai/types/testing";
import type { CacheAdapter, CacheCapabilities, HealthStatus } from "@mnemo-ai/types";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import { toErrorBody } from "../errors.js";
import { mountSelf } from "../routes/self.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const WS = "11111111-1111-1111-1111-111111111111";

// ─── Fake CacheAdapter with Redis-like counter semantics ─────────────────────

function makeFakeCache(): CacheAdapter & { store: Map<string, number | unknown> } {
  const store = new Map<string, number | unknown>();
  const cache: CacheAdapter & { store: typeof store } = {
    id: "fake-redis-cache",
    store, // exposed for test assertions
    capabilities: {
      sortedSets: false,
      pubSub: false,
      patterns: false,
      atomic: true, // incrWithTtl is atomic
      hashes: false,
    } satisfies CacheCapabilities,
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async deletePattern(_pattern: string): Promise<number> {
      return 0;
    },
    async incrWithTtl(key: string, _ttlSeconds: number): Promise<number> {
      const prev = (store.get(key) as number) ?? 0;
      const next = prev + 1;
      store.set(key, next);
      return next;
    },
    async healthCheck(): Promise<HealthStatus> {
      return { status: "ok", latencyMs: 1 };
    },
    async close(): Promise<void> {},
  };
  return cache;
}

// ─── App builder (mirrors unit/self-routes.test.ts) ──────────────────────────

function makeApp(
  storage: InMemoryStorageAdapter,
  cache?: CacheAdapter,
  approvals?: InMemoryApprovalStore
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c: any, next: any) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "test-key-id");
    c.set("actorType", "user");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage,
    cache,
    approvals,
    core: {} as unknown,
    embedModel: "text-embedding-3-small",
  } as unknown as ServerDeps;

  mountSelf(app, fakeDeps);

  app.onError((err: any, c: any) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { request: app.request.bind(app) };
}

// ─── Test suite ────────────────────────────────────────────────────────────────

describe("RSN-4: Durable self-edit budgets + approval scopes", () => {
  let storage: InMemoryStorageAdapter;
  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
  });

  // WP-5 (PRIM-6): rewritten. The previous version reached five edits by
  // sending a new body `agentId` per call "to avoid cooldown" — the very bypass
  // PRIM-6 reports. Budgets are now keyed by the authenticated actor, the
  // cooldown by actor + target, and a sessionId must name a real session.
  it("durable counter via fake cache — maxEditsPerSession enforced across calls", async () => {
    const cache = makeFakeCache();
    const { request } = makeApp(storage, cache);
    const session = await storage.createSession({ workspaceId: WS });

    // Distinct targets: no per-target cooldown, no per-fact strengthen cap.
    // 3 strengthens (maxStrengthensPerDay) + 2 weakens = 5 edits.
    const facts: any[] = [];
    for (let i = 0; i < 6; i++) {
      facts.push(
        await storage.createFact({
          workspaceId: WS,
          statement: `Test ${i}`,
          kind: "fact",
          subject: "x",
          attribution: "user_stated",
          scope: "global",
        } as any)
      );
    }
    const actions = ["strengthen", "strengthen", "strengthen", "weaken", "weaken", "weaken"];
    for (let i = 0; i < 6; i++) {
      const res = await request("/self/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: actions[i],
          target: facts[i].id,
          reason: `test edit ${i + 1}`,
          sessionId: session.id,
        }),
      });
      if (i < 5) {
        expect(res.status, `Edit ${i + 1}/5 should succeed`).toBe(200);
        expect((await res.json()).applied).toBe(true);
      } else {
        expect(res.status, "Edit 6/5 should be rate-limited").toBe(429);
        expect((await res.json()).error?.message).toMatch(/maxEditsPerSession/i);
      }
    }

    // Exactly 5 counted (not 6), under the actor's key for that session.
    const editsKey = `mnemo:selfedit:edits:${WS}:key:test-key-id:${session.id}`;
    expect(cache.store.get(editsKey), "Edit counter should be 5").toBe(5);
  });

  it("APP-062: the cooldown 429 says how long is really left (not the generic 60 s)", async () => {
    const { request } = makeApp(storage, makeFakeCache());
    const fact = await storage.createFact({
      workspaceId: WS,
      statement: "cooldown target",
      kind: "fact",
      subject: "x",
      attribution: "user_stated",
      scope: "global",
    } as any);
    const edit = () =>
      request("/self/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "weaken", target: fact.id, reason: "test" }),
      });
    expect((await edit()).status).toBe(200);
    const res = await edit();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.message).toMatch(/edit cooldown active/);
    expect(body.error.retryAfterSeconds).toBeGreaterThan(290);
    expect(body.error.retryAfterSeconds).toBeLessThanOrEqual(300);
  });

  it("B4: forget action returns 422 self_edit_forget_unsupported, never 202, and creates no ApprovalStore row", async () => {
    const cache = makeFakeCache();
    const approvals = new InMemoryApprovalStore();
    const { request } = makeApp(storage, cache, approvals);

    const fact = await storage.createFact({
      workspaceId: WS,
      statement: "Test fact",
      kind: "fact",
      subject: "x",
      attribution: "user_stated",
      scope: "global",
    } as any);

    const archiveSpy = vi.spyOn(storage, "archiveFact");
    const approvalCreateSpy = vi.spyOn(approvals, "create");

    const res = await request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "forget",
        target: fact.id,
        reason: "testing the B4 gate",
        sessionId: "sess_forget_gate",
      }),
    });

    expect(res.status, "forget must be gated with 422, never the old phantom 202").toBe(422);
    const body = await res.json();
    expect(body.error).toMatchObject({
      code: "self_edit_forget_unsupported",
    });
    expect(body.error.message).toMatch(/memory_forget/);

    // Never a 202 "pending approval" — that was the dead-end being fixed.
    expect(res.status).not.toBe(202);

    // Nothing was applied.
    expect(archiveSpy).not.toHaveBeenCalled();

    // The whole point of B4: no approval flow exists to resolve this, so no
    // ApprovalStore row is ever created for it — the caller must never be
    // told (even implicitly) that something is being tracked for later.
    expect(approvalCreateSpy).not.toHaveBeenCalled();
  });

  it("fact replace bypasses the edit_entity approval gate", async () => {
    const cache = makeFakeCache();
    const { request } = makeApp(storage, cache);

    const fact = await storage.createFact({
      workspaceId: WS,
      statement: "Original statement",
      kind: "fact",
      subject: "x",
      attribution: "user_stated",
      scope: "global",
    } as any);

    const replaceSpy = vi.spyOn(storage, "replaceFact");

    const res = await request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "replace",
        target: fact.id,
        content: "New statement",
        reason: "testing replace approval gate",
        sessionId: "sess_replace",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      applied: true,
      action: "replace",
      targetKind: "fact",
    });
    expect(body.replacementId).toBeTruthy();
    expect(replaceSpy).toHaveBeenCalledOnce();
  });

  it("strategy replace remains approval-gated as edit_entity", async () => {
    const cache = makeFakeCache();
    const { request } = makeApp(storage, cache);
    const strategy = await storage.createStrategy({
      workspaceId: WS,
      trigger: "when testing",
      action: "old action",
      scope: "global",
    } as any);

    const res = await request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "replace",
        target: `strategy:${strategy.id}`,
        content: "new action",
        reason: "testing strategy approval gate",
        sessionId: "sess_strategy_replace",
      }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      applied: false,
      action: "replace",
      targetKind: "strategy",
      approvalRequired: true,
      scope: "edit_entity",
    });
  });

  it("fallback without cache: still enforces maxEditsPerSession per-instance", async () => {
    const { request } = makeApp(storage, undefined); // No cache

    const facts: any[] = [];
    for (let i = 0; i < 6; i++) {
      facts.push(
        await storage.createFact({
          workspaceId: WS,
          statement: `Test ${i}`,
          kind: "fact",
          subject: "x",
          attribution: "user_stated",
          scope: "global",
        } as any)
      );
    }

    // No session at all: the actor's sessionless budget (5) still applies.
    const actions = ["strengthen", "strengthen", "strengthen", "weaken", "weaken", "weaken"];
    for (let i = 0; i < 6; i++) {
      const res = await request("/self/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: actions[i],
          target: facts[i].id,
          reason: `fallback test edit ${i + 1}`,
        }),
      });
      if (i < 5) {
        expect(res.status, `Fallback edit ${i + 1}/5 should succeed`).toBe(200);
      } else {
        expect(res.status, "Fallback edit 6/5 should be rate-limited").toBe(429);
        const body = await res.json();
        expect(body.error?.message).toMatch(/maxEditsPerSession/i);
        // The sessionless budget says how to get a real one.
        expect(body.error?.message).toMatch(/POST \/session\/start/);
      }
    }
  });

  it("B3 fail-closed: cache.get() throwing denies the self-edit (429, not 200)", async () => {
    // Simulate a cache that is wired but throws on every get() —
    // indistinguishable from a key-eviction that returns null under ?? 0.
    // The fix: read helpers now return MAX_SAFE_INTEGER on throw so
    // evaluateSelfEdit sees editsThisSession >> maxEditsPerSession and denies.
    const throwingCache: CacheAdapter = {
      id: "fake-throwing-cache",
      capabilities: {
        sortedSets: false,
        pubSub: false,
        patterns: false,
        atomic: true,
        hashes: false,
      } satisfies CacheCapabilities,
      async get<T>(_key: string): Promise<T | null> {
        throw new Error("Redis connection lost");
      },
      async set() {},
      async delete() {},
      async deletePattern() {
        return 0;
      },
      async incrWithTtl(_key: string, _ttl: number) {
        return 1;
      },
      async healthCheck() {
        return { status: "ok" as const, latencyMs: 0 };
      },
      async close() {},
    };

    const { request } = makeApp(storage, throwingCache);
    const fact = await storage.createFact({
      workspaceId: WS,
      statement: "Fact used for B3 cache-throw test",
      kind: "fact",
      subject: "x",
      attribution: "user_stated",
      scope: "global",
    } as any);

    const res = await request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "strengthen",
        target: fact.id,
        reason: "should be denied due to cache outage",
        sessionId: "sess_b3",
        agentId: "agent_b3",
      }),
    });

    // Fail-closed: cache error must NOT be treated as "budget fully available".
    expect(res.status, "B3: cache throw must result in 429 (deny), not 200 (allow)").toBe(429);
  });

  it("strengthen action is not approval-gated (should succeed)", async () => {
    const cache = makeFakeCache();
    const { request } = makeApp(storage, cache);

    const fact = await storage.createFact({
      workspaceId: WS,
      statement: "Test",
      kind: "fact",
      subject: "x",
      attribution: "user_stated",
      scope: "global",
    } as any);

    const worthSpy = vi.spyOn(storage, "updateWorth");

    const res = await request("/self/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "strengthen",
        target: fact.id,
        reason: "testing strengthen (not approval-gated)",
        sessionId: "sess_strengthen",
      }),
    });

    expect(res.status, "Strengthen should succeed (200 OK)").toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(body.action).toBe("strengthen");

    // updateWorth should have been called (strengthen was applied)
    expect(worthSpy).toHaveBeenCalledWith(fact.id, WS, "fact", {
      success: 1,
      failure: 0,
      creditWeight: 1,
    });
  });
});
