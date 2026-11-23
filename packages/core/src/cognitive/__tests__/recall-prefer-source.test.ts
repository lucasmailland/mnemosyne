import { describe, it, expect, vi } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";

// Isolate cold cascade: stub composition + worth so the test focuses on
// what recallCold does with a fact's source episode (spec §17 lines 1101-1104).
vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));

const { recallCold } = await import("../recall-cold.js");

const auth = {
  workspaceId: "ws",
  scopes: ["memory:admin"],
  sessionId: "s1",
} as unknown as AuthContext;

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const SOURCE_EPISODE = {
  id: "ep-source",
  workspaceId: "ws",
  title: "Source episode",
  narrative: "The source episode narrative",
  occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  participants: [],
  topics: [],
  linkedFactIds: ["fact-1"],
  isRoot: true,
  depth: 0,
  isSynthetic: false,
  createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  metadata: {},
};

const SOURCE_FACT = {
  id: "fact-1",
  workspaceId: "ws",
  subject: "user",
  kind: "other" as const,
  scope: "global" as const,
  statement: "user knows thing", // viewFact reads f.statement as content
  sensitivity: "internal" as const,
  attribution: "user_stated" as const,
  attributedTo: "user" as const,
  sourceMessageIds: [],
  revisionCount: 0,
  protocolVersion: "3",
  episodeId: "ep-source", // ← the field under test (MnemoFact.episodeId)
  status: "active" as const,
  pinned: false,
  canonical: false,
  validFrom: new Date(), // determinism-ok: throwaway fixture date, not asserted
  embeddingStale: false,
  memoryStrength: 0.8,
  memoryStability: 1.0,
  // Beta-Bernoulli worth fields so passesWorthGate(hit) is satisfied
  worth: 0.9, // must be > 0.5
  worthAlpha: 10, // wilsonLowerBound(10,2) >> 0.3
  worthBeta: 2,
  worthSuccess: 8,
  worthFailure: 0,
  confidence: 0.9,
  relevance: 0.9,
  hitCount: 10,
  memoryType: "semantic" as const,
  createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  updatedAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
  metadata: {},
};

/** Build a minimal CoreContext stub. `getEpisodeOverride` controls what
 *  storage.getEpisode returns: pass `null` to simulate storage miss,
 *  pass `undefined` (default) to return SOURCE_EPISODE. */
function makeCtx(
  opts: {
    getEpisodeOverride?: typeof SOURCE_EPISODE | null;
    missingGetEpisode?: boolean;
  } = {}
) {
  const episodeResult =
    opts.getEpisodeOverride === undefined ? SOURCE_EPISODE : opts.getEpisodeOverride;

  const getEpisode = opts.missingGetEpisode
    ? undefined
    : vi.fn(async (_id: string, _ws: string) => episodeResult as typeof SOURCE_EPISODE | null);

  const storage: Record<string, unknown> = {
    getFact: vi.fn(async () => SOURCE_FACT),
    getRelations: vi.fn(async () => []),
    queryHyperedges: vi.fn(async () => ({
      items: [],
      total: 0,
      offset: 0,
      limit: 10,
      hasMore: false,
    })),
    recordRecall: vi.fn(async () => undefined),
    getCoOccurrencePatterns: vi.fn(async () => []),
    createHyperedge: vi.fn(async () => ({ id: "x", memberIds: [] })),
  };
  if (getEpisode !== undefined) {
    storage["getEpisode"] = getEpisode;
  }

  // Vector search returns only the fact with a mediocre score (0.6).
  // preferSourceEpisode should inject the episode at the fact's score (0.6)
  // and demote the fact below it.
  // Vector search returns only the fact with a mediocre score (0.6).
  // preferSourceEpisode should inject the episode at the fact's score (0.6)
  // and demote the fact below it.
  const vector = {
    search: vi.fn(async () => [{ id: "fact-1", score: 0.6, primitiveKind: "fact" }]),
  };
  const embed = {
    id: "e",
    model: "m",
    dimensions: 3,
    embed: vi.fn(async (xs: string[]) => xs.map(() => new Float32Array([1, 0, 0]))),
    embedSingle: vi.fn(async () => new Float32Array([1, 0, 0])),
  };
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return this;
    },
  };
  const telemetry = {
    startSpan: () => ({ end() {}, setAttribute() {}, setStatus() {} }),
    histogram() {},
  };
  const outbox = { append: vi.fn(async () => undefined) };
  const ctx = {
    storage,
    vector,
    embed,
    logger,
    telemetry,
    outbox,
    config: {},
  } as unknown as Parameters<typeof recallCold>[0];
  return { ctx, getEpisode };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("WP-3: recallCold no longer injects source episodes (spec §17 lines 1101-1104)", () => {
  // RECALL-2's sibling: the source episode was injected at the fact's score
  // with no similarity of its own, and the fact demoted below it. Episodes are
  // recallable on their own embedding (DEFAULT_RECALL_KINDS) — one that
  // matches the query competes like any other hit; one that does not stays out.
  it("does not inject the source episode of a recalled fact, nor fetch it", async () => {
    const { ctx, getEpisode } = makeCtx();
    const res = await recallCold(ctx, { workspaceId: "ws", text: "thing", limit: 10 } as any, auth);

    expect(res.hits.find((h) => h.id === "ep-source")).toBeUndefined();
    expect(getEpisode).not.toHaveBeenCalled();
  });

  it("keeps the fact at its own score — nothing demotes it", async () => {
    const { ctx } = makeCtx();
    const res = await recallCold(ctx, { workspaceId: "ws", text: "thing", limit: 10 } as any, auth);

    const factHit = res.hits.find((h) => h.id === "fact-1");
    expect(factHit).toBeDefined();
    expect(res.hits[0]!.id).toBe("fact-1");
  });

  it("storage miss (getEpisode returns null) → silent no-op, no throw", async () => {
    const { ctx } = makeCtx({ getEpisodeOverride: null });
    await expect(
      recallCold(ctx, { workspaceId: "ws", text: "thing", limit: 10 } as any, auth)
    ).resolves.not.toThrow();

    const res = await recallCold(ctx, { workspaceId: "ws", text: "thing", limit: 10 } as any, auth);
    const episodeHit = res.hits.find((h) => h.id === "ep-source");
    expect(episodeHit).toBeUndefined();
    // Fact is still present
    expect(res.hits.find((h) => h.id === "fact-1")).toBeDefined();
  });

  it("absent getEpisode port method → silent no-op, no throw", async () => {
    const { ctx } = makeCtx({ missingGetEpisode: true });
    await expect(
      recallCold(ctx, { workspaceId: "ws", text: "thing", limit: 10 } as any, auth)
    ).resolves.not.toThrow();

    const res = await recallCold(ctx, { workspaceId: "ws", text: "thing", limit: 10 } as any, auth);
    expect(res.hits.find((h) => h.id === "fact-1")).toBeDefined();
  });
});
