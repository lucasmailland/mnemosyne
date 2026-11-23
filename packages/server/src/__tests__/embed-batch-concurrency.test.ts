/**
 * Collapse embeds every turn of a session in one `embed()` call to measure
 * recurrence. Firing all of them at once (hundreds, for a long session) queued
 * the requests at Bedrock, and the per-text 3s deadline expired on the tail of
 * the queue: `embed timed out after 3000ms` on sessions whose individual
 * embeds take a fraction of that.
 */
import { describe, it, expect } from "vitest";
import { createEmbedAdapter, EMBED_BATCH_CONCURRENCY } from "../embed-adapter.js";
import type { LLMProviderLike } from "../deps.js";

describe("embed adapter batch concurrency", () => {
  it("keeps a large batch to a bounded number of requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const provider = {
      embed: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return [0.1, 0.2, 0.3];
      },
    } as unknown as LLMProviderLike;
    const adapter = createEmbedAdapter(provider, "m", 3);

    const vectors = await adapter.embed(Array.from({ length: 50 }, (_, i) => `turn ${i}`));

    expect(vectors).toHaveLength(50);
    expect(peak).toBe(EMBED_BATCH_CONCURRENCY);
  });

  it("returns vectors in input order", async () => {
    const provider = {
      embed: async (text: string) => {
        await new Promise((r) => setTimeout(r, text === "a" ? 5 : 0));
        return [text === "a" ? 1 : 2];
      },
    } as unknown as LLMProviderLike;
    const adapter = createEmbedAdapter(provider, "m", 1);
    const [a, b] = await adapter.embed(["a", "b"]);
    expect(a![0]).toBe(1);
    expect(b![0]).toBe(2);
  });
});
