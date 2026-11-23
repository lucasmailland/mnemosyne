/**
 * Unit tests for /events routes (Wave A4).
 *
 * Mirrors the pattern from tasks-route.test.ts:
 *   - Build a minimal OpenAPIHono app with a fake auth middleware
 *   - Mount the events sub-router with fake storage overrides
 *   - Drive via app.request() — no real HTTP socket, no DB
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import type { MnemoEvent } from "@mnemo-ai/types";
import { toErrorBody } from "../../errors.js";
import { mountEvents } from "../../routes/events.js";

// ── Test workspace ID (valid UUID) ────────────────────────────────────────────

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

// ── Helper: build minimal app with fake storage ───────────────────────────────

function makeEventsApp(storageOverrides: Partial<StorageAdapter>) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  // Fake auth — stamps all required AuthVariables without touching bcrypt/DB
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "test-key-id");
    c.set("actorType", "user");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage: storageOverrides as unknown as StorageAdapter,
    // flatten-legacy-dual-core PR13: T14 auto-fact automation ported off
    // `deps.core.createFact` to `deps.cognitive.remember` — see
    // `__tests__/parity/events.parity.test.ts` for the dedicated parity
    // coverage of that call site.
    cognitive: { remember: vi.fn().mockResolvedValue({}) } as unknown,
  } as unknown as ServerDeps;

  mountEvents(app, fakeDeps);

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { request: app.request.bind(app) };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseEvent: MnemoEvent = {
  id: "evt-1",
  workspaceId: WORKSPACE_ID,
  type: "user" as const,
  name: "shipped-wave-a",
  description: "Wave A merged",
  occurredAt: new Date("2026-06-14T00:00:00.000Z"),
  source: "test",
  relatedEntities: [],
  annotations: [],
  createdAt: new Date("2026-06-14T00:00:00.000Z"),
  metadata: {},
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /events — list events", () => {
  it("returns 200 with items array (offset/limit/hasMore shape, no nextCursor)", async () => {
    const { request } = makeEventsApp({
      queryEvents: vi.fn().mockResolvedValue({
        items: [baseEvent],
        total: 1,
        offset: 0,
        limit: 25,
        hasMore: false,
      }),
    });

    const res = await request("/events");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: { id: string; createdAt: string; occurredAt: string }[];
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("evt-1");
    // Wire shape must use ISO strings, not Date objects
    expect(body.items[0].createdAt).toBe("2026-06-14T00:00:00.000Z");
    expect(body.items[0].occurredAt).toBe("2026-06-14T00:00:00.000Z");
    expect(body.total).toBe(1);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(25);
    expect(body.hasMore).toBe(false);
    // PaginatedResult has NO nextCursor
    expect("nextCursor" in body).toBe(false);
  });
});

describe("POST /events — create event", () => {
  it("returns 201 and converts occurredAt ISO string to Date before hitting storage", async () => {
    const createEvent = vi.fn().mockResolvedValue(baseEvent);
    const { request } = makeEventsApp({ createEvent });

    const res = await request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "user",
        name: "shipped-wave-a",
        description: "Wave A merged",
        occurredAt: "2026-06-14T00:00:00.000Z",
        source: "test",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.id).toBe("evt-1");
    expect(body.name).toBe("shipped-wave-a");
    expect(createEvent).toHaveBeenCalledOnce();

    // Verify occurredAt was converted to a Date instance before hitting storage
    const callArg = (createEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      occurredAt: unknown;
    };
    expect(callArg.occurredAt).toBeInstanceOf(Date);
    expect((callArg.occurredAt as Date).toISOString()).toBe("2026-06-14T00:00:00.000Z");
  });
});

describe("GET /events/:id — get missing event → 404", () => {
  it("returns 404 with not_found code when event does not exist", async () => {
    const { request } = makeEventsApp({
      getEvent: vi.fn().mockResolvedValue(null),
    });

    const res = await request("/events/missing");
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("DELETE /events/:id — events are immutable", () => {
  // PRIM-10: this answered 204 while changing nothing — the event stayed
  // recallable and so did the fact derived from it. An honest refusal now.
  it("returns 409 event_immutable for an existing event, with no side effects", async () => {
    const archiveEvent = vi.fn().mockResolvedValue(undefined);
    const { request } = makeEventsApp({
      getEvent: vi.fn().mockResolvedValue(baseEvent),
      archiveEvent,
    });

    const res = await request("/events/evt-1", { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("event_immutable");
    expect(archiveEvent).not.toHaveBeenCalled();
  });

  it("returns 404 (not 409) for an event above the caller's ceiling", async () => {
    const { request } = makeEventsApp({
      getEvent: vi.fn().mockResolvedValue({ ...baseEvent, sensitivity: "restricted" }),
    });
    const res = await request("/events/evt-1", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when event does not exist (404-first pattern)", async () => {
    const { request } = makeEventsApp({
      getEvent: vi.fn().mockResolvedValue(null),
    });

    const res = await request("/events/missing", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
