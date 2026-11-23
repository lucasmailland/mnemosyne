/**
 * P109 — a failing delta-episode lookup must not cost the episode.
 *
 * `computeDeltaEpisodeLink` (DELTAMEM §16) is an enrichment: it delta-encodes
 * the new episode against a similar existing one, and its documented behaviour
 * when there is no similar neighbour is to fall back to a ROOT episode. A throw
 * is not that fallback. The call sat bare inside the episode try/catch, so any
 * failure inside it skipped `createEpisode` and the outer handler logged the
 * loss as "non-fatal".
 *
 * Found on a live stack, not by reading: after the workspace's embedding model
 * changed, `mnemo_episode` held vectors at one width while the query embedded at
 * another. pgvector cannot compare mismatched widths, the neighbour lookup threw,
 * and the collapse reported `completed` with facts extracted and NO EPISODE —
 * the single artefact the context layer exists to produce. `preferSourceEpisode`
 * then has nothing to surface, and every fact from that session is
 * context-orphaned.
 */
import { describe, it, expect, vi } from "vitest";
import { collapseSession } from "../collapse.js";
import type { CoreContext } from "../../cognitive/context.js";
import type { AuthContext } from "@mnemo-ai/types";

const auth = {
  actorId: "system:test",
  actorType: "system",
  workspaceId: "ws",
  scopes: [],
} as unknown as AuthContext;

function makeTurns(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    workspaceId: "ws",
    sessionId: "s1",
    turnIndex: i,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `mensaje sobre la migracion de cache ${i}`,
    createdAt: new Date(0),
  }));
}

function makeCtx(opts: { vectorSearchThrows?: boolean } = {}) {
  const createEpisode = vi.fn(async (input: Record<string, unknown>) => ({
    id: "ep-1",
    ...input,
  }));
  const linkSessionFactsToEpisode = vi.fn(async () => 2);
  const warn = vi.fn();

  const summary = {
    goal: "migrar el cache",
    outcome: "resolved",
    facts: [{ content: "el cache pasa a Valkey", topicKey: "cache", confidence: 0.9 }],
    decisions: [],
    strategies: [],
    llmTokensUsed: 10,
  };

  const ctx = {
    config: { surpriseThreshold: 0, maxHotTierSize: 1000 },
    logger: {
      debug() {},
      info() {},
      warn,
      error() {},
      child() {
        return this;
      },
    },
    embed: {
      embed: async (xs: string[]) => xs.map(() => [1, 0, 0]),
      embedSingle: async () => new Float32Array([1, 0, 0]),
    },
    // Deliberately healthy: computePE uses this earlier in the pipeline, and a
    // throw here would prove nothing about the delta step.
    vector: { search: async () => [] },
    llm: {
      generate: async () => ({
        content: JSON.stringify(summary),
        tokensUsed: { input: 10, output: 10 },
      }),
    },
    cache: null,
    outbox: { append: async () => {} },
    storage: {
      getSession: async () => ({
        id: "s1",
        workspaceId: "ws",
        agentId: "agent-x",
        status: "active",
        turnCount: 4,
        tokenCount: 50,
        openedAt: new Date(0),
        metadata: {},
      }),
      listTurns: async () => makeTurns(4),
      createFact: async () => ({ id: "f-1" }),
      // P125: collapse now routes a topicKey'd fact through the upsert before
      // inserting. `null` = nothing to merge into, i.e. this double keeps its
      // previous create-everything behaviour; it is here so the double covers
      // the port method the code actually calls.
      mergeFactByTopicKey: async () => null,
      createDecision: async () => ({ id: "d" }),
      createStrategy: async () => ({ id: "st" }),
      createRelation: async () => ({ id: "r" }),
      createEpisode,
      linkSessionFactsToEpisode,
      closeSession: async () => {},
      // The real failure shape, at the real call site: computeDeltaEpisodeLink
      // asks storage for similar episodes, and pgvector refuses to compare
      // vectors of different widths.
      findSimilarEpisodes: async () => {
        if (opts.vectorSearchThrows) throw new Error("different halfvec dimensions 1024 and 768");
        return [];
      },
      // Must exist: computeDeltaEpisodeLink returns {} early when it does not,
      // which would make this test pass without ever reaching the throw.
      reconstructEpisode: async () => ({ id: "ep-parent", narrative: "previo", depth: 0 }),
    },
  } as unknown as CoreContext;

  return { ctx, createEpisode, linkSessionFactsToEpisode, warn };
}

describe("P109 — the episode survives a broken delta-link lookup", () => {
  it("creates the episode anyway when the neighbour lookup throws", async () => {
    const { ctx, createEpisode } = makeCtx({ vectorSearchThrows: true });

    const result = await collapseSession(
      { sessionId: "s1", workspaceId: "ws", reason: "explicit" },
      ctx,
      auth
    );

    expect(result.status).toBe("completed");
    // The whole point: a flat episode is worth immeasurably more than none.
    expect(createEpisode).toHaveBeenCalledTimes(1);
  });

  it("still links the session's facts to that episode", async () => {
    // Without this, every fact written during the session — including the ones
    // an agent wrote by hand through remember() — stays context-orphaned.
    const { ctx, linkSessionFactsToEpisode } = makeCtx({ vectorSearchThrows: true });

    await collapseSession({ sessionId: "s1", workspaceId: "ws", reason: "explicit" }, ctx, auth);

    expect(linkSessionFactsToEpisode).toHaveBeenCalledWith("ws", "s1", "ep-1");
  });

  it("writes a ROOT episode — no parent, no delta payload", async () => {
    const { ctx, createEpisode } = makeCtx({ vectorSearchThrows: true });

    await collapseSession({ sessionId: "s1", workspaceId: "ws", reason: "explicit" }, ctx, auth);

    const input = createEpisode.mock.calls[0]![0] as Record<string, unknown>;
    // "No reachable neighbour" is the same situation as "no similar neighbour",
    // which DELTAMEM §16 already answers with a root episode.
    expect(input["parentEpisodeId"] ?? null).toBeNull();
    expect(input["deltaContent"] ?? null).toBeNull();
  });

  it("says so in the log instead of degrading silently", async () => {
    const { ctx, warn } = makeCtx({ vectorSearchThrows: true });

    await collapseSession({ sessionId: "s1", workspaceId: "ws", reason: "explicit" }, ctx, auth);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("delta-episode link unavailable"),
      expect.objectContaining({ operation: "collapse.episode_delta" })
    );
  });

  it("still creates the episode on the healthy path", async () => {
    // Guard against "fixing" this by disabling delta linking altogether.
    const { ctx, createEpisode, warn } = makeCtx();

    await collapseSession({ sessionId: "s1", workspaceId: "ws", reason: "explicit" }, ctx, auth);

    expect(createEpisode).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("delta-episode link unavailable"),
      expect.anything()
    );
  });
});
