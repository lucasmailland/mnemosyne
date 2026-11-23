import { describe, it, expect, vi } from "vitest";
import { importClaudeMemory } from "../claude-import.js";
import type { PluginContext } from "../../index.js";

function makeCtx() {
  const createFact = vi.fn(async () => ({ id: "f-new" }));
  const ctx = { workspaceId: "ws", config: {}, createFact, log: { info: vi.fn() } } as unknown as PluginContext;
  return { ctx, createFact };
}

describe("claude-import importClaudeMemory", () => {
  it("imports 3 entries as facts", async () => {
    const { ctx, createFact } = makeCtx();
    const json = JSON.stringify([
      { content: "Fact A", subject: "A", tags: ["x"] },
      { content: "Fact B" },
      { text: "Fact C (text field)" },
    ]);
    const count = await importClaudeMemory(ctx, json);
    expect(count).toBe(3);
    expect(createFact).toHaveBeenCalledTimes(3);
    expect(createFact).toHaveBeenCalledWith(expect.objectContaining({ tags: expect.arrayContaining(["claude-import"]) }));
  });

  it("throws on malformed JSON", async () => {
    const { ctx } = makeCtx();
    await expect(importClaudeMemory(ctx, "not json")).rejects.toThrow("claude-import: malformed JSON");
  });

  it("throws when input is not an array", async () => {
    const { ctx } = makeCtx();
    await expect(importClaudeMemory(ctx, '{"content": "a"}')).rejects.toThrow("Expected a JSON array");
  });
});
