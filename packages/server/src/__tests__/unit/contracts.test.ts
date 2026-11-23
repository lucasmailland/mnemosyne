/**
 * Contract tests — Wave V §36
 *
 * These tests verify that the Mnemosyne HTTP API returns JSON that conforms to
 * the schemas in packages/server/contracts/*.schema.json.
 *
 * Each test:
 *   1. Mounts a minimal Hono sub-router with a fake auth middleware and a
 *      mock StorageAdapter/Core stub.
 *   2. Issues an in-process HTTP request via `app.request()`.
 *   3. Validates the JSON body against the contract schema using a
 *      hand-rolled structural assertion (no external JSON Schema library
 *      required — we keep the test self-contained).
 *
 * Coverage: 7 core contract assertions × ~3 routes = 21 assertions.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { ForbiddenError } from "../../errors.js";
import { mountFacts } from "../../routes/facts.js";
import { mountWebhooks } from "../../routes/webhooks.js";
import { mountEpisodes } from "../../routes/episodes.js";
import { mountEntities } from "../../routes/entities.js";
import { createRateLimitMiddleware, type RateLimitBackend } from "../../ratelimit.js";
import { createIdempotencyMiddleware, type IdempotencyStore } from "../../idempotency.js";
import { toErrorBody } from "../../errors.js";
import { contractsDir, loadSchema, validate } from "../_schemaValidate.js";

// ── Minimal fake auth middleware ───────────────────────────────────────────────

function withFakeAuth(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  workspaceId = "ws_contract_test"
): void {
  app.use("*", async (c, next) => {
    c.set("workspaceId", workspaceId);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "contract-tester");
    c.set("actorType", "user");
    c.set("scopes", ["memory:read", "memory:write", "memory:export"]);
    await next();
  });
}

// ── Minimal StorageAdapter mock ────────────────────────────────────────────────

const now = new Date().toISOString(); // determinism-ok: throwaway fixture date, not asserted
const WS = "ws_contract_test";

function factRecord(id: string) {
  return {
    id,
    workspaceId: WS,
    agentId: null,
    actorId: null,
    sessionId: null,
    scope: "global" as const,
    scopeRef: null,
    statement: `Test statement ${id}`,
    subject: "test-subject",
    kind: "other" as const,
    confidence: 0.8,
    pinned: false,
    relevance: null,
    hitCount: 0,
    lastRecalledAt: null,
    sourceMessageIds: [],
    attributedTo: null,
    linkedMemoryIds: [],
    metadata: {},
    status: "active" as const,
    mergedIntoId: null,
    validFrom: new Date(now),
    validTo: null,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    worthAlpha: 1,
    worthBeta: 2,
    entityId: null,
    extractionSource: null,
    tags: [],
    sensitivity: "internal" as const,
    topicKey: null,
    lshBands: null,
  };
}

function webhookRecord(id: string) {
  return {
    id,
    workspaceId: WS,
    url: "https://example.com/webhook",
    events: ["fact.created"],
    isActive: true,
    secretHash: "test-secret",
    description: "Test webhook",
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

function buildMockStorage() {
  return {
    queryFacts: vi
      .fn()
      .mockResolvedValue({ items: [factRecord("fact_c1")], total: 1, offset: 0, limit: 20 }),
    // flatten-legacy-dual-core PR9b: GET /facts (list) ported off
    // deps.core.listFacts onto deps.storage.queryFactsPage (D6.3).
    queryFactsPage: vi
      .fn()
      .mockResolvedValue({ items: [factRecord("fact_c1")], nextCursor: null, total: 1 }),
    getFact: vi.fn().mockResolvedValue(factRecord("fact_c1")),
    createWebhookEndpoint: vi.fn().mockResolvedValue(webhookRecord("wh_c1")),
    listWebhookEndpoints: vi.fn().mockResolvedValue([webhookRecord("wh_c1")]),
    getWebhookEndpoint: vi.fn().mockResolvedValue(webhookRecord("wh_c1")),
    updateWebhookEndpoint: vi.fn().mockResolvedValue(webhookRecord("wh_c1")),
    deleteWebhookEndpoint: vi.fn().mockResolvedValue(undefined),
    listWebhookDeliveries: vi.fn().mockResolvedValue([]),
    recordWebhookDelivery: vi.fn().mockResolvedValue(undefined),
    appendAuditEntry: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Contract test suites ───────────────────────────────────────────────────────

describe("Contract: facts", () => {
  const factSchema = loadSchema("fact");
  let app: OpenAPIHono<{ Variables: AuthVariables }>;
  let mockStorage: ReturnType<typeof buildMockStorage>;

  beforeAll(() => {
    app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withFakeAuth(app);
    mockStorage = buildMockStorage();

    const deps = {
      storage: mockStorage,
      core: {
        recall: vi.fn().mockResolvedValue({ facts: [], episodes: [], skills: [] }),
        listFacts: vi.fn().mockResolvedValue({
          items: [factRecord("fact_c1")],
          total: 1,
          offset: 0,
          limit: 20,
        }),
        getFact: vi.fn().mockResolvedValue(factRecord("fact_c1")),
      },
    } as unknown as ServerDeps;

    mountFacts(app, deps);
  });

  it("GET /facts returns an array and each item matches fact schema", async () => {
    const res = await app.request("/facts", {
      headers: { Authorization: "Bearer test_key" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      const err = validate(item, factSchema);
      expect(err).toBeNull();
    }
  });

  it("fact response has required fields: id, workspaceId, scope, statement, subject, kind, confidence, createdAt, updatedAt", async () => {
    const res = await app.request("/facts", {
      headers: { Authorization: "Bearer test_key" },
    });
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    const item = body.items[0]!;
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("workspaceId");
    expect(item).toHaveProperty("scope");
    expect(item).toHaveProperty("statement");
    expect(item).toHaveProperty("subject");
    expect(item).toHaveProperty("kind");
    expect(item).toHaveProperty("confidence");
    expect(item).toHaveProperty("createdAt");
    expect(item).toHaveProperty("updatedAt");
  });

  it("confidence is a number between 0 and 1", async () => {
    const res = await app.request("/facts", {
      headers: { Authorization: "Bearer test_key" },
    });
    const body = (await res.json()) as { items: { confidence: number }[] };
    const item = body.items[0]!;
    expect(typeof item.confidence).toBe("number");
    expect(item.confidence).toBeGreaterThanOrEqual(0);
    expect(item.confidence).toBeLessThanOrEqual(1);
  });

  it("scope is one of the allowed values", async () => {
    const res = await app.request("/facts", {
      headers: { Authorization: "Bearer test_key" },
    });
    const body = (await res.json()) as { items: { scope: string }[] };
    const item = body.items[0]!;
    expect(["global", "conversation"]).toContain(item.scope);
  });
});

describe("Contract: webhooks", () => {
  let app: OpenAPIHono<{ Variables: AuthVariables }>;
  let mockStorage: ReturnType<typeof buildMockStorage>;

  beforeAll(() => {
    app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withFakeAuth(app);
    mockStorage = buildMockStorage();
    const deps = { storage: mockStorage } as unknown as ServerDeps;
    mountWebhooks(app, deps);
  });

  it("POST /webhooks returns 201 with id, url, events, isActive", async () => {
    const res = await app.request("/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook", events: ["fact.created"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("url");
    expect(body).toHaveProperty("events");
    expect(body).toHaveProperty("isActive");
    expect(body).toHaveProperty("secret"); // only on creation
    expect(typeof body["secret"]).toBe("string");
  });

  it("GET /webhooks returns items array", async () => {
    const res = await app.request("/webhooks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("webhook item has isActive boolean", async () => {
    const res = await app.request("/webhooks");
    const body = (await res.json()) as { items: { isActive: unknown }[] };
    if (body.items.length > 0) {
      expect(typeof body.items[0]!.isActive).toBe("boolean");
    }
  });

  it("p45 Slice C: POST /webhooks emits a create audit entry with resolveProvenance()'s actor", async () => {
    await app.request("/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook2", events: ["fact.created"] }),
    });
    expect(mockStorage.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        actorId: "key:contract-tester",
        actorType: "user",
        action: "create",
        resourceKind: "webhook_endpoint",
      })
    );
  });

  it("p45 Slice C: PATCH /webhooks/:id emits an update audit entry", async () => {
    await app.request("/webhooks/wh_c1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    expect(mockStorage.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update",
        resourceKind: "webhook_endpoint",
        resourceId: "wh_c1",
      })
    );
  });

  it("p45 Slice C: DELETE /webhooks/:id emits a delete audit entry", async () => {
    await app.request("/webhooks/wh_c1", { method: "DELETE" });
    expect(mockStorage.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "delete",
        resourceKind: "webhook_endpoint",
        resourceId: "wh_c1",
      })
    );
  });
});

// ── Episode contract tests ─────────────────────────────────────────────────

function episodeRecord(id: string) {
  return {
    id,
    workspaceId: WS,
    title: `Test episode ${id}`,
    narrative: "A test narrative.",
    occurredAt: now,
    durationMinutes: null,
    participants: [],
    topics: ["test"],
    linkedFactIds: [],
    sourceConversationId: null,
    sensitivity: "internal" as const,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    isSynthetic: false,
    agentId: null,
  };
}

describe("Contract: episodes", () => {
  const episodeSchema = loadSchema("episode");
  let app: OpenAPIHono<{ Variables: AuthVariables }>;

  beforeAll(() => {
    app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withFakeAuth(app);

    const ep = episodeRecord("mepi_c1");
    // flatten-legacy-dual-core PR15: GET /episodes/:id is now also ported
    // off the legacy core client onto deps.storage.getEpisode (task 6c.2) —
    // this fixture needs Date fields (what getEpisode actually returns),
    // unlike `ep` above (ISO strings, used by the list route which passes
    // items straight through to c.json without an explicit mapper).
    const epDomain = {
      ...ep,
      occurredAt: new Date(now),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
    const deps = {
      // flatten-legacy-dual-core PR10: GET /episodes ported off the legacy
      // core client onto deps.storage.queryEpisodes.
      storage: {
        ...buildMockStorage(),
        queryEpisodes: vi
          .fn()
          .mockResolvedValue({ items: [ep], total: 1, offset: 0, limit: 50, hasMore: false }),
        getEpisode: vi.fn().mockResolvedValue(epDomain),
        getFact: vi.fn().mockResolvedValue(null),
      },
    } as unknown as ServerDeps;

    mountEpisodes(app, deps);
  });

  it("GET /episodes returns array with id, workspaceId, title, narrative, occurredAt, isSynthetic, createdAt, updatedAt", async () => {
    const res = await app.request("/episodes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    const item = body.items[0]!;
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("workspaceId");
    expect(item).toHaveProperty("title");
    expect(item).toHaveProperty("narrative");
    expect(item).toHaveProperty("occurredAt");
    expect(item).toHaveProperty("isSynthetic");
    expect(item).toHaveProperty("createdAt");
    expect(item).toHaveProperty("updatedAt");
  });

  it("episode item conforms to episode.schema.json", async () => {
    const res = await app.request("/episodes");
    const body = (await res.json()) as { items: unknown[] };
    for (const item of body.items) {
      const err = validate(item, episodeSchema);
      expect(err).toBeNull();
    }
  });

  it("isSynthetic is a boolean", async () => {
    const res = await app.request("/episodes");
    const body = (await res.json()) as { items: { isSynthetic: unknown }[] };
    if (body.items.length > 0) {
      expect(typeof body.items[0]!.isSynthetic).toBe("boolean");
    }
  });

  it("GET /episodes/:id returns a single episode", async () => {
    const res = await app.request("/episodes/mepi_c1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { episode: Record<string, unknown>; linkedFacts: unknown[] };
    expect(body).toHaveProperty("episode");
    expect(body.episode).toHaveProperty("id", "mepi_c1");
    expect(body.episode).toHaveProperty("title");
    expect(body.episode).toHaveProperty("narrative");
  });
});

// ── Skill schema contract tests (no HTTP route — structural only) ────────────

describe("Contract: skill schema (structural)", () => {
  const skillSchema = loadSchema("skill");

  it("skill.schema.json has required fields: id, workspaceId, name, promptTemplate, createdAt, updatedAt", () => {
    const required = skillSchema["required"] as string[] | undefined;
    expect(required).toBeDefined();
    for (const field of ["id", "workspaceId", "name", "promptTemplate", "createdAt", "updatedAt"]) {
      expect(required).toContain(field);
    }
  });

  it("validate() accepts a valid skill object", () => {
    const skill = {
      id: "skill_abc",
      workspaceId: WS,
      name: "Test skill",
      promptTemplate: "You are a helpful assistant.",
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };
    const err = validate(skill, skillSchema);
    expect(err).toBeNull();
  });

  it("validate() rejects a skill missing promptTemplate", () => {
    const skill = {
      id: "skill_abc",
      workspaceId: WS,
      name: "Test skill",
      createdAt: now,
      updatedAt: now,
    };
    const err = validate(skill, skillSchema);
    expect(err).not.toBeNull();
    expect(err).toContain("promptTemplate");
  });
});

// Appended: task + event contract coverage (Phase 6.3)
describe("contract schemas — task + event", () => {
  it("task.schema.json exists and declares required fields", () => {
    const schema = JSON.parse(readFileSync(join(contractsDir, "task.schema.json"), "utf8"));
    expect(schema.required).toEqual(
      expect.arrayContaining(["id", "workspaceId", "title", "status"])
    );
  });
  it("event.schema.json exists and declares required fields", () => {
    const schema = JSON.parse(readFileSync(join(contractsDir, "event.schema.json"), "utf8"));
    expect(schema.required).toEqual(expect.arrayContaining(["id", "workspaceId", "type"]));
  });
});

describe("Contract: JSON Schema structural validator", () => {
  it("validate() passes a correct object", () => {
    const schema = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    } as Record<string, unknown>;
    expect(validate({ id: "abc" }, schema)).toBeNull();
  });

  it("validate() catches missing required field", () => {
    const schema = { type: "object", required: ["id", "name"], properties: {} } as Record<
      string,
      unknown
    >;
    const err = validate({ id: "abc" }, schema);
    expect(err).toContain("missing required property");
  });

  it("validate() catches wrong type", () => {
    const schema = { type: "string" } as Record<string, unknown>;
    const err = validate(42, schema);
    expect(err).toContain("expected type");
  });

  it("validate() accepts union type (string | null)", () => {
    const schema = { type: ["string", "null"] } as Record<string, unknown>;
    expect(validate(null, schema)).toBeNull();
    expect(validate("hello", schema)).toBeNull();
    expect(validate(42, schema)).not.toBeNull();
  });

  it("validate() checks enum membership", () => {
    const schema = { enum: ["a", "b", "c"] } as Record<string, unknown>;
    expect(validate("a", schema)).toBeNull();
    expect(validate("z", schema)).not.toBeNull();
  });

  it("validate() checks numeric range", () => {
    const schema = { type: "number", minimum: 0, maximum: 1 } as Record<string, unknown>;
    expect(validate(0.5, schema)).toBeNull();
    expect(validate(-0.1, schema)).not.toBeNull();
    expect(validate(1.1, schema)).not.toBeNull();
  });

  it("validate() traverses nested properties", () => {
    const schema = {
      type: "object",
      required: ["confidence"],
      properties: { confidence: { type: "number", minimum: 0, maximum: 1 } },
    } as Record<string, unknown>;
    expect(validate({ confidence: 0.8 }, schema)).toBeNull();
    expect(validate({ confidence: 2 }, schema)).not.toBeNull();
  });
});

// ── §36 Wave AC3 — HTTP-harness behavioral assertions ─────────────────────────
//
// These 3 tests complete the 7-assertion contract matrix:
//   ✓ schema_validates    (facts/episodes/webhooks describe blocks above)
//   ✓ required_fields     (above)
//   ✓ unknown_fields      (MCP contract.test.ts)
//   ✓ happy_path          (above)
//   + auth_scope_enforced → 403   (below)
//   + rate_limit_respected → 429  (below)
//   + idempotency_works           (below)

describe("Contract: HTTP-harness behavioral assertions (§36 Wave AC3)", () => {
  it("auth_scope_enforced — returns 403 when the required scope is absent", async () => {
    const app = new Hono();
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err);
      return c.json(body, status as Parameters<typeof c.json>[1]);
    });
    // Fake auth with NO scopes — mirrors a scoped mk_* key missing memory:read
    app.use("*", async (c, next) => {
      c.set("workspaceId" as never, "ws_scope_test");
      c.set("scopes" as never, [] as string[]);
      await next();
    });
    // Scope guard matches the real app.ts gate: throws ForbiddenError when scope absent
    app.use("*", async (c, next) => {
      const scopes = c.get("scopes" as never) as string[];
      if (!scopes.includes("memory:read")) {
        throw new ForbiddenError("API key scope insufficient: requires 'memory:read'");
      }
      return next();
    });
    app.get("/facts", (c) => c.json({ items: [] }));

    const res = await app.request("/facts");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("rate_limit_respected — returns 429 with Retry-After when the token bucket is exhausted", async () => {
    const exhausted: RateLimitBackend = {
      async consumeToken() {
        return { allowed: false, remaining: 0, resetSeconds: 30 };
      },
      async acquireSlot() {
        return { acquired: true, inFlight: 1 };
      },
      async releaseSlot() {},
      healthy: true,
    };
    const app = new Hono();
    app.onError((err, c) => {
      const { status, body } = toErrorBody(err);
      return c.json(body, status as Parameters<typeof c.json>[1]);
    });
    app.use("*", async (c, next) => {
      c.set("workspaceId" as never, "ws_rl_test");
      c.set("plan" as never, "free");
      await next();
    });
    app.use("*", createRateLimitMiddleware({ backend: exhausted }));
    app.get("/recall", (c) => c.json({ ok: true }));

    const res = await app.request("/recall");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });

  it("idempotency_works — POST with same Idempotency-Key replays stored response without re-executing", async () => {
    const rows = new Map<
      string,
      { requestHash: string; responseCode?: number; responseBody?: string; recoveryPoint: string }
    >();
    const store: IdempotencyStore = {
      async begin(workspaceId, key, requestHash) {
        const id = `${workspaceId}:${key}`;
        const existing = rows.get(id);
        if (!existing) {
          rows.set(id, { requestHash, recoveryPoint: "started" });
          return { state: "new" };
        }
        if (existing.requestHash !== requestHash) return { state: "mismatch" };
        if (existing.responseCode != null) {
          return {
            state: "replay",
            responseCode: existing.responseCode,
            responseBody: existing.responseBody!,
          };
        }
        return { state: "in_flight" };
      },
      async complete(workspaceId, key, code, body) {
        const row = rows.get(`${workspaceId}:${key}`);
        if (row) {
          row.responseCode = code;
          row.responseBody = body;
          row.recoveryPoint = "completed";
        }
      },
      async recordPhase(workspaceId, key, phase) {
        const row = rows.get(`${workspaceId}:${key}`);
        if (row) row.recoveryPoint = phase;
      },
      async getRecoveryPoint(workspaceId, key) {
        return (rows.get(`${workspaceId}:${key}`)?.recoveryPoint as never) ?? null;
      },
    };

    let callCount = 0;
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("workspaceId" as never, "ws_idem_test");
      await next();
    });
    app.use("*", createIdempotencyMiddleware({ store }));
    app.post("/facts", (c) => c.json({ ok: true, n: ++callCount }));

    const r1 = await app.request("/facts", {
      method: "POST",
      headers: { "Idempotency-Key": "idem-k1" },
      body: "{}",
    });
    const b1 = await r1.json();
    const r2 = await app.request("/facts", {
      method: "POST",
      headers: { "Idempotency-Key": "idem-k1" },
      body: "{}",
    });
    const b2 = await r2.json();

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(b2).toEqual(b1);
    expect(callCount).toBe(1); // handler executed exactly once
  });
});

// ── Completeness guard — every contract-locked entity group must have a schema ──────────────

// Core entity route groups whose response is contract-locked.
// Admin/ops endpoints without a canonical object shape are excluded (noted here).
const CONTRACT_LOCKED = [
  "fact",
  "episode",
  "event",
  "task",
  "skill",
  "entity",
  "decision",
  "reasoning",
  "hyperedge",
];

describe("contract completeness — every contract-locked entity has a schema", () => {
  it.each(CONTRACT_LOCKED)("%s.schema.json exists", (name) => {
    expect(existsSync(join(contractsDir, `${name}.schema.json`))).toBe(true);
  });
});

// ── Live route assertion: entity ───────────────────────────────────────────────

// flatten-legacy-dual-core PR9a: `listEntitiesRoute` now reads from
// `deps.storage.queryEntities` (v3 MnemoEntity, Date fields) instead of
// `deps.core.listEntities` — fixture switched from ISO-string `now` to a
// real `Date`, and gained `sensitivity`/`validFrom` (both required on
// `MnemoEntity`, silently absent from the pre-port fixture since the legacy
// route never ran it through `entityToWire()`'s `.toISOString()` calls).
function entityRecord(id: string) {
  return {
    id,
    workspaceId: WS,
    name: "Acme Corp",
    kind: "organization" as const,
    aliases: ["Acme"],
    canonicalId: undefined,
    description: undefined,
    sensitivity: "internal" as const,
    metadata: {},
    firstSeenAt: new Date(now),
    lastSeenAt: new Date(now),
    mentionCount: 3,
    validFrom: new Date(now),
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

describe("GET /entities — entity contract", () => {
  const entitySchema = loadSchema("entity");
  let app: OpenAPIHono<{ Variables: AuthVariables }>;

  beforeAll(() => {
    app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withFakeAuth(app);

    const ent = entityRecord("ment_c1");
    const deps = {
      storage: {
        ...buildMockStorage(),
        queryEntities: vi
          .fn()
          .mockResolvedValue({ items: [ent], total: 1, offset: 0, limit: 50, hasMore: false }),
        getEntity: vi.fn().mockResolvedValue(ent),
        queryFacts: vi
          .fn()
          .mockResolvedValue({ items: [], total: 0, offset: 0, limit: 100, hasMore: false }),
        createEntity: vi.fn().mockResolvedValue(ent),
        updateEntity: vi.fn().mockResolvedValue(ent),
        countEntityMentions: vi.fn().mockResolvedValue({}),
      },
      core: {},
    } as unknown as ServerDeps;

    mountEntities(app, deps);
  });

  it("GET /entities returns array and each item conforms to entity.schema.json", async () => {
    const res = await app.request("/entities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      const err = validate(item, entitySchema);
      expect(err).toBeNull();
    }
  });

  it("entity item has required fields: id, workspaceId, name, kind, createdAt, updatedAt", async () => {
    const res = await app.request("/entities");
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    const item = body.items[0]!;
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("workspaceId");
    expect(item).toHaveProperty("name");
    expect(item).toHaveProperty("kind");
    expect(item).toHaveProperty("createdAt");
    expect(item).toHaveProperty("updatedAt");
  });
});

// TODO(W0-followup): live route assertions for decision, reasoning, hyperedge.
// Schema contracts are locked above via the completeness guard.
// Live assertions require heavier mock setup (storage.listDecisions, storage.queryHyperedges,
// reasoning chain stubs) — deferred to a follow-up task to keep this PR focused.
