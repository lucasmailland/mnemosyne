// packages/mcp/src/tools/__tests__/compare.test.ts
//
// Thin-caller contract for `memory_compare`, mirroring
// `packages/mcp/src/__tests__/contracts/compare.test.ts` — updated alongside
// it (docs/archive/openspec/decompose-recall-and-compare, Slice 2) since `compare.ts` no
// longer calls `client.getFact` or computes anything locally.
import { describe, it, expect, vi } from "vitest";
import { registerCompare } from "../compare.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

/** Capture the registered handler and its declared input schema. */
function captureTool() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>;
  let schema: Record<string, unknown>;
  const server = {
    registerTool(_name: string, def: { inputSchema: unknown }, fn: typeof handler) {
      schema = def.inputSchema as Record<string, unknown>;
      handler = fn;
    },
  } as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
  const compareFacts = vi.fn();
  const client = { compareFacts } as unknown as MnemosyneClient;
  registerCompare(server, client);
  return { handler: handler!, schema: schema!, compareFacts };
}

describe("memory_compare — schema validation", () => {
  it("accepts two fact IDs via zod schema", () => {
    const { schema } = captureTool();
    expect(() =>
      (schema as { factIdA: { parse: (v: unknown) => unknown } }).factIdA.parse("mfact_abc")
    ).not.toThrow();
    expect(() =>
      (schema as { factIdB: { parse: (v: unknown) => unknown } }).factIdB.parse("mfact_xyz")
    ).not.toThrow();
  });

  it("rejects empty factIdA", () => {
    const { schema } = captureTool();
    expect(() =>
      (schema as { factIdA: { parse: (v: unknown) => unknown } }).factIdA.parse("")
    ).toThrow();
  });
});

describe("memory_compare — handler: forwards to client.compareFacts", () => {
  it("passes factIdA/factIdB through unchanged", async () => {
    const { handler, compareFacts } = captureTool();
    compareFacts.mockResolvedValue({
      factA: { id: "mfact_a" },
      factB: { id: "mfact_b" },
      differences: [],
      suggestedVerb: "compatible",
      sameSubject: false,
    });

    await handler({ factIdA: "mfact_a", factIdB: "mfact_b" });

    expect(compareFacts).toHaveBeenCalledWith({ factIdA: "mfact_a", factIdB: "mfact_b" });
  });

  it("returns the server response as structuredContent, unmodified", async () => {
    const { handler, compareFacts } = captureTool();
    const serverResult = {
      factA: { id: "mfact_a", content: "User prefers dark mode" },
      factB: { id: "mfact_b", content: "User prefers light mode" },
      differences: ['content: "User prefers dark mode" → "User prefers light mode"'],
      suggestedVerb: "conflicts_with",
      sameSubject: true,
    };
    compareFacts.mockResolvedValue(serverResult);

    const result = (await handler({ factIdA: "mfact_a", factIdB: "mfact_b" })) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: typeof serverResult;
    };

    expect(result.structuredContent).toEqual(serverResult);
    expect(JSON.parse(result.content[0]!.text)).toEqual(serverResult);
  });
});

describe("memory_compare — error handling", () => {
  it("returns isError when client.compareFacts throws", async () => {
    const { handler, compareFacts } = captureTool();
    compareFacts.mockRejectedValue(new Error("404 not found"));

    const result = (await handler({ factIdA: "mfact_missing", factIdB: "mfact_b" })) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("404 not found");
  });
});
