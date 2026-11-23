/**
 * Task P3.2: Verifies that recallWithCaches emits a parent mnemo.recall span
 * and that tier sub-spans (mnemo.recall.hot / mnemo.recall.pointer / mnemo.recall.cold)
 * are created with a parent link.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";

// ── Fake telemetry ─────────────────────────────────────────────────────────────

const spans: Array<{ name: string; hasParent: boolean }> = [];
const histograms: Array<{ name: string; tier: string }> = [];

const fakeTelemetry = {
  startSpan: (name: string, opts?: { parent?: unknown }) => {
    spans.push({ name, hasParent: Boolean(opts?.parent) });
    return { setAttribute() {}, setStatus() {}, end() {} };
  },
  counter() {},
  histogram(_name: string, _value: number, attrs?: Record<string, string>) {
    if (attrs?.tier) histograms.push({ name: _name, tier: attrs.tier });
  },
  gauge() {},
  shutdown: async () => {},
};

// ── Minimal CoreContext stub ───────────────────────────────────────────────────

const WS = "ws-span-test";

function makeCtx() {
  const embedding = new Float32Array(8).fill(0.5);
  return {
    embed: {
      model: "test-embed",
      embedSingle: async () => embedding,
    },
    storage: {
      // Embedding cache — miss → generate
      getCachedEmbedding: async () => null,
      putCachedEmbedding: async () => undefined,
      // L3 query cache — miss
      lookupQueryCache: async () => null,
      upsertQueryCache: async () => undefined,
      // Pointer tier candidates — empty so it falls through
      pointerCandidates: async () => [],
      // Cold-tier vector search — empty, short-circuits cold path early
      getFact: async () => null,
      getRelations: async () => [],
      queryHyperedges: async () => ({ items: [] }),
      getRecallLog: async () => [],
      recordRecall: async () => undefined,
    },
    vector: {
      search: async () => [],
    },
    cache: null,
    outbox: {
      append: async () => undefined,
    },
    telemetry: fakeTelemetry,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      fatal() {},
      child() { return this as typeof this; },
    },
    config: {
      maxHotTierSize: 1000,
      worthDecayLambda: 0.85,
      surpriseThreshold: 0.15,
      hotTierTtlSeconds: 86400,
      injectionScoreThreshold: 0.85,
      anomalyScoreThreshold: 0.8,
    },
  } as never;
}

const auth: AuthContext = {
  workspaceId: WS,
  actorId: "agent-span-test",
  actorType: "agent",
  scopes: ["memory:read"] as never,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("recall span threading (P3.2)", () => {
  beforeEach(() => {
    spans.length = 0;
    histograms.length = 0;
  });

  it("emits a root mnemo.recall span with no parent", async () => {
    // Import after beforeEach so module-level spans are cleared
    const { createCore } = await import("../index.js");
    const core = createCore(makeCtx() as never);
    await core.recall({ workspaceId: WS, text: "hello world" }, auth);

    expect(spans.some((s) => s.name === "mnemo.recall" && !s.hasParent)).toBe(true);
  });

  it("emits at least one tier sub-span with a parent link", async () => {
    const { createCore } = await import("../index.js");
    const core = createCore(makeCtx() as never);
    await core.recall({ workspaceId: WS, text: "hello world" }, auth);

    // At least one of hot/pointer/cold spans must have a parent
    expect(
      spans.some((s) => s.name.startsWith("mnemo.recall.") && s.hasParent),
    ).toBe(true);
  });

  it("mnemo.recall span appears before any tier sub-span", async () => {
    const { createCore } = await import("../index.js");
    const core = createCore(makeCtx() as never);
    await core.recall({ workspaceId: WS, text: "hello world" }, auth);

    const rootIdx = spans.findIndex((s) => s.name === "mnemo.recall");
    const firstTierIdx = spans.findIndex((s) => s.name.startsWith("mnemo.recall."));
    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(firstTierIdx).toBeGreaterThan(rootIdx);
  });

  it("emits mnemo_recall_duration_seconds histogram for the cold tier", async () => {
    const { createCore } = await import("../index.js");
    const core = createCore(makeCtx() as never);
    // No token budget → runs full cascade → hits cold path
    await core.recall({ workspaceId: WS, text: "hello world" }, auth);

    expect(
      histograms.some((h) => h.name === "mnemo_recall_duration_seconds" && h.tier === "cold"),
    ).toBe(true);
  });
});
