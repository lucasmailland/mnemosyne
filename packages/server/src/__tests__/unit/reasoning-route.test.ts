/**
 * Unit tests for /reasoning routes (Wave A5).
 *
 * Mirrors the pattern from events-route.test.ts:
 *   - Build a minimal OpenAPIHono app with a fake auth middleware
 *   - Mount the reasoning sub-router with fake storage overrides
 *   - Drive via app.request() — no real HTTP socket, no DB
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import type { MnemoReasoning } from "@mnemo-ai/types";
import { toErrorBody } from "../../errors.js";
import { mountReasoning } from "../../routes/reasoning.js";

// ── Test workspace ID (valid UUID) ────────────────────────────────────────────

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

// ── Helper: build minimal app with fake storage ───────────────────────────────

function makeReasoningApp(storageOverrides: Partial<StorageAdapter>) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  // Fake auth — stamps all required AuthVariables without touching bcrypt/DB
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "key-reasoning-route-test");
    c.set("actorType", "agent");
    c.set("userId", null);
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage: storageOverrides as unknown as StorageAdapter,
    core: {} as unknown,
  } as unknown as ServerDeps;

  mountReasoning(app, fakeDeps);

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { request: app.request.bind(app) };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseReasoning: MnemoReasoning = {
  id: "rsn-1",
  workspaceId: WORKSPACE_ID,
  question: "Why ship Wave A first?",
  chain: [{ step: 1, reasoning: "It unblocks B" }],
  conclusion: "Ship A before B",
  successCount: 0,
  failureCount: 0,
  worth: 0.5,
  embeddingStale: false,
  status: "active" as const,
  usageCount: 0,
  validFrom: new Date("2026-06-14T00:00:00.000Z"),
  createdAt: new Date("2026-06-14T00:00:00.000Z"),
  updatedAt: new Date("2026-06-14T00:00:00.000Z"),
  metadata: {},
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /reasoning — list reasoning", () => {
  it("returns 200 with { items, total, offset, limit, hasMore } (no nextCursor)", async () => {
    const { request } = makeReasoningApp({
      queryReasoning: vi.fn().mockResolvedValue({
        items: [baseReasoning],
        total: 1,
        offset: 0,
        limit: 25,
        hasMore: false,
      }),
    });

    const res = await request("/reasoning");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: { id: string; createdAt: string; updatedAt: string }[];
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("rsn-1");
    // Wire shape must use ISO strings, not Date objects
    expect(body.items[0].createdAt).toBe("2026-06-14T00:00:00.000Z");
    expect(body.items[0].updatedAt).toBe("2026-06-14T00:00:00.000Z");
    expect(body.total).toBe(1);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(25);
    expect(body.hasMore).toBe(false);
    // PaginatedResult has NO nextCursor
    expect("nextCursor" in body).toBe(false);
  });
});

describe("POST /reasoning — create reasoning", () => {
  it("returns 201 and the created reasoning row", async () => {
    const createReasoning = vi.fn().mockResolvedValue(baseReasoning);
    const { request } = makeReasoningApp({ createReasoning });

    const res = await request("/reasoning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "Why ship Wave A first?",
        chain: [{ step: 1, reasoning: "It unblocks B" }],
        conclusion: "Ship A before B",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; question: string; worth: number };
    expect(body.id).toBe("rsn-1");
    expect(body.question).toBe("Why ship Wave A first?");
    expect(body.worth).toBe(0.5);
    expect(createReasoning).toHaveBeenCalledOnce();

    // Verify workspaceId was injected from auth context
    const callArg = (createReasoning as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      workspaceId: string;
    };
    expect(callArg.workspaceId).toBe(WORKSPACE_ID);
  });
});

describe("GET /reasoning/:id — get missing reasoning → 404", () => {
  it("returns 404 with not_found code when reasoning does not exist", async () => {
    const { request } = makeReasoningApp({
      getReasoning: vi.fn().mockResolvedValue(null),
    });

    const res = await request("/reasoning/missing");
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("PATCH /reasoning/:id — returns 404 when reasoning does not exist", () => {
  it("returns 404 with not_found code (404-first pattern)", async () => {
    const { request } = makeReasoningApp({
      getReasoning: vi.fn().mockResolvedValue(null),
    });

    const res = await request("/reasoning/missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("PATCH /reasoning/:id — returns 200 with updated fields when reasoning exists", () => {
  it("calls updateReasoning with the patched fields and returns the updated wire shape", async () => {
    const updatedReasoning: MnemoReasoning = {
      ...baseReasoning,
      conclusion: "Revised conclusion",
      status: "archived" as const,
    };
    const updateReasoning = vi.fn().mockResolvedValue(updatedReasoning);
    const { request } = makeReasoningApp({
      getReasoning: vi.fn().mockResolvedValue(baseReasoning),
      updateReasoning,
    });

    const res = await request("/reasoning/rsn-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conclusion: "Revised conclusion", status: "archived" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; conclusion: string; status: string };
    expect(body.id).toBe("rsn-1");
    expect(body.conclusion).toBe("Revised conclusion");
    expect(body.status).toBe("archived");

    expect(updateReasoning).toHaveBeenCalledOnce();
    const [callId, callPatch] = (updateReasoning as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { conclusion?: string; status?: string },
    ];
    expect(callId).toBe("rsn-1");
    expect(callPatch.conclusion).toBe("Revised conclusion");
    expect(callPatch.status).toBe("archived");
  });
});

describe("DELETE /reasoning/:id — archive reasoning", () => {
  it("returns 204 when reasoning exists", async () => {
    const { request } = makeReasoningApp({
      getReasoning: vi.fn().mockResolvedValue(baseReasoning),
      archiveReasoning: vi.fn().mockResolvedValue(undefined),
    });

    const res = await request("/reasoning/rsn-1", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("returns 404 when reasoning does not exist (404-first pattern)", async () => {
    const { request } = makeReasoningApp({
      getReasoning: vi.fn().mockResolvedValue(null),
    });

    const res = await request("/reasoning/missing", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
