/**
 * Unit tests for /hyperedges routes (Wave D2).
 *
 * Mirrors the pattern from reasoning-route.test.ts:
 *   - Build a minimal OpenAPIHono app with a fake auth middleware
 *   - Mount the hyperedges sub-router with fake storage overrides
 *   - Drive via app.request() — no real HTTP socket, no DB
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import type { MnemoHyperedge } from "@mnemo-ai/types";
import { toErrorBody } from "../../errors.js";
import { mountHyperedges } from "../../routes/hyperedges.js";

// ── Test workspace ID (valid UUID) ────────────────────────────────────────────

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

// ── Helper: build minimal app with fake storage ───────────────────────────────

function makeHyperedgeApp(storageOverrides: Partial<StorageAdapter>) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  // Fake auth — stamps all required AuthVariables without touching bcrypt/DB
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "key-hyperedges-route-test");
    c.set("actorType", "agent");
    c.set("userId", null);
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage: storageOverrides as unknown as StorageAdapter,
    core: {} as unknown,
  } as unknown as ServerDeps;

  mountHyperedges(app, fakeDeps);

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { request: app.request.bind(app) };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseHyperedge: MnemoHyperedge = {
  id: "he-1",
  workspaceId: WORKSPACE_ID,
  memberIds: ["m1", "m2", "m3"],
  label: "test-trio",
  activationCount: 0,
  worth: 0.5,
  validFrom: new Date("2026-06-14T00:00:00.000Z"),
  validTo: undefined,
  createdAt: new Date("2026-06-14T00:00:00.000Z"),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /hyperedges — list hyperedges", () => {
  it("returns 200 with { items, total, offset, limit, hasMore }", async () => {
    const { request } = makeHyperedgeApp({
      queryHyperedges: vi.fn().mockResolvedValue({
        items: [baseHyperedge],
        total: 1,
        offset: 0,
        limit: 50,
        hasMore: false,
      }),
    });

    const res = await request("/hyperedges");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: { id: string; validFrom: string; validTo: string | null; createdAt: string }[];
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("he-1");
    // Wire shape must use ISO strings, not Date objects
    expect(body.items[0].validFrom).toBe("2026-06-14T00:00:00.000Z");
    expect(body.items[0].validTo).toBeNull();
    expect(body.items[0].createdAt).toBe("2026-06-14T00:00:00.000Z");
    expect(body.total).toBe(1);
    expect(body.hasMore).toBe(false);
  });
});

describe("POST /hyperedges — create hyperedge", () => {
  it("returns 400 when memberIds has fewer than 3 entries", async () => {
    const { request } = makeHyperedgeApp({});

    const res = await request("/hyperedges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds: ["a", "b"] }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 201 and the created hyperedge when memberIds has 3+ entries", async () => {
    const createHyperedge = vi.fn().mockResolvedValue(baseHyperedge);
    const { request } = makeHyperedgeApp({ createHyperedge });

    const res = await request("/hyperedges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds: ["m1", "m2", "m3"], label: "test-trio" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      memberIds: string[];
      label: string;
      worth: number;
    };
    expect(body.id).toBe("he-1");
    expect(body.memberIds).toEqual(["m1", "m2", "m3"]);
    expect(body.label).toBe("test-trio");
    expect(body.worth).toBe(0.5);
    expect(createHyperedge).toHaveBeenCalledOnce();

    // Verify workspaceId was injected from auth context
    const callArg = (createHyperedge as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      workspaceId: string;
    };
    expect(callArg.workspaceId).toBe(WORKSPACE_ID);
  });
});

describe("GET /hyperedges/:id — get missing hyperedge → 404", () => {
  it("returns 404 with not_found code when hyperedge does not exist", async () => {
    const { request } = makeHyperedgeApp({
      getHyperedge: vi.fn().mockResolvedValue(null),
    });

    const res = await request("/hyperedges/missing");
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("PATCH /hyperedges/:id — returns 404 when hyperedge does not exist", () => {
  it("returns 404 with not_found code (404-first pattern)", async () => {
    const { request } = makeHyperedgeApp({
      getHyperedge: vi.fn().mockResolvedValue(null),
    });

    const res = await request("/hyperedges/missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "new-label" }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("DELETE /hyperedges/:id — archive hyperedge", () => {
  it("returns 204 when hyperedge exists", async () => {
    const { request } = makeHyperedgeApp({
      getHyperedge: vi.fn().mockResolvedValue(baseHyperedge),
      archiveHyperedge: vi.fn().mockResolvedValue(undefined),
    });

    const res = await request("/hyperedges/he-1", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("returns 404 when hyperedge does not exist (404-first pattern)", async () => {
    const { request } = makeHyperedgeApp({
      getHyperedge: vi.fn().mockResolvedValue(null),
    });

    const res = await request("/hyperedges/missing", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("PRIM-12 / PRIM-13: workspace travels with the update; members are verified", () => {
  it("PATCH forwards the workspace id to updateHyperedge (RLS context before the read)", async () => {
    const updateHyperedge = vi.fn().mockResolvedValue({ ...baseHyperedge, label: "renamed" });
    const { request } = makeHyperedgeApp({
      getHyperedge: vi.fn().mockResolvedValue(baseHyperedge),
      updateHyperedge,
    });
    const res = await request("/hyperedges/he-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "renamed" }),
    });
    expect(res.status).toBe(200);
    expect(updateHyperedge).toHaveBeenCalledWith("he-1", {
      workspaceId: WORKSPACE_ID,
      label: "renamed",
    });
  });

  it("POST asks the adapter to verify members and maps its typed failures to 404 / 400", async () => {
    const { StorageNotFoundError, StorageValidationError } = await import("@mnemo-ai/types");
    const createHyperedge = vi
      .fn()
      .mockRejectedValueOnce(new StorageNotFoundError("Hyperedge members not found: ghost"))
      .mockRejectedValueOnce(new StorageValidationError("Hyperedge members must be distinct"));
    const { request } = makeHyperedgeApp({ createHyperedge });
    const post = () =>
      request("/hyperedges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberIds: ["a", "b", "c"] }),
      });
    expect((await post()).status).toBe(404);
    expect((await post()).status).toBe(400);
    expect(createHyperedge).toHaveBeenCalledWith(
      expect.objectContaining({ verifyMembers: true, maxSensitivity: expect.any(String) })
    );
  });
});
