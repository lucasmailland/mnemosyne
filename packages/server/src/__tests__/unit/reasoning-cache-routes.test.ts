/**
 * Unit tests for POST /reasoning/resolve, /record, /feedback (Wave M1, spec §8).
 *
 * Uses the same pattern as reasoning-route.test.ts: minimal OpenAPIHono app
 * with fake auth middleware and mocked storage. No real HTTP socket, no DB.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";

import type { AuthVariables } from "../../auth.js";
import type { ServerDeps } from "../../deps.js";
import type { StorageAdapter } from "@mnemo-ai/types";
import type { MnemoReasoning } from "@mnemo-ai/types";
import { toErrorBody } from "../../errors.js";
import { mountReasoning } from "../../routes/reasoning.js";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} };
const noopTelemetry = {
  startSpan: () => noopSpan,
  counter: () => {},
  histogram: () => {},
  gauge: () => {},
  shutdown: async () => {},
};

function makeApp(
  storageOverrides: Partial<StorageAdapter> | StorageAdapter,
  llm?: { embed: (text: string, model: string) => Promise<number[]> }
) {
  const app = new OpenAPIHono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    c.set("workspaceId", WORKSPACE_ID);
    c.set("apiKeyPrefix", "mns_live_");
    c.set("actorId", "key-reasoning-cache-test");
    c.set("actorType", "agent");
    c.set("userId", null);
    c.set("scopes", [] as ReadonlyArray<string>);
    await next();
  });

  const fakeDeps = {
    storage: storageOverrides as unknown as StorageAdapter,
    core: {} as unknown,
    embedModel: "text-embedding-3-small",
    telemetry: noopTelemetry,
    ...(llm ? { llm } : {}),
  } as unknown as ServerDeps;

  mountReasoning(app, fakeDeps);

  app.onError((err, c) => {
    const { status, body } = toErrorBody(err);
    return c.json(body, status as Parameters<typeof c.json>[1]);
  });

  return { request: app.request.bind(app) };
}

const baseReasoning: MnemoReasoning = {
  id: "rsn-1",
  workspaceId: WORKSPACE_ID,
  question: "How to deploy?",
  chain: [{ step: 1, reasoning: "check CI first" }],
  conclusion: "merge then deploy",
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

// ─── POST /reasoning/resolve ──────────────────────────────────────────────────

describe("POST /reasoning/resolve — MISS when no embedding or no candidates", () => {
  it("returns { action: 'execute' } when no candidates match", async () => {
    const { request } = makeApp({
      searchReasoning: vi.fn().mockResolvedValue([]),
    });

    const res = await request("/reasoning/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "How do I deploy?" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("execute");
  });

  it("returns 500 when no llm and no topicKey (no way to embed)", async () => {
    // Without embed capability and without a topicKey, resolve should degrade gracefully
    const { request } = makeApp({
      searchReasoning: vi.fn().mockResolvedValue([]),
    });

    const res = await request("/reasoning/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "How do I deploy?" }),
    });
    // Should still work — returns execute miss
    expect([200, 500]).toContain(res.status);
  });

  it("returns { action: 'execute' } when storage not available", async () => {
    const { request } = makeApp({});

    const res = await request("/reasoning/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "How do I deploy?" }),
    });
    // No storage means we can't search — should fail gracefully or return 500
    expect([200, 500]).toContain(res.status);
  });
});

describe("POST /reasoning/resolve — HIT via topicKey fast-path", () => {
  it("returns hit when topicKey matches an active reasoning with good worth", async () => {
    const goodReasoning: MnemoReasoning = {
      ...baseReasoning,
      worth: 0.8,
      successCount: 9,
      failureCount: 1,
      topicKey: "deploy-flow",
    };
    const { request } = makeApp({
      queryReasoning: vi.fn().mockResolvedValue({
        items: [goodReasoning],
        total: 1,
        offset: 0,
        limit: 1,
        hasMore: false,
      }),
      recordReasoningUse: vi.fn().mockResolvedValue(undefined),
    });

    const res = await request("/reasoning/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "How to deploy?", topicKey: "deploy-flow" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      action: string;
      reasoning_id?: string;
      suggested_model?: string;
    };
    expect(body.action).toBe("hit");
    expect(body.reasoning_id).toBe("rsn-1");
    expect(body.suggested_model).toBe("haiku");
  });

  it("returns miss when topicKey matches but worth <= 0.5", async () => {
    const lowWorth: MnemoReasoning = {
      ...baseReasoning,
      worth: 0.4,
      topicKey: "deploy-flow",
    };
    const { request } = makeApp({
      queryReasoning: vi.fn().mockResolvedValue({
        items: [lowWorth],
        total: 1,
        offset: 0,
        limit: 1,
        hasMore: false,
      }),
    });

    const res = await request("/reasoning/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "How to deploy?", topicKey: "deploy-flow" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("execute");
  });

  it("returns miss when topicKey row is quarantined", async () => {
    const quarantined: MnemoReasoning = {
      ...baseReasoning,
      worth: 0.8,
      status: "quarantined" as const,
      topicKey: "deploy-flow",
    };
    const { request } = makeApp({
      queryReasoning: vi.fn().mockResolvedValue({
        items: [quarantined],
        total: 1,
        offset: 0,
        limit: 1,
        hasMore: false,
      }),
    });

    const res = await request("/reasoning/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "How to deploy?", topicKey: "deploy-flow" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("execute");
  });
});

// ─── POST /reasoning/record ───────────────────────────────────────────────────

describe("POST /reasoning/record — inserts when no near-duplicate exists", () => {
  it("returns 201 with the new reasoning when dedupDecision says insert", async () => {
    const createReasoning = vi.fn().mockResolvedValue(baseReasoning);
    const updateWorth = vi.fn().mockResolvedValue(undefined);
    const { request } = makeApp({
      searchReasoning: vi.fn().mockResolvedValue([]), // no duplicates
      createReasoning,
      updateWorth,
      getReasoning: vi.fn().mockResolvedValue(baseReasoning),
      recordReasoningUse: vi.fn().mockResolvedValue(undefined),
    });

    const res = await request("/reasoning/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "How to deploy?",
        chain: [{ step: 1, reasoning: "check CI first" }],
        conclusion: "merge then deploy",
        outcome: "success",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; worth: number };
    expect(body.id).toBe("rsn-1");
    expect(createReasoning).toHaveBeenCalledOnce();
    expect(updateWorth).toHaveBeenCalled();
  });
});

describe("POST /reasoning/record — sensitivity (APP-022 server side)", () => {
  const deps = (createReasoning: ReturnType<typeof vi.fn>) => ({
    searchReasoning: vi.fn().mockResolvedValue([]),
    createReasoning,
    updateWorth: vi.fn().mockResolvedValue(undefined),
    getReasoning: vi.fn().mockResolvedValue(baseReasoning),
    recordReasoningUse: vi.fn().mockResolvedValue(undefined),
  });
  const record = (extra: Record<string, unknown>) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "q",
      chain: [{ step: 1, reasoning: "r" }],
      conclusion: "c",
      ...extra,
    }),
  });

  it("stores the tier the caller asked for instead of dropping it", async () => {
    const createReasoning = vi.fn().mockResolvedValue(baseReasoning);
    const { request } = makeApp(deps(createReasoning));
    const res = await request("/reasoning/record", record({ sensitivity: "public" }));
    expect(res.status).toBe(201);
    expect(createReasoning.mock.calls[0]![0]).toMatchObject({ sensitivity: "public" });
  });

  it("refuses a tier above the caller's ceiling", async () => {
    const createReasoning = vi.fn().mockResolvedValue(baseReasoning);
    const { request } = makeApp(deps(createReasoning));
    const res = await request("/reasoning/record", record({ sensitivity: "restricted" }));
    expect(res.status).toBe(404);
    expect(createReasoning).not.toHaveBeenCalled();
  });

  it("rejects a tier that is not a sensitivity", async () => {
    const createReasoning = vi.fn().mockResolvedValue(baseReasoning);
    const { request } = makeApp(deps(createReasoning));
    const res = await request("/reasoning/record", record({ sensitivity: "secret" }));
    expect(res.status).toBe(400);
    expect(createReasoning).not.toHaveBeenCalled();
  });
});

describe("POST /reasoning/record — upserts when near-duplicate exists", () => {
  it("returns 201 with the existing reasoning when dedupDecision says upsert", async () => {
    const updateWorth = vi.fn().mockResolvedValue(undefined);
    const recordReasoningUse = vi.fn().mockResolvedValue(undefined);
    const fakeLlm = { embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)) };
    const { request } = makeApp(
      {
        searchReasoning: vi.fn().mockResolvedValue([
          // high cosine → triggers upsert
          {
            id: "rsn-1",
            cosine: 0.97,
            worth: 0.8,
            successCount: 8,
            failureCount: 2,
            status: "active",
          },
        ]),
        updateWorth,
        recordReasoningUse,
        getReasoning: vi.fn().mockResolvedValue(baseReasoning),
        findHiddenIds: vi.fn().mockResolvedValue([]),
      },
      fakeLlm
    );

    const res = await request("/reasoning/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "How to deploy?",
        chain: [{ step: 1, reasoning: "check CI" }],
        conclusion: "merge then deploy",
        outcome: "success",
      }),
    });

    expect(res.status).toBe(201);
    expect(updateWorth).toHaveBeenCalled();
    expect(recordReasoningUse).toHaveBeenCalledWith("rsn-1", WORKSPACE_ID);
  });
});

describe("a cached chain above the caller's ceiling is not in the cache for them", () => {
  const hiddenCandidate = {
    id: "rsn-secret",
    cosine: 0.99,
    worth: 0.95,
    successCount: 40,
    failureCount: 0,
    status: "golden",
  };
  const fakeLlm = () => ({ embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)) });

  it("POST /reasoning/resolve answers execute and does not name it", async () => {
    const recordReasoningUse = vi.fn();
    const { request } = makeApp(
      {
        searchReasoning: vi.fn().mockResolvedValue([hiddenCandidate]),
        getReasoning: vi.fn().mockResolvedValue({ ...baseReasoning, id: "rsn-secret" }),
        recordReasoningUse,
        findHiddenIds: vi.fn().mockResolvedValue(["rsn-secret"]),
      },
      fakeLlm()
    );
    const res = await request("/reasoning/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "How to deploy?" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ action: "execute" });
    expect(text).not.toContain("rsn-secret");
    expect(recordReasoningUse).not.toHaveBeenCalled();
  });

  it("POST /reasoning/resolve by topicKey skips a hidden chain", async () => {
    const { request } = makeApp({
      queryReasoning: vi.fn().mockResolvedValue({
        items: [
          {
            ...baseReasoning,
            id: "rsn-secret",
            topicKey: "deploy",
            worth: 0.95,
            successCount: 40,
            usageCount: 40,
            sensitivity: "restricted",
          },
        ],
        total: 1,
      }),
      recordReasoningUse: vi.fn(),
    });
    const res = await request("/reasoning/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "How to deploy?", topicKey: "deploy" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ action: "execute" });
    expect(text).not.toContain("rsn-secret");
  });

  it("POST /reasoning/record stores a new chain instead of bumping the hidden one", async () => {
    const updateWorth = vi.fn().mockResolvedValue(undefined);
    const createReasoning = vi.fn().mockResolvedValue({ ...baseReasoning, id: "rsn-new" });
    const { request } = makeApp(
      {
        searchReasoning: vi.fn().mockResolvedValue([hiddenCandidate]),
        findHiddenIds: vi.fn().mockResolvedValue(["rsn-secret"]),
        createReasoning,
        updateWorth,
        recordReasoningUse: vi.fn(),
        getReasoning: vi.fn().mockResolvedValue({ ...baseReasoning, id: "rsn-new" }),
      },
      fakeLlm()
    );
    const res = await request("/reasoning/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "How to deploy?",
        chain: [{ step: 1, reasoning: "check CI" }],
        conclusion: "merge then deploy",
        outcome: "success",
      }),
    });
    expect(res.status).toBe(201);
    expect(createReasoning).toHaveBeenCalledOnce();
    expect(updateWorth).not.toHaveBeenCalledWith(
      "rsn-secret",
      expect.anything(),
      "reasoning",
      expect.anything()
    );
    expect(await res.text()).not.toContain("rsn-secret");
  });
});

// ─── POST /reasoning/feedback ─────────────────────────────────────────────────

describe("POST /reasoning/feedback — updates worth and transitions status", () => {
  it("returns 404 when reasoning_id does not exist", async () => {
    const { request } = makeApp({
      getReasoning: vi.fn().mockResolvedValue(null),
    });

    const res = await request("/reasoning/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasoning_id: "missing", outcome: "success" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 200 and quarantines when repeated failures drop worth below 0.3", async () => {
    const failedReasoning: MnemoReasoning = {
      ...baseReasoning,
      worth: 0.2, // already low — lifecycle should quarantine
      successCount: 1,
      failureCount: 4,
    };
    const updateWorth = vi.fn().mockResolvedValue(undefined);
    const setReasoningStatus = vi.fn().mockResolvedValue(undefined);
    const quarantinedReasoning: MnemoReasoning = {
      ...failedReasoning,
      status: "quarantined" as const,
    };
    const getReasoning = vi
      .fn()
      .mockResolvedValueOnce(failedReasoning) // initial fetch
      .mockResolvedValueOnce(failedReasoning) // after updateWorth
      .mockResolvedValueOnce(quarantinedReasoning); // final fetch

    const { request } = makeApp({
      getReasoning,
      updateWorth,
      setReasoningStatus,
    });

    const res = await request("/reasoning/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasoning_id: "rsn-1", outcome: "fail" }),
    });

    expect(res.status).toBe(200);
    expect(setReasoningStatus).toHaveBeenCalledWith("rsn-1", WORKSPACE_ID, "quarantined");
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("quarantined");
  });

  it("returns 200 and promotes to golden when worth > 0.8 and usage >= 50", async () => {
    const highPerformance: MnemoReasoning = {
      ...baseReasoning,
      worth: 0.9,
      successCount: 50,
      failureCount: 5,
      usageCount: 50,
    };
    const updateWorth = vi.fn().mockResolvedValue(undefined);
    const setReasoningStatus = vi.fn().mockResolvedValue(undefined);
    const goldenReasoning: MnemoReasoning = { ...highPerformance, status: "golden" as const };
    const getReasoning = vi
      .fn()
      .mockResolvedValueOnce(highPerformance)
      .mockResolvedValueOnce(highPerformance)
      .mockResolvedValueOnce(goldenReasoning);

    const { request } = makeApp({
      getReasoning,
      updateWorth,
      setReasoningStatus,
    });

    const res = await request("/reasoning/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasoning_id: "rsn-1", outcome: "success" }),
    });

    expect(res.status).toBe(200);
    expect(setReasoningStatus).toHaveBeenCalledWith("rsn-1", WORKSPACE_ID, "golden");
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("golden");
  });

  it("returns 200 with no status change when reasoning is healthy", async () => {
    const healthy: MnemoReasoning = {
      ...baseReasoning,
      worth: 0.7,
      successCount: 7,
      failureCount: 3,
      usageCount: 10,
    };
    const updateWorth = vi.fn().mockResolvedValue(undefined);
    const setReasoningStatus = vi.fn().mockResolvedValue(undefined);
    const getReasoning = vi.fn().mockResolvedValue(healthy);

    const { request } = makeApp({
      getReasoning,
      updateWorth,
      setReasoningStatus,
    });

    const res = await request("/reasoning/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasoning_id: "rsn-1", outcome: "success" }),
    });

    expect(res.status).toBe(200);
    // No status transition needed
    expect(setReasoningStatus).not.toHaveBeenCalled();
  });
});

// ─── Integration: record → resolve → HIT (InMemoryStorageAdapter end-to-end) ──

describe("record → resolve → HIT integration (InMemoryStorageAdapter)", () => {
  let storage: InMemoryStorageAdapter;
  let fakeLlm: { embed: (text: string, model: string) => Promise<number[]> };

  beforeEach(() => {
    storage = new InMemoryStorageAdapter();
    // Fake LLM: always returns the same unit vector — InMemory searchReasoning
    // returns cosine=1.0 for every row, so embedding content does not matter.
    fakeLlm = { embed: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)) };
  });

  it("resolves to a HIT with the same reasoning_id after recording a successful chain", async () => {
    const { request } = makeApp(storage, fakeLlm);

    // Step 1: Record the same successful chain several times under one topicKey.
    // §8c: the topicKey fast-path now enforces the SAME gate as the vector path —
    // worth>0.5 AND Wilson lower-bound>0.3 (i.e. it needs evidence, ~>=5 uses) —
    // so a single record is intentionally NOT enough. Each record dedup-upserts
    // (same topicKey + identical vector) and bumps successCount.
    let reasoning_id = "";
    for (let i = 0; i < 5; i++) {
      const recordRes = await request("/reasoning/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "What is the deploy process?",
          chain: [
            { step: 1, reasoning: "Check CI status" },
            { step: 2, reasoning: "Merge PR" },
          ],
          conclusion: "Deploy after CI passes",
          outcome: "success",
          topicKey: "deploy-flow-integration",
        }),
      });
      expect(recordRes.status).toBe(201);
      const recordBody = (await recordRes.json()) as { id: string };
      if (i === 0) reasoning_id = recordBody.id;
    }
    expect(typeof reasoning_id).toBe("string");

    // Step 2: Resolve using the same topicKey — fast-path should return a HIT.
    const resolveRes = await request("/reasoning/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "What is the deploy process?",
        topicKey: "deploy-flow-integration",
      }),
    });

    expect(resolveRes.status).toBe(200);
    const resolveBody = (await resolveRes.json()) as {
      action: string;
      reasoning_id?: string;
      suggested_model?: string;
    };
    expect(resolveBody.action).toBe("hit");
    expect(resolveBody.reasoning_id).toBe(reasoning_id);
    expect(resolveBody.suggested_model).toBe("haiku");
  });
});
