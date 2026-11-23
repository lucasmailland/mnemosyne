/**
 * RET-2 — Verify /session/start calls preinjectAnticipation and returns
 * the anticipated memory ids in the response. The workSet spy must be called
 * with the "anticipation" key and the ttl set to 30*60 (default lookAhead).
 */
import { describe, it, expect, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { mountRoutes } from "../index.js";
import { toErrorBody } from "../../errors.js";

describe("session/start pre-injects anticipated memories (RET-2)", () => {
  it("calls workingMemory.workSet with anticipation slot and returns anticipated ids", async () => {
    const workSet = vi.fn().mockResolvedValue(undefined);

    // Storage returns periodic pattern (always available, no cue needed)
    // to ensure preinjectAnticipation stages at least one result
    const now = new Date(); // determinism-ok: used for single-run fixture, not cross-run
    // flatten-legacy-dual-core PR10: startSession ported off deps.core onto
    // deps.storage.createSession (StorageAdapter). MnemoSession's date field
    // is `openedAt`, not legacy CoreLike's `startedAt`.
    const createSession = vi.fn(async () => ({
      id: "sess-abc",
      agentId: "agent-1",
      status: "active",
      openedAt: new Date().toISOString(), // determinism-ok: throwaway fixture
    }));

    const storage = {
      getSequentialPatterns: vi.fn(async () => []),
      getPeriodicPatterns: vi.fn(async () => [
        {
          workspaceId: "ws",
          memoryId: "fact-periodic-1",
          dayOfWeek: now.getUTCDay(),
          hourBucket: Math.floor(now.getUTCHours() / 3),
          slotShare: 0.8,
          distinctWeeks: 4,
        },
      ]),
      getConditionalPatterns: vi.fn(async () => []),
      getCoOccurrencePatterns: vi.fn(async () => []),
      // p45 Slice B: POST /session/start now emits a session_open audit entry
      // via emitAudit() after a successful startSession call.
      appendAuditEntry: vi.fn(async () => undefined),
      createSession,
    };

    const workingMemory = { workSet };

    const deps = {
      storage,
      workingMemory,
    } as unknown as ServerDeps;

    const app = new Hono();
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err, undefined);
      return c.json(body, status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500);
    });

    const v1 = new OpenAPIHono<{ Variables: AuthVariables }>();
    // Bypass auth — inject workspaceId the way the auth middleware does
    v1.use("*", async (c, next) => {
      c.set("workspaceId", "ws");
      c.set("actorId", "tester");
      await next();
    });

    mountRoutes(v1, deps);
    app.route("/", v1);

    const res = await app.request("/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });

    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json).toHaveProperty("anticipated");
    expect(json.anticipated).toBeInstanceOf(Array);
    expect(json.anticipated.length).toBeGreaterThan(0);
    expect(json.anticipated[0]).toHaveProperty("id");
    expect(json.anticipated[0]).toHaveProperty("score");
    expect(json.anticipated[0]).toHaveProperty("source");

    // Verify workSet was called with the anticipation slot and correct TTL
    expect(workSet).toHaveBeenCalledTimes(1);
    const [ws, agent, key, value, ttl] = workSet.mock.calls[0];
    expect(ws).toBe("ws");
    expect(agent).toBe("agent-1");
    expect(key).toBe("anticipation");
    expect(ttl).toBe(30 * 60); // default lookAheadMinutes * 60
    expect(value).toHaveProperty("items");
    expect(value).toHaveProperty("generatedAt");
    expect(value.items).toBeInstanceOf(Array);
  });

  it("returns empty anticipated array when no patterns exist", async () => {
    const workSet = vi.fn().mockResolvedValue(undefined);

    const createSession = vi.fn(async () => ({
      id: "sess-xyz",
      agentId: null,
      status: "active",
      openedAt: new Date().toISOString(), // determinism-ok: throwaway fixture
    }));

    // Storage returns no patterns
    const storage = {
      getSequentialPatterns: vi.fn(async () => []),
      getPeriodicPatterns: vi.fn(async () => []),
      getConditionalPatterns: vi.fn(async () => []),
      getCoOccurrencePatterns: vi.fn(async () => []),
      // p45 Slice B: POST /session/start now emits a session_open audit entry
      // via emitAudit() after a successful startSession call.
      appendAuditEntry: vi.fn(async () => undefined),
      createSession,
    };

    const workingMemory = { workSet };

    const deps = {
      storage,
      workingMemory,
    } as unknown as ServerDeps;

    const app = new Hono();
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err, undefined);
      return c.json(body, status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500);
    });

    const v1 = new OpenAPIHono<{ Variables: AuthVariables }>();
    v1.use("*", async (c, next) => {
      c.set("workspaceId", "ws");
      c.set("actorId", "tester");
      await next();
    });

    mountRoutes(v1, deps);
    app.route("/", v1);

    const res = await app.request("/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json).toHaveProperty("anticipated");
    expect(json.anticipated).toEqual([]);

    // workSet should not be called when there are no staged items
    expect(workSet).not.toHaveBeenCalled();
  });

  it("session creation succeeds even when preinjectAnticipation fails", async () => {
    const workSet = vi.fn().mockRejectedValue(new Error("Redis down"));

    const createSession = vi.fn(async () => ({
      id: "sess-fail",
      agentId: null,
      status: "active",
      openedAt: new Date().toISOString(), // determinism-ok: throwaway fixture
    }));

    const storage = {
      getSequentialPatterns: vi.fn(async () => {
        throw new Error("Storage error");
      }),
      getPeriodicPatterns: vi.fn(async () => []),
      getConditionalPatterns: vi.fn(async () => []),
      getCoOccurrencePatterns: vi.fn(async () => []),
      // p45 Slice B: POST /session/start now emits a session_open audit entry
      // via emitAudit() after a successful startSession call.
      appendAuditEntry: vi.fn(async () => undefined),
      createSession,
    };

    const workingMemory = { workSet };

    const deps = {
      storage,
      workingMemory,
    } as unknown as ServerDeps;

    const app = new Hono();
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err, undefined);
      return c.json(body, status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500);
    });

    const v1 = new OpenAPIHono<{ Variables: AuthVariables }>();
    v1.use("*", async (c, next) => {
      c.set("workspaceId", "ws");
      c.set("actorId", "tester");
      await next();
    });

    mountRoutes(v1, deps);
    app.route("/", v1);

    const res = await app.request("/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    // Session creation should still succeed (201)
    expect(res.status).toBe(201);

    const json = await res.json();
    // anticipated should be empty array (failure was swallowed)
    expect(json).toHaveProperty("anticipated");
    expect(json.anticipated).toEqual([]);
  });
});
