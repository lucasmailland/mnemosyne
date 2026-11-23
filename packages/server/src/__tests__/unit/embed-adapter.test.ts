import { describe, it, expect, vi } from "vitest";
import { createEmbedAdapter } from "../../embed-adapter.js";
import type { LLMProviderLike } from "../../deps.js";

// ADP-5: the embed path never called recordLlmUsage — embedWithUsage
// existed on LLMProviderLike (and was even wrapped for §11 noise
// injection elsewhere) but nothing ever forwarded its usage/cost to the
// metrics layer, unlike the completion side (index.ts's onLlmUsage hook).

describe("createEmbedAdapter (ADP-5)", () => {
  it("calls onUsage with the provider's tokensUsed/costUSD when embedWithUsage is available", async () => {
    const onUsage = vi.fn();
    const provider: LLMProviderLike = {
      embed: vi.fn(async () => [0.1, 0.2, 0.3]),
      embedWithUsage: vi.fn(async () => ({
        vector: [0.1, 0.2, 0.3],
        tokensUsed: 42,
        costUSD: 0.00042,
        model: "text-embedding-3-small",
        provider: "openai",
      })),
    };

    // P117: the declared width must match the fixture's 3-element vector. It
    // said 1536 before, which was harmless while nothing checked — the adapter
    // now refuses a vector whose width disagrees with the store it feeds. This
    // test is about usage accounting, so the fixture is made self-consistent
    // rather than exempted; width-mismatch behaviour has its own file
    // (embed-width-guard.test.ts).
    const adapter = createEmbedAdapter(provider, "text-embedding-3-small", 3, onUsage);
    const vec = await adapter.embedSingle("hello world");

    // Float32Array rounding — compare with tolerance, not exact equality.
    expect(Array.from(vec)).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(0.2, 6),
      expect.closeTo(0.3, 6),
    ]);
    expect(onUsage).toHaveBeenCalledWith({
      provider: "openai",
      model: "text-embedding-3-small",
      tokens: 42,
      costUSD: 0.00042,
    });
  });

  it("omits costUSD from onUsage when the vendor result doesn't price it", async () => {
    const onUsage = vi.fn();
    const provider: LLMProviderLike = {
      embed: vi.fn(async () => [0.1]),
      embedWithUsage: vi.fn(async () => ({
        vector: [0.1],
        tokensUsed: 10,
        model: "some-model",
        provider: "some-provider",
      })),
    };

    const adapter = createEmbedAdapter(provider, "some-model", 1, onUsage);
    await adapter.embedSingle("x");

    expect(onUsage).toHaveBeenCalledWith({
      provider: "some-provider",
      model: "some-model",
      tokens: 10,
    });
  });

  it("falls back to plain embed() and never calls onUsage when embedWithUsage is absent", async () => {
    const onUsage = vi.fn();
    const provider: LLMProviderLike = {
      embed: vi.fn(async () => [0.5]),
    };

    const adapter = createEmbedAdapter(provider, "m", 1, onUsage);
    const vec = await adapter.embedSingle("x");

    expect(Array.from(vec)).toEqual([0.5]);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("records usage once per text for batched embed()", async () => {
    const onUsage = vi.fn();
    const provider: LLMProviderLike = {
      embed: vi.fn(async () => [0]),
      embedWithUsage: vi.fn(async (text: string) => ({
        vector: [0],
        tokensUsed: text.length,
        model: "m",
        provider: "p",
      })),
    };

    const adapter = createEmbedAdapter(provider, "m", 1, onUsage);
    await adapter.embed(["ab", "abcd"]);

    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenNthCalledWith(1, { provider: "p", model: "m", tokens: 2 });
    expect(onUsage).toHaveBeenNthCalledWith(2, { provider: "p", model: "m", tokens: 4 });
  });

  it("returns the NO_EMBED_ADAPTER stub when no provider is configured", async () => {
    const adapter = createEmbedAdapter(undefined, "m", 1536);
    expect(adapter.model).toBe("none");
    await expect(adapter.embedSingle("x")).rejects.toThrow(/No embed adapter configured/);
  });
});
