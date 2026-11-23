// packages/core/src/v3/__tests__/delta-episode-residual.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { applyDelta } from "@mnemo-ai/types";
import { computeDeltaEpisodeLink } from "../delta-episode.js";
import type { CoreContext } from "../context.js";

const WS = "ws-residual";

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
    config: {},
  } as unknown as CoreContext;
}

const PARENT = [
  "Deploy process started",
  "Built the container image",
  "Pushed to the registry",
  "Ran the migration",
  "Health check green",
].join("\n");

const CHILD = [
  "Deploy process started",
  "Built the container image",
  "Pushed to the registry",
  "Rolled back the migration",
  "Health check green",
].join("\n");

describe("computeDeltaEpisodeLink — residual encoding (F4)", () => {
  it("stores a residual shorter than the child and exactly reconstructable", async () => {
    const storage = new InMemoryStorageAdapter();
    const vec = [1, 0, 0];

    // Seed parent episode and simulate the OutboxWorker embedding it.
    const parent = await storage.createEpisode({
      workspaceId: WS,
      title: "deploy",
      narrative: PARENT,
      occurredAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
    });
    storage.setEmbedding(parent.id, vec);

    const ctx = makeCtx(storage, vec);
    const link = await computeDeltaEpisodeLink(ctx, WS, CHILD);

    expect(link.parentEpisodeId).toBe(parent.id);
    expect(typeof link.deltaContent).toBe("string");
    // >70% shared text ⇒ delta strictly smaller than the child narrative.
    expect(link.deltaContent!.length).toBeLessThan(CHILD.length);
    // applyDelta(parentReconstructed, delta) === child exactly.
    expect(applyDelta(PARENT, link.deltaContent!)).toBe(CHILD);
  });

  it("returns an empty link when no similar parent exists", async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, [1, 0, 0]);
    const link = await computeDeltaEpisodeLink(ctx, WS, "a brand new narrative");
    expect(link).toEqual({});
  });
});
