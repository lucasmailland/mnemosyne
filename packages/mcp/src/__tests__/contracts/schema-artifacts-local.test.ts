import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MnemosyneClient } from "@mnemo-ai/client-ts";
import { registerAllTools } from "../../registry.js";
import { compactSchema } from "../../tool-surface.js";
import { normalizeSchema } from "./schema-normalizer.js";

describe("WP-8 input artifacts without a network fixture", () => {
  it("matches the four additive tool schemas", () => {
    const server = new McpServer({ name: "contracts", version: "0" });
    const schemas = new Map<string, unknown>();
    const original = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation((name, config, callback) => {
      if (["memory_fact", "memory_recall", "memory_relate", "memory_search"].includes(name)) {
        const inputSchema = (config as unknown as { inputSchema: Record<string, z.ZodType> })
          .inputSchema;
        // The artifacts record what tools/list serves, which is compacted (tool-surface.ts).
        const schema = normalizeSchema(
          compactSchema(z.toJSONSchema(z.object(inputSchema), { target: "draft-07" }))
        ) as Record<string, unknown>;
        delete schema.additionalProperties;
        if (name === "memory_relate") delete schema.required;
        schemas.set(name, schema);
      }
      return original(name, config, callback);
    });
    registerAllTools(server, {} as MnemosyneClient);
    for (const [name, schema] of schemas) {
      const artifact = JSON.parse(
        readFileSync(new URL(`../../../contracts/${name.slice(7)}.json`, import.meta.url), "utf8")
      ) as { inputSchema: unknown };
      expect(artifact.inputSchema).toEqual(schema);
    }
    expect(schemas.size).toBe(4);
  });
});
