/**
 * WP-3 — the POST /recall relevance contract that WP-8 (MCP) and WP-10 (hooks)
 * render: per hit `kind`, `topicKey`, `subject`, `scopeRef`, `status`,
 * `similarity`, `trust`, `injectionScore`; per response `nothingRelevant`.
 *
 * PRIM-9 / AGENTSIM-4: the wire mapper dropped the primitive kind and every
 * identity field, so a stale value and the current one looked the same and a
 * decision could not be told from a fact. SEC-3: it also dropped the injection
 * score, and nothing said a hit was untrusted data. RECALL-3 / AGENTSIM-15:
 * no "nothing relevant" signal.
 */
import { afterEach, describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { RecallHit, RecallQuery, RecallResponse } from "@mnemo-ai/types";
import { mountRecall } from "../routes/recall.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_recallcontracttest000001";
const WS_ID = "00000000-0000-0000-0000-0000000000c3";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "key-c3", keyHash, workspaceId: WS_ID, scopes: [], plan: "free" },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

const authed = () => ({
  authorization: `Bearer ${PLAINTEXT_KEY}`,
  "content-type": "application/json",
});

const LONG = "x".repeat(400);

function hit(overrides: Partial<RecallHit> & { id: string }): RecallHit {
  return {
    primitive: "fact",
    content: "content",
    score: 0.8,
    sensitivity: "internal",
    injectionScore: 0,
    provenance: "user_stated",
    origin: "local",
    contested: false,
    validFrom: new Date("2026-10-01T00:00:00Z"),
    validTo: null,
    tags: [],
    relations: [],
    ...overrides,
  } as RecallHit;
}

async function call(
  response: Partial<RecallResponse>,
  body: Record<string, unknown> = {},
  capture: { q?: RecallQuery } = {}
) {
  const deps = {
    core: { recall: async () => [] } as unknown as ServerDeps["core"],
    apiKeys: await makeKeyLookup(),
    cognitive: {
      recall: async (q: RecallQuery) => {
        capture.q = q;
        return {
          hits: [],
          total: 0,
          query: { text: "q", limit: 10, offset: 0 },
          latencyMs: 0,
          fromHotTier: false,
          ...response,
        };
      },
    },
  } as unknown as ServerDeps;
  const app = buildMountHarness(deps, [mountRecall]);
  const res = await app.request("/recall", {
    method: "POST",
    headers: authed(),
    body: JSON.stringify({ query: "who owns billing", ...body }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    hits: Array<Record<string, unknown>>;
    nothingRelevant: boolean;
    debug?: Record<string, unknown>;
  };
}

describe("POST /recall — WP-3 hit contract", () => {
  const hits = [
    hit({
      id: "d1",
      primitive: "decision",
      content: LONG,
      similarity: 0.71,
      topicKey: "ledgerly/eventing",
      scopeRef: "ledgerly",
      status: "active",
      injectionScore: 0.12,
    }),
    hit({
      id: "f1",
      similarity: 0.66,
      topicKey: "ledgerly/billing-owner",
      subject: "billing-ownership",
      scopeRef: "ledgerly",
      status: "contested",
      contested: true,
    }),
  ];

  for (const projection of ["full", "compact"] as const) {
    it(`carries kind, identity, status, similarity and trust (${projection})`, async () => {
      const body = await call({ hits }, { projection });

      expect(body.hits[0]).toMatchObject({
        id: "d1",
        kind: "decision",
        similarity: 0.71,
        topicKey: "ledgerly/eventing",
        scopeRef: "ledgerly",
        status: "active",
        trust: "untrusted",
        injectionScore: 0.12,
      });
      expect(body.hits[1]).toMatchObject({
        id: "f1",
        kind: "fact",
        subject: "billing-ownership",
        topicKey: "ledgerly/billing-owner",
        status: "contested",
        trust: "untrusted",
        injectionScore: 0,
      });
      if (projection === "compact") expect(body.hits[0]!.truncated).toBe(true);
    });
  }

  it("omits fields a hit does not have instead of sending nulls", async () => {
    const body = await call({ hits: [hit({ id: "lex-1" })] });
    expect(body.hits[0]).not.toHaveProperty("similarity");
    expect(body.hits[0]).not.toHaveProperty("topicKey");
    expect(body.hits[0]).not.toHaveProperty("subject");
    // The trust label never depends on what was stored.
    expect(body.hits[0]!.trust).toBe("untrusted");
  });
});

describe("POST /recall — nothingRelevant", () => {
  it("forwards the core's judgement", async () => {
    const weak = await call({
      hits: [hit({ id: "f1", similarity: 0.31 })],
      nothingRelevant: true,
      debug: {
        modeRequested: "auto",
        modeUsed: "auto",
        tiersConsulted: ["auto", "cold"],
        cacheHit: false,
        fallback: false,
        relevanceFloor: 0.5,
      },
    });
    expect(weak.nothingRelevant).toBe(true);
    expect(weak.hits).toHaveLength(1);
    expect(weak.debug?.relevanceFloor).toBe(0.5);

    expect(
      (await call({ hits: [hit({ id: "f1" })], nothingRelevant: false })).nothingRelevant
    ).toBe(false);
  });

  it("is always present: an empty answer without a judgement is 'nothing'", async () => {
    expect((await call({ hits: [] })).nothingRelevant).toBe(true);
    expect((await call({ hits: [hit({ id: "hot-1" })] })).nothingRelevant).toBe(false);
  });
});

describe("POST /recall — MNEMO_RECALL_RELEVANCE_FLOOR", () => {
  afterEach(() => {
    delete process.env.MNEMO_RECALL_RELEVANCE_FLOOR;
  });

  it("forwards the operator's floor to core", async () => {
    process.env.MNEMO_RECALL_RELEVANCE_FLOOR = "0.42";
    const capture: { q?: RecallQuery } = {};
    await call({ hits: [] }, {}, capture);
    expect(capture.q?.relevanceFloor).toBe(0.42);
  });

  it("leaves it to core's per-model default when unset", async () => {
    const capture: { q?: RecallQuery } = {};
    await call({ hits: [] }, {}, capture);
    expect(capture.q?.relevanceFloor).toBeUndefined();
  });
});

describe("POST /recall — kinds (APP-022)", () => {
  async function post(kinds: unknown) {
    let called = false;
    const deps = {
      apiKeys: await makeKeyLookup(),
      cognitive: {
        recall: async () => {
          called = true;
          return { hits: [], total: 0, query: { text: "q", limit: 10, offset: 0 }, latencyMs: 0 };
        },
      },
    } as unknown as ServerDeps;
    const app = buildMountHarness(deps, [mountRecall]);
    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "who owns billing", kinds }),
    });
    return { res, called };
  }

  it("an unknown kind is a 400 that names it, and nothing is searched", async () => {
    const { res, called } = await post(["fact", "facts"]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; param?: string } };
    expect(body.error.message).toContain("'facts'");
    expect(body.error.param).toBe("kinds");
    expect(called).toBe(false);
  });

  it("every recallable kind and entity are accepted", async () => {
    const kinds = [
      "fact",
      "decision",
      "strategy",
      "workflow",
      "skill",
      "episode",
      "task",
      "event",
      "reasoning",
      "entity",
    ];
    const { res, called } = await post(kinds);
    expect(res.status).toBe(200);
    expect(called).toBe(true);
  });
});
