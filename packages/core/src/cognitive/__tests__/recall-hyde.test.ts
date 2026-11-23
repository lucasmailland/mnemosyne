import { describe, it, expect, vi } from "vitest";
import { generateHydeDoc } from "../hyde.js";
describe("HyDE degraded path", () => {
  it("returns null (no throw) when ctx.llm is absent", async () => {
    const ctx = { llm: undefined, logger: { debug() {}, warn() {} } } as any;
    await expect(generateHydeDoc(ctx, "where do we deploy?")).resolves.toBeNull();
  });
  it("returns the LLM pseudo-doc text when llm present", async () => {
    const ctx = { llm: { id: "x", model: "m", generate: async () => ({ content: "We deploy on Fly.io.", model: "m", tokensUsed: { input: 1, output: 1 }, costUSD: 0 }) }, logger: { debug() {}, warn() {} } } as any;
    await expect(generateHydeDoc(ctx, "where do we deploy?")).resolves.toBe("We deploy on Fly.io.");
  });

  it("returns null when LLM generate throws", async () => {
    const ctx = {
      llm: { id: "x", model: "m", generate: async () => { throw new Error("network error"); } },
      logger: { debug: vi.fn(), warn: vi.fn() },
    } as any;
    await expect(generateHydeDoc(ctx, "test")).resolves.toBeNull();
  });

  it("returns null when LLM returns empty content", async () => {
    const ctx = {
      llm: { id: "x", model: "m", generate: async () => ({ content: "   ", model: "m", tokensUsed: { input: 1, output: 1 }, costUSD: 0 }) },
      logger: { debug: vi.fn(), warn: vi.fn() },
    } as any;
    await expect(generateHydeDoc(ctx, "test")).resolves.toBeNull();
  });
});
