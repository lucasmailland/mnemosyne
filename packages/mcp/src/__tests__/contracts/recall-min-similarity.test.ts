import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { registerRecall } from "../../tools/recall.js";

describe("memory_recall minSimilarity", () => {
  it("forwards an explicit floor and omits it by default", async () => {
    const recall = vi.fn(async (_input: Record<string, unknown>) => ({ hits: [] }));
    const server = new McpServer({ name: "test", version: "0.0.0" });
    let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
    const original = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation((name, schema, cb) => {
      if (name === "memory_recall") handler = cb as typeof handler;
      return original(name, schema, cb);
    });
    registerRecall(server, { recall } as unknown as MnemosyneClient);
    expect(handler).toBeDefined();
    await handler!({ query: "chatbot", minSimilarity: 0.8 });
    expect(recall.mock.calls[0]?.[0]).toMatchObject({ minSimilarity: 0.8 });
    await handler!({ query: "chatbot" });
    expect(recall.mock.calls[1]?.[0]).not.toHaveProperty("minSimilarity");
  });
});
