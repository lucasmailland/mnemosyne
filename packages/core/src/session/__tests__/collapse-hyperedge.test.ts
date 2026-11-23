import { describe, it, expect, vi } from "vitest";
import { extractConsolidationHyperedges } from "../collapse.js";

// Build a minimal CoreContext stub for testing hyperedge extraction
function makeCtx(opts: {
  llm?: { generate: (input: unknown) => Promise<{ content: string }> } | null;
  createHyperedge?: ReturnType<typeof vi.fn>;
}) {
  const createHyperedge = opts.createHyperedge ?? vi.fn().mockResolvedValue({ id: "he-1" });
  return {
    llm: opts.llm === undefined ? null : opts.llm,
    storage: {
      createHyperedge,
      getFact: vi.fn(async (id: string) => ({ id, statement: `statement of ${id}` })),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    telemetry: { startSpan: vi.fn().mockReturnValue({ end: vi.fn() }) },
  } as any;
}

describe("extractConsolidationHyperedges", () => {
  it("returns early without throwing when LLM is absent", async () => {
    const createHyperedge = vi.fn();
    const ctx = makeCtx({ llm: null, createHyperedge });
    // Should not throw, should not call createHyperedge
    await extractConsolidationHyperedges(ctx, "ws-1", ["f1", "f2", "f3"], "");
    expect(createHyperedge).not.toHaveBeenCalled();
  });

  it("does not call createHyperedge when LLM returns empty array", async () => {
    const createHyperedge = vi.fn();
    const ctx = makeCtx({
      llm: { generate: vi.fn().mockResolvedValue({ content: "[]" }) },
      createHyperedge,
    });
    await extractConsolidationHyperedges(ctx, "ws-1", ["f1", "f2", "f3"], "some context");
    expect(createHyperedge).not.toHaveBeenCalled();
  });

  it("calls createHyperedge once when LLM returns a valid group of 3 indices", async () => {
    const createHyperedge = vi.fn().mockResolvedValue({ id: "he-99" });
    const ctx = makeCtx({
      llm: { generate: vi.fn().mockResolvedValue({ content: "[[0,1,2]]" }) },
      createHyperedge,
    });
    const factIds = ["fact-alpha", "fact-beta", "fact-gamma"];
    await extractConsolidationHyperedges(ctx, "ws-1", factIds, "context text");
    expect(createHyperedge).toHaveBeenCalledOnce();
    const args = createHyperedge.mock.calls[0][0];
    expect(args.memberIds).toEqual(["fact-alpha", "fact-beta", "fact-gamma"]);
    expect(args.workspaceId).toBe("ws-1");
    expect(args.label).toBe("auto-consolidated");
  });

  it("skips groups with fewer than 3 members", async () => {
    const createHyperedge = vi.fn().mockResolvedValue({ id: "he-1" });
    const ctx = makeCtx({
      llm: { generate: vi.fn().mockResolvedValue({ content: "[[0,1],[2,3,4]]" }) },
      createHyperedge,
    });
    const factIds = ["f0", "f1", "f2", "f3", "f4"];
    await extractConsolidationHyperedges(ctx, "ws-1", factIds, "");
    // Only the 3-member group [2,3,4] should produce a hyperedge
    expect(createHyperedge).toHaveBeenCalledOnce();
    const args = createHyperedge.mock.calls[0][0];
    expect(args.memberIds).toEqual(["f2", "f3", "f4"]);
  });

  it("is a no-op when fewer than 3 factIds regardless of LLM", async () => {
    const generate = vi.fn();
    const createHyperedge = vi.fn();
    const ctx = makeCtx({
      llm: { generate },
      createHyperedge,
    });
    await extractConsolidationHyperedges(ctx, "ws-1", ["only-one", "two"], "");
    expect(generate).not.toHaveBeenCalled();
    expect(createHyperedge).not.toHaveBeenCalled();
  });

  it("does not throw when LLM returns invalid JSON (non-fatal)", async () => {
    const createHyperedge = vi.fn();
    const ctx = makeCtx({
      llm: { generate: vi.fn().mockResolvedValue({ content: "not valid json" }) },
      createHyperedge,
    });
    // Must not throw — just logs a warning
    await expect(
      extractConsolidationHyperedges(ctx, "ws-1", ["f1", "f2", "f3"], "")
    ).resolves.toBeUndefined();
    expect(createHyperedge).not.toHaveBeenCalled();
  });
});

describe("APP-061 — the prompt carries the facts it asks to group", () => {
  it("lists each new fact's statement by index and asks for JSON only", async () => {
    const generate = vi.fn().mockResolvedValue({ content: "[]" });
    const statements: Record<string, string> = {
      f0: "The orders API runs on Fastify.",
      f1: "The orders API is deployed to eu-west-1.",
      f2: "The orders API owner is the payments team.",
    };
    const ctx = makeCtx({ llm: { generate } });
    ctx.storage.getFact = vi.fn(async (id: string) => ({ id, statement: statements[id] }));
    await extractConsolidationHyperedges(ctx, "ws-1", ["f0", "f1", "f2"], "turns");
    const prompt = (generate.mock.calls[0]![0] as { messages: Array<{ content: string }> })
      .messages[0]!.content;
    expect(prompt).toContain("0: The orders API runs on Fastify.");
    expect(prompt).toContain("2: The orders API owner is the payments team.");
    expect(prompt).toMatch(/only the JSON/i);
  });

  it("an adapter without getFact skips the pass (no fact-less prompt) and says so", async () => {
    const generate = vi.fn().mockResolvedValue({ content: "[[0,1,2]]" });
    const createHyperedge = vi.fn();
    const ctx = makeCtx({ llm: { generate }, createHyperedge });
    delete ctx.storage.getFact;
    await extractConsolidationHyperedges(ctx, "ws-1", ["f0", "f1", "f2"], "turns");
    await extractConsolidationHyperedges(ctx, "ws-1", ["f0", "f1", "f2"], "turns");
    expect(generate).not.toHaveBeenCalled();
    expect(createHyperedge).not.toHaveBeenCalled();
    const skips = ctx.logger.warn.mock.calls.filter(([msg]: [string]) =>
      msg.includes("hyperedge_extract_skipped")
    );
    expect(skips).toHaveLength(1);
  });
});
