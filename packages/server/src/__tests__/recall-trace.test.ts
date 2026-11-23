/**
 * POST /recall `debug: true` forwards into the core query and copies the core's
 * `debug.trace` into the response; without it nothing is added.
 */
import { describe, it, expect, vi } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { RecallQuery, RecallResponse } from "@mnemo-ai/types";
import { mountRecall } from "../routes/recall.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_recalltracetest0000001";
const WS_ID = "00000000-0000-0000-0000-000000000018";

const TRACE = [
  { name: "vector", candidatesIn: 5, candidatesOut: 4, ms: 1.5 },
  { name: "response", candidatesIn: 2, candidatesOut: 2, ms: 0.1 },
];

async function makeApp(seen: RecallQuery[]) {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [
      { id: "key001", keyHash, workspaceId: WS_ID, scopes: ["memory:read"], plan: "free" },
    ],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const cognitive = {
    recall: async (q: RecallQuery): Promise<RecallResponse> => {
      seen.push(q);
      return {
        hits: [],
        total: 0,
        query: { text: q.text, limit: q.limit ?? 10, offset: q.offset ?? 0 },
        latencyMs: 1,
        fromHotTier: false,
        searchMode: "vector",
        debug: {
          modeRequested: "auto",
          modeUsed: "auto",
          tiersConsulted: ["cold"],
          cacheHit: false,
          fallback: false,
          ...(q.debug === true ? { trace: TRACE } : {}),
        },
      };
    },
  } as unknown as NonNullable<ServerDeps["cognitive"]>;
  return buildMountHarness(
    { apiKeys, embedModel: "text-embedding-3-small", cognitive } as unknown as ServerDeps,
    [mountRecall]
  );
}

const post = (app: Awaited<ReturnType<typeof makeApp>>, body: object) =>
  app.request("/recall", {
    method: "POST",
    headers: { authorization: `Bearer ${PLAINTEXT_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /recall — debug.trace", () => {
  it("returns debug.trace from the core when the request has debug: true", async () => {
    const seen: RecallQuery[] = [];
    const res = await post(await makeApp(seen), { query: "coffee", debug: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { debug: { trace?: unknown } };
    expect(seen[0]!.debug).toBe(true);
    expect(body.debug.trace).toEqual(TRACE);
  });

  it("has no trace key without debug, and does not forward it", async () => {
    const seen: RecallQuery[] = [];
    const app = await makeApp(seen);
    for (const extra of [{}, { debug: false }]) {
      const res = await post(app, { query: "coffee", ...extra });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { debug: Record<string, unknown> };
      expect("trace" in body.debug).toBe(false);
    }
    expect(seen.every((q) => q.debug === undefined)).toBe(true);
  });
});

// C1, end to end: the real core behind the route, a vector port that returns a
// restricted memory (it has no ceiling), and keys with and without memory:admin.
import { createCore } from "@mnemo-ai/core/cognitive";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import type { EmbedAdapter, OutboxAdapter, RecallTraceStage, VectorAdapter } from "@mnemo-ai/types";

async function realCoreApp(scopes: string[]) {
  const storage = new InMemoryStorageAdapter();
  const seed = (statement: string, sensitivity: string) =>
    storage.createFact({
      workspaceId: WS_ID,
      statement,
      kind: "fact",
      sensitivity,
      attribution: "user_stated",
      worth: 0.9,
    } as never);
  const visible = await seed("coffee beans come from Huila", "internal");
  const hidden = await seed("coffee supplier contract terms", "restricted");
  const vector = {
    upsert: async () => undefined,
    delete: async () => undefined,
    search: async () =>
      [visible, hidden].map((f) => ({ id: f.id, score: 0.9, primitiveKind: "fact" })),
  } as unknown as VectorAdapter;
  const unit = () => new Float32Array([1, 0, 0]);
  const embed = {
    model: "stub-embed",
    dimensions: 3,
    embed: async (texts: string[]) => texts.map(unit),
    embedSingle: async () => unit(),
  } as unknown as EmbedAdapter;
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
  const core = createCore({
    storage: storage as never,
    vector,
    embed,
    outbox: { append: async () => undefined } as unknown as OutboxAdapter,
    logger: quiet as never,
    telemetry: {
      startSpan: () => ({ end() {}, setAttribute() {}, recordException() {}, addEvent() {} }),
      histogram() {},
      counter() {},
      gauge() {},
    } as never,
  });
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  const apiKeys = {
    listActive: async () => [{ id: "key001", keyHash, workspaceId: WS_ID, scopes, plan: "free" }],
    touch: async () => {},
  } as unknown as ApiKeyLookup;
  const app = buildMountHarness(
    { apiKeys, embedModel: "stub-embed", cognitive: core } as unknown as ServerDeps,
    [mountRecall]
  );
  return { app, hidden };
}

async function tracedRecall(scopes: string[]) {
  const { app, hidden } = await realCoreApp(scopes);
  const res = await post(app as never, { query: "coffee", debug: true, minSimilarity: 0.5 });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    hits: Array<{ id: string }>;
    debug: { trace: RecallTraceStage[] };
  };
  return { body, hidden, stage: (n: string) => body.debug.trace.find((s) => s.name === n) };
}

describe("POST /recall — debug.trace above the caller's ceiling", () => {
  it("a read key sees null counts before eligibility and an eligibility count without the hidden hit", async () => {
    const { body, hidden, stage } = await tracedRecall(["memory:read"]);
    expect(body.hits.map((h) => h.id)).not.toContain(hidden.id);
    expect(stage("vector")).toMatchObject({ candidatesIn: null, candidatesOut: null });
    expect(stage("fusion")).toMatchObject({ candidatesIn: null, candidatesOut: null });
    expect(stage("eligibility")).toMatchObject({ candidatesIn: 1, candidatesOut: 1 });
  });

  it("an admin key whose effective ceiling admits every tier still sees the raw counts", async () => {
    // The env ceiling (default internal) caps admin keys too.
    vi.stubEnv("MNEMO_SENSITIVITY_CEILING", "restricted");
    try {
      const { stage } = await tracedRecall(["memory:read", "memory:admin"]);
      expect(stage("vector")).toMatchObject({ candidatesIn: 2, candidatesOut: 2 });
      expect(stage("eligibility")).toMatchObject({ candidatesIn: 2, candidatesOut: 2 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("an admin key under the default env ceiling is a limited caller", async () => {
    const { stage } = await tracedRecall(["memory:read", "memory:admin"]);
    expect(stage("vector")).toMatchObject({ candidatesIn: null, candidatesOut: null });
    expect(stage("eligibility")).toMatchObject({ candidatesIn: 1, candidatesOut: 1 });
  });
});
