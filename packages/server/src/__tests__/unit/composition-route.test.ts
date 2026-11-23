/**
 * Unit tests for /composition/* routes (Wave H4).
 *
 * Pattern mirrors anticipation-route.test.ts:
 *   - OpenAPIHono with fake auth middleware
 *   - Fake storage overrides — no DB
 *   - app.request() for in-process HTTP
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";
import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter, MnemoCompositionRule } from "@mnemo-ai/types";
import { mountComposition } from "../../routes/composition.js";
import { toErrorBody } from "../../errors.js";

const WORKSPACE_ID = "ws-test-01";

const BASE_RULE = {
  id: "r-1",
  workspaceId: WORKSPACE_ID,
  name: "Test Rule",
  description: "A test rule",
  conditionDsl: { all: [{ op: "text_contains", needle: "auth" }] },
  actionDsl: {
    op: "derive_fact",
    statementTemplate: "Auth related",
    kind: "inferred",
    baseConfidence: 0.8,
    sensitivity: "internal",
  },
  priority: 100,
  isActive: true,
  executionCount: 5,
  source: "manual" as const,
  createdBy: "user-1",
  metadata: {},
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-02T00:00:00Z"),
};

function makeApp(storageOverrides: Partial<StorageAdapter> = {}) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "tester");
    c.set("actorType", "user");
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });
  const fakeDeps = {
    storage: storageOverrides as unknown as StorageAdapter,
    core: {} as unknown,
  } as unknown as ServerDeps;
  mountComposition(app, fakeDeps);
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
  return { request: app.request.bind(app) };
}

// ─── GET /composition/rules ───────────────────────────────────────────────────

describe("GET /composition/rules", () => {
  it("returns 200 with paginated list", async () => {
    const { request } = makeApp({
      queryCompositionRules: vi.fn(async () => ({
        items: [BASE_RULE],
        total: 1,
        offset: 0,
        limit: 50,
        hasMore: false,
      })),
    });
    const res = await request("/composition/rules");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe("Test Rule");
    expect(body.total).toBe(1);
  });

  it("passes isActive filter as boolean", async () => {
    const queryFn = vi.fn(async () => ({
      items: [],
      total: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
    }));
    const { request } = makeApp({ queryCompositionRules: queryFn });
    await request("/composition/rules?isActive=true");
    expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
  });
});

// ─── POST /composition/rules ──────────────────────────────────────────────────

describe("POST /composition/rules", () => {
  it("creates a rule and returns 201", async () => {
    const { request } = makeApp({
      createCompositionRule: vi.fn(async () => BASE_RULE),
    });
    const res = await request("/composition/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Rule",
        conditionDsl: { all: [{ op: "text_contains", needle: "auth" }] },
        actionDsl: {
          op: "derive_fact",
          statementTemplate: "Auth related",
          kind: "inferred",
          baseConfidence: 0.8,
          sensitivity: "internal",
        },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("r-1");
    expect(body.name).toBe("Test Rule");
  });

  it("rejects a rule whose relation verb is not one of the 9 locked verbs (§34.6)", async () => {
    const create = vi.fn(async () => BASE_RULE);
    const { request } = makeApp({ createCompositionRule: create });
    const res = await request("/composition/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Verb Rule",
        conditionDsl: {
          all: [{ op: "relation", from: "$a", to: "$b", verb: "frobnicates" }],
        },
        actionDsl: {
          op: "derive_fact",
          statementTemplate: "x",
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("conditionDsl");
    // The rule must never reach storage.
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a rule whose action op is outside the locked set (§34.6)", async () => {
    const create = vi.fn(async () => BASE_RULE);
    const { request } = makeApp({ createCompositionRule: create });
    const res = await request("/composition/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Action Rule",
        conditionDsl: { all: [{ op: "text_contains", needle: "auth" }] },
        actionDsl: { op: "delete_everything" },
      }),
    });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("p45 Slice C: passes resolveProvenance()'s actorId into created_by (reused column)", async () => {
    const create = vi.fn(async () => BASE_RULE);
    const { request } = makeApp({ createCompositionRule: create });
    const res = await request("/composition/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Provenance Rule",
        conditionDsl: { all: [{ op: "text_contains", needle: "auth" }] },
        actionDsl: {
          op: "derive_fact",
          statementTemplate: "Auth related",
          kind: "inferred",
          baseConfidence: 0.8,
          sensitivity: "internal",
        },
      }),
    });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ createdBy: "key:tester" }));
  });
});

// ─── GET /composition/rules/:id ───────────────────────────────────────────────

describe("GET /composition/rules/:id", () => {
  it("returns 200 when found", async () => {
    const { request } = makeApp({
      getCompositionRule: vi.fn(async () => BASE_RULE),
    });
    const res = await request("/composition/rules/r-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("r-1");
  });

  it("returns 404 when not found", async () => {
    const { request } = makeApp({
      getCompositionRule: vi.fn(async () => null),
    });
    const res = await request("/composition/rules/nonexistent");
    expect(res.status).toBe(404);
  });
});

// ─── PATCH /composition/rules/:id ────────────────────────────────────────────

describe("PATCH /composition/rules/:id", () => {
  it("returns 200 with updated rule", async () => {
    const updated = { ...BASE_RULE, name: "Updated Rule" };
    const { request } = makeApp({
      updateCompositionRule: vi.fn(async () => updated),
    });
    const res = await request("/composition/rules/r-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Rule" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Updated Rule");
  });

  it("returns 404 when rule not found", async () => {
    const { request } = makeApp({
      updateCompositionRule: vi.fn(async () => null as unknown as MnemoCompositionRule),
    });
    const res = await request("/composition/rules/missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── POST /composition/dry-run ────────────────────────────────────────────────

describe("POST /composition/dry-run", () => {
  it("dry-runs an inline rule and returns inferences", async () => {
    const { request } = makeApp({});
    const res = await request("/composition/dry-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rule: {
          name: "Inline Rule",
          conditionDsl: { all: [{ op: "text_contains", needle: "auth" }] },
          actionDsl: {
            op: "derive_fact",
            statementTemplate: "Auth pattern detected",
            kind: "inferred",
            baseConfidence: 0.7,
            sensitivity: "internal",
          },
        },
        hits: [{ id: "f-1", primitive: "fact", content: "auth token", score: 0.9 }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inferences).toHaveLength(1);
    expect(body.inferences[0].derivedStatement).toBe("Auth pattern detected");
    expect(body.inferences[0].type).toBe("fact");
    expect(body.ruleName).toBe("Inline Rule");
  });

  it("dry-runs a stored rule by ruleId", async () => {
    const { request } = makeApp({
      getCompositionRule: vi.fn(async () => BASE_RULE),
    });
    const res = await request("/composition/dry-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ruleId: "r-1",
        hits: [{ id: "f-1", primitive: "fact", content: "auth token", score: 0.9 }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ruleId).toBe("r-1");
  });

  it("returns 404 when ruleId not found", async () => {
    const { request } = makeApp({
      getCompositionRule: vi.fn(async () => null),
    });
    const res = await request("/composition/dry-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruleId: "nonexistent", hits: [] }),
    });
    expect(res.status).toBe(404);
  });
});
