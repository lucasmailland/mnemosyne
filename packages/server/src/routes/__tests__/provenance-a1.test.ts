/**
 * p45 Slice A1 — route-local resolveProvenance() wiring.
 *
 * Covers spec scenario "Episode/reasoning/capture write carries real
 * provenance" for episodes.ts and reasoning.ts, and "Review resolution
 * replaces synthetic identity" for review.ts. Pattern mirrors
 * entities-link-user.test.ts: a minimal OpenAPIHono app + fake auth
 * middleware that sets actorId/userId/actorType directly on context, driven
 * via app.request() — no socket, no DB.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi } from "vitest";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import { toErrorBody } from "../../errors.js";
import { mountEpisodes } from "../episodes.js";
import { mountReasoning } from "../reasoning.js";
import { mountReview } from "../review.js";

const WS = "22222222-2222-2222-2222-222222222222";
const RAW_ACTOR_ID = "key-a1-test-id";
const USER_ID = "user-a1-test";

function withAuth(app: OpenAPIHono<{ Variables: AuthVariables }>): void {
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", RAW_ACTOR_ID);
    c.set("actorType", "user");
    c.set("userId", USER_ID);
    c.set("scopes", ["memory:write"]);
    await next();
  });
}

function withErrors(app: OpenAPIHono<{ Variables: AuthVariables }>): void {
  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });
}

describe("POST /episodes — carries real provenance (spec: Episode write carries real provenance)", () => {
  it("passes resolveProvenance(c)'s actorId/userId/actorType into createEpisode, never a placeholder", async () => {
    const createEpisode = vi.fn(async (input: Record<string, unknown>) => ({
      id: "mepi_test",
      workspaceId: input.workspaceId,
      title: input.title,
      narrative: input.narrative,
      occurredAt: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      durationMinutes: null,
      participants: [],
      topics: [],
      linkedFactIds: [],
      sourceConversationId: null,
      sensitivity: "internal",
      metadata: {},
      createdAt: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      updatedAt: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      isSynthetic: false,
    }));
    const deps = { storage: { createEpisode } } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountEpisodes(app, deps);
    withErrors(app);

    const res = await app.request("/episodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", narrative: "n" }),
    });

    expect(res.status).toBe(201);
    expect(createEpisode).toHaveBeenCalledTimes(1);
    const call = createEpisode.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(call.userId).toBe(USER_ID);
    expect(call.actorType).toBe("user");
  });
});

describe("POST /reasoning — carries real provenance (spec: reasoning write carries real provenance)", () => {
  it("passes resolveProvenance(c)'s triple into createReasoning", async () => {
    const createReasoning = vi.fn(async (input: Record<string, unknown>) => ({
      id: "reas_test",
      workspaceId: input.workspaceId,
      question: input.question,
      chain: input.chain,
      conclusion: input.conclusion,
      successCount: 0,
      failureCount: 0,
      worth: 0.5,
      status: "active",
      sensitivity: "internal",
      usageCount: 0,
      validFrom: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      createdAt: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      updatedAt: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      metadata: {},
    }));
    const deps = { storage: { createReasoning } } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountReasoning(app, deps);
    withErrors(app);

    const res = await app.request("/reasoning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "why?",
        chain: [{ step: 0, reasoning: "because" }],
        conclusion: "done",
      }),
    });

    expect(res.status).toBe(201);
    expect(createReasoning).toHaveBeenCalledTimes(1);
    const call = createReasoning.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(call.userId).toBe(USER_ID);
    expect(call.actorType).toBe("user");
  });
});

describe("POST /reasoning/record (insert branch only) — carries real provenance", () => {
  it("passes the triple into createReasoning when no near-duplicate exists (insert, not upsert)", async () => {
    const createReasoning = vi.fn(async (input: Record<string, unknown>) => ({
      id: "reas_record_test",
      workspaceId: input.workspaceId,
      question: input.question,
      chain: input.chain,
      conclusion: input.conclusion,
      successCount: 0,
      failureCount: 0,
      worth: 0.5,
      status: "active",
      sensitivity: "internal",
      usageCount: 0,
      validFrom: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      createdAt: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      updatedAt: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      metadata: {},
    }));
    const getReasoning = vi.fn(async () => ({
      id: "reas_record_test",
      workspaceId: WS,
      question: "q",
      chain: [{ step: 0, reasoning: "r" }],
      conclusion: "c",
      successCount: 0,
      failureCount: 0,
      worth: 0.5,
      status: "active",
      sensitivity: "internal",
      usageCount: 0,
      validFrom: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      createdAt: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      updatedAt: new Date(), // determinism-ok: filler timestamp on a mock fixture, never asserted
      metadata: {},
    }));
    const updateWorth = vi.fn(async () => {});
    // No deps.llm → searchReasoning is never called → candidates stays [] →
    // dedupDecision([]) returns { action: "insert" }, exercising the insert
    // branch (never the upsert branch, which this task must NOT touch).
    const deps = {
      storage: { createReasoning, getReasoning, updateWorth },
    } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountReasoning(app, deps);
    withErrors(app);

    const res = await app.request("/reasoning/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "why record?",
        chain: [{ step: 0, reasoning: "because" }],
        conclusion: "recorded",
      }),
    });

    expect(res.status).toBe(201);
    expect(createReasoning).toHaveBeenCalledTimes(1);
    const call = createReasoning.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.actorId).toBe(`key:${RAW_ACTOR_ID}`);
    expect(call.userId).toBe(USER_ID);
    expect(call.actorType).toBe("user");
  });
});

describe("POST /review/{id}/resolve — replaces synthetic identity (spec: Review resolution replaces synthetic identity)", () => {
  it("calls core.resolveReview with resolvedBy = resolveProvenance(c).actorId, never `apikey:<workspaceId>`", async () => {
    const resolveReview = vi.fn(async () => ({
      resolved: true,
      factId: "mfact_test",
      decisionId: null,
      cascaded: false,
    }));
    // flatten-legacy-dual-core PR10: review.ts ported off deps.core.
    const deps = {
      storage: { resolveActiveLearningReview: resolveReview },
    } as unknown as ServerDeps;

    const app = new OpenAPIHono<{ Variables: AuthVariables }>();
    withAuth(app);
    mountReview(app, deps);
    withErrors(app);

    const res = await app.request("/review/mrev_test0000000000000000000/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution: "kept" }),
    });

    expect(res.status).toBe(200);
    expect(resolveReview).toHaveBeenCalledTimes(1);
    const call = resolveReview.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.resolvedBy).toBe(`key:${RAW_ACTOR_ID}`);
    expect(call.resolvedBy).not.toBe(`apikey:${WS}`);
    expect(call).not.toHaveProperty("resolvedByUserId");
  });
});

// Task 1.5 — grep-assert zero synthetic-identity literals remain in the 3
// wired route files.
describe("no synthetic identity literals remain in the Slice A1 route files", () => {
  const files = ["episodes.ts", "reasoning.ts", "review.ts"];

  it.each(files)("%s contains no `apikey:` / `mns_live_` fallback literals", (file) => {
    const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/apikey:/);
    expect(source).not.toMatch(/mns_live_/);
    expect(source).not.toMatch(/resolvedByUserId/);
  });
});
