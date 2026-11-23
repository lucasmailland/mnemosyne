import { describe, it, expect } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { remember } from "../remember.js";
import type { AuthContext } from "@mnemo-ai/types";
import type { EmbeddingNoiseConfig } from "../../security/embedding-noise.js";

// B2: Optional ε-DP embedding noise wired into the write path.
// The stored vector_upsert outbox payload must reflect noise config:
//   - mode "off"     → vector is byte-identical to the raw embedding
//   - mode "laplace" → vector differs from the raw embedding

/** Raw embedding returned by the embed stub. */
const RAW_EMBEDDING = new Float32Array([0.1, 0.2, 0.3]);

function makeCtx(
  storage: InMemoryStorageAdapter,
  embeddingNoise?: EmbeddingNoiseConfig,
) {
  return {
    storage,
    vector: { search: async () => [] }, // PE = 1.0 → never surprise-gated
    embed: { embedSingle: async () => RAW_EMBEDDING },
    telemetry: { startSpan: () => ({ end: () => {}, setAttribute: () => {}, setStatus: () => {} }) },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    config: {
      surpriseThreshold: 0,
      maxHotTierSize: 1000,
      worthDecayLambda: 0.1,
      hotTierTtlSeconds: 3600,
      injectionScoreThreshold: 0.85,
      anomalyScoreThreshold: 0.8,
      ...(embeddingNoise !== undefined ? { embeddingNoise } : {}),
    },
  } as never;
}

const auth: AuthContext = {
  workspaceId: "ws-noise-test",
  actorId: "agent-noise",
  actorType: "agent",
  scopes: ["memory:write"] as never,
};

describe("remember() — B2 ε-DP embedding noise", () => {
  it('mode "off": stored vector is byte-identical to the raw embedding', async () => {
    const storage = new InMemoryStorageAdapter();
    const ctx = makeCtx(storage, { mode: "off", epsilon: 1 });

    await remember(
      ctx,
      { workspaceId: "ws-noise-test", kind: "fact", content: "noise off test" },
      auth,
    );

    // InMemoryStorageAdapter.createFact also pushes a vector_upsert without a
    // `vector` field.  The entry appended by remember.ts (which carries the actual
    // vector) is the last one with eventType "vector_upsert" AND a vector field.
    const upsert = storage.outbox
      .filter((e) => e.eventType === "vector_upsert" && Array.isArray((e.payload as Record<string, unknown>).vector))
      .at(-1);
    expect(upsert).toBeDefined();
    const storedVector = (upsert!.payload as { vector: number[] }).vector;
    expect(storedVector).toEqual(Array.from(RAW_EMBEDDING));
  });

  it('mode "laplace": stored vector differs from the raw embedding', async () => {
    const storage = new InMemoryStorageAdapter();
    // Deterministic rng so the test is reproducible.
    const ctx = makeCtx(storage, {
      mode: "laplace",
      epsilon: 1,
      rng: () => 0.9,
    });

    await remember(
      ctx,
      { workspaceId: "ws-noise-test", kind: "fact", content: "noise laplace test" },
      auth,
    );

    const upsert = storage.outbox
      .filter((e) => e.eventType === "vector_upsert" && Array.isArray((e.payload as Record<string, unknown>).vector))
      .at(-1);
    expect(upsert).toBeDefined();
    const storedVector = (upsert!.payload as { vector: number[] }).vector;
    // With rng()=0.9 the Laplace sample is non-zero, so every element shifts.
    expect(storedVector).not.toEqual(Array.from(RAW_EMBEDDING));
  });
});
