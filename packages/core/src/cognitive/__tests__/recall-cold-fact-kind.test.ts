import { describe, it, expect } from "vitest";
import type { CoreContext } from "../context.js";
import { recallCold } from "../recall-cold.js";

// PgVectorAdapter searches mnemo_fact and reports its `kind` column as the hit's
// primitiveKind. On mnemo_fact that column is the FACT kind (preference, trait,
// event, relationship, skill, concern, other), not the primitive kind — so a
// recall over real facts receives these values and must still serve them.
const FACTS: Record<string, string> = {
  "f-concern": "concern",
  "f-event": "event",
  "f-other": "other",
};

function fact(id: string) {
  return {
    id,
    workspaceId: "ws1",
    statement: `statement ${id}`,
    kind: FACTS[id],
    status: "active",
    worth: 0.5,
    worthAlpha: 2,
    worthBeta: 2,
    sensitivity: "internal",
    attribution: "user_stated",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    validFrom: new Date("2026-01-01T00:00:00Z"),
    validTo: null,
  };
}

const vectorHits = Object.entries(FACTS).map(([id, kind], i) => ({
  id,
  score: 0.9 - i * 0.1,
  primitiveKind: kind,
}));

function makeCtx(storage: Record<string, unknown>): CoreContext {
  return {
    storage: {
      getRelations: async () => [],
      queryHyperedges: async () => ({ items: [] }),
      recordRecall: async () => {},
      ...storage,
    },
    vector: { search: async () => vectorHits.map((h) => ({ ...h })) },
    embed: {
      embed: async () => [],
      embedSingle: async () => new Float32Array([1, 0, 0]),
      model: "m",
      dimensions: 3,
    },
    outbox: { append: async () => {} },
    llm: undefined,
    config: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    },
    telemetry: {
      startSpan: () => ({ end() {}, setAttribute() {}, recordException() {}, addEvent() {} }),
      histogram() {},
      counter() {},
      gauge() {},
    },
  } as unknown as CoreContext;
}

async function recall(ctx: CoreContext) {
  return recallCold(
    ctx,
    { workspaceId: "ws1", text: "q", embedding: new Float32Array([1, 0, 0]), limit: 10 } as never,
    { workspaceId: "ws1", actorId: "a", actorType: "agent", scopes: ["memory:read"] } as never
  );
}

describe("recallCold serves facts whatever their fact kind", () => {
  it("with batch hydration, like the Postgres storage adapter", async () => {
    // Mirrors RecallRepository.getRecallPrimitives: refs are grouped by kind and
    // each primitive table is queried; a kind with no table returns nothing.
    const ctx = makeCtx({
      getRecallPrimitives: async (_ws: string, refs: Array<{ id: string; kind: string }>) =>
        refs
          .filter((ref) => ref.kind === "fact" && ref.id in FACTS)
          .map((ref) => ({ id: ref.id, kind: "fact", value: fact(ref.id) })),
    });
    const resp = await recall(ctx);
    expect(resp.hits.map((h) => h.id).sort()).toEqual(["f-concern", "f-event", "f-other"]);
    expect(resp.hits.every((h) => h.primitive === "fact")).toBe(true);
  });

  it("with per-hit hydration", async () => {
    const ctx = makeCtx({
      getFact: async (id: string) => (id in FACTS ? fact(id) : null),
      getEvent: async () => null,
    });
    const resp = await recall(ctx);
    expect(resp.hits.map((h) => h.id).sort()).toEqual(["f-concern", "f-event", "f-other"]);
    expect(resp.hits.every((h) => h.primitive === "fact")).toBe(true);
  });
});
