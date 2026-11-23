// packages/mcp/src/__tests__/contracts/compare.test.ts
//
// Thin-caller contract for `memory_compare` (docs/archive/openspec/decompose-recall-and-compare,
// Slice 2, design.md D4). All comparison domain logic
// (`computeDifferences`/`detectSameSubject`/`suggestVerb`/`leadingTokens`) was
// relocated server-side into `packages/server/src/facts/compare.ts` — this
// suite no longer proves the B6 4-value `SuggestableVerb` behavior (that
// anchor migrated byte-for-byte to `packages/server/src/__tests__/facts-compare.test.ts`,
// exercising the relocated pure function directly). It instead proves the
// tool is now a pure forwarder: both ids reach `client.compareFacts()`
// unchanged, its response passes through as `structuredContent`, and a
// rejected promise maps to `isError`.
import { describe, it, expect, vi } from "vitest";
import { registerCompare } from "../../tools/compare.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";

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

describe("memory_compare — the tool's inputSchema exposes no per-fact workspace targeting", () => {
  it("only accepts factIdA/factIdB", () => {
    const { schema } = captureTool();
    expect(Object.keys(schema).sort()).toEqual(["factIdA", "factIdB"]);
  });

  it("rejects empty factIdA/factIdB via zod", () => {
    const { schema } = captureTool();
    expect(() =>
      (schema as { factIdA: { parse: (v: unknown) => unknown } }).factIdA.parse("")
    ).toThrow();
    expect(() =>
      (schema as { factIdB: { parse: (v: unknown) => unknown } }).factIdB.parse("")
    ).toThrow();
  });
});

describe("memory_compare — forwards both ids to client.compareFacts", () => {
  it("calls client.compareFacts with exactly { factIdA, factIdB }", async () => {
    const { handler, compareFacts } = captureTool();
    compareFacts.mockResolvedValue({
      factA: { id: "mfact_a" },
      factB: { id: "mfact_b" },
      differences: [],
      suggestedVerb: "compatible",
      sameSubject: false,
    });

    await handler({ factIdA: "mfact_a", factIdB: "mfact_b" });

    expect(compareFacts).toHaveBeenCalledTimes(1);
    expect(compareFacts).toHaveBeenCalledWith({ factIdA: "mfact_a", factIdB: "mfact_b" });
  });
});

describe("memory_compare — returns client.compareFacts' response verbatim", () => {
  it("passes the server response through as structuredContent, no local recomputation", async () => {
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
  it("returns isError when client.compareFacts rejects (e.g. 404)", async () => {
    const { handler, compareFacts } = captureTool();
    compareFacts.mockRejectedValue(new Error("404 Not Found: Fact mfact_b not found"));

    const result = (await handler({ factIdA: "mfact_a", factIdB: "mfact_b" })) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("404");
  });

  it("returns isError with the underlying message when client.compareFacts throws a generic error", async () => {
    const { handler, compareFacts } = captureTool();
    compareFacts.mockRejectedValue(new Error("network error"));

    const result = (await handler({ factIdA: "mfact_a", factIdB: "mfact_b" })) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("network error");
  });
});
