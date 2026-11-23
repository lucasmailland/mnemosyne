import { describe, it, expect, vi } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";

// Isolate the cold cascade: stub composition + worth so the test focuses on the
// episode-reconstruction wiring in fetchView.
vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));

const { recallCold } = await import("../recall-cold.js");

const auth = { workspaceId: "ws", scopes: ["memory:admin"], sessionId: "s1" } as unknown as AuthContext;

function makeCtx(over: { episode: any; reconstruct?: any }) {
  const reconstructEpisode = over.reconstruct ?? vi.fn(async () => ({
    ...over.episode,
    narrative: "ROOT narrative\n+delta child\n+delta grandchild",
  }));
  const storage = {
    getEpisode: vi.fn(async () => over.episode),
    reconstructEpisode,
    getRelations: vi.fn(async () => []),
    queryHyperedges: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 10, hasMore: false })),
    recordRecall: vi.fn(async () => undefined),
    getCoOccurrencePatterns: vi.fn(async () => []),
    createHyperedge: vi.fn(async () => ({ id: "x", memberIds: [] })),
  };
  const vector = {
    search: vi.fn(async () => [{ id: "ep-leaf", score: 0.9, primitiveKind: "episode" }]),
  };
  const embed = {
    id: "e", model: "m", dimensions: 3,
    embed: vi.fn(async (xs: string[]) => xs.map(() => new Float32Array([1, 0, 0]))),
    embedSingle: vi.fn(async () => new Float32Array([1, 0, 0])),
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  const telemetry = { startSpan: () => ({ end() {}, setAttribute() {}, setStatus() {} }), histogram: () => {} };
  const outbox = { append: vi.fn(async () => undefined) };
  const ctx = { storage, vector, embed, logger, telemetry, outbox, config: {} } as any;
  return { ctx, reconstructEpisode };
}

const DELTA_EPISODE = {
  id: "ep-leaf", workspaceId: "ws", title: "leaf", narrative: "+delta grandchild",
  occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  participants: [], topics: [], linkedFactIds: [],
  parentEpisodeId: "ep-child", deltaContent: "+delta grandchild", isRoot: false, depth: 2,
  isSynthetic: false, createdAt: new Date(), updatedAt: new Date(), metadata: {}, // determinism-ok: throwaway fixture date, not asserted
};

const ROOT_EPISODE = { ...DELTA_EPISODE, id: "ep-leaf", narrative: "ROOT narrative", parentEpisodeId: undefined, isRoot: true, depth: 0, deltaContent: undefined };

describe("recall episode reconstruction (§16/§17)", () => {
  it("reconstructs a delta-encoded episode's full narrative at read time", async () => {
    const { ctx, reconstructEpisode } = makeCtx({ episode: DELTA_EPISODE });
    const res = await recallCold(ctx, { workspaceId: "ws", text: "deploy", limit: 5 } as any, auth);
    expect(reconstructEpisode).toHaveBeenCalledWith("ep-leaf", "ws");
    const hit = res.hits.find((h) => h.id === "ep-leaf")!;
    expect(hit.content).toBe("ROOT narrative\n+delta child\n+delta grandchild");
  });

  it("does NOT reconstruct a root episode (no parent)", async () => {
    const { ctx, reconstructEpisode } = makeCtx({ episode: ROOT_EPISODE });
    const res = await recallCold(ctx, { workspaceId: "ws", text: "deploy", limit: 5 } as any, auth);
    expect(reconstructEpisode).not.toHaveBeenCalled();
    const hit = res.hits.find((h) => h.id === "ep-leaf")!;
    expect(hit.content).toBe("ROOT narrative");
  });

  it("falls back to the stored narrative when reconstruction fails", async () => {
    const failing = vi.fn(async () => { throw new Error("broken chain"); });
    const { ctx } = makeCtx({ episode: DELTA_EPISODE, reconstruct: failing });
    const res = await recallCold(ctx, { workspaceId: "ws", text: "deploy", limit: 5 } as any, auth);
    expect(failing).toHaveBeenCalled();
    const hit = res.hits.find((h) => h.id === "ep-leaf")!;
    expect(hit.content).toBe("+delta grandchild"); // stored narrative, not a throw
  });
});
