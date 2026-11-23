/**
 * Unit tests for P15 — sensitivity ceiling enforcement on non-fact primitives.
 *
 * Tests (Task 5.1):
 *   - Decision list filtered when maxSensitivity ceiling excludes confidential items
 *   - Decision GET returns 404 when item sensitivity exceeds ceiling
 *   - Entity list filtered when maxSensitivity ceiling excludes confidential items
 *   - Entity GET returns 404 when item sensitivity exceeds ceiling
 *   - Event list filtered when maxSensitivity ceiling excludes confidential items
 *   - Event GET returns 404 when item sensitivity exceeds ceiling
 *   - Task list filtered when maxSensitivity ceiling excludes confidential items
 *   - Task GET returns 404 when item sensitivity exceeds ceiling
 *
 * Pattern: OpenAPIHono + fake auth middleware + vi.fn() storage mocks.
 * No real DB, no bcrypt — pure route-level unit tests.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import { toErrorBody } from "../../errors.js";
import { mountDecisions } from "../../routes/decisions.js";
import { mountEntities } from "../../routes/entities.js";
import { mountEvents } from "../../routes/events.js";
import { mountTasks } from "../../routes/tasks.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000015";

// ── App builders ──────────────────────────────────────────────────────────────

// flatten-legacy-dual-core PR8: all of decisions.ts (list/get) is now ported
// to deps.storage — wired here instead of deps.core.
function makeDecisionApp(storageOverrides: Record<string, unknown>, maxSensitivity?: string) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", [] as ReadonlyArray<string>);
    if (maxSensitivity !== undefined) c.set("maxSensitivity" as never, maxSensitivity);
    await next();
  });
  mountDecisions(app, { storage: storageOverrides } as unknown as ServerDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app;
}

// flatten-legacy-dual-core PR8: getEntityRoute is ported to deps.storage
// (entity via getEntity + linkedFactCount via a separate queryFacts call).
// flatten-legacy-dual-core PR9a: listEntitiesRoute also ported, to
// deps.storage.queryEntities (D6.2) — this builder wires both off deps.core.
function makeEntityApp(
  overrides: {
    queryEntities?: Record<string, unknown>["queryEntities"];
    getEntity?: unknown;
  } & Record<string, unknown>,
  maxSensitivity?: string
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", [] as ReadonlyArray<string>);
    if (maxSensitivity !== undefined) c.set("maxSensitivity" as never, maxSensitivity);
    await next();
  });
  mountEntities(app, {
    core: {},
    storage: {
      queryEntities: overrides.queryEntities,
      getEntity: overrides.getEntity,
      countEntityMentions: vi.fn().mockResolvedValue({}),
      queryFacts: vi
        .fn()
        .mockResolvedValue({ total: 0, items: [], offset: 0, limit: 1, hasMore: false }),
    },
  } as unknown as ServerDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app;
}

function makeEventApp(storageOverrides: Partial<StorageAdapter>, maxSensitivity?: string) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("scopes", [] as ReadonlyArray<string>);
    if (maxSensitivity !== undefined) c.set("maxSensitivity" as never, maxSensitivity);
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

function makeTaskApp(storageOverrides: Partial<StorageAdapter>, maxSensitivity?: string) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "agent-test");
    c.set("scopes", [] as ReadonlyArray<string>);
    c.set("plan", "free");
    if (maxSensitivity !== undefined) c.set("maxSensitivity" as never, maxSensitivity);
    await next();
  });
  mountTasks(app, {
    storage: storageOverrides as unknown as StorageAdapter,
    accessPolicies: { getPolicy: vi.fn().mockResolvedValue(null) },
    bus: undefined,
  } as unknown as ServerDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseDecision = {
  id: "dec-1",
  workspaceId: WORKSPACE_ID,
  agentId: null,
  conversationId: null,
  kind: "architecture" as const,
  title: "Use PostgreSQL",
  body: "Body text",
  topicKey: "use-postgresql",
  revisionCount: 1,
  normalizedHash: "abc123",
  decidedByUserId: null,
  status: "active" as const,
  supersededById: null,
  sensitivity: "confidential" as const,
  metadata: {},
  validFrom: "2026-01-01T00:00:00.000Z",
  validTo: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const baseEntity = {
  id: "ment_p15test01",
  workspaceId: WORKSPACE_ID,
  kind: "project" as const,
  name: "Mnemosyne",
  description: "Memory system",
  aliases: [],
  canonicalId: null,
  sensitivity: "confidential" as const,
  metadata: {},
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  mentionCount: 0,
  // P120: response schemas project the bitemporal interval.
  validFrom: new Date("2026-01-01T00:00:00.000Z"),
  validTo: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const baseEvent = {
  id: "evt-1",
  workspaceId: WORKSPACE_ID,
  type: "user" as const,
  name: "deploy-prod",
  description: "Deployed to prod",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  source: "test",
  relatedEntities: [],
  annotations: [],
  sensitivity: "confidential" as const,
  // P120: response schemas project the bitemporal interval.
  validFrom: new Date("2026-01-01T00:00:00.000Z"),
  validTo: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  metadata: {},
};

const baseTask = {
  id: "tsk-1",
  workspaceId: WORKSPACE_ID,
  title: "Fix auth",
  status: "pending" as const,
  priority: "high" as const,
  assignedTo: "agent-test",
  blockedBy: [],
  subtaskIds: [],
  relatedFacts: [],
  relatedEntities: [],
  sensitivity: "confidential" as const,
  // P120: response schemas project the bitemporal interval.
  validFrom: new Date("2026-01-01T00:00:00.000Z"),
  validTo: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  metadata: {},
};

// ── Decision ceiling tests ─────────────────────────────────────────────────────

describe("Decisions — sensitivity ceiling enforcement (P15/Task 5.1)", () => {
  it("GET /decisions filters out confidential items when ceiling is 'public'", async () => {
    const publicDecision = { ...baseDecision, id: "dec-pub", sensitivity: "public" as const };
    const app = makeDecisionApp(
      {
        // flatten-legacy-dual-core PR8: queryDecisions returns a
        // PaginatedResult ({items, total, offset, limit, hasMore}), not a
        // bare array — the route destructures `.items`.
        queryDecisions: vi.fn().mockResolvedValue({
          items: [publicDecision, baseDecision],
          total: 2,
          offset: 0,
          limit: 50,
          hasMore: false,
        }),
        dispatchWebhookEvent: vi.fn(),
      },
      "public"
    );

    const res = await app.request("/decisions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toEqual(["dec-pub"]);
  });

  it("GET /decisions/:id returns 404 when item sensitivity exceeds ceiling", async () => {
    const app = makeDecisionApp({ getDecision: vi.fn().mockResolvedValue(baseDecision) }, "public");

    const res = await app.request("/decisions/dec-1");
    expect(res.status).toBe(404);
  });

  // (JSON.stringify serializes Date fields to ISO automatically, so
  // baseDecision's already-ISO-string validFrom/validTo/createdAt/updatedAt
  // work unmodified against the ported deps.storage.getDecision route —
  // unlike entities, decisions.ts does not run its response through a
  // Date-typed wire mapper.)

  it("GET /decisions/:id returns 200 when item sensitivity is within ceiling", async () => {
    const internalDecision = { ...baseDecision, sensitivity: "internal" as const };
    const app = makeDecisionApp(
      { getDecision: vi.fn().mockResolvedValue(internalDecision) }
      // no maxSensitivity → env ceiling defaults to "internal" → allows "internal" items
    );

    const res = await app.request("/decisions/dec-1");
    expect(res.status).toBe(200);
  });
});

// ── Entity ceiling tests ───────────────────────────────────────────────────────

describe("Entities — sensitivity ceiling enforcement (P15/Task 5.1)", () => {
  it("GET /entities filters out confidential items when ceiling is 'public'", async () => {
    // flatten-legacy-dual-core PR9a: listEntitiesRoute now runs its response
    // through entityToWire() (.toISOString() on Date fields) — real Date
    // objects needed, not the shared ISO-string baseEntity (same fixture
    // fix the two GET /entities/:id tests below already needed in PR8).
    const asV3 = (e: typeof baseEntity) => ({
      ...e,
      firstSeenAt: new Date(e.firstSeenAt),
      lastSeenAt: new Date(e.lastSeenAt),
      // P120: response schemas project the bitemporal interval.
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validTo: null,
      createdAt: new Date(e.createdAt),
      updatedAt: new Date(e.updatedAt),
    });
    const publicEntity = asV3({ ...baseEntity, id: "ment_pub01", sensitivity: "public" as const });
    const app = makeEntityApp(
      {
        queryEntities: vi.fn().mockResolvedValue({
          items: [publicEntity, asV3(baseEntity)],
          total: 2,
          offset: 0,
          limit: 50,
          hasMore: false,
        }),
      },
      "public"
    );

    const res = await app.request("/entities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toEqual(["ment_pub01"]);
  });

  it("GET /entities/:id returns 404 when item sensitivity exceeds ceiling", async () => {
    // flatten-legacy-dual-core PR8: getEntityRoute is ported to
    // deps.storage.getEntity, which returns the entity directly (not
    // wrapped in {entity, linkedFactCount} — the count is now a separate
    // queryFacts call) — and the response runs through entityToWire(),
    // which calls .toISOString() on Date fields, so this fixture needs
    // real Date objects, not the shared ISO-string baseEntity.
    const v3Entity = {
      ...baseEntity,
      firstSeenAt: new Date(baseEntity.firstSeenAt),
      lastSeenAt: new Date(baseEntity.lastSeenAt),
      // P120: response schemas project the bitemporal interval.
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validTo: null,
      createdAt: new Date(baseEntity.createdAt),
      updatedAt: new Date(baseEntity.updatedAt),
    };
    const app = makeEntityApp({ getEntity: vi.fn().mockResolvedValue(v3Entity) }, "public");

    const res = await app.request("/entities/ment_p15test01");
    expect(res.status).toBe(404);
  });

  it("GET /entities/:id returns 200 when item sensitivity is within ceiling", async () => {
    const internalEntity = {
      ...baseEntity,
      sensitivity: "internal" as const,
      firstSeenAt: new Date(baseEntity.firstSeenAt),
      lastSeenAt: new Date(baseEntity.lastSeenAt),
      // P120: response schemas project the bitemporal interval.
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validTo: null,
      createdAt: new Date(baseEntity.createdAt),
      updatedAt: new Date(baseEntity.updatedAt),
    };
    const app = makeEntityApp(
      { getEntity: vi.fn().mockResolvedValue(internalEntity) }
      // no maxSensitivity → env ceiling defaults to "internal" → allows "internal" items
    );

    const res = await app.request("/entities/ment_p15test01");
    expect(res.status).toBe(200);
  });
});

// ── Event ceiling tests ────────────────────────────────────────────────────────

describe("Events — sensitivity ceiling enforcement (P15/Task 5.1)", () => {
  it("GET /events filters out confidential items when ceiling is 'public'", async () => {
    const publicEvent = { ...baseEvent, id: "evt-pub", sensitivity: "public" as const };
    const app = makeEventApp(
      {
        queryEvents: vi.fn().mockResolvedValue({
          items: [publicEvent, baseEvent],
          total: 2,
          offset: 0,
          limit: 25,
          hasMore: false,
        }),
      },
      "public"
    );

    const res = await app.request("/events");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toEqual(["evt-pub"]);
  });

  it("GET /events/:id returns 404 when item sensitivity exceeds ceiling", async () => {
    const app = makeEventApp({ getEvent: vi.fn().mockResolvedValue(baseEvent) }, "public");

    const res = await app.request("/events/evt-1");
    expect(res.status).toBe(404);
  });

  it("GET /events/:id returns 200 when item sensitivity is within ceiling", async () => {
    const internalEvent = { ...baseEvent, sensitivity: "internal" as const };
    const app = makeEventApp(
      { getEvent: vi.fn().mockResolvedValue(internalEvent) }
      // no maxSensitivity → env ceiling defaults to "internal" → allows "internal" items
    );

    const res = await app.request("/events/evt-1");
    expect(res.status).toBe(200);
  });
});

// ── Task ceiling tests ─────────────────────────────────────────────────────────

describe("Tasks — sensitivity ceiling enforcement (P15/Task 5.1)", () => {
  it("GET /tasks filters out confidential items when ceiling is 'public'", async () => {
    const publicTask = { ...baseTask, id: "tsk-pub", sensitivity: "public" as const };
    const app = makeTaskApp(
      {
        queryTasks: vi.fn().mockResolvedValue({
          items: [publicTask, baseTask],
          total: 2,
          offset: 0,
          limit: 50,
          hasMore: false,
        }),
      },
      "public"
    );

    const res = await app.request("/tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toEqual(["tsk-pub"]);
  });

  it("GET /tasks/:id returns 404 when item sensitivity exceeds ceiling", async () => {
    const app = makeTaskApp({ getTask: vi.fn().mockResolvedValue(baseTask) }, "public");

    const res = await app.request("/tasks/tsk-1");
    expect(res.status).toBe(404);
  });

  it("GET /tasks/:id returns 200 when item sensitivity is within ceiling", async () => {
    const internalTask = { ...baseTask, sensitivity: "internal" as const };
    const app = makeTaskApp(
      { getTask: vi.fn().mockResolvedValue(internalTask) }
      // no maxSensitivity → env ceiling defaults to "internal" → allows "internal" items
    );

    const res = await app.request("/tasks/tsk-1");
    expect(res.status).toBe(200);
  });
});
