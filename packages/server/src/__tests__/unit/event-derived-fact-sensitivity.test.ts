/**
 * PRIM-7 — the fact POST /events derives from an event's description must be
 * at least as sensitive as the event.
 *
 * Measured on 9a20d6ea: a `restricted` event ("SECRET … root password was
 * exposed") was itself unreadable to the caller (404), while the auto-fact
 * carrying the same description landed as `internal` and came back from
 * POST /recall and GET /facts?q=. Same for `confidential`. The route called
 * `remember()` without a sensitivity, so the storage default won.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { MnemoEvent, Sensitivity } from "@mnemo-ai/types";
import { mountEvents } from "../../routes/events.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-0000000000e7";
const CALLER_SCOPES = ["memory:read", "memory:write", "memory:event"];

function makeApp(persistedSensitivity: Sensitivity | undefined) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "caller-key-id");
    c.set("actorType", "agent");
    c.set("scopes", CALLER_SCOPES as ReadonlyArray<string>);
    await next();
  });

  const remember = vi.fn().mockResolvedValue({ id: "fact-1", kind: "fact" });
  const createEvent = vi
    .fn()
    .mockImplementation(async (input: { description: string }): Promise<MnemoEvent> => ({
      id: "evt-1",
      workspaceId: WORKSPACE_ID,
      type: "external",
      name: "wintermarch credential leak",
      description: input.description,
      occurredAt: new Date("2026-10-17T00:00:00.000Z"),
      source: "test",
      relatedEntities: [],
      annotations: [],
      createdAt: new Date("2026-10-17T00:00:00.000Z"),
      metadata: {},
      ...(persistedSensitivity ? { sensitivity: persistedSensitivity } : {}),
    }));
  mountEvents(app, {
    storage: { createEvent },
    cognitive: { remember },
  } as unknown as ServerDeps);
  return { app, remember };
}

async function postEvent(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  sensitivity?: Sensitivity
): Promise<number> {
  const res = await app.request("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "external",
      name: "wintermarch credential leak",
      description: "SECRET wintermarch root password was exposed",
      occurredAt: "2026-10-17T00:00:00.000Z",
      source: "test",
      ...(sensitivity ? { sensitivity } : {}),
    }),
  });
  return res.status;
}

// PRIM-14: a caller can only write tiers it may read back, and the process
// ceiling defaults to `internal`. These tests write restricted events.
let prevCeiling: string | undefined;
beforeAll(() => {
  prevCeiling = process.env.MNEMO_SENSITIVITY_CEILING;
  process.env.MNEMO_SENSITIVITY_CEILING = "restricted";
});
afterAll(() => {
  if (prevCeiling === undefined) delete process.env.MNEMO_SENSITIVITY_CEILING;
  else process.env.MNEMO_SENSITIVITY_CEILING = prevCeiling;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("PRIM-7 — the derived fact inherits the event's sensitivity", () => {
  it.each(["restricted", "confidential"] as const)(
    "REGRESSION: a %s event yields a fact of the same tier, never the internal default",
    async (sensitivity) => {
      const { app, remember } = makeApp(sensitivity);
      expect(await postEvent(app, sensitivity)).toBe(201);
      await flush();
      expect(remember).toHaveBeenCalledTimes(1);
      const [req] = remember.mock.calls[0]!;
      expect(req.sensitivity).toBe(sensitivity);
    }
  );

  it("uses the PERSISTED event's tier (what GET /events/:id enforces), not just the request body", async () => {
    const { app, remember } = makeApp("restricted");
    expect(await postEvent(app)).toBe(201);
    await flush();
    expect(remember.mock.calls[0]![0].sensitivity).toBe("restricted");
  });

  it("an internal event still yields an internal fact", async () => {
    const { app, remember } = makeApp("internal");
    expect(await postEvent(app, "internal")).toBe(201);
    await flush();
    expect(remember.mock.calls[0]![0].sensitivity).toBe("internal");
  });

  it("passes the caller's real scopes, not a fabricated list", async () => {
    const { app, remember } = makeApp("internal");
    await postEvent(app);
    await flush();
    const [, auth] = remember.mock.calls[0]!;
    expect([...auth.scopes]).toEqual(CALLER_SCOPES);
  });
});
