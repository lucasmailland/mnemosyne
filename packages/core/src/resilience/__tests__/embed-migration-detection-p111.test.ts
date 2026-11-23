import { describe, it, expect } from "vitest";
import { hybridRecallWeights } from "../embedMigration.js";

// P111 — `hasActiveEmbeddingMigration` was declared optional on the port, called
// by recall-cold on every cold recall, and implemented by NO adapter. The call
// site guards it (`ctx.storage.hasActiveEmbeddingMigration ? … : false`), so an
// absent implementation never threw — it took the `false` branch forever.
//
// The consequence runs the wrong way round. A workspace mid-migration holds
// embeddings from two different models, which are not comparable to each other
// or to the query vector; that is exactly when recall should lean on the lexical
// arm. Answering "no migration" kept the vector arm at 0.6 during the one window
// it is least trustworthy.
//
// These guards pin the weights either side of that flag. The adapter-side
// predicate (which now mirrors listStaleEmbeddings exactly, so "there is work to
// do" and "a migration is active" cannot disagree) is covered by the
// adapter-postgres integration suite, which needs a real Postgres.

describe("hybridRecallWeights — the flag recall could never see (P111)", () => {
  it("leans on the lexical arm while a migration is active", () => {
    const w = hybridRecallWeights(true);
    expect(w.fts).toBeGreaterThan(w.vector);
    expect(w).toEqual({ fts: 0.7, vector: 0.3 });
  });

  it("prefers the vector arm when embeddings are homogeneous", () => {
    const w = hybridRecallWeights(false);
    expect(w.vector).toBeGreaterThan(w.fts);
    expect(w).toEqual({ fts: 0.4, vector: 0.6 });
  });

  it("weights always sum to 1 — a partial shift would silently rescale scores", () => {
    for (const active of [true, false]) {
      const w = hybridRecallWeights(active);
      expect(w.fts + w.vector).toBeCloseTo(1, 10);
    }
  });
});
