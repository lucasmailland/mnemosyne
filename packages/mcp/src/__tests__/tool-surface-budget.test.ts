import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { describe, expect, it, vi } from "vitest";
import { registerAllTools, type ToolProfile } from "../registry.js";

/**
 * Audit 2026-11-22, PLAN 3.3 — what tools/list costs a client's context, as a
 * budget that fails when exceeded. Tool schemas are paid on every request by
 * hosts that do not defer tools. Bytes, not tokens: a byte figure is exact and
 * needs no credential (scripts/measure-tool-surface.mjs adds token counts).
 */
const BUDGET_BYTES: Record<ToolProfile, number> = { core: 16_000, full: 45_000 };

/** As index.ts builds it: declaring the tools capability installs tools/list at construction. */
async function connect(profile: ToolProfile, client = {} as MnemosyneClient, lazy = false) {
  const server = lazy
    ? new McpServer({ name: "surface", version: "0" })
    : new McpServer({ name: "surface", version: "0" }, { capabilities: { tools: {} } });
  registerAllTools(server, client, undefined, profile);
  const mcp = new Client({ name: "surface-test", version: "0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(a), server.connect(b)]);
  return { mcp, close: () => Promise.all([mcp.close(), server.close()]) };
}

async function listTools(profile: ToolProfile, lazy = false) {
  const { mcp, close } = await connect(profile, {} as MnemosyneClient, lazy);
  const { tools } = await mcp.listTools();
  await close();
  return tools;
}

describe("tools/list byte budget", () => {
  it.each(["core", "full"] as const)("%s fits its budget", async (profile) => {
    const bytes = Buffer.byteLength(JSON.stringify(await listTools(profile)), "utf8");
    console.log(`MEASURE tools/list ${profile}: ${bytes} bytes`);
    expect(bytes).toBeLessThanOrEqual(BUDGET_BYTES[profile]);
  });

  it.each([false, true])(
    "carries no boilerplate a client never needs (lazy handlers: %s)",
    async (lazy) => {
      const json = JSON.stringify(await listTools("full", lazy));
      expect(json).not.toContain('"$schema"');
      expect(json).not.toContain("9007199254740991");
      expect(json).not.toContain('"pattern"');
      expect(json).not.toContain('"taskSupport":"forbidden"');
      expect(json).not.toContain('"propertyNames":{"type":"string"}');
      expect(json).not.toContain('"additionalProperties":{}');
    }
  );

  it("keeps the format and the validation the long patterns used to spell out", async () => {
    const tools = await listTools("core");
    const recall = tools.find((t) => t.name === "memory_recall");
    const asOf = (recall?.inputSchema.properties as Record<string, Record<string, unknown>>).asOf;
    expect(asOf).toMatchObject({ type: "string", format: "date-time" });

    const recallSpy = vi.fn();
    const { mcp, close } = await connect("core", {
      recall: recallSpy,
    } as unknown as MnemosyneClient);
    const result = await mcp.callTool({
      name: "memory_recall",
      arguments: { query: "x", asOf: "yesterday" },
    });
    await close();
    expect(result.isError).toBe(true);
    expect(recallSpy).not.toHaveBeenCalled();
  });

  it("keeps the annotations that differ from the MCP defaults", async () => {
    const tools = new Map((await listTools("full")).map((t) => [t.name, t]));
    expect(tools.get("memory_fact")?.annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(tools.get("memory_recall")?.annotations).toEqual({
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools.get("memory_purge")?.annotations).toMatchObject({ openWorldHint: false });
    expect(tools.get("memory_purge")?.annotations?.destructiveHint ?? true).toBe(true);
  });
});
