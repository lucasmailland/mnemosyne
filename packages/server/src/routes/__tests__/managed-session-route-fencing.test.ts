import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountRoutes } from "../index.js";

function createApp(
  options: {
    managed?: boolean;
    storageAbsent?: boolean;
    appendErrorCode?: string;
    status?: "active" | "collapse_pending" | "collapsed" | "archived";
    archiveReason?: string | null;
    retryResult?: boolean;
    retryError?: Error;
    getSessionError?: Error;
    pinErrorCode?: string;
  } = {}
) {
  const collapseSession = vi.fn();
  const archiveSession = vi.fn();
  const closeSession = vi.fn();
  const appendTurn = vi.fn(async () => {
    if (options.appendErrorCode) {
      throw Object.assign(new Error("Session is closed for writes."), {
        code: options.appendErrorCode,
      });
    }
  });
  const pinSessionTurn = vi.fn(async () => {
    if (options.pinErrorCode) {
      throw Object.assign(new Error("Session is closed for writes."), {
        code: options.pinErrorCode,
      });
    }
    return true;
  });
  const retryLegacyManagedArchive = vi.fn(async () => {
    if (options.retryError) throw options.retryError;
    return options.retryResult ?? false;
  });
  const deps = {
    cognitive: { collapseSession },
    storage: {
      getSession: vi.fn(async () => {
        if (options.getSessionError) throw options.getSessionError;
        return {
          id: "managed-1",
          workspaceId: "ws",
          status: options.status ?? "collapse_pending",
          sourceHost: options.managed === false ? null : "opencode",
          archiveReason: options.archiveReason ?? null,
        };
      }),
      listTurns: vi.fn(async () => []),
      appendTurn,
      archiveSession,
      closeSession,
      pinSessionTurn,
      retryLegacyManagedArchive,
    },
    telemetry: {
      startSpan: () => ({
        setAttribute() {},
        setStatus() {},
        end() {},
      }),
    },
  } as unknown as ServerDeps;
  if (options.storageAbsent) deps.storage = undefined;
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
  return {
    app,
    v1,
    collapseSession,
    appendTurn,
    archiveSession,
    closeSession,
    pinSessionTurn,
    retryLegacyManagedArchive,
  };
}

describe("managed session route fencing", () => {
  it("fails closed before legacy collapse when storage is absent", async () => {
    const { app, collapseSession } = createApp({ storageAbsent: true });
    const response = await app.request("/session/managed-1/collapse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(503);
    expect(collapseSession).not.toHaveBeenCalled();
  });

  it("rejects legacy collapse before running extraction", async () => {
    const { app, collapseSession } = createApp();
    const response = await app.request("/session/managed-1/collapse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(409);
    expect(collapseSession).not.toHaveBeenCalled();
  });

  it("fails closed when managed-session detection storage fails", async () => {
    const { app, collapseSession } = createApp({
      getSessionError: new Error("session lookup unavailable"),
    });
    const response = await app.request("/session/managed-1/collapse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(500);
    expect(collapseSession).not.toHaveBeenCalled();
  });

  it("rejects legacy discard before changing managed state", async () => {
    const { app, archiveSession, closeSession } = createApp();
    const response = await app.request("/session/managed-1/discard", { method: "POST" });

    expect(response.status).toBe(409);
    expect(archiveSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("rejects legacy turn append before changing a managed transcript", async () => {
    const { app, appendTurn } = createApp();
    const response = await app.request("/session/managed-1/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "user", content: "must use harness ingestion" }),
    });

    expect(response.status).toBe(409);
    expect(appendTurn).not.toHaveBeenCalled();
  });

  it("maps closed legacy turn writes to conflict instead of an internal error", async () => {
    const { app } = createApp({ managed: false, appendErrorCode: "SESSION_TERMINAL" });
    const response = await app.request("/session/managed-1/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "user", content: "too late" }),
    });

    expect(response.status).toBe(409);
  });

  it("rejects pin mutation for authoritative managed collapse input", async () => {
    const { app, pinSessionTurn } = createApp();
    const response = await app.request("/session/managed-1/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnIndex: 0, pinned: true }),
    });

    expect(response.status).toBe(409);
    expect(pinSessionTurn).not.toHaveBeenCalled();
  });

  it("maps a repository pin fence won after route preflight to conflict", async () => {
    const { app } = createApp({
      status: "active",
      pinErrorCode: "SESSION_CLOSED",
    });
    const response = await app.request("/session/managed-1/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnIndex: 0, pinned: true }),
    });

    expect(response.status).toBe(409);
  });

  it("documents the managed pin conflict response", async () => {
    const { v1 } = createApp();
    const document = v1.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "test", version: "1" },
    }) as { paths: Record<string, { post: { responses: Record<string, unknown> } }> };

    expect(document.paths["/session/{id}/pin"]?.post.responses).toHaveProperty("409");
  });

  it("allows explicit retry only for an enumerated recoverable managed archive", async () => {
    const { app, collapseSession, retryLegacyManagedArchive } = createApp({
      status: "archived",
      archiveReason: "no_pin",
      retryResult: true,
    });
    const response = await app.request("/session/managed-1/collapse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategy: "explicit" }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      accepted: true,
      sessionId: "managed-1",
      resumed: false,
      status: "collapse_pending",
    });
    expect(retryLegacyManagedArchive).toHaveBeenCalledWith({
      workspaceId: "ws",
      sessionId: "managed-1",
    });
    expect(collapseSession).not.toHaveBeenCalled();
  });

  it("does not retry llm_unavailable or non-explicit managed archives", async () => {
    for (const [archiveReason, strategy] of [
      ["llm_unavailable", "explicit"],
      ["no_pin", "auto"],
    ] as const) {
      const { app, retryLegacyManagedArchive } = createApp({
        status: "archived",
        archiveReason,
      });
      const response = await app.request("/session/managed-1/collapse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategy }),
      });

      expect(response.status).toBe(409);
      expect(retryLegacyManagedArchive).not.toHaveBeenCalled();
    }
  });

  it("does not fall through to legacy collapse when managed retry fails", async () => {
    const { app, collapseSession } = createApp({
      status: "archived",
      archiveReason: "no_pin",
      retryError: new Error("database unavailable"),
    });
    const response = await app.request("/session/managed-1/collapse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategy: "explicit" }),
    });

    expect(response.status).toBe(500);
    expect(collapseSession).not.toHaveBeenCalled();
  });
});
