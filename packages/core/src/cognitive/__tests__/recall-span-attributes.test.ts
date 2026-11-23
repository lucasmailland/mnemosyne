// packages/core/src/v3/__tests__/recall-span-attributes.test.ts
import { describe, it, expect, vi } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";

// Isolate the orchestrator from the composition engine.
vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));

const { createCore } = await import("../index.js");

// ── Test span exporter ──────────────────────────────────────────────────────
type Attr = Record<string, string | number | boolean>;
function makeTestTelemetry() {
  const spans: Array<{ name: string; attrs: Attr }> = [];
  return {
    spans,
    telemetry: {
      startSpan(name: string, opts?: { attributes?: Attr }) {
        const rec = { name, attrs: { ...(opts?.attributes ?? {}) } };
        spans.push(rec);
        return {
          setAttribute(k: string, v: string | number | boolean) {
            rec.attrs[k] = v;
          },
          setStatus() {},
          end() {},
        };
      },
      counter() {},
      histogram() {},
      gauge() {},
      async shutdown() {},
    },
  };
}

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return this as any;
  },
} as any;
const auth = {
  actorType: "agent",
  actorId: "a1",
  scopes: [],
  workspaceId: "ws1",
} as unknown as AuthContext;

// Storage that serves a hot-tier hit list with worth metadata.
function makeStorage() {
  const fact = (id: string, worth: number) => ({
    id,
    statement: `hot fact ${id}`,
    status: "active",
    sensitivity: "internal",
    worth,
    worthAlpha: 18,
    worthBeta: 4,
    attribution: "user_stated",
    createdAt: "2026-01-01T00:00:00Z",
    validFrom: null,
    validTo: null,
  });
  return {
    async getFact(id: string) {
      return fact(id, id === "f1" ? 0.8 : 0.6);
    },
    async getRecallLog() {
      const now = Date.now(); // determinism-ok: only relative offsets (0–4s) matter for ACT-R activation scoring
      return [0, 1000, 2000, 3000, 4000].map((ago, i) => ({
        id: `r-${i}`,
        recalledAt: new Date(now - ago).toISOString(),
        recallScore: 1,
      }));
    },
    // L3 + embedding cache helpers absent → undefined (graceful)
  } as any;
}

function makeCache(ids: string[]) {
  const z = new Map<string, number>();
  ids.forEach((id, i) => z.set(id, i + 1));
  return {
    id: "fake",
    capabilities: { sortedSets: true, pubSub: false, patterns: false, atomic: false },
    async zincrby(_k: string, by: number, member: string) {
      z.set(member, (z.get(member) ?? 0) + by);
    },
    async zrangeByScore() {
      return [...z.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    },
  } as any;
}

describe("mnemo.recall span attributes (F18)", () => {
  it("sets result_count, worth_avg, tier_hit, cache_hit and cost attrs after recall", async () => {
    const { spans, telemetry } = makeTestTelemetry();
    const core = createCore({
      storage: makeStorage(),
      vector: { search: vi.fn(async () => []) } as any,
      embed: { model: "test", embedSingle: vi.fn(async () => new Float32Array([0.1, 0.2])) } as any,
      outbox: { append: vi.fn(async () => {}) } as any,
      cache: makeCache(["f1", "f2", "f3"]),
      logger,
      telemetry,
    });

    await core.recall(
      {
        workspaceId: "ws1",
        text: "hot fact", // two content terms: one-term queries skip the hot tier (RECALL-8)
        limit: 10,
        embedding: new Float32Array([0.1, 0.2]),
      } as any,
      auth
    );

    const recallSpan = spans.find((s) => s.name === "mnemo.recall");
    expect(recallSpan, "mnemo.recall span must be emitted").toBeTruthy();
    expect(recallSpan!.attrs["mnemo.workspace_id"]).toBe("ws1");
    expect(recallSpan!.attrs["mnemo.operation"]).toBe("recall");
    expect(typeof recallSpan!.attrs["mnemo.result_count"]).toBe("number");
    expect(typeof recallSpan!.attrs["mnemo.worth_avg"]).toBe("number");
    expect(typeof recallSpan!.attrs["mnemo.tier_hit"]).toBe("string");
    expect(typeof recallSpan!.attrs["mnemo.cache_hit"]).toBe("boolean");
    expect(recallSpan!.attrs["mnemo.tokens_saved"]).toBe(0);
    expect(recallSpan!.attrs["mnemo.llm_cost_usd"]).toBe(0);
  });
});
