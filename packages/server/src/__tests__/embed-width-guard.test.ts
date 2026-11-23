/**
 * P117 — the embed adapter must refuse a vector whose width disagrees with the
 * one the vector store was sized from.
 *
 * Boot validation (`resolveEmbedDimensions`) only checks what the operator
 * DECLARED. The model is free to disagree with the declaration: point
 * MNEMO_EMBED_MODEL at a 1024-dim model while MNEMO_EMBED_DIMENSIONS says 1536
 * and there is no config error to find — every vector is silently the wrong
 * shape. Comparing the returned array against the advertised width is the only
 * place that catches it.
 */
import { describe, it, expect } from "vitest";
import { createEmbedAdapter } from "../embed-adapter.js";
import type { LLMProviderLike } from "../deps.js";

const providerReturning = (width: number): LLMProviderLike =>
  ({
    embed: async () => Array.from({ length: width }, (_, i) => i / width),
  }) as unknown as LLMProviderLike;

describe("P117 — embed adapter width guard", () => {
  it("passes a vector through when the model agrees with the configured width", async () => {
    const adapter = createEmbedAdapter(providerReturning(1024), "mxbai-embed-large", 1024);
    const [vec] = await adapter.embed(["hello"]);
    expect(vec).toHaveLength(1024);
    expect(await adapter.embedSingle("hello")).toHaveLength(1024);
  });

  it("throws when the model returns a narrower vector than configured", async () => {
    const adapter = createEmbedAdapter(providerReturning(768), "nomic-embed-text", 1536);
    await expect(adapter.embed(["hello"])).rejects.toThrow(
      /returned a 768-dim vector but the vector store is configured for 1536/
    );
  });

  it("throws on embedSingle too — both entry points are guarded", async () => {
    // embedSingle is the path recall uses for the query vector; leaving it
    // unguarded would mean queries embedded at one width searching an index
    // built at another.
    const adapter = createEmbedAdapter(providerReturning(2048), "some-model", 1536);
    await expect(adapter.embedSingle("hello")).rejects.toThrow(/2048-dim vector/);
  });

  it("names both escape hatches in the message", async () => {
    // An operator hitting this needs to know it is fixable two ways: change the
    // declared width, or change the model. A bare dimension mismatch does not
    // tell them which knob exists.
    const adapter = createEmbedAdapter(providerReturning(1024), "mxbai-embed-large", 1536);
    await expect(adapter.embed(["x"])).rejects.toThrow(/MNEMO_EMBED_DIMENSIONS/);
    await expect(adapter.embed(["x"])).rejects.toThrow(/1536-dim model/);
  });

  it("does NOT silently truncate or pad", async () => {
    // The tempting "fix" is to resize the vector. A resized embedding is not a
    // degraded embedding — it is a different point in a space it was never
    // computed in, ranking as noise while looking perfectly healthy in the
    // database. Failing loudly is the only honest option.
    const adapter = createEmbedAdapter(providerReturning(1024), "m", 1536);
    await expect(adapter.embed(["x"])).rejects.toThrow();
  });
});
