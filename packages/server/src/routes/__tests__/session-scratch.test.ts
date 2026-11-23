import bcrypt from "bcrypt";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { CacheAdapter } from "@mnemo-ai/types";

import { createApp } from "../../app.js";
import { BCRYPT_COST, type ApiKeyLookup } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";

const API_KEY = "mns_live_sessionScratchRoute000001";
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000034";
const REQUEST_ID = "scratch-route-test";

let apiKeys: ApiKeyLookup;

beforeAll(async () => {
  const keyHash = await bcrypt.hash(API_KEY, BCRYPT_COST);
  apiKeys = {
    listActive: async () => [
      {
        id: "scratch-route-key",
        keyHash,
        workspaceId: WORKSPACE_ID,
        scopes: ["memory:read", "memory:write"],
      },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
});

function makeCache(): CacheAdapter {
  return {
    id: "scratch-route-cache",
    capabilities: {
      sortedSets: false,
      pubSub: false,
      patterns: false,
      atomic: false,
      hashes: false,
    },
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    deletePattern: async () => 0,
    healthCheck: async () => ({ status: "ok", latencyMs: 0 }),
    close: async () => {},
  };
}

function makeApp(
  options: {
    bufferWriter?: ReturnType<typeof vi.fn>;
    coreWriter?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const replaceSessionScratch = options.coreWriter ?? vi.fn(async () => true);
  const getSession = vi.fn(async () => ({ id: "existing-session" }));
  const updateSessionScratch = vi.fn(async () => {});
  const deps = {
    apiKeys,
    embedModel: "text-embedding-3-small",
    cognitive: {},
    // flatten-legacy-dual-core PR10: replaceSessionScratch ported off
    // deps.core onto deps.storage (StorageAdapter.replaceSessionScratch).
    storage: { getSession, updateSessionScratch, replaceSessionScratch },
    cache: makeCache(),
    telemetry: {
      startSpan: () => ({ setAttribute: () => {}, setStatus: () => {}, end: () => {} }),
      counter: () => {},
      histogram: () => {},
      gauge: () => {},
      shutdown: async () => {},
    },
    ...(options.bufferWriter ? { sessionBuffer: { setScratch: options.bufferWriter } } : {}),
  } as unknown as ServerDeps;

  return {
    app: createApp({ deps, version: "0.0.0-test" }),
    replaceSessionScratch,
    getSession,
    updateSessionScratch,
  };
}

function request(
  app: ReturnType<typeof createApp>,
  sessionId: string,
  scratch: Record<string, unknown>
) {
  return app.request(`/session/${sessionId}/scratch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      "x-request-id": REQUEST_ID,
    },
    body: JSON.stringify({ scratch }),
  });
}

function notFoundBody(sessionId: string) {
  return {
    error: {
      type: "not_found_error",
      code: "not_found",
      message: `Session ${sessionId} not found.`,
      retryable: false,
      request_id: REQUEST_ID,
    },
  };
}

describe("POST /session/:id/scratch", () => {
  it("returns 204 through SessionBuffer without pre-reading storage", async () => {
    const setScratch = vi.fn(async () => true);
    const { app, getSession } = makeApp({ bufferWriter: setScratch });
    const scratch = { note: "unchanged", nested: { value: 1 } };

    const response = await request(app, "session-buffer", scratch);

    expect(response.status).toBe(204);
    expect(setScratch).toHaveBeenCalledWith(WORKSPACE_ID, "session-buffer", scratch);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("maps a missing or cross-workspace SessionBuffer result to the canonical 404", async () => {
    const setScratch = vi.fn(async () => false);
    const { app, getSession } = makeApp({ bufferWriter: setScratch });

    const response = await request(app, "hidden-session", { a: 1 });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(notFoundBody("hidden-session"));
    expect(getSession).not.toHaveBeenCalled();
  });

  it("uses the scoped core fallback with the authenticated workspace and unchanged scratch", async () => {
    const replaceSessionScratch = vi.fn(async () => true);
    const { app, getSession, updateSessionScratch } = makeApp({
      coreWriter: replaceSessionScratch,
    });
    const scratch = { note: "unchanged", nested: { value: 1 } };

    const response = await request(app, "session-core", scratch);

    expect(response.status).toBe(204);
    expect(replaceSessionScratch).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      sessionId: "session-core",
      scratch,
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(updateSessionScratch).not.toHaveBeenCalled();
  });

  it("maps a missing or cross-workspace scoped core result to the same canonical 404", async () => {
    const replaceSessionScratch = vi.fn(async () => false);
    const { app, getSession } = makeApp({ coreWriter: replaceSessionScratch });

    const response = await request(app, "hidden-session", { a: 1 });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(notFoundBody("hidden-session"));
    expect(getSession).not.toHaveBeenCalled();
  });

  it("returns the canonical 500 body when the durable writer rejects", async () => {
    const setScratch = vi.fn(async () => {
      throw new Error("postgres down");
    });
    const { app, getSession } = makeApp({ bufferWriter: setScratch });

    const response = await request(app, "session-error", { a: 1 });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        type: "api_error",
        code: "internal_error",
        message: "Internal server error",
        retryable: false,
        request_id: REQUEST_ID,
      },
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("documents 204, 401, 404, and 500 responses without the stale 501", async () => {
    const { app } = makeApp();
    const response = await app.request("/openapi.json", {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const document = (await response.json()) as {
      paths: Record<string, { post: { responses: Record<string, { description: string }> } }>;
    };

    expect(document.paths["/session/{id}/scratch"]?.post.responses).toEqual({
      204: { description: "Scratch updated." },
      401: { description: "Missing or invalid bearer token." },
      404: { description: "Session not found." },
      500: { description: "Scratch update failed." },
    });
  });
});
