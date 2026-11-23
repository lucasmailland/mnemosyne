/**
 * Tests for POST /events/:id/annotations — append annotation to event.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import type { MnemoEvent } from "@mnemo-ai/types";
import { toErrorBody } from "../../errors.js";
import { mountEvents } from "../../routes/events.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

function makeEventsApp(storageOverrides: Partial<StorageAdapter>) {
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

  return { request: app.request.bind(app) };
}

const baseEvent: MnemoEvent = {
  id: "evt-1",
  workspaceId: WORKSPACE_ID,
  type: "user" as const,
  name: "shipped-wave-o",
  description: "Wave O merged",
  occurredAt: new Date("2026-06-14T00:00:00.000Z"),
  source: "test",
  relatedEntities: [],
  annotations: [],
  createdAt: new Date("2026-06-14T00:00:00.000Z"),
  metadata: {},
};

describe("POST /events/:id/annotations — append annotation", () => {
  it("returns 200 with the annotation appended", async () => {
    const annotationAt = "2026-06-14T12:00:00.000Z";
    const annotatedEvent: MnemoEvent = {
      ...baseEvent,
      annotations: [{ author: "agent-1", content: "This is notable", at: new Date(annotationAt) }],
    };
    const appendEventAnnotation = vi.fn().mockResolvedValue(annotatedEvent);

    const { request } = makeEventsApp({
      getEvent: vi.fn().mockResolvedValue(baseEvent),
      appendEventAnnotation,
    });

    const res = await request("/events/evt-1/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        author: "agent-1",
        content: "This is notable",
        at: annotationAt,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { annotations: { author: string; content: string }[] };
    expect(body.annotations).toHaveLength(1);
    expect(body.annotations[0].author).toBe("agent-1");
    expect(body.annotations[0].content).toBe("This is notable");
    expect(appendEventAnnotation).toHaveBeenCalledOnce();
  });

  it("returns 404 when event does not exist", async () => {
    const { request } = makeEventsApp({
      getEvent: vi.fn().mockResolvedValue(null),
    });

    const res = await request("/events/missing/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "agent-1", content: "Irrelevant" }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});
