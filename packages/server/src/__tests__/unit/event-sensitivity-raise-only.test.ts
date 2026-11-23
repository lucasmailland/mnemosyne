/**
 * Unit tests for P15 — event raise-only sensitivity guard.
 *
 * Tests (Task 5.2):
 *   - PATCH /events/:id/sensitivity with a lower tier → 422
 *   - PATCH /events/:id/sensitivity with same tier → 200 (idempotent allow)
 *   - PATCH /events/:id/sensitivity with higher tier → 200
 *   - PATCH /events/:id/sensitivity on missing event → 404
 *
 * Pattern: OpenAPIHono + fake auth + vi.fn() storage mocks.
 * No real DB — pure route-level unit test.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import { toErrorBody } from "../../errors.js";
import { mountEvents } from "../../routes/events.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000015";

function makeEventApp(storageOverrides: Partial<StorageAdapter>) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });
  const fakeDeps = {
    storage: storageOverrides as unknown as StorageAdapter,
  } as unknown as ServerDeps;
  mountEvents(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app;
}

const baseEvent = {
  id: "evt-raise",
  workspaceId: WORKSPACE_ID,
  type: "user" as const,
  name: "deploy",
  description: "Deployed",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  source: "ci",
  relatedEntities: [],
  annotations: [],
  sensitivity: "confidential" as const,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  metadata: {},
};

describe("PATCH /events/:id/sensitivity — raise-only guard (P15/Task 5.2)", () => {
  // These events are confidential; a caller whose ceiling reads them.
  beforeEach(() => vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted"));
  afterEach(() => vi.unstubAllEnvs());

  it("returns 422 when trying to lower sensitivity (confidential → internal)", async () => {
    const app = makeEventApp({
      getEvent: vi.fn().mockResolvedValue(baseEvent),
      updateEventSensitivity: vi.fn(),
    });

    const res = await app.request("/events/evt-raise/sensitivity", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sensitivity: "internal" }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/only be raised/i);
  });

  it("returns 422 when trying to lower sensitivity (confidential → public)", async () => {
    const app = makeEventApp({
      getEvent: vi.fn().mockResolvedValue(baseEvent),
      updateEventSensitivity: vi.fn(),
    });

    const res = await app.request("/events/evt-raise/sensitivity", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sensitivity: "public" }),
    });

    expect(res.status).toBe(422);
  });

  it("returns 200 when raising sensitivity (confidential → restricted)", async () => {
    const raisedEvent = { ...baseEvent, sensitivity: "restricted" as const };
    const getEvent = vi
      .fn()
      .mockResolvedValueOnce(baseEvent) // lookup for raise-guard
      .mockResolvedValueOnce(raisedEvent); // re-fetch for response
    const updateEventSensitivity = vi.fn().mockResolvedValue(undefined);

    const app = makeEventApp({ getEvent, updateEventSensitivity });

    const res = await app.request("/events/evt-raise/sensitivity", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sensitivity: "restricted" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sensitivity: string };
    expect(body.sensitivity).toBe("restricted");
    expect(updateEventSensitivity).toHaveBeenCalledOnce();
    expect(updateEventSensitivity).toHaveBeenCalledWith("evt-raise", WORKSPACE_ID, "restricted");
  });

  it("returns 200 for same sensitivity (idempotent — not a lowering)", async () => {
    const sameEvent = { ...baseEvent, sensitivity: "confidential" as const };
    const getEvent = vi.fn().mockResolvedValueOnce(baseEvent).mockResolvedValueOnce(sameEvent);
    const updateEventSensitivity = vi.fn().mockResolvedValue(undefined);

    const app = makeEventApp({ getEvent, updateEventSensitivity });

    const res = await app.request("/events/evt-raise/sensitivity", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sensitivity: "confidential" }),
    });

    expect(res.status).toBe(200);
    expect(updateEventSensitivity).toHaveBeenCalledOnce();
  });

  it("returns 404 when event does not exist", async () => {
    const app = makeEventApp({
      getEvent: vi.fn().mockResolvedValue(null),
    });

    const res = await app.request("/events/missing/sensitivity", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sensitivity: "restricted" }),
    });

    expect(res.status).toBe(404);
  });
});

describe("PATCH /events/:id/sensitivity — the caller's own ceiling", () => {
  it("refuses a raise past the caller's ceiling (404 sensitivity_above_ceiling, nothing written)", async () => {
    const updateEventSensitivity = vi.fn();
    const app = makeEventApp({
      getEvent: vi.fn().mockResolvedValue({ ...baseEvent, sensitivity: "internal" }),
      updateEventSensitivity,
    });
    const res = await app.request("/events/evt-raise/sensitivity", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sensitivity: "confidential" }),
    });
    expect(res.status).toBe(404);
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("sensitivity_above_ceiling");
    // An update, not a create: the message says nothing was changed.
    expect(error.message).toBe(
      "sensitivity 'confidential' is above this credential's read ceiling ('internal'); the event could never be read again, so it was not changed."
    );
    expect(updateEventSensitivity).not.toHaveBeenCalled();
  });
});
