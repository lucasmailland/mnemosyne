import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { remember } from "../remember.js";
import { computeDeltaEpisodeLink, DELTA_EPISODE_SIM_THRESHOLD } from "../delta-episode.js";
import type { AuthContext } from "@mnemo-ai/types";
import type { CoreContext } from "../context.js";

// DELTAMEM §16 — delta-episode auto-formation on the episode write path.
//
// In production the embedding is written asynchronously by the OutboxWorker.
// The InMemoryStorageAdapter does not run that worker, so these tests simulate
// it by calling setEmbedding(episodeId, vec) after creation — exactly the state
// findSimilarEpisodes reads. The embed mock returns a fixed unit vector so the
// cosine of any narrative against an indexed episode is 1.0 (> 0.85 threshold).

const WS = "ws-delta";

const auth: AuthContext = {
  workspaceId: WS,
  actorId: "agent-1",
  actorType: "agent",
  scopes: ["memory:write"] as never,
};

function makeCtx(storage: InMemoryStorageAdapter, vec: number[]): CoreContext {
  return {
    storage,
    vector: { search: async () => [] },
    embed: {
      id: "mock",
      model: "mock-embed",
      dimensions: vec.length,
      embed: async (texts: string[]) => texts.map(() => new Float32Array(vec)),
      embedSingle: async () => new Float32Array(vec),
      healthCheck: async () => ({ healthy: true }) as never,
    },
    telemetry: { startSpan: () => ({ end: () => {} }) },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    config: {
      surpriseThreshold: 0,
      maxHotTierSize: 1000,
      worthDecayLambda: 0.1,
      hotTierTtlSeconds: 3600,
      injectionScoreThreshold: 0.85,
      anomalyScoreThreshold: 0.8,
    },
  } as unknown as CoreContext;
}

describe("DELTAMEM §16 — delta-episode auto-formation", () => {
  it("computeDeltaEpisodeLink returns empty link when no similar episode exists", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, [1, 0, 0]);
    const link = await computeDeltaEpisodeLink(ctx, WS, "a brand new narrative");
    expect(link).toEqual({});
  });

  it("links a new episode to its nearest indexed episode as a delta", async () => {
    const storage = new InMemoryStorageAdapter();
    const vec = [1, 0, 0];
    const ctx = makeCtx(storage, vec);

    // First episode — created as a root (nothing to link to yet).
    const first = await remember(
      ctx,
      { workspaceId: WS, kind: "episode", content: "deployed the auth service", subject: "deploy" },
      auth,
    );
    const firstEp = await storage.getEpisode(first.id, WS);
    expect(firstEp?.parentEpisodeId).toBeUndefined();
    expect(firstEp?.isRoot).toBe(true);
    expect(firstEp?.depth).toBe(0);

    // Simulate the OutboxWorker having embedded the first episode.
    storage.setEmbedding(first.id, vec);

    // Second episode — cosine 1.0 against the first (> 0.85) ⇒ delta-linked.
    const second = await remember(
      ctx,
      { workspaceId: WS, kind: "episode", content: "rolled back the auth service", subject: "deploy" },
      auth,
    );
    const secondEp = await storage.getEpisode(second.id, WS);
    expect(secondEp?.parentEpisodeId).toBe(first.id);
    expect(secondEp?.isRoot).toBe(false);
    expect(secondEp?.depth).toBe(1);
    // DELTAMEM §16: deltaContent is now a RESIDUAL payload, not the raw narrative.
    // The two single-line narratives share no lines, so encodeDelta emits a
    // MNEMO_FULL_V1 payload that reconstructs to exactly the child narrative.
    expect(secondEp?.deltaContent).not.toBe("rolled back the auth service");
    expect(secondEp?.deltaContent?.startsWith("MNEMO_")).toBe(true);

    // Reconstruction applies the residual onto the parent (replace, not append):
    // the leaf narrative is recovered exactly.
    const full = await storage.reconstructEpisode(second.id, WS);
    expect(full.narrative).toBe("rolled back the auth service");
  });

  it("does not link when the best match is below the threshold", async () => {
    const storage = new InMemoryStorageAdapter();
    // Seed an episode indexed with an orthogonal vector → cosine 0 (< 0.85).
    const rootVec = [0, 1, 0];
    const root = await remember(
      makeCtx(storage, rootVec),
      { workspaceId: WS, kind: "episode", content: "unrelated topic", subject: "x" },
      auth,
    );
    storage.setEmbedding(root.id, rootVec);

    // New episode embeds to an orthogonal vector → no parent.
    const next = await remember(
      makeCtx(storage, [1, 0, 0]),
      { workspaceId: WS, kind: "episode", content: "a different unrelated topic", subject: "y" },
      auth,
    );
    const nextEp = await storage.getEpisode(next.id, WS);
    expect(nextEp?.parentEpisodeId).toBeUndefined();
    expect(nextEp?.isRoot).toBe(true);
  });

  it("threshold constant is the documented 0.85", () => {
    expect(DELTA_EPISODE_SIM_THRESHOLD).toBe(0.85);
  });
});
